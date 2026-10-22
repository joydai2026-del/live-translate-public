// DeepL API. DEEPL_API_KEY required; keys ending in ":fx" use the free endpoint.
// API: POST /v2/translate, header "Authorization: DeepL-Auth-Key <key>", JSON {text:[...], source_lang, target_lang}
import { checkLang, fetchJson, translateError } from './langs.js';

export const name = 'deepl';
const SOURCE = { en: 'EN', zh: 'ZH' };
const TARGET = { en: 'EN-US', zh: 'ZH-HANS' };

// 456: character quota used up; 403: bad or missing key.
const kindFor = (status) => ({ 456: 'quota', 429: 'quota', 401: 'auth', 403: 'auth' })[status];

export async function translate(text, from, to) {
  checkLang(from, to);
  const key = process.env.DEEPL_API_KEY;
  if (!key) throw translateError('DEEPL_API_KEY is not set', 'auth');
  const host = key.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
  const j = await fetchJson(`${host}/v2/translate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `DeepL-Auth-Key ${key}` },
    body: JSON.stringify({ text: [text], source_lang: SOURCE[from], target_lang: TARGET[to] }),
  }, kindFor);
  const t = j?.translations?.[0]?.text;
  if (typeof t !== 'string') throw new Error('deepl: bad response');
  return t;
}
