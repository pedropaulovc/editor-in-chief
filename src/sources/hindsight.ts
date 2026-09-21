import { createHash } from 'node:crypto';
import { parse } from 'dotenv';
import { z } from 'zod';
import { isoWeek } from '../calendar';
import { expandPath } from '../config';
import type { Collection, Context, Evidence } from '../contracts';
import { sanitize } from '../safety';

const HOST = 'https://hindsight.vza.net';
const KEY = 'source:hindsight';
const PRIORITY = ['omp-harmonic-analyzer', 'omp-el400', 'omp-oh-my-pi', 'omp-agent-plugins', 'omp-agent-sessions-backup'];
const QUERY = 'Find engineering milestones, failures, design tradeoffs, measurements, demonstrations, reusable AI-assisted engineering workflows, and supporting public commit, issue, logbook or project references. Prefer concrete work and evidence. Do not include credentials, confidential third-party information, unrelated politics or personal activity.';
const BankSchema = z.object({ bank_id: z.string().min(1).max(500), last_write_at: z.string().nullable().optional().transform(value => value ?? null), fact_count: z.number().int().nonnegative() });
const BankPageSchema = z.object({ banks: z.array(BankSchema).max(100), total: z.number().int().nonnegative() });
const MemorySchema = z.object({ id: z.string().min(1).max(500), text: z.string().max(30_000), occurred_start: z.string().nullable().optional(), mentioned_at: z.string().nullable().optional() });
type Bank = z.infer<typeof BankSchema>;
interface PendingBank { id: string; fingerprint: string; queuedAt: string }
interface MemoryState {
  banks: Record<string, Bank>;
  recalled: Record<string, { fingerprint: string; at: string }>;
  pending: PendingBank[];
  inventoryOffset: number;
  inventoryTotal: number;
  inventoryAt?: string;
  weeklyRevisit?: string;
}
class SourceError extends Error {}
function initial(): MemoryState { return { banks: {}, recalled: {}, pending: [], inventoryOffset: 0, inventoryTotal: 0 }; }
function fingerprint(bank: Bank): string { return `${bank.last_write_at ?? 'unknown'}:${bank.fact_count}`; }
async function token(ctx: Context): Promise<string> {
  let text: string;
  try { text = await Bun.file(expandPath(ctx.config.hindsightEnvFile)).text(); }
  catch { throw new SourceError('Hindsight designated credential file is unavailable'); }
  const value = parse(text).HINDSIGHT_API_TOKEN;
  if (!value || /[\r\n]/.test(value)) throw new SourceError('Hindsight HINDSIGHT_API_TOKEN is missing or invalid');
  return value;
}
async function request(ctx: Context, credential: string, path: string, body?: unknown): Promise<unknown> {
  if (ctx.config.hindsightUrl !== HOST || !/^\/v1\/default\/banks(?:\?|\/)/.test(path)) throw new SourceError('Hindsight fixed-host request rejected');
  const endpoint = path.includes('/memories/') ? '/v1/default/banks/{bank}/memories/recall' : '/v1/default/banks';
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(`${HOST}${path}`, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(45_000)]),
      });
    } catch { throw new SourceError(`Hindsight ${endpoint}: request failed or deadline exceeded`); }
    if (body === undefined && attempt < 2 && (response.status === 429 || response.status >= 500)) {
      const delay = Number(response.headers.get('retry-after'));
      await response.body?.cancel();
      if (Number.isFinite(delay) && delay > 10) throw new SourceError(`Hindsight ${endpoint}: HTTP ${response.status}; retry deferred`);
      await Bun.sleep(Math.max(1, delay || 2 ** attempt) * 1000);
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new SourceError(`Hindsight ${endpoint}: HTTP ${response.status}`); }
    if (Number(response.headers.get('content-length')) > 2_000_000) { await response.body?.cancel(); throw new SourceError(`Hindsight ${endpoint}: response bound exceeded`); }
    try {
      const text = await response.text();
      if (text.length > 2_000_000) throw new Error();
      return JSON.parse(text);
    } catch { throw new SourceError(`Hindsight ${endpoint}: invalid or oversized response`); }
  }
}
async function bankPage(ctx: Context, credential: string, offset: number): Promise<{ banks: Bank[]; total: number }> {
  const data = await request(ctx, credential, `/v1/default/banks?limit=100&offset=${offset}`);
  const parsed = BankPageSchema.safeParse(data);
  if (!parsed.success) throw new SourceError('Hindsight bank inventory schema invalid');
  return parsed.data;
}
async function recall(ctx: Context, credential: string, id: string): Promise<z.infer<typeof MemorySchema>[]> {
  const data = await request(ctx, credential, `/v1/default/banks/${encodeURIComponent(id)}/memories/recall`, {
    query: QUERY, budget: 'low', max_tokens: 2048, trace: false, query_timestamp: ctx.now.toISOString(),
  });
  const parsed = z.object({ results: z.array(MemorySchema).max(100) }).safeParse(data);
  if (!parsed.success) throw new SourceError('Hindsight recall schema or result bound invalid');
  return parsed.data.results;
}
function safeFailure(error: unknown): string { return error instanceof SourceError ? error.message : 'Hindsight operation failed; no response body retained'; }

export async function collectHindsight(ctx: Context): Promise<Collection> {
  const state = ctx.state.get<MemoryState>(KEY, initial());
  const now = ctx.now.toISOString();
  const evidence: Evidence[] = [];
  const failures: string[] = [];
  let credential: string;
  try { credential = await token(ctx); }
  catch (error) { return { evidence, coverage: { source: 'hindsight', status: 'failed', count: 0, detail: safeFailure(error) } }; }
  // Checkpoint each inventory page. Retrieval can continue against known banks if inventory fails.
  let inventoryComplete = false;
  for (let page = 0; page < 4 && !ctx.signal.aborted; page++) {
    try {
      const result = await bankPage(ctx, credential, state.inventoryOffset);
      if (!result.banks.length && state.inventoryOffset < result.total) throw new SourceError('Hindsight inventory returned an empty unfinished page');
      for (const bank of result.banks) {
        state.banks[bank.bank_id] = bank;
        if (bank.bank_id === 'omp-editor-in-chief' || !bank.fact_count) {
          state.pending = state.pending.filter(item => item.id !== bank.bank_id);
          continue;
        }
        const version = fingerprint(bank);
        if (state.recalled[bank.bank_id]?.fingerprint !== version) {
          const queued = state.pending.find(item => item.id === bank.bank_id);
          if (queued) queued.fingerprint = version;
          else state.pending.push({ id: bank.bank_id, fingerprint: version, queuedAt: now });
        }
      }
      state.inventoryOffset += result.banks.length;
      state.inventoryTotal = result.total;
      if (state.inventoryOffset >= result.total) { state.inventoryOffset = 0; state.inventoryAt = now; inventoryComplete = true; }
      ctx.state.set(KEY, state);
      if (inventoryComplete) break;
    } catch (error) { failures.push(safeFailure(error)); break; }
  }
  const thisWeek = isoWeek(ctx.now, ctx.config.timezone);
  const revisit = state.weeklyRevisit !== thisWeek
    ? Object.values(state.banks).filter(bank => bank.bank_id !== 'omp-editor-in-chief' && bank.fact_count > 0 && state.recalled[bank.bank_id]?.fingerprint === fingerprint(bank) && !state.pending.some(item => item.id === bank.bank_id))
      .sort((a, b) => state.recalled[a.bank_id]!.at.localeCompare(state.recalled[b.bank_id]!.at))[0]
    : undefined;
  // At most four priority slots; oldest queued work gets the remaining slots even if priority banks keep changing.
  const priority = state.pending.filter(item => PRIORITY.includes(item.id)).sort((a, b) => PRIORITY.indexOf(a.id) - PRIORITY.indexOf(b.id)).slice(0, 4);
  const ordered = [...priority, ...state.pending.filter(item => !priority.includes(item)).sort((a, b) => a.queuedAt.localeCompare(b.queuedAt))].slice(0, revisit ? 7 : 8);
  if (revisit) ordered.push({ id: revisit.bank_id, fingerprint: fingerprint(revisit), queuedAt: now });
  let retrieved = 0;
  let withheld = 0;
  for (const item of ordered) {
    if (ctx.signal.aborted) break;
    try {
      const results = await recall(ctx, credential, item.id);
      const normalized: Evidence[] = [];
      const seen = new Set<string>();
      for (const memory of results) {
        if (typeof memory.id !== 'string' || !memory.id || memory.id.length > 500 || typeof memory.text !== 'string') throw new SourceError('Hindsight memory schema invalid');
        if (seen.has(memory.id)) continue;
        seen.add(memory.id);
        try {
          if (memory.text.includes(credential)) throw new Error('Loaded credential detected');
          const text = sanitize(memory.text);
          if (!text.trim()) continue;
          const occurredAt = [memory.occurred_start, memory.mentioned_at].find(value => typeof value === 'string' && Number.isFinite(Date.parse(value))) ?? null;
          normalized.push({
            id: `hindsight:${encodeURIComponent(item.id)}:${encodeURIComponent(memory.id)}`, source: 'hindsight', sourceUrl: null,
            observedAt: now, occurredAt, revision: createHash('sha256').update(text).update(occurredAt ?? '').digest('hex'),
            text: `Reported in work notes; not independently verified. Ask Pedro to verify material claims.\n${text.slice(0, 6000)}`,
            provenance: { bank: sanitize(item.id), memoryId: sanitize(memory.id), verification: 'reported-work-notes', retrieval: 'ranked-low-budget', truncated: text.length > 6000 },
          });
        } catch { withheld++; }
      }
      ctx.state.putEvidence(normalized);
      evidence.push(...normalized);
      state.recalled[item.id] = { fingerprint: item.fingerprint, at: now };
      state.pending = state.pending.filter(pending => pending.id !== item.id);
      if (revisit?.bank_id === item.id) state.weeklyRevisit = thisWeek;
      ctx.state.set(KEY, state);
      retrieved++;
    } catch (error) {
      failures.push(safeFailure(error));
      // Retain failed work but move it behind its waiting peers so one bad bank cannot monopolize rotation.
      const pending = state.pending.find(entry => entry.id === item.id);
      if (pending) pending.queuedAt = now;
      ctx.state.set(KEY, state);
    }
  }
  if (withheld) failures.push(`Source-sanitization blocker: ${withheld} memory facts withheld`);
  const partial = !inventoryComplete || state.pending.length > 0 || failures.length > 0 || ctx.signal.aborted;
  return { evidence, coverage: {
    source: 'hindsight', status: partial ? 'partial' : 'ranked', count: evidence.length, checkpoint: state.inventoryAt,
    blockers:[...new Set(failures)],
    detail: `Ranked retrieval, never exhaustive change capture: ${retrieved}/8 bank recalls; ${state.pending.length} queued; ${Object.keys(state.banks).length}/${state.inventoryTotal} bank metadata seen; inventory ${inventoryComplete ? 'complete' : `pending at offset ${state.inventoryOffset}`}.${failures.length ? ` ${[...new Set(failures)].join('; ')}` : ''}`,
  } };
}

export async function doctorHindsight(ctx: Context): Promise<unknown> {
  try {
    const credential = await token(ctx);
    let offset = 0;
    let total = 0;
    let populated = 0;
    let chosen: Bank | undefined;
    for (let page = 0; page < 10; page++) {
      const result = await bankPage(ctx, credential, offset);
      total = result.total;
      populated += result.banks.filter(bank => bank.fact_count > 0).length;
      const eligible = result.banks.filter(bank => bank.fact_count > 0 && bank.bank_id !== 'omp-editor-in-chief');
      chosen = chosen ?? eligible.find(bank => PRIORITY.includes(bank.bank_id)) ?? eligible[0];
      offset += result.banks.length;
      if (offset >= total || !result.banks.length) break;
    }
    const results = chosen ? await recall(ctx, credential, chosen.bank_id) : [];
    return { source: 'hindsight', available: true, bankCount: total, banksInspected: offset, populatedBanksInspected: populated, inventoryComplete: offset >= total, boundedRecall: { attempted: Boolean(chosen), resultCount: results.length, budget: 'low', maxTokens: 2048, trace: false }, coverage: 'ranked retrieval; not an exhaustive memory export' };
  } catch (error) { return { source: 'hindsight', available: false, error: safeFailure(error) }; }
}
