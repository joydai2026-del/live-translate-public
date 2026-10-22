// PLANNER-OWNED. Do not edit. Acceptance tests for REVIEW-R2.md (task brief: tasks/T3-review-R2.md).
// No network: loopback only (127.0.0.1 to 127.0.0.5 as source addresses), stubbed fetch for providers, headless
// Chromium from playwright@1.64.1. Deterministic translators (echo, delayed echo, scripted failures).
//
// PLANNER GATES (fail until the planner fixes other planner-owned checks; the coder must NOT touch them):
// - B1: checks/acceptance.test.js and the transcript() helper in checks/review-R1.test.js read transcripts with
//   &token=<hostToken>, and the skipped R1 "M2: transcript requires hostToken or readToken" test is enabled or removed.
// - B2: the R1 "M1: daily translation char budget" test no longer posts to a room that has idled past IDLE_MS.
// - M3: the G7 presence test in checks/grill.test.js opens its host stream with ?role=host&token=<hostToken>.
//
// NEW OR CHANGED INTERFACES these tests rely on (also specified in tasks/T3-review-R2.md):
// B1  GET /api/rooms/:code/transcript requires ?token=<hostToken|readToken>, else 403 (as in checks/grill.test.js G8).
//     The host page download links carry the host token and download with 200.
// M1  POST /api/rooms/:code/segments, final:true, may carry `wait:false`. Then the server answers 200 right after
//     storing and broadcasting, without waiting for the translator: {id, text, speaker, translation:null, pending:true}
//     (or {id, text, speaker, translation} with no pending when the translation is already known, e.g. on-device).
//     The translation arrives on SSE as the same-id update. Without `wait` (or wait:true) nothing changes: the
//     response waits and carries the translation (checks/acceptance.test.js and grill.test.js G1 rely on this).
//     Host and guest pages send wait:false on every final, so open POSTs never pile up on one HTTP/1.1 origin.
// M2  Finals may carry `clientId`: string of 1 to 64 chars from [A-Za-z0-9_-], else 400. Per room and speaker, a final
//     whose clientId was already stored returns 200 with that same segment ({id, text, speaker, translation[, pending]
//     [, error, errorKind]}, waiting for the translation unless wait:false) and is NOT stored, translated or broadcast
//     again (it should not use up rate-limit tokens either). This holds while the first POST is still translating.
//     SSE `segment` events (pending, update, backlog) of a final posted with a clientId include `clientId`.
//     Pages send a fresh random clientId per final and the same one on every retry of it, and the send queue matches
//     its own echo by clientId (m2), not by text.
// M3  GET /api/rooms/:code/events?role=host&token=<hostToken> is the host stream and is not counted in presence.
//     ?role=host without a valid host token counts as a reader. The host page opens its stream with the token.
// M4  Open SSE streams are capped: server.js exports MAX_STREAMS_PER_IP = 20 (across all rooms, by client IP) and
//     MAX_STREAMS_PER_ROOM = 50. Above a cap the events request gets 429 JSON {error} (with retry-after). Closing a
//     stream frees its slot. A stream opened with a valid host token (M3) is exempt from both caps. README "Limits"
//     documents both numbers.
// M5  [data-test=translate-banner] stays inside the viewport when shown, even after the transcript has scrolled
//     (e.g. position: sticky or fixed).
// M6  Host and guest pages key interim cards by speaker as well as id: a host interim and a guest interim are two
//     separate li.interim cards, and an empty "clear" interim removes only the cards of its own speaker.
// M7  A `translation` field on a final is honoured only with a valid hostToken. With a guestToken it is ignored (the
//     server translates) or rejected with 400; never stored or broadcast.
// m1  A provider failure (any errorKind other than budget) gives the reserved characters back to the daily budget.
// m4  POST /api/rooms/:code/guests always requires content-type application/json (415 otherwise, body or not).
//     New: DELETE /api/rooms/:code/guests JSON {hostToken} -> 204, revokes every guest token of the room (their
//     POSTs get 403) and frees the MAX_GUESTS slots; wrong token -> 403.
// m5  Google provider sends the key in the `x-goog-api-key` header, never in the URL.
// m6  Guest footer privacy copy is inside a <details> whose <summary> has "隐私" and "Privacy"; collapsed, the footer
//     is under 120 px tall on a 390x844 phone. Guest copy does not tell the guest to download a transcript.
// m7  Copy: host device note says "Lines translated on this device are not sent to a translation service". English
//     privacy copy on the four pages says "Safari may send it to Apple"; Chinese copy says Safari 可能 ... Apple.
//     README says "Safari may send" and drops "the most natural English and Chinese".
// m8  While the push-to-talk buttons are shown, the host status line and the empty-transcript text mention holding a
//     button (/\bhold\b/i), also after switching the continuous-mode language.
// m9  No stale evidence/grill-fail-*.png files next to a green run.
// m10 md transcript: text and translations cannot form Markdown links, images or raw HTML: no unescaped "](", no
//     unescaped "![", no raw "<" from user text. Plain "[" and "]" may stay (acceptance.test.js expects the md to
//     contain "[zh]Thank you very much.").
// m11 Guest page: [data-test=reader-lang] button with data-lang="zh"|"en" (the reader language), shown in both-ways
//     rooms, toggles on click and is remembered in localStorage. Default: "zh" when navigator.language starts with zh,
//     else "en" (en-zh rooms are always zh, zh-en always en). Each final card not from this guest has [data-test=big]
//     (the text in the reader language: the original when seg.lang equals it, else the translation or its placeholder)
//     and [data-test=small] (the other one).
// m12 rooms.js exports MAX_TOTAL_CHARS (50,000,000) and new RoomStore({maxTotalChars}) caps the stored final text
//     across all rooms; a final over it gets 503 JSON {error}. Deleting or expiring a room frees its characters.
import test, { after } from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import http from 'node:http'; import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { createServer } from '../src/server.js'; import * as rooms from '../src/rooms.js';
import * as server from '../src/server.js'; import * as google from '../src/translate/google.js';

for (const k of ['PUBLIC_URL', 'TRUST_PROXY', 'TRANSLATE_DAILY_CHAR_LIMIT', 'GOOGLE_TRANSLATE_API_KEY']) delete process.env[k];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000, step = 50) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return v; await sleep(step); } }
const echo = () => { const calls = []; return { calls, translate: async (t, f, to) => { calls.push([t, f, to]); return `[${to}]${t}`; } }; };
const slow = (ms) => { const calls = []; return { calls, translate: async (t, f, to) => { calls.push([t, f, to]); await sleep(ms); return `[${to}]${t}`; } }; };
const clock = (t = Date.UTC(2026, 9, 20, 12)) => { const c = { t, now: () => c.t, adv: (ms) => { c.t += ms; } }; return c; };
const cid = () => 'c' + crypto.randomBytes(9).toString('base64url');

async function up({ translator = echo(), ...opts } = {}) {
  const s = createServer({ translator, ...opts });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { s, translator, b: `http://127.0.0.1:${s.address().port}`, close: () => { s.close(); s.closeAllConnections?.(); } };
}
// node:http client (independent of global fetch, which the provider test stubs; `from` picks the source IP).
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
const room = async (b, direction = 'both') => (await req('POST', b + '/api/rooms', { body: { direction } })).json;
const seg = (b, code, body, from) => req('POST', `${b}/api/rooms/${code}/segments`, { body, from });
const guestToken = async (b, code) => (await req('POST', `${b}/api/rooms/${code}/guests`, { body: {} })).json?.guestToken;
const tUrl = (b, code, format, token) => `${b}/api/rooms/${code}/transcript?format=${format}${token ? '&token=' + encodeURIComponent(token) : ''}`;
const transcript = async (b, code, token) => (await req('GET', tUrl(b, code, 'json', token))).json?.segments || [];
// SSE client that keeps the HTTP status and every event: {event, data, t}.
function sse(url, { from } = {}) {
  const out = { all: [], ended: false, status: null };
  const u = new URL(url);
  out.ready = new Promise((resolve) => {
    out.req = http.get({ host: u.hostname, port: u.port, path: u.pathname + u.search, localAddress: from, agent: false }, (res) => {
      out.status = res.statusCode; resolve(res.statusCode);
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
    out.req.on('error', () => { out.ended = true; resolve(out.status ?? 0); });
  });
  out.segs = () => out.all.filter((e) => e.event === 'segment').map((e) => e.data);
  out.readers = () => out.all.filter((e) => e.event === 'presence').at(-1)?.data?.readers;
  out.close = () => out.req.destroy();
  return out;
}
function stubFetch(handler) {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => handler(String(url), init);
  return () => { globalThis.fetch = orig; };
}
const jsonRes = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const read = (f) => fs.readFileSync(f, 'utf8');
const PAGES = ['index.html', 'host.html', 'guest.html', 'join.html'];

// ---------------- Browser helpers ----------------
let br;
const browser = async () => (br ??= await chromium.launch());
after(async () => { await br?.close(); });
function fakeSpeech() {
  window.__recs = [];
  class FakeSR extends EventTarget {
    constructor() { super(); window.__recs.push(this); }
    start() { this.running = true; setTimeout(() => this.onstart?.(new Event('start')), 0); }
    stop() { if (!this.running) return; this.running = false; setTimeout(() => this.onend?.(new Event('end')), 0); }
    abort() { this.stop(); }
  }
  window.SpeechRecognition = FakeSR; window.webkitSpeechRecognition = FakeSR;
}
async function hostPage(b, code, hostToken, scripts = [fakeSpeech]) {
  const ctx = await (await browser()).newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(([c, t]) => { try { sessionStorage.setItem('hostToken:' + c, t); } catch {} }, [code, hostToken]);
  for (const f of scripts) await ctx.addInitScript(f);
  const page = await ctx.newPage();
  await page.goto(`${b}/host/${code}`);
  return { ctx, page };
}
async function guestPage(b, code, { locale = 'zh-CN' } = {}) {
  const ctx = await (await browser()).newContext({ viewport: { width: 390, height: 844 }, isMobile: true, locale });
  const page = await ctx.newPage(); await page.goto(`${b}/j/${code}`); return { ctx, page };
}
const feed = (page, text, isFinal) => page.evaluate(([t, f]) => { Promise.resolve(window.__liveTranslateTest.feed(t, f)).catch(() => {}); }, [text, isFinal]);

// ================= Planner gates (B1, B2, M3): other planner-owned checks must agree with this review =================
test('B1 planner gate: acceptance and R1 checks read transcripts with a token; R1 M2 skip resolved', () => {
  for (const f of ['checks/acceptance.test.js', 'checks/review-R1.test.js']) {
    const lines = read(f).split('\n').filter((l) => l.includes('/transcript?'));
    assert.ok(lines.length, f + ' has no transcript reads');
    for (const l of lines) assert.match(l, /token/, `${f} reads a transcript without a token: ${l.trim().slice(0, 140)}`);
  }
  assert.doesNotMatch(read('checks/review-R1.test.js'), /test\('M2: transcript requires[^\n]*skip:/, 'R1 M2 transcript test is still skipped');
});

test('B2 planner gate: the R1 daily budget test does not post to a room that idled past IDLE_MS', () => {
  const t = read('checks/review-R1.test.js');
  const start = t.indexOf("test('M1: daily translation char budget");
  assert.ok(start >= 0, 'R1 budget test not found');
  const block = t.slice(start, t.indexOf('\ntest(', start + 10));
  const rollover = block.indexOf('c.adv(24 * 60 * 60 * 1000)');
  const ok = rollover < 0 || /idleMs/.test(block) || /room\(/.test(block.slice(rollover));
  assert.ok(ok, 'after advancing 24 h the R1 budget test still posts to the old room (expired after IDLE_MS = 12 h, so 404)');
});

test('M3 planner gate: the G7 presence check opens its host stream with the host token', () => {
  const lines = read('checks/grill.test.js').split('\n').filter((l) => l.includes('events?role=host'));
  assert.ok(lines.length, 'G7 host stream not found');
  for (const l of lines) assert.match(l, /token=/, 'G7 host stream has no token: ' + l.trim());
});

// ================= B1 =================
test('B1 browser: transcript is closed without a token; the host Markdown link still downloads', async () => {
  const { b, close } = await up(); let ctx;
  try {
    const r = await room(b, 'en-zh');
    assert.equal((await seg(b, r.code, { hostToken: r.hostToken, text: 'Private line.', lang: 'en', final: true })).status, 200);
    for (const f of ['json', 'md', 'txt']) assert.equal((await req('GET', tUrl(b, r.code, f))).status, 403, f + ' without a token must be 403');
    assert.equal((await req('GET', tUrl(b, r.code, 'md', r.readToken))).status, 200, 'readToken must open the transcript');
    let page; ({ ctx, page } = await hostPage(b, r.code, r.hostToken));
    const href = await until(async () => { const h = await page.getAttribute('[data-test=download-md]', 'href'); return h && h.includes('token=') ? h : null; }, 3000);
    assert.ok(href, 'host Markdown link carries no token');
    const got = await req('GET', new URL(href, b).href);
    assert.equal(got.status, 200); assert.ok(got.text.includes('Private line.'), 'downloaded md lacks the line');
  } finally { await ctx?.close(); close(); }
});

// ================= B2 (correct version of the R1 check; passes against correct code) =================
test('B2: the daily budget resets on the next UTC day (fresh room, same server)', async () => {
  const c = clock(); const tr = echo();
  const { b, close } = await up({ translator: tr, store: new rooms.RoomStore({ now: c.now }), now: c.now, dailyCharLimit: 50 });
  try {
    const a = await room(b, 'en-zh');
    assert.equal((await seg(b, a.code, { hostToken: a.hostToken, text: 'a'.repeat(30), lang: 'en', final: true })).json.translation, '[zh]' + 'a'.repeat(30));
    c.adv(2000);
    assert.equal((await seg(b, a.code, { hostToken: a.hostToken, text: 'b'.repeat(30), lang: 'en', final: true })).json.errorKind, 'budget');
    c.adv(24 * 60 * 60 * 1000);
    const n = await room(b, 'en-zh');
    const r = await seg(b, n.code, { hostToken: n.hostToken, text: 'c'.repeat(30), lang: 'en', final: true });
    assert.equal(r.status, 200); assert.equal(r.json.translation, '[zh]' + 'c'.repeat(30), 'budget must reset on the next UTC day');
    assert.equal(tr.calls.length, 2);
  } finally { close(); }
});

// ================= M1 =================
test('M1: a final with wait:false is answered at once; the translation follows on SSE', async () => {
  const tr = slow(1500); const { b, close } = await up({ translator: tr });
  try {
    const { code, hostToken } = await room(b, 'en-zh');
    const ev = sse(`${b}/api/rooms/${code}/events`); await ev.ready;
    const t0 = Date.now();
    const r = await seg(b, code, { hostToken, text: 'Slow line.', lang: 'en', final: true, wait: false });
    const dt = Date.now() - t0;
    assert.equal(r.status, 200);
    assert.ok(dt < 600, `wait:false POST took ${dt} ms (must not wait for the 1500 ms translator)`);
    assert.equal(typeof r.json.id, 'number'); assert.equal(r.json.pending, true); assert.equal(r.json.translation ?? null, null);
    const upd = await until(() => ev.segs().find((s) => s.final && s.id === r.json.id && s.translation === '[zh]Slow line.'), 4000);
    assert.ok(upd, 'translation update never arrived on SSE');
    assert.equal(tr.calls.length, 1);
    ev.close();
    // Without `wait` the planner interface is unchanged: the response carries the translation.
    const w = await seg(b, code, { hostToken, text: 'Waited line.', lang: 'en', final: true });
    assert.equal(w.json.translation, '[zh]Waited line.');
  } finally { close(); }
});

test('M1 browser: with a 4 s translator, 10 fast finals and interims reach readers within 1 s each', async () => {
  const { b, close } = await up({ translator: slow(4000) }); let ctx;
  try {
    const { code, hostToken } = await room(b, 'en-zh');
    const ev = sse(`${b}/api/rooms/${code}/events`); await ev.ready;
    let page; ({ ctx, page } = await hostPage(b, code, hostToken));
    await page.waitForFunction(() => window.__liveTranslateTest?.feed, null, { timeout: 5000 });
    await sleep(300);
    const fedFinal = {}; const fedInterim = {};
    for (let i = 1; i <= 10; i++) {
      fedFinal[i] = Date.now(); await feed(page, `Line ${i}.`, true);
      await sleep(150);
      if (i < 10) { fedInterim[i] = Date.now(); await feed(page, `partial words ${i}`, false); }
      await sleep(150);
    }
    await until(() => ev.segs().filter((s) => s.final && s.translation).length >= 10, 15000, 100);
    ev.close();
    const late = [];
    for (let i = 1; i <= 10; i++) {
      const first = ev.all.find((e) => e.event === 'segment' && e.data.final && e.data.text === `Line ${i}.`);
      if (!first) late.push(`Line ${i}. never arrived`);
      else if (first.t - fedFinal[i] > 1000) late.push(`Line ${i}. after ${first.t - fedFinal[i]} ms`);
    }
    assert.deepEqual(late, [], 'originals held back by open POSTs');
    const ids = ev.segs().filter((s) => s.final && s.translation).map((s) => [s.text, s.id]).sort((x, y) => x[1] - y[1]).map((x) => x[0]);
    assert.deepEqual(ids, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => `Line ${i}.`), 'ids must follow feed order');
    const interims = Object.keys(fedInterim).map((i) => [i, ev.all.find((e) => e.event === 'segment' && !e.data.final && e.data.text === `partial words ${i}`)]);
    const arrived = interims.filter(([, e]) => e);
    assert.ok(arrived.length >= 7, `only ${arrived.length} of 9 interims were broadcast`);
    for (const [i, e] of arrived) assert.ok(e.t - fedInterim[i] <= 1000, `interim ${i} broadcast after ${e.t - fedInterim[i]} ms`);
  } finally { await ctx?.close(); close(); }
});

// ================= M2 =================
test('M2: a repeated clientId returns the same segment; one line, one translator call', async () => {
  const tr = echo(); const { b, close } = await up({ translator: tr });
  try {
    const { code, hostToken } = await room(b, 'en-zh');
    const id = cid();
    const a = await seg(b, code, { hostToken, text: 'Hello again.', lang: 'en', final: true, clientId: id });
    const r = await seg(b, code, { hostToken, text: 'Hello again.', lang: 'en', final: true, clientId: id });
    assert.equal(a.status, 200); assert.equal(r.status, 200);
    assert.equal(r.json.id, a.json.id, 'retry got a new id');
    assert.equal(r.json.translation, '[zh]Hello again.');
    assert.equal(tr.calls.length, 1, 'retry was translated again');
    // Same text, other clientId: a real new line.
    await seg(b, code, { hostToken, text: 'Hello again.', lang: 'en', final: true, clientId: cid() });
    assert.deepEqual((await transcript(b, code, hostToken)).map((s) => s.text), ['Hello again.', 'Hello again.']);
    assert.equal((await seg(b, code, { hostToken, text: 'x', lang: 'en', final: true, clientId: 'bad id!' })).status, 400, 'invalid clientId');
    assert.equal((await seg(b, code, { hostToken, text: 'x', lang: 'en', final: true, clientId: 'a'.repeat(65) })).status, 400, 'clientId too long');
  } finally { close(); }
});

test('M2: a retry that arrives while the first POST is still translating is deduplicated', async () => {
  const tr = slow(800); const { b, close } = await up({ translator: tr });
  try {
    const { code, hostToken } = await room(b, 'en-zh');
    const ev = sse(`${b}/api/rooms/${code}/events`); await ev.ready;
    const id = cid();
    const body = { hostToken, text: 'Lost response.', lang: 'en', final: true, clientId: id };
    const first = seg(b, code, body); await sleep(200);
    const [x, y] = await Promise.all([first, seg(b, code, body)]);
    assert.equal(y.json.id, x.json.id); assert.equal(tr.calls.length, 1);
    assert.equal((await transcript(b, code, hostToken)).length, 1);
    await sleep(200); ev.close();
    const finals = ev.segs().filter((s) => s.final);
    assert.ok(finals.every((s) => s.id === x.json.id), 'a second line was broadcast');
    assert.ok(finals.length <= 2, 'the repeat was broadcast again');
    assert.ok(finals.every((s) => s.clientId === id), 'm2: SSE finals must echo their clientId');
  } finally { close(); }
});

test('M2 browser: a final whose response is lost after reaching the server is stored once', async () => {
  const { b, close } = await up(); let ctx;
  try {
    const { code, hostToken } = await room(b, 'en-zh');
    let page; ({ ctx, page } = await hostPage(b, code, hostToken));
    let cut = 0;
    await page.route('**/segments', async (route) => {
      const body = route.request().postDataJSON?.() || {};
      if (body.final === true && cut === 0) { cut++; await route.fetch().catch(() => {}); return route.abort('connectionreset'); }
      return route.continue();
    });
    await page.waitForFunction(() => window.__liveTranslateTest?.feed, null, { timeout: 5000 });
    await feed(page, 'Only once.', true);
    await feed(page, 'Second line.', true);
    await until(async () => (await transcript(b, code, hostToken)).some((s) => s.text === 'Second line.'), 10000, 100);
    await sleep(1500);
    assert.equal(cut, 1);
    assert.deepEqual((await transcript(b, code, hostToken)).map((s) => s.text), ['Only once.', 'Second line.']);
  } finally { await ctx?.close(); close(); }
});

// ================= M3 =================
test('M3: ?role=host needs the host token to stay out of the reader count', async () => {
  const { b, close } = await up();
  try {
    const { code, hostToken } = await room(b, 'en-zh');
    const eaves = sse(`${b}/api/rooms/${code}/events?role=host`);
    assert.equal(await until(() => eaves.readers() === 1, 2000), true, '?role=host without a token must count as a reader');
    const host = sse(`${b}/api/rooms/${code}/events?role=host&token=${encodeURIComponent(hostToken)}`);
    assert.equal(await until(() => host.readers() === 1, 2000), true, 'the real host stream must not be counted');
    const wrong = sse(`${b}/api/rooms/${code}/events?role=host&token=${'x'.repeat(hostToken.length)}`);
    assert.equal(await until(() => host.readers() === 2, 2000), true, 'a wrong token must count as a reader');
    eaves.close(); host.close(); wrong.close();
  } finally { close(); }
});

test('M3 browser: the host page is not counted, an untokened ?role=host stream is', async () => {
  const { b, close } = await up(); let ctx;
  try {
    const { code, hostToken } = await room(b, 'en-zh');
    let page; ({ ctx, page } = await hostPage(b, code, hostToken));
    await sleep(800);
    assert.equal((await page.textContent('[data-test=readers]')).trim(), '0', 'host page counts itself');
    const eaves = sse(`${b}/api/rooms/${code}/events?role=host`);
    const shown = await until(async () => (await page.textContent('[data-test=readers]')).trim() === '1', 3000);
    eaves.close();
    assert.ok(shown, 'silent eavesdropper is invisible to the host');
  } finally { await ctx?.close(); close(); }
});

// ================= M4 =================
test('M4: at most 20 open streams per IP across rooms; a closed stream frees its slot', async () => {
  const { b, close } = await up();
  try {
    assert.equal(server.MAX_STREAMS_PER_IP, 20);
    const ra = await room(b); const rb = await room(b); const rc = await room(b);
    const open = [];
    for (let i = 0; i < 20; i++) {
      const s = sse(`${b}/api/rooms/${(i % 2 ? ra : rb).code}/events`, { from: '127.0.0.1' });
      open.push(s); assert.equal(await s.ready, 200, 'stream ' + (i + 1));
    }
    const extra = sse(`${b}/api/rooms/${rc.code}/events`, { from: '127.0.0.1' });
    assert.equal(await extra.ready, 429, 'stream 21 from one IP must get 429');
    open.shift().close();
    const again = await until(async () => { const s = sse(`${b}/api/rooms/${rc.code}/events`, { from: '127.0.0.1' }); if ((await s.ready) === 200) return s; s.close(); return null; }, 3000, 100);
    assert.ok(again, 'closing a stream must free its slot'); open.push(again);
    const other = sse(`${b}/api/rooms/${rc.code}/events`, { from: '127.0.0.2' });
    assert.equal(await other.ready, 200, 'other IPs are unaffected'); open.push(other);
    for (const s of open) s.close();
  } finally { close(); }
});

test('M4: at most 50 open streams per room; the tokened host stream still connects', async () => {
  const { b, close } = await up();
  try {
    assert.equal(server.MAX_STREAMS_PER_ROOM, 50);
    const { code, hostToken } = await room(b);
    const open = [];
    for (const [ip, n] of [['127.0.0.2', 20], ['127.0.0.3', 20], ['127.0.0.4', 10]]) {
      for (let i = 0; i < n; i++) { const s = sse(`${b}/api/rooms/${code}/events`, { from: ip }); open.push(s); assert.equal(await s.ready, 200, `${ip} stream ${i + 1}`); }
    }
    const extra = sse(`${b}/api/rooms/${code}/events`, { from: '127.0.0.5' });
    assert.equal(await extra.ready, 429, 'stream 51 in one room must get 429');
    const host = sse(`${b}/api/rooms/${code}/events?role=host&token=${encodeURIComponent(hostToken)}`, { from: '127.0.0.5' });
    assert.equal(await host.ready, 200, 'the host must always get its stream'); open.push(host);
    for (const s of open) s.close();
  } finally { close(); }
});

test('M4: README limits section documents the stream caps', () => {
  const t = read('README.md');
  const i = t.indexOf('## Limits'); assert.ok(i >= 0, 'README has no Limits section');
  const sec = t.slice(i, t.indexOf('\n## ', i + 5) >>> 0);
  assert.match(sec, /stream/i); assert.match(sec, /\b20\b/); assert.match(sec, /\b50\b/);
});

// ================= M5 =================
test('M5 browser: the translation banner is inside the viewport after a long transcript', async () => {
  const translator = { translate: async (t, f, to) => { if (t.includes('QUOTA')) throw Object.assign(new Error('quota used up'), { kind: 'quota' }); return `[${to}]${t}`; } };
  const { b, close } = await up({ translator }); let ctx;
  try {
    const { code, hostToken } = await room(b, 'en-zh');
    let page; ({ ctx, page } = await hostPage(b, code, hostToken));
    await page.waitForFunction(() => window.__liveTranslateTest?.feed, null, { timeout: 5000 });
    for (let i = 1; i <= 20; i++) { await feed(page, `This is transcript line number ${i}, long enough to take some room.`, true); await sleep(120); }
    await page.waitForFunction(() => document.querySelectorAll('[data-test=segments] li:not(.interim)').length >= 20, null, { timeout: 20000 });
    await feed(page, 'QUOTA line.', true);
    await page.waitForSelector('[data-test=translate-banner]', { state: 'visible', timeout: 8000 });
    await sleep(400);
    const box = await page.locator('[data-test=translate-banner]').boundingBox();
    const vh = await page.evaluate(() => window.innerHeight);
    const sy = await page.evaluate(() => window.scrollY);
    assert.ok(sy > 0, 'test setup: the page did not scroll');
    assert.ok(box && box.y >= 0 && box.y < vh, `banner is off-screen (y=${box?.y}, viewport ${vh})`);
  } finally { await ctx?.close(); close(); }
});

// ================= M6 =================
test('M6 browser: host and guest interims are separate cards; a guest clear keeps the host card', async () => {
  const { b, close } = await up(); const ctxs = [];
  try {
    const { code, hostToken } = await room(b, 'both');
    const h = await hostPage(b, code, hostToken); ctxs.push(h.ctx);
    const g = await guestPage(b, code); ctxs.push(g.ctx);
    const gt = await guestToken(b, code); assert.ok(gt, 'no guest token');
    await sleep(500);
    assert.equal((await seg(b, code, { hostToken, text: 'Hello', lang: 'en', final: false })).status, 200);
    assert.equal((await seg(b, code, { guestToken: gt, text: '你好', lang: 'zh', final: false })).status, 200);
    const cards = (page) => page.evaluate(() => [...document.querySelectorAll('[data-test=segments] li.interim')].map((li) => li.innerText));
    for (const [name, page] of [['host', h.page], ['guest', g.page]]) {
      const ok = await until(async () => { const c = await cards(page); return c.length === 2 && c.some((t) => t.includes('Hello')) && c.some((t) => t.includes('你好')); }, 3000);
      assert.ok(ok, `${name} page interim cards: ${JSON.stringify(await cards(page))}`);
    }
    assert.equal((await seg(b, code, { guestToken: gt, text: '', lang: 'zh', final: false })).status, 200);
    await sleep(600);
    for (const [name, page] of [['host', h.page], ['guest', g.page]]) {
      const c = await cards(page);
      assert.ok(c.some((t) => t.includes('Hello')), `${name}: the guest clear removed the host interim`);
      assert.ok(!c.some((t) => t.includes('你好')), `${name}: the guest interim was not cleared`);
    }
  } finally { for (const c of ctxs) await c.close(); close(); }
});

// ================= M7 =================
test('M7: a guest cannot attach its own translation', async () => {
  const tr = echo(); const { b, close } = await up({ translator: tr });
  try {
    const { code, hostToken } = await room(b, 'en-zh');
    const gt = await guestToken(b, code);
    const r = await seg(b, code, { guestToken: gt, text: '我同意', lang: 'zh', final: true, translation: 'I refuse' });
    if (r.status === 400) return;
    assert.equal(r.status, 200);
    assert.notEqual(r.json.translation, 'I refuse');
    assert.equal(r.json.translation, '[en]我同意'); assert.equal(tr.calls.length, 1);
    assert.ok(!(await transcript(b, code, hostToken)).some((s) => s.translation === 'I refuse'), 'guest translation was stored');
  } finally { close(); }
});

// ================= MINOR =================
test('m1: a provider failure refunds the daily budget', async () => {
  let n = 0; const translator = { translate: async (t, f, to) => { if (n++ === 0) throw Object.assign(new Error('slow provider'), { kind: 'timeout' }); return `[${to}]${t}`; } };
  const { b, close } = await up({ translator, dailyCharLimit: 50 });
  try {
    const { code, hostToken } = await room(b, 'en-zh');
    assert.equal((await seg(b, code, { hostToken, text: 'a'.repeat(30), lang: 'en', final: true })).json.errorKind, 'timeout');
    const r = await seg(b, code, { hostToken, text: 'b'.repeat(30), lang: 'en', final: true });
    assert.equal(r.json.translation, '[zh]' + 'b'.repeat(30), 'failed call still counted against the budget');
  } finally { close(); }
});

test('m3: README PUBLIC_URL row mentions the LAN address fallback', () => {
  const row = read('README.md').split('\n').find((l) => /^\|\s*`PUBLIC_URL`/.test(l));
  assert.ok(row, 'no PUBLIC_URL row in the env table');
  assert.match(row, /LAN|private network/i);
  assert.ok(!row.includes("Without it, the address of the host's request is used."), 'stale PUBLIC_URL row');
});

test('m4: POST /guests always needs JSON; the host can reset guest tokens', async () => {
  const { b, close } = await up();
  try {
    const { code, hostToken } = await room(b, 'en-zh');
    assert.equal((await req('POST', `${b}/api/rooms/${code}/guests`)).status, 415, 'bodyless POST /guests must be 415');
    assert.equal((await req('POST', `${b}/api/rooms/${code}/guests`, { body: '{}', headers: { 'content-type': 'text/plain' } })).status, 415);
    const tokens = []; for (let i = 0; i < rooms.MAX_GUESTS; i++) tokens.push(await guestToken(b, code));
    assert.ok(tokens.every(Boolean));
    assert.equal((await req('POST', `${b}/api/rooms/${code}/guests`, { body: {} })).status, 429, 'guest slots are full');
    assert.equal((await req('DELETE', `${b}/api/rooms/${code}/guests`, { body: { hostToken: 'x'.repeat(hostToken.length) } })).status, 403);
    assert.equal((await req('DELETE', `${b}/api/rooms/${code}/guests`, { body: { hostToken } })).status, 204, 'host reset guests');
    assert.equal((await seg(b, code, { guestToken: tokens[0], text: '你好', lang: 'zh', final: true })).status, 403, 'revoked guest token still works');
    assert.equal((await req('POST', `${b}/api/rooms/${code}/guests`, { body: {} })).status, 201, 'reset did not free the slots');
  } finally { close(); }
});

test('m5: Google key travels in the x-goog-api-key header, not the URL', async () => {
  process.env.GOOGLE_TRANSLATE_API_KEY = 'test-google-key';
  let seen;
  const restore = stubFetch(async (url, init) => { seen = { url, headers: new Headers(init.headers) }; return jsonRes({ data: { translations: [{ translatedText: '你好' }] } }); });
  try {
    assert.equal(await google.translate('Hello', 'en', 'zh'), '你好');
    assert.ok(!/[?&]key=/.test(seen.url) && !seen.url.includes('test-google-key'), 'key in URL: ' + seen.url);
    assert.equal(seen.headers.get('x-goog-api-key'), 'test-google-key');
  } finally { restore(); delete process.env.GOOGLE_TRANSLATE_API_KEY; }
});

test('m6: guest privacy copy is collapsed and does not promise a guest download', () => {
  const t = read('public/guest.html');
  assert.ok(!t.includes('Download your transcript'), 'guest copy tells the guest to download');
  assert.ok(!t.includes('离开前请下载记录'), 'Chinese guest copy tells the guest to download');
  const d = t.match(/<details[\s\S]*?<\/details>/); assert.ok(d, 'guest footer has no <details>');
  const s = d[0].match(/<summary[\s\S]*?<\/summary>/); assert.ok(s, '<details> has no <summary>');
  assert.match(s[0], /隐私/); assert.match(s[0], /Privacy/);
});

test('m6 browser: collapsed guest footer is under 120 px on a 390x844 phone', async () => {
  const { b, close } = await up(); let ctx;
  try {
    const { code, hostToken } = await room(b, 'en-zh');
    await seg(b, code, { hostToken, text: 'Hello there.', lang: 'en', final: true });
    let page; ({ ctx, page } = await guestPage(b, code));
    await page.waitForFunction(() => document.body.innerText.includes('[zh]Hello there.'), null, { timeout: 5000 });
    const box = await page.locator('footer').boundingBox();
    assert.ok(box && box.height < 120, `guest footer is ${box?.height} px tall`);
  } finally { await ctx?.close(); close(); }
});

test('m7: copy does not overclaim (device translation, Apple, DeepL)', () => {
  const host = read('public/host.html');
  assert.ok(!host.includes('so the text does not go to a translation service'));
  assert.ok(host.includes('Lines translated on this device are not sent to a translation service'));
  for (const f of PAGES) {
    const t = read('public/' + f);
    assert.ok(!/Safari sends it to Apple|Safari uses Apple/.test(t), f + ' says Safari sends audio to Apple');
    assert.match(t, /Safari may send it to Apple/, f);
    if (/[一-鿿]/.test(t) && t.includes('Apple')) {
      assert.ok(!t.includes('Safari 则发送给 Apple'), f + ' Chinese copy overclaims');
      for (const m of (t.match(/Safari[^。；<]*Apple/g) || []).filter((x) => /[一-鿿]/.test(x))) assert.match(m, /可能/, f + ': ' + m);
    }
  }
  const r = read('README.md');
  assert.ok(!/Safari uses Apple|Safari sends it to Apple/.test(r)); assert.match(r, /Safari may send/);
  assert.ok(!r.includes('the most natural English and Chinese'), 'unsourced DeepL quality claim');
});

test('m8 browser: host status and empty text explain holding a button while push-to-talk is shown', async () => {
  const { b, close } = await up();
  try {
    for (const dir of ['en-zh', 'zh-en', 'both']) {
      const { code, hostToken } = await room(b, dir);
      const { ctx, page } = await hostPage(b, code, hostToken);
      try {
        await sleep(700);
        if (dir === 'both') { await page.click('[data-test=lang-zh]'); await sleep(200); }
        const status = (await page.textContent('[data-test=status]')).trim();
        const empty = (await page.textContent('[data-test=empty]')).trim();
        assert.match(status, /\bhold\b/i, `${dir} status: ${status}`);
        assert.match(empty, /\bhold\b/i, `${dir} empty text: ${empty}`);
      } finally { await ctx.close(); }
    }
  } finally { close(); }
});

test('m9: no stale failure screenshots in evidence/', () => {
  const stale = fs.existsSync('evidence') ? fs.readdirSync('evidence').filter((f) => /^grill-fail-/.test(f)) : [];
  assert.deepEqual(stale, []);
});

test('m10: md transcript cannot carry links, images or raw HTML from speech or replies', async () => {
  const { b, close } = await up();
  try {
    const { code, hostToken } = await room(b, 'en-zh');
    const gt = await guestToken(b, code);
    await seg(b, code, { hostToken, text: '![x](https://tracker.example/p.png) and <img src="https://tracker.example/q.png">', lang: 'en', final: true });
    await seg(b, code, { guestToken: gt, text: '[点这里](https://evil.example/)', lang: 'zh', final: true });
    await seg(b, code, { hostToken, text: 'Thank you.', lang: 'en', final: true });
    const md = (await req('GET', tUrl(b, code, 'md', hostToken))).text;
    assert.doesNotMatch(md, /(?<!\\)!\[/, 'unescaped image syntax');
    assert.doesNotMatch(md, /(?<!\\)\]\(/, 'unescaped link syntax');
    assert.ok(!md.includes('<img'), 'raw HTML from user text');
    assert.ok(md.includes('[zh]Thank you.'), 'plain brackets must stay (acceptance.test.js relies on them)');
  } finally { close(); }
});

test('m11 browser: guest reader language picks which text is big, toggles and is remembered', async () => {
  const { b, close } = await up(); let ctx;
  try {
    const { code, hostToken } = await room(b, 'both');
    await seg(b, code, { hostToken, text: 'Hello.', lang: 'en', final: true });
    await seg(b, code, { hostToken, text: '火车站在前面。', lang: 'zh', final: true });
    let page; ({ ctx, page } = await guestPage(b, code, { locale: 'zh-CN' }));
    const cards = () => page.evaluate(() => [...document.querySelectorAll('[data-test=segments] li:not(.mine)')].map((li) => [li.querySelector('[data-test=big]')?.textContent?.trim(), li.querySelector('[data-test=small]')?.textContent?.trim()]));
    const want = (x) => until(async () => JSON.stringify(await cards()) === JSON.stringify(x), 4000);
    const zh = [['[zh]Hello.', 'Hello.'], ['火车站在前面。', '[en]火车站在前面。']];
    const en = [['Hello.', '[zh]Hello.'], ['[en]火车站在前面。', '火车站在前面。']];
    assert.ok(await want(zh), 'zh reader: ' + JSON.stringify(await cards()));
    assert.equal(await page.getAttribute('[data-test=reader-lang]', 'data-lang'), 'zh');
    await page.click('[data-test=reader-lang]');
    assert.ok(await want(en), 'en reader: ' + JSON.stringify(await cards()));
    assert.equal(await page.getAttribute('[data-test=reader-lang]', 'data-lang'), 'en');
    await page.reload();
    assert.ok(await want(en), 'reader language not remembered: ' + JSON.stringify(await cards()));
  } finally { await ctx?.close(); close(); }
});

test('m12: a global stored-text cap returns 503; other rooms still read; deleting a room frees space', async () => {
  const store = new rooms.RoomStore({ maxTotalChars: 100 });
  const { b, close } = await up({ store });
  try {
    assert.equal(rooms.MAX_TOTAL_CHARS, 50_000_000);
    const a = await room(b, 'en-zh'); const c = await room(b, 'en-zh');
    assert.equal((await seg(b, a.code, { hostToken: a.hostToken, text: 'a'.repeat(60), lang: 'en', final: true })).status, 200);
    assert.equal((await seg(b, c.code, { hostToken: c.hostToken, text: 'c'.repeat(30), lang: 'en', final: true })).status, 200);
    const over = await seg(b, c.code, { hostToken: c.hostToken, text: 'd'.repeat(20), lang: 'en', final: true });
    assert.equal(over.status, 503, 'over the global cap'); assert.equal(typeof over.json?.error, 'string');
    assert.equal((await transcript(b, a.code, a.hostToken)).length, 1, 'other rooms still read fine');
    assert.equal((await req('DELETE', `${b}/api/rooms/${a.code}`, { body: { hostToken: a.hostToken } })).status, 204);
    assert.equal((await seg(b, c.code, { hostToken: c.hostToken, text: 'd'.repeat(20), lang: 'en', final: true })).status, 200, 'deleting a room must free its chars');
  } finally { close(); }
});
