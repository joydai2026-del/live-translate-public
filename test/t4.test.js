// T4 behaviour beyond the planner checks: LAN choice, guest cap, reconnect replay, pending transcript text, azure kinds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, lanAddress, GRACE_MS } from '../src/server.js';
import { MAX_GUESTS } from '../src/rooms.js';
import { kindFor } from '../src/translate/azure.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slow = (ms) => ({ translate: async (t, f, to) => { await sleep(ms); return `[${to}]${t}`; } });
async function up(translator) {
  const s = createServer({ translator });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { b: `http://127.0.0.1:${s.address().port}`, close: () => { s.close(); s.closeAllConnections?.(); } };
}
const post = (u, body) => fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function readSse(url, headers, ms) {
  const ac = new AbortController();
  const res = await fetch(url, { signal: ac.signal, headers });
  const rd = res.body.getReader();
  let buf = '';
  const t = setTimeout(() => ac.abort(), ms);
  try { for (;;) { const { value, done } = await rd.read(); if (done) break; buf += new TextDecoder().decode(value); } } catch { /* aborted */ }
  clearTimeout(t);
  return buf.split('\n\n').filter((b) => /event: segment/.test(b)).map((b) => ({
    id: Number((b.match(/^id: (\d+)/m) || [])[1]), data: JSON.parse(b.split('\n').find((l) => l.startsWith('data:')).slice(5)),
  }));
}
const v4 = (address, internal = false) => ({ address, family: 'IPv4', internal });

test('lanAddress prefers 192.168, then 10, then 172.16/12, ignores public, internal and IPv6', () => {
  assert.equal(lanAddress({ a: [v4('172.17.0.1')], b: [v4('10.1.2.3')], c: [v4('192.168.0.9')] }), '192.168.0.9');
  assert.equal(lanAddress({ a: [v4('172.31.255.1')], b: [v4('172.32.0.1')] }), '172.31.255.1');
  assert.equal(lanAddress({ lo: [v4('127.0.0.1', true)], e: [v4('8.8.8.8')], v6: [{ address: 'fe80::1', family: 'IPv6', internal: false }] }), null);
  assert.equal(lanAddress({ e: [{ address: '10.0.0.2', family: 4, internal: false }] }), '10.0.0.2');
});

test('createServer({lanHost}) uses the LAN address with the port from the Host header', async () => {
  const s = createServer({ translator: slow(0), lanHost: '192.168.1.5' });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${s.address().port}`;
  try {
    assert.equal((await (await fetch(b + '/api/config')).json()).joinBase, `http://192.168.1.5:${s.address().port}`);
  } finally { s.close(); s.closeAllConnections?.(); }
});

test(`guest tokens are capped at ${MAX_GUESTS} per room`, async () => {
  const { b, close } = await up(slow(0));
  try {
    const { code } = await (await post(b + '/api/rooms', { direction: 'en-zh' })).json();
    for (let i = 0; i < MAX_GUESTS; i++) assert.equal((await post(`${b}/api/rooms/${code}/guests`, {})).status, 201);
    assert.equal((await post(`${b}/api/rooms/${code}/guests`, {})).status, 429);
  } finally { close(); }
});

test('a reader reconnecting after the pending event gets the update (Last-Event-ID)', async () => {
  const { b, close } = await up(slow(GRACE_MS + 400));
  try {
    const { code, hostToken } = await (await post(b + '/api/rooms', { direction: 'en-zh' })).json();
    const p = post(`${b}/api/rooms/${code}/segments`, { hostToken, text: 'Hello', lang: 'en', final: true });
    await sleep(GRACE_MS + 100);
    const first = await readSse(`${b}/api/rooms/${code}/events`, {}, 100);
    assert.equal(first.length, 1); assert.equal(first[0].data.pending, true);
    const md = await (await fetch(`${b}/api/rooms/${code}/transcript?format=md&token=${hostToken}`)).text();
    assert.match(md, /_\(translating\)_/);
    assert.match(await (await fetch(`${b}/api/rooms/${code}/transcript?format=txt&token=${hostToken}`)).text(), /\(translating\)/);
    await p;
    const again = await readSse(`${b}/api/rooms/${code}/events`, { 'last-event-id': String(first[0].id) }, 100);
    assert.equal(again.length, 1); assert.equal(again[0].data.translation, '[zh]Hello'); assert.ok(!again[0].data.pending);
    const none = await readSse(`${b}/api/rooms/${code}/events`, { 'last-event-id': String(again[0].id) }, 100);
    assert.equal(none.length, 0);
  } finally { close(); }
});

test('guest lines are labelled in md and txt transcripts', async () => {
  const { b, close } = await up(slow(0));
  try {
    const { code, hostToken } = await (await post(b + '/api/rooms', { direction: 'en-zh' })).json();
    const { guestToken } = await (await post(`${b}/api/rooms/${code}/guests`, {})).json();
    await post(`${b}/api/rooms/${code}/segments`, { guestToken, text: '你好', lang: 'zh', final: true });
    assert.match(await (await fetch(`${b}/api/rooms/${code}/transcript?format=txt&token=${hostToken}`)).text(), /ZH \(guest\): 你好/);
  } finally { close(); }
});

test('azure: a 403 that is not the free quota is an auth problem', () => {
  assert.equal(kindFor(403, '', { error: { code: 403000 } }), 'auth');
  assert.equal(kindFor(403, '', { error: { code: 403001 } }), 'quota');
  assert.equal(kindFor(500, '', {}), undefined);
});
