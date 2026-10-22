// PLANNER-OWNED. Do not edit. Acceptance tests for REVIEW-R1.md (task brief: tasks/T3-review-R1.md).
// No network: only 127.0.0.1/127.0.0.2 loopback, stubbed fetch for providers, headless Chromium from playwright@1.64.1.
//
// NEW INTERFACES these tests rely on (also specified in tasks/T3-review-R1.md):
// - Clock injection: `new RoomStore({now})` uses `now` for per-room rate limiters (not only idle expiry), and
//   `createServer({translator, store, now, dailyCharLimit})` uses `now` (default: store.now) for every server-level
//   limiter and the daily budget. Client IP = req.socket.remoteAddress (X-Forwarded-For only when TRUST_PROXY=1).
// - Limits (429 JSON {error}): POST /api/rooms 10 per IP per hour (bucket burst 10, refill 10/h). Finals per IP across
//   all rooms: burst 30, refill 1/s. Finals per room: own bucket, burst >= 10, refill >= 1/s. Interims per room: own
//   bucket, separate from finals (interims may 429, finals must not be starved by interims). Room-not-found responses
//   per IP: burst 30, refill 0.5/s; once empty, /api/rooms/:code* lookups that would 404 return 429.
// - Daily translation budget: option `dailyCharLimit` (else env TRANSLATE_DAILY_CHAR_LIMIT read at createServer time;
//   unset or 0 = unlimited). Counts characters of final text sent to the translator per UTC day of `now`. A final that
//   would exceed it is still saved and broadcast with translation:null, error:true, errorKind:'budget', and the
//   translator is NOT called. The POST response includes errorKind.
// - rooms.js exports MAX_ROOM_CHARS (total chars of stored final text per room, <= 500000). A final that would push a
//   room over it returns 409.
// - errorKind on segments (POST response, SSE, transcript json) whenever error:true: 'quota' | 'auth' | 'timeout' |
//   'budget' | 'other'. Providers throw errors with `err.kind` set ('quota','auth','timeout','other'); errors without a
//   kind map to 'other'. MyMemory responseStatus 429 or quota text -> 'quota'; DeepL 456 -> 'quota', 403 -> 'auth'.
// - Startup (node src/server.js) prints a warning naming MYMEMORY_EMAIL when the translator is mymemory and it is unset,
//   and naming the missing env var (e.g. DEEPL_API_KEY) when TRANSLATOR=deepl|google|libretranslate lacks key or URL.
// - GET /api/config -> {translator, joinBase}; joinBase is PUBLIC_URL (no trailing slash) or proto://host from the
//   request. qr.svg encodes exactly `${joinBase}/j/${code}`. x-forwarded-proto is honoured only when TRUST_PROXY=1.
//   qr.svg cache-control is private (never public).
// - DELETE /api/rooms/:code with JSON {hostToken} -> 204 (room, segments gone, SSE streams ended), wrong token -> 403.
// - POST bodies must be content-type application/json, else 415. `final` must be a boolean, else 400.
// - Interim with empty text (final:false, text:'') is a "clear" signal: 200 and broadcast {final:false,text:''}. An
//   interim whose text equals the room's last final text is dropped (not broadcast).
// - Pages: host has [data-test=end-room], [data-test=localhost-warning] (visible when the page is on localhost,
//   127.x or [::1] and joinBase is local too), [data-test=translate-banner] (shown on errorKind quota/auth/budget),
//   join link [data-test=join-url] href === joinBase + '/j/' + code. Guest and join UI strings include Simplified
//   Chinese. Host requests navigator.wakeLock('screen') while listening. Finals are delivered exactly once even when
//   SpeechRecognition repeats a final (Android). Finals are retried on 429/5xx/network error with backoff, in order.
//   Typed text stays in the input until the POST succeeds. The join input accepts pasted "abc-234".
// - Files: README.md (setup, env vars, PUBLIC_URL, https, limits, privacy), DECISIONS.md (inline QR), Nayuki
//   copyright notice in src/qr.js.
import test, { after } from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import http from 'node:http'; import net from 'node:net'; import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createServer } from '../src/server.js'; import * as rooms from '../src/rooms.js';
import * as mock from '../src/translate/mock.js'; import * as mymemory from '../src/translate/mymemory.js';
import * as deepl from '../src/translate/deepl.js'; import { encodeQR, qrSvg } from '../src/qr.js';
import crypto from 'node:crypto';

for (const k of ['PUBLIC_URL', 'TRUST_PROXY', 'TRANSLATE_DAILY_CHAR_LIMIT']) delete process.env[k];
const CJK = /[一-鿿]/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const echo = () => { const calls = []; return { calls, translate: async (t, f, to) => { calls.push([t, f, to]); return `[${to}]${t}`; } }; };
const clock = (t = Date.UTC(2026, 9, 20, 12)) => { const c = { t, now: () => c.t, adv: (ms) => { c.t += ms; } }; return c; };

async function up({ translator = echo(), c, ...opts } = {}) {
  const store = c ? new rooms.RoomStore({ now: c.now }) : undefined;
  const s = createServer({ translator, ...(store ? { store, now: c.now } : {}), ...opts });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { s, translator, b: `http://127.0.0.1:${s.address().port}`, close: () => { s.close(); s.closeAllConnections?.(); } };
}
// node:http client (works while global fetch is stubbed; `from` picks the source IP).
function req(method, url, { body, headers = {}, from } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const h = { ...(body !== undefined && typeof body !== 'string' ? { 'content-type': 'application/json' } : {}), ...headers };
    if (data !== undefined) h['content-length'] = Buffer.byteLength(data);
    const r = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: h, localAddress: from, agent: false }, (res) => {
      const ch = []; res.on('data', (d) => ch.push(d));
      res.on('end', () => { const text = Buffer.concat(ch).toString(); let json; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, text, json }); });
    });
    r.on('error', reject); if (data !== undefined) r.write(data); r.end();
  });
}
const room = async (b, direction = 'both', from) => (await req('POST', b + '/api/rooms', { body: { direction }, from })).json;
const seg = (b, code, body, from) => req('POST', `${b}/api/rooms/${code}/segments`, { body, from });
const tUrl = (b, code, f, token) => `${b}/api/rooms/${code}/transcript?format=${f}${token ? '&token=' + encodeURIComponent(token) : ''}`;
const transcript = async (b, code, token) => { const r = await req('GET', tUrl(b, code, 'json', token)); return r.json?.segments || []; };
function sse(url) {
  const out = { events: [], ended: false };
  const u = new URL(url);
  out.req = http.get({ host: u.hostname, port: u.port, path: u.pathname, agent: false }, (res) => {
    let buf = ''; res.setEncoding('utf8');
    res.on('data', (d) => { buf += d; let k; while ((k = buf.indexOf('\n\n')) >= 0) { const blk = buf.slice(0, k); buf = buf.slice(k + 2); const line = blk.split('\n').find((l) => l.startsWith('data:')); if (line && /event: ?segment/.test(blk)) out.events.push(JSON.parse(line.slice(5))); } });
    res.on('end', () => { out.ended = true; }); res.on('close', () => { out.ended = true; });
  });
  out.req.on('error', () => { out.ended = true; });
  out.close = () => out.req.destroy();
  return out;
}
async function until(fn, ms = 5000, step = 50) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return v; await sleep(step); } }
function stubFetch(handler) {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => handler(String(url), init);
  return () => { globalThis.fetch = orig; };
}
const jsonRes = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

// ---------------- Browser helpers ----------------
let br;
const browser = async () => (br ??= await chromium.launch());
after(async () => { await br?.close(); });
function fakeSpeech() {
  window.__recs = [];
  const fire = (t, name, ev) => { if (typeof t['on' + name] === 'function') t['on' + name](ev); else t.dispatchEvent(ev); };
  class FakeSR extends EventTarget {
    constructor() { super(); window.__recs.push(this); }
    start() { this.running = true; setTimeout(() => fire(this, 'start', new Event('start')), 0); }
    stop() { if (!this.running) return; this.running = false; setTimeout(() => fire(this, 'end', new Event('end')), 0); }
    abort() { this.stop(); }
  }
  window.SpeechRecognition = FakeSR; window.webkitSpeechRecognition = FakeSR;
  window.__emit = (resultIndex, items) => {
    const rec = [...window.__recs].reverse().find((r) => r.running);
    if (!rec) throw new Error('no running recognizer');
    const results = items.map(([t, f]) => { const r = [{ transcript: t, confidence: 0.9 }]; r.isFinal = f; r.item = (i) => r[i]; return r; });
    results.item = (i) => results[i];
    const ev = new Event('result'); ev.resultIndex = resultIndex; ev.results = results; fire(rec, 'result', ev);
  };
}
function noSpeech() { delete window.SpeechRecognition; delete window.webkitSpeechRecognition; try { delete Window.prototype.webkitSpeechRecognition; delete Window.prototype.SpeechRecognition; } catch {} }
function fakeWake() {
  window.__wake = [];
  Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request: async (type) => { window.__wake.push(type); const s = new EventTarget(); s.type = type; s.released = false; s.release = async () => { s.released = true; }; return s; } } });
}
async function hostPage(b, code, hostToken, scripts = [fakeSpeech]) {
  const ctx = await (await browser()).newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(([c, t]) => { try { sessionStorage.setItem('hostToken:' + c, t); } catch {} }, [code, hostToken]);
  for (const f of scripts) await ctx.addInitScript(f);
  const page = await ctx.newPage();
  await page.goto(`${b}/host/${code}`);
  return { ctx, page };
}
async function guestPage(b, path) {
  const ctx = await (await browser()).newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  const page = await ctx.newPage(); await page.goto(b + path); return { ctx, page };
}
async function startMic(page) {
  await page.click('[data-test=mic]');
  await page.waitForFunction(() => window.__recs.some((r) => r.running), null, { timeout: 3000 });
}

// ================= B1 =================
test('B1 server: interims at 10/s never starve finals (injected clock, 20 s of speech)', async () => {
  const c = clock(); const { b, close } = await up({ c });
  try {
    const { code, hostToken } = await room(b);
    const finals = []; const interimStatuses = new Set();
    for (let i = 1; i <= 200; i++) {
      c.adv(100);
      const r = await seg(b, code, { hostToken, text: 'partial words ' + i, lang: 'en', final: false });
      interimStatuses.add(r.status);
      if (i % 30 === 0) { const f = await seg(b, code, { hostToken, text: `Final sentence ${i / 30}.`, lang: 'en', final: true }); finals.push(f.status); }
    }
    assert.deepEqual(finals, [200, 200, 200, 200, 200, 200], 'every final must be accepted');
    for (const st of interimStatuses) assert.ok(st === 200 || st === 429, 'interim status ' + st);
    assert.deepEqual((await transcript(b, code, hostToken)).map((s) => s.text), [1, 2, 3, 4, 5, 6].map((n) => `Final sentence ${n}.`));
  } finally { close(); }
});

test('B1 browser: a burst of 50 recognition interims then a final reaches the transcript', async () => {
  const { b, close } = await up({ translator: mock }); let ctx;
  try {
    const { code, hostToken } = await room(b, 'en-zh');
    ({ ctx } = await hostPage(b, code, hostToken)); const page = ctx.pages()[0];
    await startMic(page);
    for (let i = 1; i <= 50; i++) { await page.evaluate((t) => window.__emit(0, [[t, false]]), 'where is the train'.slice(0, 3 + (i % 15)) + ' ' + i); await sleep(20); }
    await page.evaluate(() => window.__emit(0, [['Where is the train station?', true]]));
    const got = await until(async () => (await transcript(b, code, hostToken)).find((s) => s.text === 'Where is the train station?'), 8000);
    assert.ok(got, 'final line lost after interim burst');
    assert.match(got.translation || '', CJK);
  } finally { await ctx?.close(); close(); }
});

test('B1 browser: finals rejected with 429 are retried and stay in order', async () => {
  const { b, close } = await up({ translator: mock }); let ctx;
  try {
    const { code, hostToken } = await room(b, 'en-zh');
    ({ ctx } = await hostPage(b, code, hostToken)); const page = ctx.pages()[0];
    let refused = 0;
    await page.route('**/segments', async (route) => {
      const body = route.request().postDataJSON?.() || {};
      if (body.final === true && refused < 2) { refused++; return route.fulfill({ status: 429, contentType: 'application/json', body: '{"error":"too many"}' }); }
      return route.continue();
    });
    await page.evaluate(() => { const f = window.__liveTranslateTest.feed; Promise.resolve(f('First line.', true)).catch(() => {}); Promise.resolve(f('Second line.', true)).catch(() => {}); });
    const ok = await until(async () => (await transcript(b, code, hostToken)).length >= 2, 10000, 100);
    assert.ok(ok, 'finals were not retried after 429');
    assert.equal(refused, 2);
    assert.deepEqual((await transcript(b, code, hostToken)).map((s) => s.text), ['First line.', 'Second line.']);
  } finally { await ctx?.close(); close(); }
});

// ================= M1 =================
test('M1: room creation limited to 10 per IP per hour, other IPs unaffected', async () => {
  const c = clock(); const { b, close } = await up({ c });
  try {
    const st = [];
    for (let i = 0; i < 11; i++) st.push((await req('POST', b + '/api/rooms', { body: { direction: 'en-zh' }, from: '127.0.0.1' })).status);
    assert.deepEqual(st, [...Array(10).fill(201), 429]);
    assert.equal((await req('POST', b + '/api/rooms', { body: { direction: 'en-zh' }, from: '127.0.0.2' })).status, 201);
    c.adv(60 * 60 * 1000 + 1000);
    assert.equal((await req('POST', b + '/api/rooms', { body: { direction: 'en-zh' }, from: '127.0.0.1' })).status, 201);
  } finally { close(); }
});

test('M1: finals are limited per IP across rooms (burst 30), other IPs unaffected', async () => {
  const c = clock(); const { b, close } = await up({ c });
  try {
    const rs = []; for (let i = 0; i < 4; i++) rs.push(await room(b, 'en-zh', '127.0.0.1'));
    const st = [];
    for (let n = 0; n < 10; n++) for (const r of rs) st.push((await seg(b, r.code, { hostToken: r.hostToken, text: 'line ' + n, lang: 'en', final: true }, '127.0.0.1')).status);
    assert.ok(st.every((x) => x === 200 || x === 429), String(st));
    assert.ok(st.filter((x) => x === 200).length <= 30, 'more than 30 finals accepted from one IP in a burst');
    assert.ok(st.includes(429));
    const other = await room(b, 'en-zh', '127.0.0.2');
    assert.equal((await seg(b, other.code, { hostToken: other.hostToken, text: 'hello', lang: 'en', final: true }, '127.0.0.2')).status, 200);
  } finally { close(); }
});

test('M1: daily translation char budget (option) stops calling the translator, saves line with errorKind budget', async () => {
  const c = clock(); const tr = echo(); const { b, close } = await up({ c, translator: tr, dailyCharLimit: 50 });
  try {
    const { code, hostToken } = await room(b, 'en-zh');
    const ev = sse(`${b}/api/rooms/${code}/events`);
    const a = await seg(b, code, { hostToken, text: 'a'.repeat(30), lang: 'en', final: true });
    assert.equal(a.status, 200); assert.equal(a.json.translation, '[zh]' + 'a'.repeat(30));
    c.adv(2000);
    const z = await seg(b, code, { hostToken, text: 'b'.repeat(30), lang: 'en', final: true });
    assert.equal(z.status, 200); assert.equal(z.json.translation, null); assert.equal(z.json.error, true); assert.equal(z.json.errorKind, 'budget');
    assert.equal(tr.calls.length, 1, 'translator must not be called once the budget is used up');
    await until(() => ev.events.filter((e) => e.final).length >= 2, 2000); ev.close();
    assert.equal(ev.events.filter((e) => e.final)[1]?.errorKind, 'budget');
    assert.equal((await transcript(b, code, hostToken))[1].errorKind, 'budget');
    c.adv(24 * 60 * 60 * 1000);
    // The old room expired after IDLE_MS (12 h); the budget is per server, so a fresh room checks the reset.
    const fresh = await room(b, 'en-zh');
    const n = await seg(b, fresh.code, { hostToken: fresh.hostToken, text: 'c'.repeat(10), lang: 'en', final: true });
    assert.equal(n.json.translation, '[zh]' + 'c'.repeat(10)); assert.equal(tr.calls.length, 2, 'budget must reset the next UTC day');
  } finally { close(); }
});

test('M1: TRANSLATE_DAILY_CHAR_LIMIT env is honoured', async () => {
  process.env.TRANSLATE_DAILY_CHAR_LIMIT = '20';
  const tr = echo(); let srv;
  try {
    srv = await up({ c: clock(), translator: tr });
    const { code, hostToken } = await room(srv.b, 'en-zh');
    const r = await seg(srv.b, code, { hostToken, text: 'x'.repeat(30), lang: 'en', final: true });
    assert.equal(r.status, 200); assert.equal(r.json.errorKind, 'budget'); assert.equal(tr.calls.length, 0);
  } finally { delete process.env.TRANSLATE_DAILY_CHAR_LIMIT; srv?.close(); }
});

test('M1: stored text per room is capped (MAX_ROOM_CHARS, 409 after)', async () => {
  const max = rooms.MAX_ROOM_CHARS;
  assert.equal(typeof max, 'number', 'rooms.js must export MAX_ROOM_CHARS'); assert.ok(max > 0 && max <= 500000);
  const c = clock(); const { b, close } = await up({ c });
  try {
    const { code, hostToken } = await room(b, 'en-zh');
    let stored = 0, last = 0;
    for (let i = 0; i < Math.ceil(max / 2000) + 2; i++) {
      c.adv(5000);
      last = (await seg(b, code, { hostToken, text: String(i % 10).repeat(2000), lang: 'en', final: true })).status;
      if (last !== 200) break; stored += 2000;
    }
    assert.equal(last, 409); assert.ok(stored <= max && stored > max - 2000, `stored ${stored} of ${max}`);
  } finally { close(); }
});

// ================= M2 =================
test('M2: room-not-found lookups are rate limited per IP (30, then 429)', async () => {
  const c = clock(); const { b, close } = await up({ c });
  try {
    const { code } = await room(b);
    const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; const st = [];
    for (let i = 0; i < 40; i++) { let g = 'Z' + A[i % 32] + A[(i * 7) % 32] + 'Q9' + A[(i * 3) % 32]; if (g === code) g = 'ZZZZZZ'; st.push((await req('GET', `${b}/api/rooms/${g}`, { from: '127.0.0.1' })).status); }
    assert.deepEqual(st.slice(0, 30), Array(30).fill(404)); assert.deepEqual(st.slice(30), Array(10).fill(429));
    assert.equal((await req('GET', `${b}/api/rooms/${code}`, { from: '127.0.0.2' })).status, 200);
    c.adv(60 * 1000);
    assert.equal((await req('GET', `${b}/api/rooms/${code}`, { from: '127.0.0.1' })).status, 200);
  } finally { close(); }
});

test('M2: transcript requires hostToken or readToken', async () => {
  const { b, close } = await up();
  try {
    const { code, hostToken } = await room(b);
    assert.equal((await req('GET', tUrl(b, code, 'json'))).status, 403);
    assert.equal((await req('GET', tUrl(b, code, 'json', hostToken))).status, 200);
  } finally { close(); }
});

// ================= M3 =================
test('M3: /api/config joinBase matches the QR target, PUBLIC_URL respected', async () => {
  let srv;
  try {
    srv = await up();
    const { code } = await room(srv.b);
    const cfg = (await req('GET', srv.b + '/api/config')).json;
    assert.equal(cfg.joinBase, srv.b);
    assert.equal((await req('GET', `${srv.b}/api/rooms/${code}/qr.svg`)).text, qrSvg(`${cfg.joinBase}/j/${code}`));
    srv.close();
    process.env.PUBLIC_URL = 'http://192.168.1.5:3000/';
    srv = await up();
    const r2 = await room(srv.b);
    const cfg2 = (await req('GET', srv.b + '/api/config')).json;
    assert.equal(cfg2.joinBase, 'http://192.168.1.5:3000');
    assert.equal((await req('GET', `${srv.b}/api/rooms/${r2.code}/qr.svg`)).text, qrSvg(`http://192.168.1.5:3000/j/${r2.code}`));
  } finally { delete process.env.PUBLIC_URL; srv?.close(); }
});

test('M3 browser: host link equals QR target with PUBLIC_URL, localhost warning otherwise', async () => {
  let srv, ctx;
  try {
    process.env.PUBLIC_URL = 'http://192.168.1.5:3000';
    srv = await up({ translator: mock });
    const r = await room(srv.b, 'en-zh');
    ({ ctx } = await hostPage(srv.b, r.code, r.hostToken)); let page = ctx.pages()[0];
    await page.waitForFunction((c) => document.querySelector('[data-test=join-url]')?.href?.endsWith('/j/' + c), r.code, { timeout: 3000 });
    const href = await page.getAttribute('[data-test=join-url]', 'href');
    assert.equal(href, `http://192.168.1.5:3000/j/${r.code}`);
    assert.equal((await req('GET', `${srv.b}/api/rooms/${r.code}/qr.svg`)).text, qrSvg(href));
    await sleep(300);
    assert.equal(await page.isVisible('[data-test=localhost-warning]'), false);
    await ctx.close(); srv.close(); delete process.env.PUBLIC_URL;
    srv = await up({ translator: mock });
    const r2 = await room(srv.b, 'en-zh');
    ({ ctx } = await hostPage(srv.b, r2.code, r2.hostToken)); page = ctx.pages()[0];
    await page.waitForSelector('[data-test=localhost-warning]', { state: 'visible', timeout: 3000 });
    assert.match(await page.textContent('[data-test=localhost-warning]'), /PUBLIC_URL/);
  } finally { delete process.env.PUBLIC_URL; await ctx?.close(); srv?.close(); }
});

test('M3: README documents setup, env vars, PUBLIC_URL, https, limits and privacy', () => {
  assert.ok(fs.existsSync('README.md'), 'README.md missing');
  const t = fs.readFileSync('README.md', 'utf8');
  for (const w of ['PUBLIC_URL', 'TRANSLATOR', 'MYMEMORY_EMAIL', 'DEEPL_API_KEY', 'GOOGLE_TRANSLATE_API_KEY', 'LIBRETRANSLATE_URL', 'TRANSLATE_DAILY_CHAR_LIMIT', 'TRUST_PROXY', 'https', 'npm test', 'npm start']) assert.ok(t.includes(w), 'README lacks ' + w);
  assert.match(t, /privacy/i); assert.match(t, /limit/i);
});

// ================= M4 =================
test('M4: privacy copy names the cloud speech services, code access and memory-only storage', () => {
  for (const f of ['index.html', 'host.html', 'guest.html', 'join.html']) {
    const t = fs.readFileSync('public/' + f, 'utf8');
    for (const re of [/Google/, /Microsoft/, /anyone with the (room )?code/i, /12 hours/, /restart/i]) assert.ok(re.test(t), `${f} privacy copy lacks ${re}`);
  }
  assert.match(fs.readFileSync('public/host.html', 'utf8'), /data-test="end-room"/);
});

test('M4: DELETE room with hostToken ends it; wrong token 403', async () => {
  const { b, close } = await up();
  try {
    const { code, hostToken } = await room(b);
    await seg(b, code, { hostToken, text: 'Hello', lang: 'en', final: true });
    const ev = sse(`${b}/api/rooms/${code}/events`);
    await until(() => ev.events.length >= 1, 2000);
    assert.equal((await req('DELETE', `${b}/api/rooms/${code}`, { body: { hostToken: 'nope' } })).status, 403);
    assert.equal((await req('GET', `${b}/api/rooms/${code}`)).status, 200);
    assert.equal((await req('DELETE', `${b}/api/rooms/${code}`, { body: { hostToken } })).status, 204);
    assert.equal((await req('GET', `${b}/api/rooms/${code}`)).status, 404);
    assert.equal((await req('GET', tUrl(b, code, 'json', hostToken))).status, 404);
    assert.ok(await until(() => ev.ended, 2000), 'SSE stream not closed on delete');
  } finally { close(); }
});

// ================= M5 =================
test('M5 browser: guest and join UI speak Chinese (waiting, unavailable, join heading and error)', async () => {
  const translator = { translate: async (t, f, to) => { if (t === 'FAIL') throw new Error('down'); return mock.translate(t, f, to); } };
  const { b, close } = await up({ translator }); let g, j;
  try {
    const { code, hostToken } = await room(b, 'en-zh');
    g = await guestPage(b, '/j/' + code);
    await g.page.waitForSelector('[data-test=waiting]', { state: 'visible' });
    assert.match(await g.page.innerText('[data-test=waiting]'), CJK, 'waiting state has no Chinese');
    await seg(b, code, { hostToken, text: 'FAIL', lang: 'en', final: true });
    await g.page.waitForSelector('[data-test=segments] li', { timeout: 5000 });
    assert.match(await g.page.innerText('[data-test=segments] li'), CJK, 'translation-unavailable label has no Chinese');
    j = await guestPage(b, '/join');
    assert.match(await j.page.innerText('h1'), CJK, 'join heading has no Chinese');
    await j.page.fill('[data-test=code-input]', 'ZZZZZZ'); await j.page.click('[data-test=join]');
    await j.page.waitForFunction(() => document.querySelector('[data-test=error]')?.textContent.trim(), null, { timeout: 3000 });
    assert.match(await j.page.innerText('[data-test=error]'), CJK, 'join error has no Chinese');
  } finally { await g?.ctx.close(); await j?.ctx.close(); close(); }
});

// ================= M6 =================
test('M6 browser: host requests a screen wake lock while listening', async () => {
  const { b, close } = await up({ translator: mock }); let ctx;
  try {
    const { code, hostToken } = await room(b, 'en-zh');
    ({ ctx } = await hostPage(b, code, hostToken, [fakeSpeech, fakeWake])); const page = ctx.pages()[0];
    await startMic(page);
    const wake = await page.waitForFunction(() => window.__wake.length > 0 && window.__wake, null, { timeout: 3000 }).then((h) => h.jsonValue()).catch(() => []);
    assert.ok(wake.length >= 1 && wake.every((x) => x === 'screen'), 'no wakeLock.request("screen") on the host');
  } finally { await ctx?.close(); close(); }
});

// ================= M7 =================
test('M7: providers classify errors (quota, auth, timeout)', async () => {
  let restore = stubFetch(async () => jsonRes({ responseStatus: 429, responseDetails: 'MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY' }));
  try { await assert.rejects(mymemory.translate('Hello', 'en', 'zh'), (e) => e.kind === 'quota'); } finally { restore(); }
  restore = stubFetch(async () => jsonRes({ responseDetails: 'too many' }, 429));
  try { await assert.rejects(mymemory.translate('Hello', 'en', 'zh'), (e) => e.kind === 'quota'); } finally { restore(); }
  restore = stubFetch(async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); });
  try { await assert.rejects(mymemory.translate('Hello', 'en', 'zh'), (e) => e.kind === 'timeout'); } finally { restore(); }
  const oldKey = process.env.DEEPL_API_KEY; process.env.DEEPL_API_KEY = 'test-key:fx';
  try {
    restore = stubFetch(async () => jsonRes({ message: 'Quota exceeded' }, 456));
    try { await assert.rejects(deepl.translate('Hello', 'en', 'zh'), (e) => e.kind === 'quota'); } finally { restore(); }
    restore = stubFetch(async () => jsonRes({ message: 'Forbidden' }, 403));
    try { await assert.rejects(deepl.translate('Hello', 'en', 'zh'), (e) => e.kind === 'auth'); } finally { restore(); }
  } finally { if (oldKey == null) delete process.env.DEEPL_API_KEY; else process.env.DEEPL_API_KEY = oldKey; }
});

test('M7: server exposes errorKind on the segment (quota from MyMemory, other for unknown errors)', async () => {
  const restore = stubFetch(async () => jsonRes({ responseStatus: 429, responseDetails: 'MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY' }));
  let srv;
  try {
    srv = await up({ translator: mymemory });
    const { code, hostToken } = await room(srv.b, 'en-zh');
    const r = await seg(srv.b, code, { hostToken, text: 'Hello', lang: 'en', final: true });
    assert.equal(r.status, 200); assert.equal(r.json.error, true); assert.equal(r.json.errorKind, 'quota');
    assert.equal((await transcript(srv.b, code, hostToken))[0].errorKind, 'quota');
  } finally { restore(); srv?.close(); }
  try {
    srv = await up({ translator: { translate: async () => { throw new Error('boom'); } } });
    const { code, hostToken } = await room(srv.b, 'en-zh');
    assert.equal((await seg(srv.b, code, { hostToken, text: 'Hello', lang: 'en', final: true })).json.errorKind, 'other');
  } finally { srv?.close(); }
});

test('M7 browser: host shows a translate banner on quota errors', async () => {
  const translator = { translate: async () => { throw Object.assign(new Error('quota used up'), { kind: 'quota' }); } };
  const { b, close } = await up({ translator }); let ctx;
  try {
    const { code, hostToken } = await room(b, 'en-zh');
    ({ ctx } = await hostPage(b, code, hostToken)); const page = ctx.pages()[0];
    await page.evaluate(() => Promise.resolve(window.__liveTranslateTest.feed('Hello there.', true)).catch(() => {}));
    await page.waitForSelector('[data-test=translate-banner]', { state: 'visible', timeout: 5000 });
    assert.match(await page.innerText('[data-test=translate-banner]'), /quota/i);
  } finally { await ctx?.close(); close(); }
});

async function startupOutput(env) {
  const port = await new Promise((r) => { const t = net.createServer(); t.listen(0, '127.0.0.1', () => { const p = t.address().port; t.close(() => r(p)); }); });
  const e = { ...process.env, PORT: String(port) };
  for (const k of ['TRANSLATOR', 'MYMEMORY_EMAIL', 'DEEPL_API_KEY', 'GOOGLE_TRANSLATE_API_KEY', 'LIBRETRANSLATE_URL', 'PUBLIC_URL']) delete e[k];
  Object.assign(e, env);
  const p = spawn(process.execPath, ['src/server.js'], { env: e });
  let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
  await until(() => /live-translate on/.test(out) || p.exitCode != null, 5000);
  await sleep(200); p.kill(); return out;
}
test('M7: startup warns about missing MYMEMORY_EMAIL and missing provider keys', async () => {
  assert.match(await startupOutput({}), /MYMEMORY_EMAIL/);
  assert.match(await startupOutput({ TRANSLATOR: 'deepl' }), /DEEPL_API_KEY/);
});

// ================= M8 (+ m7) =================
test('M8 browser: real onresult path delivers each final exactly once (resultIndex, Android repeat)', async () => {
  const { b, close } = await up({ translator: mock }); let ctx, g;
  try {
    const { code, hostToken } = await room(b, 'en-zh');
    g = await guestPage(b, '/j/' + code);
    ({ ctx } = await hostPage(b, code, hostToken)); const page = ctx.pages()[0];
    await startMic(page);
    const seq = [
      [0, [['Hel', false]]], [0, [['Hello there', false]]], [0, [['Hello there.', true]]],
      [1, [['Hello there.', true], ['How', false]]], [1, [['Hello there.', true], ['How are you?', true]]],
      [0, [['How are you?', true]]], // Android Chrome repeating the previous final
      [1, [['How are you?', true], ['Where is the station?', true]]],
    ];
    for (const [i, items] of seq) { await page.evaluate(([i, items]) => window.__emit(i, items), [i, items]); await sleep(150); }
    const want = ['Hello there.', 'How are you?', 'Where is the station?'];
    await until(async () => (await transcript(b, code, hostToken)).length >= 3, 6000);
    await sleep(800);
    assert.deepEqual((await transcript(b, code, hostToken)).map((s) => s.text), want);
    await g.page.waitForFunction(() => document.querySelectorAll('[data-test=segments] li:not(.interim)').length >= 3, null, { timeout: 5000 });
    assert.equal(await g.page.locator('[data-test=segments] li:not(.interim)').count(), 3);
  } finally { await ctx?.close(); await g?.ctx.close(); close(); }
});

test('M8 browser: speech text is rendered as text, never as HTML', async () => {
  const { b, close } = await up({ translator: mock }); let ctx, g;
  try {
    const { code, hostToken } = await room(b, 'en-zh');
    g = await guestPage(b, '/j/' + code);
    ({ ctx } = await hostPage(b, code, hostToken)); const page = ctx.pages()[0];
    const payload = '<img src=x onerror=window.__x=1>';
    await page.evaluate((t) => Promise.resolve(window.__liveTranslateTest.feed(t, true)).catch(() => {}), payload);
    await g.page.waitForFunction((t) => document.body.innerText.includes(t), payload, { timeout: 5000 });
    await page.waitForFunction((t) => document.body.innerText.includes(t), payload, { timeout: 5000 });
    assert.equal(await g.page.evaluate(() => window.__x), undefined); assert.equal(await page.evaluate(() => window.__x), undefined);
  } finally { await ctx?.close(); await g?.ctx.close(); close(); }
});

test('M8 browser: without Web Speech the host sees the notice and can still type', async () => {
  const { b, close } = await up({ translator: mock }); let ctx;
  try {
    const { code, hostToken } = await room(b, 'en-zh');
    ({ ctx } = await hostPage(b, code, hostToken, [noSpeech])); const page = ctx.pages()[0];
    await page.waitForSelector('[data-test=nospeech]', { state: 'visible', timeout: 3000 });
    await page.fill('[data-test=type-input]', 'Typed line.'); await page.press('[data-test=type-input]', 'Enter');
    assert.ok(await until(async () => (await transcript(b, code, hostToken)).some((s) => s.text === 'Typed line.'), 5000));
  } finally { await ctx?.close(); close(); }
});

test('M8: QR matrices match a reference encoder (python-qrcode 8.2, ECL M, any of the 8 masks)', () => {
  // sha256(rows of 0/1 joined by \n).slice(0,16) for masks 0..7, generated by the planner with python-qrcode 8.2.
  const GOLD = {
    'https://example.com/j/ABC234': [3, '8f037a5e73e3e3a4 7dabaab1a2078bdd eef0a8f80fb2143e 69e83e13f529834f 2283cc90c6656ff6 41bff993c780728f b0301ac1a82a9027 d6970d570687d62c'],
    'https://live-translate.example.org/j/ABC234?ref=qr-golden-test-0123456789': [5, '724c908c070f4411 d94893a383848e11 eb3599bf97456980 69d3958310e10553 be20105190f7ac59 a368144940ca6d35 a5adf14f7fd49a83 42a38bb2162fe58e'],
    ['https://live-translate.example.org/j/XYZ789?ref=' + 'q'.repeat(150)]: [10, '3fc64a59816c4e9f f1d1808cb9b4e484 ab71d2d2335934c4 334491a3db179ac4 afed81f983348c29 28c36e148d184056 f253aa35e350bef0 4c6f3e47d5c5b27e'],
  };
  for (const [text, [ver, hashes]] of Object.entries(GOLD)) {
    const m = encodeQR(text);
    assert.equal(m.length, 17 + 4 * ver, 'version for ' + text.slice(0, 40));
    const h = crypto.createHash('sha256').update(m.map((r) => r.map((x) => (x ? 1 : 0)).join('')).join('\n')).digest('hex').slice(0, 16);
    assert.ok(hashes.split(' ').includes(h), 'QR matrix differs from the reference for ' + text.slice(0, 40));
  }
});

// ================= MINOR =================
test('m1: interim repeating the last final is dropped; empty interim is a clear signal', async () => {
  const { b, close } = await up();
  try {
    const { code, hostToken } = await room(b, 'en-zh');
    const ev = sse(`${b}/api/rooms/${code}/events`);
    await sleep(100);
    assert.equal((await seg(b, code, { hostToken, text: 'Where is the', lang: 'en', final: true })).status, 200);
    await seg(b, code, { hostToken, text: 'Where is the', lang: 'en', final: false });
    const clr = await seg(b, code, { hostToken, text: '', lang: 'en', final: false });
    assert.equal(clr.status, 200, 'empty interim (clear) must be accepted');
    await sleep(300); ev.close();
    const interims = ev.events.filter((e) => !e.final);
    assert.ok(!interims.some((e) => e.text === 'Where is the'), 'stale interim was broadcast');
    assert.ok(interims.some((e) => e.text === ''), 'clear interim not broadcast');
    assert.equal((await seg(b, code, { hostToken, text: '', lang: 'en', final: true })).status, 400);
  } finally { close(); }
});

test('m2: final must be a boolean', async () => {
  const { b, close } = await up();
  try {
    const { code, hostToken } = await room(b, 'en-zh');
    assert.equal((await seg(b, code, { hostToken, text: 'hi', lang: 'en', final: 'yes' })).status, 400);
    assert.equal((await seg(b, code, { hostToken, text: 'hi', lang: 'en', final: 1 })).status, 400);
  } finally { close(); }
});

test('m3: POST bodies that are not application/json get 415', async () => {
  const { b, close } = await up();
  try {
    const body = JSON.stringify({ direction: 'both' });
    assert.equal((await req('POST', b + '/api/rooms', { body, headers: { 'content-type': 'text/plain' } })).status, 415);
    const { code, hostToken } = await room(b, 'en-zh');
    assert.equal((await req('POST', `${b}/api/rooms/${code}/segments`, { body: JSON.stringify({ hostToken, text: 'hi', lang: 'en', final: true }), headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await req('POST', b + '/api/rooms', { body: { direction: 'both' }, headers: { 'content-type': 'application/json; charset=utf-8' } })).status, 201);
  } finally { close(); }
});

test('m4: QR is privately cached and ignores x-forwarded-proto unless TRUST_PROXY=1', async () => {
  let srv;
  try {
    srv = await up();
    const { code } = await room(srv.b);
    const q = await req('GET', `${srv.b}/api/rooms/${code}/qr.svg`, { headers: { 'x-forwarded-proto': 'https' } });
    assert.match(q.headers['cache-control'], /private/); assert.doesNotMatch(q.headers['cache-control'], /public/);
    assert.equal(q.text, qrSvg(`${srv.b}/j/${code}`));
    srv.close();
    process.env.TRUST_PROXY = '1';
    srv = await up();
    const r2 = await room(srv.b);
    const q2 = await req('GET', `${srv.b}/api/rooms/${r2.code}/qr.svg`, { headers: { 'x-forwarded-proto': 'https' } });
    assert.equal(q2.text, qrSvg(`${srv.b.replace('http:', 'https:')}/j/${r2.code}`));
  } finally { delete process.env.TRUST_PROXY; srv?.close(); }
});

test('m5 browser: typed text is kept when sending fails', async () => {
  const { b, close } = await up({ translator: mock }); let ctx;
  try {
    const { code, hostToken } = await room(b, 'en-zh');
    ({ ctx } = await hostPage(b, code, hostToken, [noSpeech])); const page = ctx.pages()[0];
    let seen = 0;
    await page.route('**/segments', (route) => { seen++; return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"internal error"}' }); });
    await page.fill('[data-test=type-input]', 'Please keep me.'); await page.press('[data-test=type-input]', 'Enter');
    await until(() => seen > 0, 3000); await sleep(1500);
    assert.equal(await page.inputValue('[data-test=type-input]'), 'Please keep me.');
  } finally { await ctx?.close(); close(); }
});

test('m8: host transcript list is not a live region and app.js does not use alert()', () => {
  const host = fs.readFileSync('public/host.html', 'utf8');
  const list = host.match(/<ol[^>]*data-test="segments"[^>]*>/)?.[0] || '';
  assert.ok(list, 'segments list not found'); assert.doesNotMatch(list, /aria-live/);
  assert.doesNotMatch(fs.readFileSync('public/app.js', 'utf8'), /\balert\(/);
});

test('m9 browser: pasting a code with a dash or space keeps all six characters', async () => {
  const { b, close } = await up(); let j;
  try {
    j = await guestPage(b, '/join');
    await j.page.fill('[data-test=code-input]', 'abc-234');
    assert.equal(await j.page.inputValue('[data-test=code-input]'), 'ABC234');
    await j.page.fill('[data-test=code-input]', 'ABC 234');
    assert.equal(await j.page.inputValue('[data-test=code-input]'), 'ABC234');
  } finally { await j?.ctx.close(); close(); }
});

test('m10: Nayuki copyright kept in qr.js, DECISIONS.md records the inline QR', () => {
  assert.ok(/Copyright \(c\) Project Nayuki/.test(fs.readFileSync('src/qr.js', 'utf8')), 'src/qr.js lacks the Nayuki MIT copyright notice');
  assert.ok(fs.existsSync('DECISIONS.md'), 'DECISIONS.md missing');
  assert.match(fs.readFileSync('DECISIONS.md', 'utf8'), /QR/);
});

test('m10: project LICENSE file', () => { assert.ok(fs.existsSync('LICENSE')); });

test('m11: MyMemory HTML entities are decoded', async () => {
  const restore = stubFetch(async () => jsonRes({ responseStatus: 200, responseData: { translatedText: 'It&#39;s &quot;fine&quot; &amp; ok' } }));
  try { assert.equal(await mymemory.translate('Hello', 'en', 'zh'), 'It\'s "fine" & ok'); } finally { restore(); }
});
