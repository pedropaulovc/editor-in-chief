import { readFile } from 'node:fs/promises';
import { parse } from 'dotenv';
import { expandPath } from './config';

const exactSecrets = new Set<string>();
const secretName = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|ACCESS_KEY|CLIENT_SECRET|COOKIE|CREDENTIALS?|AUTHORIZATION|CONNECTION_STRING)(?:$|_)/i;

export class SanitizationError extends Error {
  constructor() {
    super('source-sanitization blocker: sensitive or uncertain content withheld');
    this.name = 'SanitizationError';
  }
}

/** Host-only secret registration. Never returns, logs, or serializes the value. */
export function registerSecret(value: string): void {
  if (!value.trim()) return;
  exactSecrets.add(value);
  exactSecrets.add(JSON.stringify(value).slice(1, -1));
  exactSecrets.add(encodeURIComponent(value));
}

/** Parse the designated credential file, never source it or modify process.env. */
export async function loadSafetySecrets(envFile: string): Promise<void> {
  for (const [name, value] of Object.entries(process.env)) {
    if (value && secretName.test(name)) registerSecret(value);
  }
  let contents: string;
  try {
    contents = await readFile(expandPath(envFile), 'utf8');
  } catch (error) {
    // Missing Hindsight credentials must not disable independent public sources.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new SanitizationError();
  }
  for (const [name, value] of Object.entries(parse(contents))) {
    if (secretName.test(name)) registerSecret(value);
  }
}

const unsafePatterns = [
  /-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----/i,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{16})\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /\b(?:authorization|proxy-authorization)\s*["']?\s*[:=]\s*["']?(?:bearer|basic)\s+\S+/i,
  /\b(?:bearer\s+[A-Za-z0-9._~+\/-]{16,}|(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password|passwd|HINDSIGHT_API_TOKEN)\s*["']?\s*[:=]\s*["']?[^\s"',;}]{4,})/i,
  /https?:\/\/[^\s/@]+:[^\s/@]+@/i,
  /[?&](?:token|api_key|key|secret|password|signature|sig|access_token|auth)=[^\s&#"']+/i,
  /\b(?:confidential|under (?:an? )?NDA|non-disclosure|internal[- ]only|not for (?:publication|distribution)|do not (?:publish|share|disclose)|private (?:customer|client|employee) (?:data|records)|trade secret)\b/i,
  /\b(?:customer|client|patient|employee)[ -]?(?:email|phone|address|record|identity|identifier|SSN)\s*[:=]/i,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /\b\d{3}-\d{2}-\d{4}\b/,
  /\b(?:memory|hindsight|artifact|agent|history):\/\//i,
  /https?:\/\/hindsight\.vza\.net(?:[\/:?#]|$)/i,
  /["'](?:access_token|refresh_token|raw_memories|memory_chunks|raw_prompt|system_prompt|api_secret)["']\s*:/i,
  /(?:^|\n|\\n)\s*(?:data: \{["'](?:choices|type)["']|-----BEGIN (?:RAW |SESSION |MEMORY )?DUMP)/i,
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/,
];

/** A conservative publication gate, not a claim that regex detects all secrets.
 * Safe text is unchanged so exact draft quotations remain verifiable. A suspect
 * candidate is withheld wholesale rather than guessed-at partial redaction.
 */
export function sanitize(text: string): string {
  const normalized = text.normalize('NFKC');
  for (const secret of exactSecrets) {
    if (text.includes(secret) || normalized.includes(secret.normalize('NFKC'))) throw new SanitizationError();
  }
  if (unsafePatterns.some(pattern => pattern.test(text) || pattern.test(normalized))) throw new SanitizationError();
  return text;
}

/** Error bodies are untrusted too: expose a bounded diagnostic, never raw JSON. */
export function sanitizeError(error: unknown): string {
  if (error instanceof SanitizationError) return error.message;
  if (!(error instanceof Error)) return 'Operation failed; response details withheld';
  const message = error.message.split('\n', 1)[0] ?? '';
  if (!message || message.length > 400 || /[{}]|(?:request|response)\s*(?:body|payload)/i.test(message)) {
    return 'Operation failed; response details withheld';
  }
  try { return sanitize(message); }
  catch { return 'Operation failed; sensitive diagnostic withheld'; }
}
