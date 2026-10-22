// Picks a translation provider by name (env TRANSLATOR, default mymemory).
import * as mock from './mock.js';
import * as mymemory from './mymemory.js';
import * as libretranslate from './libretranslate.js';
import * as deepl from './deepl.js';
import * as google from './google.js';
import * as azure from './azure.js';

export const providers = { mock, mymemory, libretranslate, deepl, google, azure };

export function getTranslator(name = process.env.TRANSLATOR || 'mymemory') {
  const p = providers[String(name).toLowerCase()];
  if (!p) throw new Error(`unknown TRANSLATOR "${name}" (choose: ${Object.keys(providers).join(', ')})`);
  return p;
}

// Startup hints about missing configuration. Names env vars only, never their values.
export function configWarnings(name = process.env.TRANSLATOR || 'mymemory', env = process.env) {
  const out = [];
  const n = String(name).toLowerCase();
  if (n === 'mymemory' && !env.MYMEMORY_EMAIL) out.push('MYMEMORY_EMAIL is not set. MyMemory\'s anonymous daily quota is small and shared by every room on this server\'s IP. Set MYMEMORY_EMAIL to raise it, or use a keyed provider with a free tier (TRANSLATOR=azure or TRANSLATOR=deepl).');
  const need = { deepl: 'DEEPL_API_KEY', google: 'GOOGLE_TRANSLATE_API_KEY', azure: 'AZURE_TRANSLATOR_KEY', libretranslate: 'LIBRETRANSLATE_URL' }[n];
  if (need && !env[need]) out.push(`TRANSLATOR=${n} but ${need} is not set, so every line will be saved without a translation.`);
  return out;
}
