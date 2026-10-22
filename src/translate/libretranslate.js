// LibreTranslate (self-hostable). LIBRETRANSLATE_URL required, LIBRETRANSLATE_API_KEY optional.
// API: POST {url}/translate {q, source, target, format, api_key} -> {translatedText}
import { checkLang, fetchJson, translateError } from './langs.js';

export const name = 'libretranslate';
// Simplified Chinese is "zh" on older servers and "zh-Hans" on newer ones; override if needed.
const CODES = () => ({ en: 'en', zh: process.env.LIBRETRANSLATE_ZH || 'zh' });

// 429: slow down / quota; 400 or 403 mentioning the API key: auth.
export function kindFor(status, msg) {
  if (status === 429) return 'quota';
  if ((status === 400 || status === 403) && /api[ _]?key/i.test(msg)) return 'auth';
  return undefined;
}

export async function translate(text, from, to) {
  checkLang(from, to);
  const base = process.env.LIBRETRANSLATE_URL;
  if (!base) throw translateError('LIBRETRANSLATE_URL is not set', 'auth');
  const body = { q: text, source: CODES()[from], target: CODES()[to], format: 'text' };
  if (process.env.LIBRETRANSLATE_API_KEY) body.api_key = process.env.LIBRETRANSLATE_API_KEY;
  const j = await fetchJson(new URL('translate', base.endsWith('/') ? base : base + '/'), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }, kindFor);
  if (typeof j?.translatedText !== 'string') throw new Error('libretranslate: bad response');
  return j.translatedText;
}
