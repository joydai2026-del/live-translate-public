// Azure AI Translator v3. AZURE_TRANSLATOR_KEY required; AZURE_TRANSLATOR_REGION for regional or multi-service keys.
// API: POST https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&from=en&to=zh-Hans
//      headers Ocp-Apim-Subscription-Key (+ Ocp-Apim-Subscription-Region), body [{"Text": "..."}]
import { checkLang, fetchJson, translateError } from './langs.js';

export const name = 'azure';
const CODES = { en: 'en', zh: 'zh-Hans' };

// 401: bad key or wrong region. 403001: free tier (F0) monthly quota used up. 429: request or character rate limit.
export function kindFor(status, msg, body) {
  if (status === 429 || (status === 403 && Number(body?.error?.code) === 403001)) return 'quota';
  if (status === 401 || status === 403) return 'auth';
  return undefined;
}

export async function translate(text, from, to) {
  checkLang(from, to);
  const key = process.env.AZURE_TRANSLATOR_KEY;
  if (!key) throw translateError('AZURE_TRANSLATOR_KEY is not set', 'auth');
  const u = new URL('https://api.cognitive.microsofttranslator.com/translate');
  u.searchParams.set('api-version', '3.0');
  u.searchParams.set('from', CODES[from]);
  u.searchParams.set('to', CODES[to]);
  const headers = { 'content-type': 'application/json', 'Ocp-Apim-Subscription-Key': key };
  if (process.env.AZURE_TRANSLATOR_REGION) headers['Ocp-Apim-Subscription-Region'] = process.env.AZURE_TRANSLATOR_REGION;
  const j = await fetchJson(u, { method: 'POST', headers, body: JSON.stringify([{ Text: text }]) }, kindFor);
  const t = j?.[0]?.translations?.[0]?.text;
  if (typeof t !== 'string') throw new Error('azure: bad response');
  return t;
}
