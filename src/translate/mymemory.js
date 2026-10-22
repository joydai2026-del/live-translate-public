// MyMemory free API: no key required, rate limited. Optional MYMEMORY_EMAIL raises the daily quota.
// Docs: https://mymemory.translated.net/doc/spec.php (GET /get?q=...&langpair=en|zh-CN, q max 500 bytes)
import { checkLang, fetchJson, chunkText, translateError } from './langs.js';

export const name = 'mymemory';
const CODES = { en: 'en', zh: 'zh-CN' };

async function one(q, from, to) {
  const u = new URL('https://api.mymemory.translated.net/get');
  u.searchParams.set('q', q);
  u.searchParams.set('langpair', `${CODES[from]}|${CODES[to]}`);
  if (process.env.MYMEMORY_EMAIL) u.searchParams.set('de', process.env.MYMEMORY_EMAIL);
  const j = await fetchJson(u);
  const status = Number(j?.responseStatus);
  const t = j?.responseData?.translatedText;
  if (status !== 200 || typeof t !== 'string') {
    const detail = String(j?.responseDetails || status).slice(0, 200);
    throw translateError(`mymemory: ${detail}`, status === 429 || QUOTA_TEXT.test(detail) ? 'quota' : 'other');
  }
  return decodeEntities(t);
}

// MyMemory reports a used-up quota in responseDetails (sometimes with HTTP 200).
const QUOTA_TEXT = /quota|USED ALL AVAILABLE FREE TRANSLATIONS|limit (reached|exceeded)/i;

// MyMemory sometimes returns HTML entities in translatedText. Decoded in one pass, so "&amp;lt;" stays "&lt;".
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decodeEntities(s) {
  return s.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|(amp|lt|gt|quot|apos|nbsp));/gi, (m, dec, hex, name) => {
    if (name) return NAMED[name.toLowerCase()];
    const cp = dec ? Number(dec) : parseInt(hex, 16);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : m;
  });
}

export async function translate(text, from, to) {
  checkLang(from, to);
  const out = [];
  for (const piece of chunkText(text, 480)) out.push(await one(piece.trim(), from, to));
  return out.join(to === 'zh' ? '' : ' ');
}
