// Google Cloud Translation v2 (Basic) REST. GOOGLE_TRANSLATE_API_KEY required (paid).
// API: POST https://translation.googleapis.com/language/translate/v2 {q, source, target, format}. The key goes in the
// x-goog-api-key header, never in the URL (proxies and egress logs record URLs).
import { checkLang, fetchJson, translateError } from './langs.js';

export const name = 'google';
const CODES = { en: 'en', zh: 'zh-CN' };

// Google answers 403 both for exhausted quotas (reason dailyLimitExceeded, rateLimitExceeded, ...) and for key
// problems; an invalid key is a 400 "API key not valid".
export function kindFor(status, msg, body) {
  const reasons = (body?.error?.errors || []).map((e) => e?.reason).concat(body?.error?.details?.map((d) => d?.reason) || []).join(' ');
  if (status === 429 || ((status === 403 || status === 400) && /quota|rate ?limit|limitexceeded/i.test(`${reasons} ${msg}`))) return 'quota';
  if (status === 401 || status === 403 || (status === 400 && /api key/i.test(msg))) return 'auth';
  return undefined;
}

export async function translate(text, from, to) {
  checkLang(from, to);
  const key = process.env.GOOGLE_TRANSLATE_API_KEY;
  if (!key) throw translateError('GOOGLE_TRANSLATE_API_KEY is not set', 'auth');
  const j = await fetchJson('https://translation.googleapis.com/language/translate/v2', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ q: text, source: CODES[from], target: CODES[to], format: 'text' }),
  }, kindFor);
  const t = j?.data?.translations?.[0]?.translatedText;
  if (typeof t !== 'string') throw new Error('google: bad response');
  return t;
}
