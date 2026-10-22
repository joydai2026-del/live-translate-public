import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
import { RoomStore, RateLimiter } from '../src/rooms.js';
import { encodeQR } from '../src/qr.js';

async function up(translator, store) {
  const s = createServer({ translator, store });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { s, b: `http://127.0.0.1:${s.address().port}` };
}
const post = (u, b) => fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
const echo = { translate: async (t, f, to) => `[${to}]${t}` };

test('translator failure saves segment with null translation and error flag', async () => {
  const { s, b } = await up({ translate: async () => { throw new Error('boom'); } });
  try {
    const { code, hostToken } = await (await post(b + '/api/rooms', { direction: 'en-zh' })).json();
    const r = await post(`${b}/api/rooms/${code}/segments`, { hostToken, text: 'Hello', lang: 'en', final: true });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.translation, null);
    assert.equal(j.error, true);
    const t = await (await fetch(`${b}/api/rooms/${code}/transcript?format=json&token=${hostToken}`)).json();
    assert.equal(t.segments.length, 1);
    assert.equal(t.segments[0].error, true);
    assert.match(await (await fetch(`${b}/api/rooms/${code}/transcript?format=txt&token=${hostToken}`)).text(), /translation unavailable/);
  } finally { s.close(); }
});

test('validation: directions, lang, bad json, lowercase code lookup, zh-en room', async () => {
  const { s, b } = await up(echo);
  try {
    assert.equal((await post(b + '/api/rooms', { direction: 'fr-de' })).status, 400);
    const { code, hostToken } = await (await post(b + '/api/rooms', { direction: 'zh-en' })).json();
    assert.equal((await fetch(`${b}/api/rooms/${code.toLowerCase()}`)).status, 200);
    assert.equal((await post(`${b}/api/rooms/${code}/segments`, { hostToken, text: 'hi', lang: 'en', final: true })).status, 400);
    assert.equal((await post(`${b}/api/rooms/${code}/segments`, { hostToken, text: 'hi', lang: 'fr', final: true })).status, 400);
    assert.equal((await post(`${b}/api/rooms/${code}/segments`, { hostToken, text: '   ', lang: 'zh', final: true })).status, 400);
    const bad = await fetch(`${b}/api/rooms/${code}/segments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
    assert.equal(bad.status, 400);
    const z = await (await post(`${b}/api/rooms/${code}/segments`, { hostToken, text: '你好', lang: 'zh', final: true })).json();
    assert.equal(z.translation, '[en]你好');
    assert.equal((await fetch(`${b}/api/rooms/${code}/transcript?format=pdf`)).status, 400);
  } finally { s.close(); }
});

test('rate limit returns 429 after burst', async () => {
  const { s, b } = await up(echo);
  try {
    const { code, hostToken } = await (await post(b + '/api/rooms', { direction: 'both' })).json();
    const statuses = [];
    for (let i = 0; i < 30; i++) statuses.push((await post(`${b}/api/rooms/${code}/segments`, { hostToken, text: 'x' + i, lang: 'en', final: false })).status);
    assert.ok(statuses.slice(0, 15).every((x) => x === 200));
    assert.ok(statuses.includes(429));
  } finally { s.close(); }
});

test('rate limiter refills over time', () => {
  let t = 0;
  const rl = new RateLimiter(5, 2, () => t);
  assert.ok(rl.take() && rl.take());
  assert.equal(rl.take(), false);
  t += 200;
  assert.ok(rl.take());
});

test('rooms expire after idle time', async () => {
  let now = 1000;
  const store = new RoomStore({ idleMs: 5000, now: () => now });
  const room = store.create('both');
  assert.ok(store.get(room.code));
  now += 4000;
  store.touch(room);
  now += 4000;
  assert.ok(store.get(room.code));
  now += 6000;
  assert.equal(store.get(room.code), null);
  assert.equal(store.rooms.size, 0);
});

test('SSE: interim events have no id, Last-Event-ID skips seen backlog', async () => {
  const { s, b } = await up(echo);
  try {
    const { code, hostToken } = await (await post(b + '/api/rooms', { direction: 'both' })).json();
    for (const t of ['one', 'two', 'three']) await post(`${b}/api/rooms/${code}/segments`, { hostToken, text: t, lang: 'en', final: true });
    const ac = new AbortController();
    const res = await fetch(`${b}/api/rooms/${code}/events`, { signal: ac.signal, headers: { 'last-event-id': '2' } });
    const rd = res.body.getReader();
    let buf = '';
    const until = async (re) => { while (!re.test(buf)) buf += new TextDecoder().decode((await rd.read()).value); };
    await until(/three/);
    assert.ok(!buf.includes('"one"') && !buf.includes('"two"'));
    await post(`${b}/api/rooms/${code}/segments`, { hostToken, text: 'fou', lang: 'en', final: false });
    await until(/fou/);
    const blk = buf.split('\n\n').find((x) => x.includes('"fou"'));
    assert.ok(!/^id:/m.test(blk));
    assert.match(blk, /"id":4/);
    ac.abort();
  } finally { s.close(); }
});

test('pages served with CSP, traversal blocked, unknown api 404', async () => {
  const { s, b } = await up(echo);
  try {
    for (const p of ['/', '/join', '/host/ABC234', '/j/ABC234']) {
      const r = await fetch(b + p);
      assert.equal(r.status, 200, p);
      assert.match(r.headers.get('content-type'), /html/);
      assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
    }
    assert.equal((await fetch(b + '/%2e%2e/package.json')).status, 404);
    assert.equal((await fetch(b + '/..%2fsrc%2fserver.js')).status, 404);
    assert.equal((await fetch(b + '/api/nope')).status, 404);
  } finally { s.close(); }
});

test('qr matrix has finder patterns and grows with data', () => {
  const m = encodeQR('http://127.0.0.1:3000/j/ABC234');
  assert.equal(m.length % 4, 1);
  for (const [x, y] of [[0, 0], [m.length - 7, 0], [0, m.length - 7]]) {
    assert.ok(m[y][x] && m[y + 6][x + 6] && m[y + 3][x + 3] && !m[y + 1][x + 1]);
  }
  assert.ok(encodeQR('x'.repeat(300)).length > m.length);
});
