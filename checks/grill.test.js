// PLANNER-OWNED. Do not edit. Acceptance tests for the "Top 8 changes" in docs/GRILL.md (task brief: tasks/T4-grill.md).
// Server-side and file checks only; browser behaviour lives in checks/grill_e2e.mjs (run by checks/slow.sh).
// No network: loopback only, stubbed fetch for providers, `node --import checks/fixtures/fake-ifaces.mjs` to fake NICs.
// Scope note: items already covered by checks/review-R1.test.js (errorKind, quota banner, startup warnings for
// mymemory/deepl, DELETE 204, 404 lookup limit, wake lock, Chinese waiting text) are not repeated here.
//
// NEW INTERFACES these tests rely on (also specified in tasks/T4-grill.md):
// G1  Finals: if the translation is not ready within 250 ms, the server broadcasts `segment` {id, lang, text,
//     translation:null, final:true, pending:true} at once and later broadcasts `segment` again with the SAME id and
//     the translation (or translation:null, error:true, errorKind). A translation ready within the grace window is
//     broadcast once, without pending. Finals are stored (transcript, backlog) at once, in id order, with pending:true
//     until translated. The POST response still waits for the translation: {id, text, translation[, error, errorKind]}.
// G2  `node src/server.js` with PUBLIC_URL unset: when a request's Host is localhost, 127.x or [::1], joinBase (config,
//     QR, host link) is http://<LAN IPv4>:<port of the Host header>. LAN IPv4 = non-internal private IPv4 from
//     os.networkInterfaces(), preferring 192.168/16, then 10/8, then 172.16/12. No private address -> request host.
//     The startup log prints the LAN join URL. PUBLIC_URL always wins. Requests to a non-local Host use that host.
// G3  POST /api/rooms/:code/guests {} -> 201 {guestToken}. POST segments accepts {guestToken, ...} instead of
//     hostToken. Guest lang: en-zh room -> zh only, zh-en room -> en only, both -> either (else 400). Host rules are
//     unchanged (host zh in an en-zh room is still 400). Bad guestToken -> 403. Segments carry speaker:'host'|'guest'
//     in SSE and transcript json.
// G5  src/translate/azure.js (name 'azure', registered in index.js). Env AZURE_TRANSLATOR_KEY (required) and
//     AZURE_TRANSLATOR_REGION (optional). POST https://api.cognitive.microsofttranslator.com/translate?api-version=3.0
//     &from=<en|zh-Hans>&to=<zh-Hans|en>, headers Ocp-Apim-Subscription-Key and (if set) Ocp-Apim-Subscription-Region,
//     body [{"Text": text}]. Errors carry err.kind: missing key or 401 -> auth, 429 or 403 with error.code 403001 ->
//     quota. Startup warns naming AZURE_TRANSLATOR_KEY when TRANSLATOR=azure lacks it.
//     On-device translation: a final POST may include `translation` (string, <= 4000 chars, else 413; non-string 400);
//     the server stores and broadcasts it and does NOT call the translator. Ignored for interims.
// G7  SSE `event: presence` data {readers:N}: N = open event streams of the room except those opened with
//     ?role=host. Sent to every stream on connect and whenever N changes.
// G8  POST /api/rooms also returns readToken. GET transcript requires ?token=<hostToken|readToken>, else 403.
//     DELETE /api/rooms/:code sends `event: end` to every stream before closing it. Privacy copy also names Apple.
import test from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import http from 'node:http'; import net from 'node:net'; import { spawn } from 'node:child_process';
import { createServer } from '../src/server.js'; import { qrSvg } from '../src/qr.js';

for (const k of ['PUBLIC_URL', 'TRUST_PROXY', 'TRANSLATE_DAILY_CHAR_LIMIT', 'AZURE_TRANSLATOR_KEY', 'AZURE_TRANSLATOR_REGION']) delete process.env[k];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000, step = 20) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return v; await sleep(step); } }
const echo = () => { const calls = []; return { calls, translate: async (t, f, to) => { calls.push([t, f, to]); return `[${to}]${t}`; } }; };
const slow = (ms, fail) => { const calls = []; return { calls, translate: async (t, f, to) => { calls.push([t, f, to]); await sleep(ms); if (fail) throw Object.assign(new Error('slow and failed'), { kind: fail }); return `[${to}]${t}`; } }; };

async function up({ translator = echo(), ...opts } = {}) {
  const s = createServer({ translator, ...opts });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { s, translator, b: `http://127.0.0.1:${s.address().port}`, close: () => { s.close(); s.closeAllConnections?.(); } };
}
// node:http client: independent of global fetch (which some tests stub).
function req(method, url, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const h = { ...(body !== undefined && typeof body !== 'string' ? { 'content-type': 'application/json' } : {}), ...headers };
    if (data !== undefined) h['content-length'] = Buffer.byteLength(data);
    const r = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: h, agent: false }, (res) => {
      const ch = []; res.on('data', (d) => ch.push(d));
      res.on('end', () => { const text = Buffer.concat(ch).toString(); let json; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, text, json }); });
    });
    r.on('error', reject); if (data !== undefined) r.write(data); r.end();
  });
}
const room = async (b, direction = 'both') => (await req('POST', b + '/api/rooms', { body: { direction } })).json;
const seg = (b, code, body) => req('POST', `${b}/api/rooms/${code}/segments`, { body });
const guest = async (b, code) => req('POST', `${b}/api/rooms/${code}/guests`, { body: {} });
const transcript = async (b, code, token) => (await req('GET', `${b}/api/rooms/${code}/transcript?format=json&token=${encodeURIComponent(token)}`)).json?.segments || [];
// SSE client that keeps every event type: {event, data, t}.
function sse(url) {
  const out = { all: [], ended: false };
  const u = new URL(url);
  out.req = http.get({ host: u.hostname, port: u.port, path: u.pathname + u.search, agent: false }, (res) => {
    let buf = ''; res.setEncoding('utf8');
    res.on('data', (d) => {
      buf += d; let k;
      while ((k = buf.indexOf('\n\n')) >= 0) {
        const blk = buf.slice(0, k); buf = buf.slice(k + 2);
        const ev = (blk.split('\n').find((l) => l.startsWith('event:')) || 'event: message').slice(6).trim();
        const line = blk.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue; let data; try { data = JSON.parse(line.slice(5)); } catch { data = line.slice(5).trim(); }
        out.all.push({ event: ev, data, t: Date.now() });
      }
    });
    res.on('end', () => { out.ended = true; }); res.on('close', () => { out.ended = true; });
  });
  out.req.on('error', () => { out.ended = true; });
  out.segs = () => out.all.filter((e) => e.event === 'segment').map((e) => e.data);
  out.close = () => out.req.destroy();
  return out;
}
function stubFetch(handler) {
  const orig = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, init = {}) => { calls.push({ url: String(url), init }); return handler(String(url), init); };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}
const jsonRes = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
async function withEnv(vars, fn) {
  const old = {};
  for (const k of Object.keys(vars)) { old[k] = process.env[k]; if (vars[k] == null) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return await fn(); } finally { for (const k of Object.keys(old)) { if (old[k] == null) delete process.env[k]; else process.env[k] = old[k]; } }
}
const freePort = () => new Promise((r) => { const t = net.createServer(); t.listen(0, '127.0.0.1', () => { const p = t.address().port; t.close(() => r(p)); }); });
// Runs `node src/server.js` (optionally with faked network interfaces) and returns its port and output.
async function cli({ env = {}, ifaces } = {}) {
  const port = await freePort();
  const e = { ...process.env, PORT: String(port), TRANSLATOR: 'mock' };
  for (const k of ['PUBLIC_URL', 'TRUST_PROXY', 'MYMEMORY_EMAIL', 'DEEPL_API_KEY', 'GOOGLE_TRANSLATE_API_KEY', 'LIBRETRANSLATE_URL', 'AZURE_TRANSLATOR_KEY', 'AZURE_TRANSLATOR_REGION']) delete e[k];
  Object.assign(e, env);
  const args = [];
  if (ifaces) { e.GRILL_FAKE_IFACES = JSON.stringify(ifaces); args.push('--import', new URL('./fixtures/fake-ifaces.mjs', import.meta.url).href); }
  const p = spawn(process.execPath, [...args, 'src/server.js'], { env: e });
  const o = { port, out: '', b: `http://127.0.0.1:${port}`, kill: () => p.kill() };
  p.stdout.on('data', (d) => { o.out += d; }); p.stderr.on('data', (d) => { o.out += d; });
  await until(() => /live-translate on/.test(o.out) || p.exitCode != null, 5000);
  await sleep(150);
  return o;
}
const v4 = (address, internal = false) => ({ address, netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal, cidr: address + '/24' });
const LO = { lo: [v4('127.0.0.1', true), { address: '::1', netmask: 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', family: 'IPv6', mac: '00:00:00:00:00:00', internal: true, cidr: '::1/128', scopeid: 0 }] };

// ================= G1: original first, translation as an update =================
test('G1: a slow translation does not hold back the original (pending broadcast, then same-id update)', async () => {
  const tr = slow(2500); const { b, close } = await up({ translator: tr });
  try {
    const { code, hostToken } = await room(b, 'en-zh');
    const ev = sse(`${b}/api/rooms/${code}/events`); await sleep(150);
    const p1 = seg(b, code, { hostToken, text: 'Line one.', lang: 'en', final: true });
    await sleep(100);
    const t2 = Date.now();
    const p2 = seg(b, code, { hostToken, text: 'Line two.', lang: 'en', final: true });
    p1.catch(() => {}); p2.catch(() => {});
    const two = await until(() => ev.segs().find((s) => s.final && s.text === 'Line two.'), 2000, 10);
    assert.ok(two, 'original of line 2 was not broadcast before the translations finished');
    assert.ok(Date.now() - t2 <= 500, `line 2 original took ${Date.now() - t2} ms (limit 500)`);
    const one = ev.segs().find((s) => s.final && s.text === 'Line one.');
    assert.ok(one, 'line 1 original missing');
    assert.equal(one.translation, null); assert.equal(one.pending, true); assert.ok(!one.error);
    assert.equal(two.translation, null); assert.equal(two.pending, true);
    assert.ok(one.id < two.id, 'ids must follow arrival order');
    assert.ok(!ev.segs().some((s) => s.translation), 'a translation arrived before the 2.5 s delay');
    const mid = await transcript(b, code, hostToken);
    assert.deepEqual(mid.map((s) => [s.text, s.translation, s.pending]), [['Line one.', null, true], ['Line two.', null, true]], 'pending finals must be in the transcript at once, in order');
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1.status, 200); assert.equal(r1.json.translation, '[zh]Line one.', 'POST response keeps returning the translation');
    assert.equal(r2.json.translation, '[zh]Line two.');
    await until(() => ev.segs().filter((s) => s.translation).length >= 2, 2000);
    ev.close();
    const upd = ev.segs().find((s) => s.translation === '[zh]Line one.');
    assert.ok(upd, 'no update event for line 1');
    assert.equal(upd.id, one.id, 'the update must reuse the id'); assert.equal(upd.final, true); assert.ok(!upd.pending);
    for (const id of [one.id, two.id]) assert.equal(ev.segs().filter((s) => s.final && s.id === id).length, 2, `line ${id}: expected pending + update`);
    const end = await transcript(b, code, hostToken);
    assert.deepEqual(end.map((s) => [s.text, s.translation, !!s.pending]), [['Line one.', '[zh]Line one.', false], ['Line two.', '[zh]Line two.', false]]);
  } finally { close(); }
});

test('G1: fast translations still arrive as one segment event each (acceptance checks stay valid)', async () => {
  const { b, close } = await up({ translator: slow(30) });
  try {
    const { code, hostToken } = await room(b, 'en-zh');
    const ev = sse(`${b}/api/rooms/${code}/events`); await sleep(100);
    for (const t of ['One.', 'Two.', 'Three.']) assert.equal((await seg(b, code, { hostToken, text: t, lang: 'en', final: true })).status, 200);
    await sleep(300); ev.close();
    const finals = ev.segs().filter((s) => s.final);
    assert.deepEqual(finals.map((s) => s.text), ['One.', 'Two.', 'Three.']);
    assert.ok(finals.every((s) => s.translation && !s.pending), 'fast translations must not produce a pending event');
  } finally { close(); }
});

test('G1: a slow translation that fails updates the line with error and errorKind', async () => {
  const { b, close } = await up({ translator: slow(1200, 'timeout') });
  try {
    const { code, hostToken } = await room(b, 'en-zh');
    const ev = sse(`${b}/api/rooms/${code}/events`); await sleep(100);
    const p = seg(b, code, { hostToken, text: 'Hello', lang: 'en', final: true }); p.catch(() => {});
    assert.ok(await until(() => ev.segs().find((s) => s.pending), 600, 10), 'no pending broadcast');
    const r = await p;
    assert.equal(r.status, 200); assert.equal(r.json.error, true); assert.equal(r.json.errorKind, 'timeout');
    const upd = await until(() => ev.segs().find((s) => s.final && s.error), 2000);
    ev.close();
    assert.ok(upd, 'no error update broadcast'); assert.equal(upd.translation, null); assert.equal(upd.errorKind, 'timeout'); assert.ok(!upd.pending);
  } finally { close(); }
});

test('G1: a guest joining mid-translation gets the pending line in the backlog, then the update', async () => {
  const { b, close } = await up({ translator: slow(1200) });
  try {
    const { code, hostToken } = await room(b, 'en-zh');
    const p = seg(b, code, { hostToken, text: 'Backlog line.', lang: 'en', final: true }); p.catch(() => {});
    await sleep(400);
    const ev = sse(`${b}/api/rooms/${code}/events`);
    const first = await until(() => ev.segs().find((s) => s.text === 'Backlog line.'), 1000);
    assert.ok(first, 'pending line missing from the backlog'); assert.equal(first.pending, true);
    await p;
    assert.ok(await until(() => ev.segs().find((s) => s.translation === '[zh]Backlog line.'), 2000), 'late joiner never got the update');
    ev.close();
  } finally { close(); }
});

// ================= G2: zero-config join URL =================
test('G2: no PUBLIC_URL -> the LAN IPv4 is the join base for local requests (config, QR, console)', async () => {
  const srv = await cli({ ifaces: { ...LO, docker0: [v4('172.17.0.1')], wlan0: [v4('192.168.1.5')] } });
  try {
    const base = `http://192.168.1.5:${srv.port}`;
    assert.ok(srv.out.includes(base), `startup log does not print ${base}:\n${srv.out}`);
    for (const host of [`127.0.0.1:${srv.port}`, `localhost:${srv.port}`, `[::1]:${srv.port}`]) {
      assert.equal((await req('GET', srv.b + '/api/config', { headers: { host } })).json?.joinBase, base, 'joinBase for Host ' + host);
    }
    const { code } = (await req('POST', srv.b + '/api/rooms', { body: { direction: 'en-zh' } })).json;
    assert.equal((await req('GET', `${srv.b}/api/rooms/${code}/qr.svg`)).text, qrSvg(`${base}/j/${code}`), 'QR must encode the LAN join URL');
    assert.equal((await req('GET', srv.b + '/api/config', { headers: { host: 'lt.example.org' } })).json?.joinBase, 'http://lt.example.org', 'a non-local Host is used as is');
  } finally { srv.kill(); }
});

test('G2: PUBLIC_URL wins over the LAN address', async () => {
  const srv = await cli({ env: { PUBLIC_URL: 'https://lt.example.org/' }, ifaces: { ...LO, wlan0: [v4('192.168.1.5')] } });
  try {
    assert.equal((await req('GET', srv.b + '/api/config')).json?.joinBase, 'https://lt.example.org');
    const { code } = (await req('POST', srv.b + '/api/rooms', { body: { direction: 'en-zh' } })).json;
    assert.equal((await req('GET', `${srv.b}/api/rooms/${code}/qr.svg`)).text, qrSvg(`https://lt.example.org/j/${code}`));
  } finally { srv.kill(); }
});

test('G2: LAN address choice (10.x over docker 172.17, any private 172.16/12, none -> request host)', async () => {
  const cases = [
    [{ ...LO, docker0: [v4('172.17.0.1')], eth0: [v4('10.0.0.7')] }, (p) => `http://10.0.0.7:${p}`],
    [{ ...LO, eth0: [v4('172.30.0.2')] }, (p) => `http://172.30.0.2:${p}`],
    [{ ...LO, eth0: [v4('203.0.113.9')] }, (p) => `http://127.0.0.1:${p}`],
  ];
  for (const [ifaces, want] of cases) {
    const srv = await cli({ ifaces });
    try { assert.equal((await req('GET', srv.b + '/api/config')).json?.joinBase, want(srv.port), JSON.stringify(Object.keys(ifaces))); } finally { srv.kill(); }
  }
});

test('G2: README explains same Wi-Fi or hotspot and gives a tunnel one-liner', () => {
  assert.ok(fs.existsSync('README.md'), 'README.md missing');
  const t = fs.readFileSync('README.md', 'utf8');
  assert.match(t, /hotspot/i); assert.match(t, /Wi-?Fi/i); assert.match(t, /cloudflared tunnel --url http:\/\/localhost:3000/);
});

// ================= G3: guest replies =================
test('G3: a guest token lets the guest reply in the room language; host rules unchanged', async () => {
  const { b, close } = await up();
  try {
    const { code, hostToken } = await room(b, 'en-zh');
    const g = await guest(b, code);
    assert.equal(g.status, 201); assert.equal(typeof g.json?.guestToken, 'string');
    const { guestToken } = g.json;
    assert.ok(guestToken.length >= 16 && guestToken !== hostToken);
    const ev = sse(`${b}/api/rooms/${code}/events`); await sleep(100);
    assert.equal((await seg(b, code, { hostToken, text: 'Hello', lang: 'en', final: true })).status, 200);
    const i = await seg(b, code, { guestToken, text: '你', lang: 'zh', final: false });
    assert.equal(i.status, 200);
    const r = await seg(b, code, { guestToken, text: '你好', lang: 'zh', final: true });
    assert.equal(r.status, 200); assert.equal(r.json.translation, '[en]你好');
    assert.equal((await seg(b, code, { guestToken, text: 'Hi', lang: 'en', final: true })).status, 400, 'en-zh guest may only send zh');
    assert.equal((await seg(b, code, { hostToken, text: '你好', lang: 'zh', final: true })).status, 400, 'host zh in an en-zh room stays rejected');
    assert.equal((await seg(b, code, { guestToken: 'x'.repeat(guestToken.length), text: '你好', lang: 'zh', final: true })).status, 403, 'forged guestToken');
    const other = await room(b, 'en-zh');
    const og = (await guest(b, other.code)).json.guestToken;
    assert.equal((await seg(b, code, { guestToken: og, text: '你好', lang: 'zh', final: true })).status, 403, 'guestToken from another room');
    assert.equal((await guest(b, 'ZZZZZZ')).status, 404);
    await sleep(200); ev.close();
    const finals = ev.segs().filter((s) => s.final);
    assert.deepEqual(finals.map((s) => [s.text, s.speaker]), [['Hello', 'host'], ['你好', 'guest']]);
    assert.equal(ev.segs().find((s) => !s.final && s.text === '你')?.speaker, 'guest', 'guest interim is broadcast with speaker');
    assert.deepEqual((await transcript(b, code, hostToken)).map((s) => [s.text, s.lang, s.speaker, s.translation]), [['Hello', 'en', 'host', '[zh]Hello'], ['你好', 'zh', 'guest', '[en]你好']]);
  } finally { close(); }
});

test('G3: guest language rules for zh-en and both rooms', async () => {
  const { b, close } = await up();
  try {
    const ze = await room(b, 'zh-en'); const gz = (await guest(b, ze.code)).json.guestToken;
    assert.equal((await seg(b, ze.code, { guestToken: gz, text: 'Thanks', lang: 'en', final: true })).json?.translation, '[zh]Thanks');
    assert.equal((await seg(b, ze.code, { guestToken: gz, text: '谢谢', lang: 'zh', final: true })).status, 400);
    const bo = await room(b, 'both'); const gb = (await guest(b, bo.code)).json.guestToken;
    assert.equal((await seg(b, bo.code, { guestToken: gb, text: 'Thanks', lang: 'en', final: true })).status, 200);
    assert.equal((await seg(b, bo.code, { guestToken: gb, text: '谢谢', lang: 'zh', final: true })).status, 200);
  } finally { close(); }
});

// ================= G5: translation budget and providers =================
test('G5: azure provider contract (fetch mocked)', async () => {
  const azure = await import('../src/translate/azure.js');
  assert.equal(azure.name, 'azure');
  const { getTranslator } = await import('../src/translate/index.js');
  assert.equal(getTranslator('azure').name, 'azure', 'azure must be registered in src/translate/index.js');
  await withEnv({ AZURE_TRANSLATOR_KEY: 'test-key', AZURE_TRANSLATOR_REGION: 'westeurope' }, async () => {
    let f = stubFetch(async () => jsonRes([{ translations: [{ text: '你好', to: 'zh-Hans' }] }]));
    try {
      assert.equal(await azure.translate('Hello', 'en', 'zh'), '你好');
      const { url, init } = f.calls[0]; const u = new URL(url); const h = new Headers(init.headers);
      assert.equal(u.host, 'api.cognitive.microsofttranslator.com'); assert.equal(u.pathname, '/translate');
      assert.equal(u.searchParams.get('api-version'), '3.0'); assert.equal(u.searchParams.get('from'), 'en'); assert.equal(u.searchParams.get('to'), 'zh-Hans');
      assert.equal((init.method || 'GET').toUpperCase(), 'POST');
      assert.equal(h.get('ocp-apim-subscription-key'), 'test-key'); assert.equal(h.get('ocp-apim-subscription-region'), 'westeurope');
      assert.deepEqual(JSON.parse(init.body), [{ Text: 'Hello' }]);
    } finally { f.restore(); }
    f = stubFetch(async () => jsonRes([{ translations: [{ text: 'Thank you', to: 'en' }] }]));
    try {
      assert.equal(await azure.translate('谢谢', 'zh', 'en'), 'Thank you');
      const u = new URL(f.calls[0].url); assert.equal(u.searchParams.get('from'), 'zh-Hans'); assert.equal(u.searchParams.get('to'), 'en');
    } finally { f.restore(); }
    for (const [status, body, kind] of [[401, { error: { code: 401000, message: 'bad key' } }, 'auth'], [403, { error: { code: 403001, message: 'free quota exceeded' } }, 'quota'], [429, { error: { code: 429001, message: 'too many' } }, 'quota']]) {
      f = stubFetch(async () => jsonRes(body, status));
      try { await assert.rejects(azure.translate('Hello', 'en', 'zh'), (e) => e.kind === kind, `HTTP ${status} -> ${kind}`); } finally { f.restore(); }
    }
    f = stubFetch(async () => jsonRes([]));
    try { await assert.rejects(azure.translate('Hello', 'en', 'fr')); } finally { f.restore(); }
  });
  await withEnv({ AZURE_TRANSLATOR_KEY: null }, async () => {
    const f = stubFetch(async () => jsonRes([]));
    try { await assert.rejects(azure.translate('Hello', 'en', 'zh'), (e) => e.kind === 'auth'); assert.equal(f.calls.length, 0, 'no request without a key'); } finally { f.restore(); }
  });
});

test('G5: startup warns when TRANSLATOR=azure has no AZURE_TRANSLATOR_KEY', async () => {
  const srv = await cli({ env: { TRANSLATOR: 'azure' } });
  try { assert.match(srv.out, /AZURE_TRANSLATOR_KEY/); } finally { srv.kill(); }
});

test('G5: README documents Azure F0 and DeepL Free as the better free options', () => {
  const t = fs.existsSync('README.md') ? fs.readFileSync('README.md', 'utf8') : '';
  for (const w of ['AZURE_TRANSLATOR_KEY', 'AZURE_TRANSLATOR_REGION', 'TRANSLATOR=azure', 'DeepL']) assert.ok(t.includes(w), 'README lacks ' + w);
  assert.ok(!/AZURE_TRANSLATOR_KEY/.test(fs.readdirSync('public').map((f) => fs.readFileSync('public/' + f, 'utf8')).join('\n')), 'key name must not reach client code');
});

test('G5: a translation computed on the host device is stored as is; the server translator is not called', async () => {
  const tr = echo(); const { b, close } = await up({ translator: tr });
  try {
    const { code, hostToken } = await room(b, 'en-zh');
    const ev = sse(`${b}/api/rooms/${code}/events`); await sleep(100);
    const r = await seg(b, code, { hostToken, text: 'Hello there.', lang: 'en', final: true, translation: '你好。' });
    assert.equal(r.status, 200); assert.equal(r.json.translation, '你好。');
    assert.equal(tr.calls.length, 0, 'translator called despite a device translation');
    const i = await seg(b, code, { hostToken, text: 'Hel', lang: 'en', final: false, translation: 'X' });
    assert.equal(i.status, 200);
    assert.equal((await seg(b, code, { hostToken, text: 'Hi', lang: 'en', final: true, translation: 42 })).status, 400);
    assert.equal((await seg(b, code, { hostToken, text: 'Hi', lang: 'en', final: true, translation: '好'.repeat(4001) })).status, 413);
    await sleep(200); ev.close();
    assert.deepEqual(ev.segs().filter((s) => s.final).map((s) => [s.text, s.translation]), [['Hello there.', '你好。']]);
    assert.ok(ev.segs().filter((s) => !s.final).every((s) => s.translation == null), 'interims never carry a translation');
  } finally { close(); }
});

// ================= G7: presence =================
test('G7: presence events count readers, excluding the host stream', async () => {
  const { b, close } = await up();
  try {
    const { code, hostToken } = await room(b, 'en-zh');
    const readers = (s) => s.all.filter((e) => e.event === 'presence').at(-1)?.data?.readers;
    const host = sse(`${b}/api/rooms/${code}/events?role=host&token=${encodeURIComponent(hostToken)}`);
    assert.equal(await until(() => readers(host) === 0, 2000), true, 'host stream must get presence {readers:0} on connect');
    const g1 = sse(`${b}/api/rooms/${code}/events`);
    assert.equal(await until(() => readers(host) === 1, 2000), true, 'one reader');
    assert.equal(await until(() => readers(g1) === 1, 2000), true, 'reader stream also gets presence');
    const g2 = sse(`${b}/api/rooms/${code}/events`);
    assert.equal(await until(() => readers(host) === 2, 2000), true, 'two readers');
    g1.close();
    assert.equal(await until(() => readers(host) === 1, 2000), true, 'count drops when a reader leaves');
    g2.close(); host.close();
  } finally { close(); }
});

// ================= G8: privacy, end room, transcript access =================
test('G8: transcript needs the hostToken or the readToken', async () => {
  const { b, close } = await up();
  try {
    const r = await room(b, 'en-zh');
    assert.equal(typeof r.readToken, 'string'); assert.ok(r.readToken.length >= 16 && r.readToken !== r.hostToken);
    await seg(b, r.code, { hostToken: r.hostToken, text: 'Hello', lang: 'en', final: true });
    const url = (f, t) => `${b}/api/rooms/${r.code}/transcript?format=${f}${t ? '&token=' + encodeURIComponent(t) : ''}`;
    assert.equal((await req('GET', url('json'))).status, 403, 'no token');
    assert.equal((await req('GET', url('json', 'x'.repeat(r.hostToken.length)))).status, 403, 'wrong token');
    for (const f of ['json', 'md', 'txt']) {
      assert.equal((await req('GET', url(f, r.hostToken))).status, 200, f + ' with hostToken');
      assert.equal((await req('GET', url(f, r.readToken))).status, 200, f + ' with readToken');
    }
  } finally { close(); }
});

test('G8: ending a room sends an end event to every stream', async () => {
  const { b, close } = await up();
  try {
    const { code, hostToken } = await room(b, 'en-zh');
    const ev = sse(`${b}/api/rooms/${code}/events`); await sleep(150);
    assert.equal((await req('DELETE', `${b}/api/rooms/${code}`, { body: { hostToken } })).status, 204);
    assert.ok(await until(() => ev.all.some((e) => e.event === 'end'), 2000), 'no `event: end` before the stream closed');
    assert.ok(await until(() => ev.ended, 2000), 'stream not closed');
  } finally { close(); }
});

test('G8: privacy copy names Apple (Safari) as well as Google', () => {
  for (const f of ['index.html', 'host.html', 'guest.html', 'join.html']) {
    const t = fs.readFileSync('public/' + f, 'utf8');
    assert.match(t, /Google/, f); assert.match(t, /Apple/, f + ' privacy copy lacks Apple');
  }
});
