import test from 'node:test';
import assert from 'node:assert/strict';
import * as mymemory from '../src/translate/mymemory.js';
import * as libre from '../src/translate/libretranslate.js';
import * as deepl from '../src/translate/deepl.js';
import * as google from '../src/translate/google.js';
import * as mock from '../src/translate/mock.js';
import { getTranslator } from '../src/translate/index.js';
import { chunkText } from '../src/translate/langs.js';

// No network: stub global fetch and record requests.
function stub(response, status = 200) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(typeof response === 'function' ? response(calls.length) : response), { status });
  };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}
function withEnv(vars, fn) {
  const old = {};
  for (const k of Object.keys(vars)) { old[k] = process.env[k]; if (vars[k] == null) delete process.env[k]; else process.env[k] = vars[k]; }
  return fn().finally(() => { for (const k of Object.keys(old)) { if (old[k] == null) delete process.env[k]; else process.env[k] = old[k]; } });
}

test('mymemory request shape and error handling', async () => {
  const f = stub({ responseStatus: 200, responseData: { translatedText: '你好' } });
  try {
    assert.equal(await mymemory.translate('Hello', 'en', 'zh'), '你好');
    const u = new URL(f.calls[0].url);
    assert.equal(u.host, 'api.mymemory.translated.net');
    assert.equal(u.searchParams.get('langpair'), 'en|zh-CN');
    assert.equal(u.searchParams.get('q'), 'Hello');
  } finally { f.restore(); }
  const g = stub({ responseStatus: 429, responseDetails: 'QUOTA' });
  try { await assert.rejects(mymemory.translate('Hello', 'en', 'zh'), /QUOTA/); } finally { g.restore(); }
});

test('mymemory chunks long text under 500 bytes', async () => {
  const f = stub((n) => ({ responseStatus: 200, responseData: { translatedText: 'p' + n } }));
  try {
    const text = 'This is a sentence. '.repeat(60);
    const out = await mymemory.translate(text, 'en', 'zh');
    assert.ok(f.calls.length > 1);
    for (const c of f.calls) assert.ok(Buffer.byteLength(new URL(c.url).searchParams.get('q')) <= 500);
    assert.match(out, /^p1p2/);
  } finally { f.restore(); }
  for (const piece of chunkText('火'.repeat(400), 480)) assert.ok(Buffer.byteLength(piece) <= 480);
});

test('libretranslate uses LIBRETRANSLATE_URL', () => withEnv({ LIBRETRANSLATE_URL: 'http://lt.local:5000', LIBRETRANSLATE_API_KEY: null }, async () => {
  const f = stub({ translatedText: 'Hello' });
  try {
    assert.equal(await libre.translate('你好', 'zh', 'en'), 'Hello');
    assert.equal(f.calls[0].url, 'http://lt.local:5000/translate');
    assert.deepEqual(JSON.parse(f.calls[0].init.body), { q: '你好', source: 'zh', target: 'en', format: 'text' });
  } finally { f.restore(); }
}));

test('deepl picks free endpoint for :fx keys', () => withEnv({ DEEPL_API_KEY: 'abc:fx' }, async () => {
  const f = stub({ translations: [{ text: '你好' }] });
  try {
    assert.equal(await deepl.translate('Hello', 'en', 'zh'), '你好');
    assert.equal(f.calls[0].url, 'https://api-free.deepl.com/v2/translate');
    assert.equal(f.calls[0].init.headers.authorization, 'DeepL-Auth-Key abc:fx');
    assert.equal(JSON.parse(f.calls[0].init.body).target_lang, 'ZH-HANS');
  } finally { f.restore(); }
}));

test('google v2 request shape; missing keys reject', () => withEnv({ GOOGLE_TRANSLATE_API_KEY: 'k1', DEEPL_API_KEY: null }, async () => {
  const f = stub({ data: { translations: [{ translatedText: 'Hello' }] } });
  try {
    assert.equal(await google.translate('你好', 'zh', 'en'), 'Hello');
    assert.equal(new URL(f.calls[0].url).searchParams.get('key'), null);
    assert.equal(new Headers(f.calls[0].init.headers).get('x-goog-api-key'), 'k1');
    assert.equal(JSON.parse(f.calls[0].init.body).source, 'zh-CN');
  } finally { f.restore(); }
  await assert.rejects(deepl.translate('Hello', 'en', 'zh'), /DEEPL_API_KEY/);
}));

test('http errors surface as rejections', async () => {
  const f = stub({ error: { message: 'bad key' } }, 403);
  try { await withEnv({ GOOGLE_TRANSLATE_API_KEY: 'k' }, () => assert.rejects(google.translate('x', 'en', 'zh'), /403.*bad key/)); } finally { f.restore(); }
});

test('index selects provider and rejects unknown', async () => {
  assert.equal(getTranslator('mock'), getTranslator('MOCK'));
  assert.equal(getTranslator('mymemory').name, 'mymemory');
  assert.throws(() => getTranslator('nope'), /unknown TRANSLATOR/);
  assert.equal(await mock.translate('Unknown words', 'en', 'zh'), '[zh] Unknown words');
  for (const [t, f, to] of [['Hello, nice to meet you.', 'en', 'zh'], ['Where is the train station?', 'en', 'zh'], ['火车站在前面。', 'zh', 'en'], ['Thank you very much.', 'en', 'zh'], ['不客气。', 'zh', 'en']]) {
    assert.ok(!(await mock.translate(t, f, to)).startsWith('['), t);
  }
});
