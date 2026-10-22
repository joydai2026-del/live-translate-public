import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
import { RoomStore, Room, KeyedLimiter, RateLimiter } from '../src/rooms.js';
import { configWarnings } from '../src/translate/index.js';
import * as google from '../src/translate/google.js';
import * as libre from '../src/translate/libretranslate.js';
import * as mymemory from '../src/translate/mymemory.js';

const post = (u, b, headers = {}) => fetch(u, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(b) });
async function up(opts = {}) {
  const s = createServer({ translator: { translate: async (t, f, to) => `[${to}]${t}` }, ...opts });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { s, b: `http://127.0.0.1:${s.address().port}` };
}
function stubFetch(handler) {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => handler(String(url), init);
  return () => { globalThis.fetch = orig; };
}
const jsonRes = (o, status = 200) => new Response(JSON.stringify(o), { status });

test('KeyedLimiter: per-key buckets, idle keys swept, map stays bounded', () => {
  let t = 0;
  const kl = new KeyedLimiter(1, 2, () => t, 3);
  assert.ok(kl.take('a') && kl.take('a'));
  assert.equal(kl.take('a'), false);
  assert.ok(kl.take('b'));
  t += 5000; // both refilled: sweeping drops them
  kl.sweep();
  assert.equal(kl.map.size, 0);
  for (const k of ['a', 'b', 'c', 'd', 'e']) kl.take(k);
  assert.ok(kl.map.size <= 3);
});

test('RateLimiter.idle is true only once the bucket is full again', () => {
  let t = 0;
  const rl = new RateLimiter(1, 2, () => t);
  rl.take();
  assert.equal(rl.idle(), false);
  t += 1000;
  assert.equal(rl.idle(), true);
});

test('Room: interim and final buckets are separate and use the store clock', () => {
  let t = 0;
  const room = new Room('ABCDEF', 'both', () => t);
  while (room.interimLimiter.take());
  assert.ok(room.finalLimiter.take(), 'finals must not share the interim bucket');
  const store = new RoomStore({ now: () => t });
  const r2 = store.create('both');
  while (r2.finalLimiter.take());
  t += 1000;
  assert.ok(r2.finalLimiter.take(), 'injected clock refills the bucket');
});

test('DELETE room: missing body or token is 403, text/plain body is 415', async () => {
  const { s, b } = await up();
  try {
    const { code, hostToken } = await (await post(b + '/api/rooms', { direction: 'both' })).json();
    assert.equal((await fetch(`${b}/api/rooms/${code}`, { method: 'DELETE' })).status, 403);
    assert.equal((await fetch(`${b}/api/rooms/${code}`, { method: 'DELETE', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ hostToken }) })).status, 415);
    assert.equal((await fetch(`${b}/api/rooms/${code}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostToken }) })).status, 204);
  } finally { s.close(); }
});

test('TRUST_PROXY=1: X-Forwarded-For first hop is the client IP for limits', async () => {
  process.env.TRUST_PROXY = '1';
  let srv;
  try {
    srv = await up();
    const st = [];
    for (let i = 0; i < 11; i++) st.push((await post(srv.b + '/api/rooms', { direction: 'en-zh' }, { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' })).status);
    assert.equal(st.at(-1), 429);
    assert.equal((await post(srv.b + '/api/rooms', { direction: 'en-zh' }, { 'x-forwarded-for': '203.0.113.8' })).status, 201);
  } finally { delete process.env.TRUST_PROXY; srv?.s.close(); }
  srv = await up();
  try {
    // Without TRUST_PROXY the header is ignored: every request counts against 127.0.0.1.
    const st = [];
    for (let i = 0; i < 11; i++) st.push((await post(srv.b + '/api/rooms', { direction: 'en-zh' }, { 'x-forwarded-for': `198.51.100.${i}` })).status);
    assert.equal(st.at(-1), 429);
  } finally { srv.s.close(); }
});

test('interim validation: empty interim accepted, final:false text too long is 413', async () => {
  const { s, b } = await up();
  try {
    const { code, hostToken } = await (await post(b + '/api/rooms', { direction: 'en-zh' })).json();
    assert.equal((await post(`${b}/api/rooms/${code}/segments`, { hostToken, text: '', lang: 'en', final: false })).status, 200);
    assert.equal((await post(`${b}/api/rooms/${code}/segments`, { hostToken, lang: 'en', final: false })).status, 400);
    assert.equal((await post(`${b}/api/rooms/${code}/segments`, { hostToken, text: 'x'.repeat(2001), lang: 'en', final: false })).status, 413);
  } finally { s.close(); }
});

test('error classification: google, libretranslate, mymemory HTTP 429 and network errors', async () => {
  assert.equal(google.kindFor(403, 'Daily Limit Exceeded', { error: { errors: [{ reason: 'dailyLimitExceeded' }] } }), 'quota');
  assert.equal(google.kindFor(403, 'The caller does not have permission', { error: { errors: [{ reason: 'forbidden' }] } }), 'auth');
  assert.equal(google.kindFor(400, 'API key not valid. Please pass a valid API key.', {}), 'auth');
  assert.equal(google.kindFor(500, 'backend', {}), undefined);
  assert.equal(libre.kindFor(429, 'Too many requests'), 'quota');
  assert.equal(libre.kindFor(403, 'Invalid API key'), 'auth');
  assert.equal(libre.kindFor(400, 'Invalid request'), undefined);
  let restore = stubFetch(async () => { throw new TypeError('fetch failed'); });
  try { await assert.rejects(mymemory.translate('Hi', 'en', 'zh'), (e) => e.kind === 'other'); } finally { restore(); }
  const old = { GOOGLE_TRANSLATE_API_KEY: process.env.GOOGLE_TRANSLATE_API_KEY };
  process.env.GOOGLE_TRANSLATE_API_KEY = 'test';
  restore = stubFetch(async () => jsonRes({ error: { message: 'Quota exceeded', errors: [{ reason: 'rateLimitExceeded' }] } }, 403));
  try { await assert.rejects(google.translate('Hi', 'en', 'zh'), (e) => e.kind === 'quota' && !/test/.test(e.message)); } finally {
    restore();
    if (old.GOOGLE_TRANSLATE_API_KEY == null) delete process.env.GOOGLE_TRANSLATE_API_KEY; else process.env.GOOGLE_TRANSLATE_API_KEY = old.GOOGLE_TRANSLATE_API_KEY;
  }
});

test('mymemory decodes numeric and named entities once', () => {
  assert.equal(mymemory.decodeEntities('&#20320;&#x597D; &lt;b&gt; &amp;lt; &bogus;'), '你好 <b> &lt; &bogus;');
});

test('configWarnings names missing vars, never values', () => {
  assert.match(configWarnings('mymemory', {}).join(' '), /MYMEMORY_EMAIL/);
  assert.deepEqual(configWarnings('mymemory', { MYMEMORY_EMAIL: 'x@example.com' }), []);
  assert.match(configWarnings('google', {}).join(' '), /GOOGLE_TRANSLATE_API_KEY/);
  assert.match(configWarnings('libretranslate', {}).join(' '), /LIBRETRANSLATE_URL/);
  assert.deepEqual(configWarnings('deepl', { DEEPL_API_KEY: 'secret-value' }), []);
});
