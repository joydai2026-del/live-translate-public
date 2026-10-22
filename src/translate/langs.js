// Shared helpers for HTTP translation providers.
export const TIMEOUT_MS = Number(process.env.TRANSLATE_TIMEOUT_MS) || 8000;

export function checkLang(from, to) {
  const ok = new Set(['en', 'zh']);
  if (!ok.has(from) || !ok.has(to)) throw new Error(`unsupported language pair ${from}->${to}`);
}

// Errors carry `kind` so the server can tell the host why a line was not translated.
export const ERROR_KINDS = ['quota', 'auth', 'timeout', 'other'];
export function translateError(message, kind = 'other', extra = {}) {
  return Object.assign(new Error(message), { kind: ERROR_KINDS.includes(kind) ? kind : 'other' }, extra);
}

// `kindFor(status, message, body)` lets each provider classify its HTTP errors; default: 429 is quota.
export async function fetchJson(url, init = {}, kindFor = () => undefined) {
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    throw translateError(timeout ? `timed out after ${TIMEOUT_MS} ms` : `network error: ${e?.message || e}`, timeout ? 'timeout' : 'other');
  }
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON error body */ }
  if (!res.ok) {
    const raw = body && (body.error?.message || body.error || body.message || body.responseDetails);
    const msg = raw ? String(typeof raw === 'string' ? raw : JSON.stringify(raw)).slice(0, 200) : '';
    const kind = kindFor(res.status, msg, body) || (res.status === 429 ? 'quota' : 'other');
    throw translateError(`HTTP ${res.status}${msg ? `: ${msg}` : ''}`, kind, { status: res.status });
  }
  return body;
}

// Split long text into pieces of at most maxBytes UTF-8 bytes, preferring sentence boundaries.
export function chunkText(text, maxBytes) {
  const bytes = (s) => Buffer.byteLength(s, 'utf8');
  if (bytes(text) <= maxBytes) return [text];
  const parts = text.match(/[^.!?。！？]+[.!?。！？]*\s*/g) || [text];
  const out = [];
  let cur = '';
  for (const p of parts) {
    if (bytes(cur + p) <= maxBytes) { cur += p; continue; }
    if (cur) out.push(cur);
    cur = '';
    if (bytes(p) <= maxBytes) { cur = p; continue; }
    let piece = '';
    for (const ch of p) {
      if (bytes(piece + ch) > maxBytes) { out.push(piece); piece = ''; }
      piece += ch;
    }
    cur = piece;
  }
  if (cur) out.push(cur);
  return out;
}
