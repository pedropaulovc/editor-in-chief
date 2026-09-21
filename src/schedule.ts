import { readFile, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandPath } from './config';
import type { Context } from './contracts';
import { nextSlots } from './calendar';

const BEGIN = '# BEGIN editor-in-chief';
const END = '# END editor-in-chief';
const SPEC = '0 8,14,20 * * *';

type MarkedBlock = { start: number; end: number; text: string };
type SlotDescription = { at: string; local: string; timezone: string };

async function crontab(ctx: Context, args: string[], input?: Buffer) {
  ctx.signal.throwIfAborted();
  const executable = Bun.which('crontab');
  if (!executable) throw new Error('crontab is not installed; scheduling requires the host user crontab');
  const proc = Bun.spawn([executable, ...args], {
    stdin: input === undefined ? 'ignore' : new Blob([new Uint8Array(input)]),
    stdout: 'pipe', stderr: 'pipe', env: { ...process.env, LC_ALL: 'C' },
  });
  const abort = () => proc.kill();
  ctx.signal.addEventListener('abort', abort, { once: true });
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(), new Response(proc.stderr).text(), proc.exited,
    ]);
    ctx.signal.throwIfAborted();
    if (code !== 0) {
      if (args.length === 1 && args[0] === '-l' && code === 1 && /^no crontab for [^\r\n]+\s*$/.test(stderr)) return Buffer.alloc(0);
      throw new Error(`crontab ${args.join(' ')} failed (exit ${code}); no unrelated entries were intentionally changed`);
    }
    return Buffer.from(stdout);
  } finally {
    ctx.signal.removeEventListener('abort', abort);
  }
}

function markedBlock(bytes: Buffer): MarkedBlock | null {
  // Latin-1 is deliberately byte-preserving: even non-UTF8 comments survive unchanged.
  const text = bytes.toString('latin1');
  const starts = [...text.matchAll(/^# BEGIN editor-in-chief\r?$/gm)];
  const ends = [...text.matchAll(/^# END editor-in-chief\r?$/gm)];
  if (!starts.length && !ends.length) return null;
  if (starts.length !== 1 || ends.length !== 1 || starts[0]!.index! >= ends[0]!.index!) {
    throw new Error('Malformed or duplicate editor-in-chief crontab markers; refusing to alter the crontab');
  }
  const start = starts[0]!.index!;
  let end = ends[0]!.index! + ends[0]![0].length;
  if (text[end] === '\n') end++;
  return { start, end, text: bytes.subarray(start, end).toString('utf8') };
}

/** Replace our marked block without decoding or rewriting unrelated bytes. */
export function updateCrontab(existing: Buffer, replacement: Buffer | null): Buffer {
  const block = markedBlock(existing);
  if (replacement === null) return block ? Buffer.concat([existing.subarray(0, block.start), existing.subarray(block.end)]) : existing;
  const newBlock = markedBlock(replacement);
  if (!newBlock || newBlock.start !== 0 || newBlock.end !== replacement.length) throw new Error('Replacement must contain exactly one complete managed cron block');
  if (existing.length && existing[existing.length - 1] !== 10) throw new Error('Existing crontab lacks its final newline; refusing to change unrelated bytes');
  return block
    ? Buffer.concat([existing.subarray(0, block.start), replacement, existing.subarray(block.end)])
    : Buffer.concat([replacement, existing]);
}

/** Host timezone and any inherited CRON_TZ must both agree with configuration. */
export function assertCronTimezone(configured: string, host: string | null, inherited?: string) {
  if (host !== configured || (inherited && inherited !== configured)) {
    throw new Error(`Host cron timezone ${inherited || host || 'unknown'} does not match configured ${configured}; change the host timezone explicitly before installation`);
  }
}

function inheritedEnvironment(bytes: Buffer, block: MarkedBlock | null) {
  const before = block ? bytes.subarray(0, block.start).toString('utf8') : '';
  const environment: Record<string, string> = {};
  for (const line of before.split('\n')) {
    const match = line.match(/^\s*(CRON_TZ|SHELL)\s*=\s*(.*?)\s*$/);
    if (match) environment[match[1]!] = match[2]!.replace(/^(['"])(.*)\1$/, '$2');
  }
  return environment;
}

async function hostTimezone(expected: string): Promise<string> {
  try {
    const localtime = await realpath('/etc/localtime');
    const marker = '/zoneinfo/';
    if (localtime.includes(marker)) return localtime.slice(localtime.indexOf(marker) + marker.length).replace(/^(posix|right)\//, '');
  } catch { /* A copied zoneinfo file has no identifying symlink. */ }
  try {
    const [local, known] = await Promise.all([readFile('/etc/localtime'), readFile(`/usr/share/zoneinfo/${expected}`)]);
    if (local.equals(known)) return expected;
  } catch { /* Refuse an unverifiable host timezone rather than trusting process.env.TZ. */ }
  throw new Error(`Cannot verify the host timezone as ${expected} from /etc/localtime; scheduling is refused`);
}

function quoted(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error('Cron paths must not contain newlines or NUL');
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Manage only this application's marked user-crontab block. Never called by run. */
export async function schedule(ctx: Context, action: 'install' | 'show' | 'remove', configPath: string): Promise<unknown> {
  const existing = await crontab(ctx, ['-l']);
  const block = markedBlock(existing);
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const config = expandPath(configPath);
  const stateDirectory = resolve(ctx.state.directory);
  const bun = Bun.which('bun') ?? process.execPath;
  const gh = Bun.which('gh');
  if (!gh && action === 'install') throw new Error('gh is not on PATH; cannot install a cron command without GitHub access');
  const pathDirectories = [...new Set([dirname(resolve(bun)), ...(gh ? [dirname(resolve(gh))] : []), '/usr/local/bin', '/usr/bin', '/bin'])];
  const minimalPath = pathDirectories.join(':');
  const command = `umask 077; cd ${quoted(repository)} && PATH=${quoted(minimalPath)} ${quoted(resolve(bun))} src/cli.ts run --apply --config ${quoted(config)} --state-dir ${quoted(stateDirectory)}`;
  // Cron handles percent signs before the shell, including inside shell quotes.
  const cronCommand = command.replaceAll('%', '\\%');
  const desired = Buffer.from(`${BEGIN}\n${SPEC} ${cronCommand}\n${END}\n`);
  if (action === 'remove') {
    if (block) {
      const updated = updateCrontab(existing, null);
      // Re-read just before replacement rather than clobbering a concurrent human edit.
      if (!(await crontab(ctx, ['-l'])).equals(existing)) throw new Error('Crontab changed during removal; retry after the other editor finishes');
      await crontab(ctx, ['-'], updated);
      if (!(await crontab(ctx, ['-l'])).equals(updated)) throw new Error('Crontab changed after removal; inspect it before retrying');
    }
    ctx.state.delete('schedule:installed');
    ctx.state.delete('schedule:pending');
    return { action, changed: Boolean(block), installed: false };
  }
  const environment = inheritedEnvironment(existing, block);
  let verifiedTimezone: string | null = null;
  let timezoneError: string | null = null;
  try { verifiedTimezone = await hostTimezone(ctx.config.timezone); }
  catch (error) { timezoneError = error instanceof Error ? error.message : 'Host timezone could not be verified'; }
  const effectiveTimezone = environment.CRON_TZ || verifiedTimezone;
  let timezoneMatches = false;
  try { assertCronTimezone(ctx.config.timezone, verifiedTimezone, environment.CRON_TZ); timezoneMatches = true; }
  catch (error) { timezoneError ??= error instanceof Error ? error.message : 'Cron timezone mismatch'; }
  if (action === 'install') {
    if (!timezoneMatches) throw new Error(timezoneError ?? `Host cron timezone ${effectiveTimezone ?? 'unknown'} does not match configured ${ctx.config.timezone}; change the host timezone explicitly before installation`);
    if (environment.SHELL && !/^\/(?:usr\/)?bin\/(?:sh|bash|dash|zsh|ksh)$/.test(environment.SHELL)) {
      throw new Error(`The marked block inherits a non-POSIX SHELL; move it before that setting or select a POSIX shell explicitly`);
    }
    const updated = updateCrontab(existing, desired);
    const record = { repository, bun: resolve(bun), config, stateDirectory, path: minimalPath, timezone: ctx.config.timezone, spec: SPEC, command, installedAt: ctx.now.toISOString() };
    if (!updated.equals(existing)) {
      ctx.state.set('schedule:pending', record);
      if (!(await crontab(ctx, ['-l'])).equals(existing)) throw new Error('Crontab changed during installation; retry after the other editor finishes');
      await crontab(ctx, ['-'], updated);
      if (!(await crontab(ctx, ['-l'])).equals(updated)) throw new Error('Crontab changed after installation; inspect it before retrying');
    }
    ctx.state.set('schedule:installed', record);
    ctx.state.delete('schedule:pending');
    return { action, changed: !updated.equals(existing), installed: true, ...record, next: slotDescriptions(ctx.now, ctx.config.timezone), caveat: 'Cron runs only while this host is up; missed runs are not replayed.' };
  }
  let next: SlotDescription[] | null = null;
  if (effectiveTimezone) {
    try { next = slotDescriptions(ctx.now, effectiveTimezone); }
    catch { timezoneError = 'The effective cron timezone is not recognized; future execution times cannot be verified'; }
  }
  const installedLine = block?.text.split('\n').find(line => line.startsWith(`${SPEC} `));
  return {
    action, installed: Boolean(block), timezoneMatches, configuredTimezone: ctx.config.timezone,
    hostTimezone: verifiedTimezone, effectiveTimezone, timezoneError,
    installedBlock: block?.text ?? null, installedCommand: installedLine?.slice(SPEC.length + 1) ?? null,
    expectedCommand: command, stateDirectory, installation: ctx.state.get('schedule:installed', null),
    next: block && !installedLine ? null : next,
    nextMeaning: block ? 'Next executions of the installed three-slot schedule' : 'Proposed slots; no editor-in-chief cron block is installed',
    caveat: 'Cron runs only while this host is up; missed runs are not replayed. Installation does not prove unattended firings.',
  };
}

function slotDescriptions(now: Date, timezone: string) {
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'shortOffset',
  });
  return nextSlots(now, timezone).map(slot => ({ at: slot.toISOString(), local: format.format(slot), timezone }));
}
