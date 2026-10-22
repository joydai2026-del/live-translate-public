// PLANNER-OWNED. Do not edit. Browser acceptance for docs/GRILL.md "Top 8 changes" (brief: tasks/T4-grill.md).
// Same tools as checks/e2e.mjs: playwright chromium, in-process server, deterministic translators, no network.
// Unlike e2e.mjs every scenario runs (one failure does not hide the others); exit 1 if any failed.
// Screenshots: evidence/grill-*.png. Interfaces: see the header of checks/grill.test.js and tasks/T4-grill.md.
// Browser hooks used here (data-test): ptt-en, ptt-zh (host hold-to-talk), reply-input + reply-form (guest typing),
// guest-talk (guest hold-to-speak), read-aloud (guest toggle, aria-pressed), readers (host reader count, text = number),
// network-hint (host, same Wi-Fi / hotspot hint), translate-banner, end-room (+ optional end-room-confirm), status.
import { chromium } from 'playwright'; import fs from 'node:fs'; import net from 'node:net'; import { spawn } from 'node:child_process';
import { createServer } from '../src/server.js'; import * as mock from '../src/translate/mock.js'; import { qrSvg } from '../src/qr.js';

for (const k of ['PUBLIC_URL', 'TRUST_PROXY', 'TRANSLATE_DAILY_CHAR_LIMIT', 'MYMEMORY_EMAIL']) delete process.env[k];
fs.mkdirSync('evidence', { recursive: true });
const realFetch = globalThis.fetch;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CJK = /[一-鿿]/;
async function until(fn, ms = 5000, step = 50) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return v; await sleep(step); } }
const must = (c, m) => { if (!c) throw new Error(m); };
const delayed = (ms, base = mock) => { const calls = []; return { calls, translate: async (t, f, to) => { calls.push(t); await sleep(typeof ms === 'function' ? ms(t) : ms); return base.translate(t, f, to); } }; };

async function up(translator = mock) {
  const s = createServer({ translator });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { s, b: `http://127.0.0.1:${s.address().port}`, close: () => { s.close(); s.closeAllConnections?.(); } };
}
const api = (b, p, method = 'GET', body) => realFetch(b + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
const room = async (b, direction) => (await api(b, '/api/rooms', 'POST', { direction })).json();
const seg = async (b, code, body) => api(b, `/api/rooms/${code}/segments`, 'POST', body);
const transcript = async (b, code, token) => ((await (await api(b, `/api/rooms/${code}/transcript?format=json&token=${encodeURIComponent(token)}`)).json().catch(() => ({}))).segments || []);

// ---- page stubs (run as init scripts) ----
function fakeSpeech() {
  window.__recs = []; window.__stops = 0; window.__aborts = 0; window.__finalOnStop = null;
  const fire = (t, name, ev) => { if (typeof t['on' + name] === 'function') t['on' + name](ev); else t.dispatchEvent(ev); };
  const result = (rec, resultIndex, items) => {
    const results = items.map(([t, f]) => { const r = [{ transcript: t, confidence: 0.9 }]; r.isFinal = f; r.item = (i) => r[i]; return r; });
    results.item = (i) => results[i];
    const ev = new Event('result'); ev.resultIndex = resultIndex; ev.results = results; fire(rec, 'result', ev);
  };
  class FakeSR extends EventTarget {
    constructor() { super(); window.__recs.push(this); }
    start() { this.running = true; setTimeout(() => fire(this, 'start', new Event('start')), 0); }
    stop() {
      window.__stops++; if (!this.running) return; this.running = false;
      const t = window.__finalOnStop; window.__finalOnStop = null;
      // Like a real recognizer: the last words are finalized after stop(), then `end`.
      setTimeout(() => { if (t) result(this, 0, [[t, true]]); setTimeout(() => fire(this, 'end', new Event('end')), 10); }, 30);
    }
    abort() { window.__aborts++; if (!this.running) return; this.running = false; setTimeout(() => fire(this, 'end', new Event('end')), 0); }
  }
  window.SpeechRecognition = FakeSR; window.webkitSpeechRecognition = FakeSR;
  window.__emit = (resultIndex, items) => { const rec = [...window.__recs].reverse().find((r) => r.running); if (!rec) throw new Error('no running recognizer'); result(rec, resultIndex, items); };
  window.__killRunning = () => { for (const r of window.__recs) if (r.running) { r.running = false; fire(r, 'end', new Event('end')); } };
}
function fakeTts() {
  window.__spoken = [];
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: { speak: (u) => window.__spoken.push({ text: u.text, lang: u.lang }), cancel() {}, pause() {}, resume() {}, getVoices: () => [], speaking: false, pending: false, paused: false, addEventListener() {}, removeEventListener() {} } });
}
function fakeTranslatorApi() {
  window.__deviceTr = [];
  self.Translator = {
    availability: async () => 'available',
    create: async (o) => { window.__deviceTr.push(o); return { translate: async (t) => '本地:' + t, destroy() {} }; },
  };
}
function fakeVisibility() {
  let state = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => state === 'hidden' });
  window.__setVisibility = (s) => { state = s; document.dispatchEvent(new Event('visibilitychange')); };
}

let br;
async function hostPage(b, code, hostToken, scripts = [fakeSpeech]) {
  const ctx = await br.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(([c, t]) => { try { sessionStorage.setItem('hostToken:' + c, t); } catch {} }, [code, hostToken]);
  for (const f of scripts) await ctx.addInitScript(f);
  const page = await ctx.newPage(); await page.goto(`${b}/host/${code}`);
  return page;
}
async function guestPage(b, code, scripts = [], clock = false) {
  const ctx = await br.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  for (const f of scripts) await ctx.addInitScript(f);
  const page = await ctx.newPage();
  if (clock) await page.clock.install();
  await page.goto(`${b}/j/${code}`);
  return page;
}
async function hold(page, sel, during) {
  await page.locator(sel).scrollIntoViewIfNeeded(); await page.locator(sel).hover(); await page.mouse.down();
  try { await during(); } finally { await page.mouse.up(); }
}

// ---- runner ----
const results = []; const cleanup = [];
async function scenario(name, fn) {
  const t0 = Date.now(); const pages = [];
  try { await fn(pages); results.push([true, name]); console.log('ok  ', name, `(${Date.now() - t0} ms)`); }
  catch (e) {
    results.push([false, name, e.message]); console.error('FAIL', name, '\n     ', e.message);
    const slug = name.split(' ')[0].toLowerCase();
    for (const [i, p] of pages.entries()) await p.screenshot({ path: `evidence/grill-fail-${slug}-${i}.png` }).catch(() => {});
  } finally {
    for (const p of pages) await p.context().close().catch(() => {});
    while (cleanup.length) { try { await cleanup.pop()(); } catch {} }
  }
}

br = await chromium.launch();

// ================= G1 =================
await scenario('G1 guest sees the original of line 2 within 500 ms while line 1 is still translating', async (pages) => {
  const { b, close } = await up(delayed(5000)); cleanup.push(close);
  const { code, hostToken } = await room(b, 'en-zh');
  const guest = await guestPage(b, code); pages.push(guest);
  const host = await hostPage(b, code, hostToken); pages.push(host);
  await sleep(500);
  await guest.evaluate(() => { window.__seen = {}; new MutationObserver(() => { for (const t of ['Line one.', 'Line two.']) if (!window.__seen[t] && document.body.innerText.includes(t)) window.__seen[t] = Date.now(); }).observe(document.body, { subtree: true, childList: true, characterData: true }); });
  await host.evaluate(() => { Promise.resolve(window.__liveTranslateTest.feed('Line one.', true)).catch(() => {}); });
  await sleep(150);
  const t2 = await host.evaluate(() => { const t = Date.now(); Promise.resolve(window.__liveTranslateTest.feed('Line two.', true)).catch(() => {}); return t; });
  await guest.waitForFunction(() => window.__seen['Line two.'], null, { timeout: 3000 }).catch(() => {});
  const seen = await guest.evaluate(() => window.__seen);
  must(seen['Line one.'], 'line 1 original never shown on the guest before its translation');
  must(seen['Line two.'], 'line 2 original never shown on the guest');
  must(seen['Line two.'] - t2 <= 500, `line 2 original took ${seen['Line two.'] - t2} ms on the guest (limit 500)`);
  const bodyNow = await guest.innerText('body');
  must(!bodyNow.includes('[zh] Line one.'), 'line 1 translation should still be pending');
  await guest.screenshot({ path: 'evidence/grill-1-guest-pending.png' });
  await guest.waitForFunction(() => document.body.innerText.includes('[zh] Line one.') && document.body.innerText.includes('[zh] Line two.'), null, { timeout: 9000 });
  const order = await guest.$$eval('[data-test=segments] li', (ls) => ls.map((l) => l.innerText));
  must(order.length === 2 && order[0].includes('Line one.') && order[1].includes('Line two.'), 'guest lines out of order: ' + JSON.stringify(order));
  await guest.screenshot({ path: 'evidence/grill-1-guest-translated.png' });
});

await scenario('G1 a final whose POST fails (500, then network error) is retried and arrives', async (pages) => {
  const { b, close } = await up(); cleanup.push(close);
  const { code, hostToken } = await room(b, 'en-zh');
  const host = await hostPage(b, code, hostToken); pages.push(host);
  let n = 0;
  await host.route('**/segments', async (route) => {
    const body = route.request().postDataJSON?.() || {};
    if (body.final === true && n < 2) { n++; return n === 1 ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"internal error"}' }) : route.abort('failed'); }
    return route.continue();
  });
  await host.evaluate(() => { Promise.resolve(window.__liveTranslateTest.feed('Thank you very much.', true)).catch(() => {}); });
  const got = await until(async () => (await transcript(b, code, hostToken)).find((s) => s.text === 'Thank you very much.'), 12000, 100);
  must(n === 2, `expected one 500 and one network failure first, saw ${n}`);
  must(got, 'final lost after a 500 and a network error');
  await host.waitForFunction(() => document.body.innerText.includes('非常感谢。'), null, { timeout: 5000 });
});

await scenario('G1 interims are throttled to about 3 per second and the newest text wins', async (pages) => {
  const { b, close } = await up(); cleanup.push(close);
  const { code, hostToken } = await room(b, 'en-zh');
  const host = await hostPage(b, code, hostToken); pages.push(host);
  const sent = [];
  await host.route('**/segments', (route) => { const j = route.request().postDataJSON?.() || {}; if (j.final === false && j.text) sent.push([Date.now(), j.text]); return route.continue(); });
  await host.evaluate(async () => { for (let i = 1; i <= 20; i++) { Promise.resolve(window.__liveTranslateTest.feed('partial ' + i, false)).catch(() => {}); await new Promise((r) => setTimeout(r, 100)); } });
  await sleep(800);
  must(sent.length >= 3, `only ${sent.length} interim POSTs in 2 s (throttled too hard)`);
  must(sent.length <= 8, `${sent.length} interim POSTs for 20 interims in 2 s (limit about 3/s)`);
  must(sent.at(-1)[1] === 'partial 20', 'last interim sent was ' + sent.at(-1)?.[1] + ', expected the newest text');
});

await scenario('G1 20 s of interims at 10/s with a final every 3 s: every final reaches the transcript in order', async (pages) => {
  const { b, close } = await up(); cleanup.push(close);
  const { code, hostToken } = await room(b, 'en-zh');
  const host = await hostPage(b, code, hostToken); pages.push(host);
  await host.evaluate(async () => {
    const f = window.__liveTranslateTest.feed;
    for (let i = 1; i <= 200; i++) {
      Promise.resolve(f('words so far ' + i, false)).catch(() => {});
      if (i % 30 === 0) Promise.resolve(f(`Sentence number ${i / 30}.`, true)).catch(() => {});
      await new Promise((r) => setTimeout(r, 100));
    }
  });
  const want = [1, 2, 3, 4, 5, 6].map((n) => `Sentence number ${n}.`);
  await until(async () => (await transcript(b, code, hostToken)).length >= 6, 15000, 200);
  const got = (await transcript(b, code, hostToken)).map((s) => s.text);
  must(JSON.stringify(got) === JSON.stringify(want), 'transcript finals: ' + JSON.stringify(got));
});

// ================= G2 =================
const freePort = () => new Promise((r) => { const t = net.createServer(); t.listen(0, '127.0.0.1', () => { const p = t.address().port; t.close(() => r(p)); }); });
await scenario('G2 zero-config: host page link and QR use the LAN address, with a Wi-Fi/hotspot hint', async (pages) => {
  const port = await freePort();
  const e = { ...process.env, PORT: String(port), TRANSLATOR: 'mock', GRILL_FAKE_IFACES: JSON.stringify({ lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true, netmask: '255.0.0.0', mac: '00:00:00:00:00:00', cidr: '127.0.0.1/8' }], wlan0: [{ address: '192.168.1.5', family: 'IPv4', internal: false, netmask: '255.255.255.0', mac: '00:00:00:00:00:01', cidr: '192.168.1.5/24' }] }) };
  delete e.PUBLIC_URL;
  const p = spawn(process.execPath, ['--import', new URL('./fixtures/fake-ifaces.mjs', import.meta.url).href, 'src/server.js'], { env: e });
  cleanup.push(() => p.kill());
  let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
  must(await until(() => /live-translate on/.test(out), 5000), 'server did not start: ' + out);
  const b = `http://127.0.0.1:${port}`; const base = `http://192.168.1.5:${port}`;
  const ctx = await br.newContext({ viewport: { width: 1280, height: 800 } }); const host = await ctx.newPage(); pages.push(host);
  await host.goto(b + '/'); await host.click('[data-test=start-both]'); await host.waitForURL(/\/host\//);
  const code = host.url().split('/host/')[1].slice(0, 6);
  await host.waitForFunction((c) => document.querySelector('[data-test=join-url]')?.href?.endsWith('/j/' + c) && document.querySelector('[data-test=join-url]').href.includes('192.168.1.5'), code, { timeout: 4000 }).catch(() => {});
  const href = await host.getAttribute('[data-test=join-url]', 'href');
  must(href === `${base}/j/${code}`, `join link is ${href}, expected ${base}/j/${code}`);
  const text = await host.textContent('[data-test=join-url]');
  must(text.includes(`192.168.1.5:${port}/j/${code}`), 'visible join link text is ' + text);
  const qr = await (await realFetch(`${b}/api/rooms/${code}/qr.svg`)).text();
  must(qr === qrSvg(href), 'QR does not encode the same URL as the link');
  must(await host.isVisible('[data-test=network-hint]'), 'no [data-test=network-hint]');
  const hint = await host.innerText('[data-test=network-hint]');
  must(/Wi-?Fi/i.test(hint) && /hotspot/i.test(hint), 'hint must mention the same Wi-Fi and a phone hotspot: ' + hint);
  must(!(await host.isVisible('[data-test=localhost-warning]')), 'localhost warning shown although the link is a LAN address');
  await host.screenshot({ path: 'evidence/grill-2-host-lan-link.png' });
});

// ================= G3 =================
await scenario('G3 guest types 你好 and the host sees it with an English translation', async (pages) => {
  const { b, close } = await up(); cleanup.push(close);
  const { code, hostToken } = await room(b, 'en-zh');
  const host = await hostPage(b, code, hostToken); pages.push(host);
  const guest = await guestPage(b, code); pages.push(guest);
  await guest.waitForSelector('[data-test=reply-input]', { state: 'visible', timeout: 4000 });
  await guest.fill('[data-test=reply-input]', '你好'); await guest.press('[data-test=reply-input]', 'Enter');
  await host.waitForFunction(() => { const t = document.querySelector('[data-test=segments]')?.innerText || ''; return t.includes('你好') && t.includes('Hello'); }, null, { timeout: 5000 });
  await guest.waitForFunction(() => (document.querySelector('[data-test=segments]')?.innerText || '').includes('你好'), null, { timeout: 5000 });
  const t = (await transcript(b, code, hostToken)).find((s) => s.text === '你好');
  must(t && t.lang === 'zh' && t.speaker === 'guest' && t.translation === 'Hello', 'transcript entry: ' + JSON.stringify(t));
  must((await guest.inputValue('[data-test=reply-input]')) === '', 'reply box not cleared after a successful send');
  await guest.screenshot({ path: 'evidence/grill-3-guest-reply.png' });
  await host.screenshot({ path: 'evidence/grill-3-host-sees-reply.png' });
});

await scenario('G3 guest hold-to-speak on a secure origin uses the guest recognizer in zh-CN', async (pages) => {
  const { b, close } = await up(); cleanup.push(close);
  const { code, hostToken } = await room(b, 'en-zh');
  const guest = await guestPage(b, code, [fakeSpeech]); pages.push(guest);
  await guest.waitForSelector('[data-test=guest-talk]', { state: 'visible', timeout: 4000 });
  await hold(guest, '[data-test=guest-talk]', async () => {
    await guest.waitForFunction(() => window.__recs.some((r) => r.running), null, { timeout: 3000 });
    const lang = await guest.evaluate(() => window.__recs.at(-1).lang);
    must(lang === 'zh-CN', 'guest recognizer lang ' + lang);
    await guest.evaluate(() => { window.__emit(0, [['谢', false]]); window.__finalOnStop = '谢谢。'; });
  });
  const t = await until(async () => (await transcript(b, code, hostToken)).find((s) => s.text === '谢谢。'), 5000);
  must(t && t.speaker === 'guest' && t.lang === 'zh', 'guest speech not saved as a guest zh line: ' + JSON.stringify(t));
  must((await guest.evaluate(() => window.__aborts)) === 0, 'release must stop(), not abort()');
});

// ================= G4 =================
await scenario('G4 host push-to-talk: hold 对方说中文 -> zh-CN recognizer, release -> stop() and a zh final, no stale interim', async (pages) => {
  const { b, close } = await up(); cleanup.push(close);
  const { code, hostToken } = await room(b, 'both');
  const guest = await guestPage(b, code); pages.push(guest);
  const host = await hostPage(b, code, hostToken); pages.push(host);
  await host.waitForSelector('[data-test=ptt-zh]', { state: 'visible', timeout: 4000 });
  must(/中文/.test(await host.innerText('[data-test=ptt-zh]')) && /English/i.test(await host.innerText('[data-test=ptt-en]')), 'push-to-talk labels');
  await hold(host, '[data-test=ptt-zh]', async () => {
    await host.waitForFunction(() => window.__recs.some((r) => r.running), null, { timeout: 3000 });
    const lang = await host.evaluate(() => window.__recs.filter((r) => r.running).at(-1).lang);
    must(lang === 'zh-CN', 'recognizer lang while holding 对方说中文: ' + lang);
    await host.evaluate(() => { window.__emit(0, [['火车站', false]]); window.__finalOnStop = '火车站在前面。'; });
    await guest.waitForFunction(() => document.querySelector('[data-test=segments] li.interim'), null, { timeout: 3000 }).catch(() => {});
    await host.screenshot({ path: 'evidence/grill-4-host-ptt-holding.png' });
  });
  const st = await host.evaluate(() => ({ stops: window.__stops, aborts: window.__aborts }));
  must(st.stops >= 1 && st.aborts === 0, 'release must call stop(), not abort(): ' + JSON.stringify(st));
  const t = await until(async () => (await transcript(b, code, hostToken)).find((s) => s.text === '火车站在前面。'), 5000);
  must(t && t.lang === 'zh', 'final after release not sent as zh: ' + JSON.stringify(t));
  await sleep(1000);
  must((await host.locator('[data-test=segments] li.interim').count()) === 0, 'stale interim card on the host 1 s after release');
  must((await guest.locator('[data-test=segments] li.interim').count()) === 0, 'stale interim card on the guest 1 s after release');
  await hold(host, '[data-test=ptt-en]', async () => {
    await host.waitForFunction(() => window.__recs.some((r) => r.running), null, { timeout: 3000 });
    const lang = await host.evaluate(() => window.__recs.filter((r) => r.running).at(-1).lang);
    must(lang === 'en-US', 'recognizer lang while holding I speak English: ' + lang);
    await host.evaluate(() => { window.__finalOnStop = 'Thank you very much.'; });
  });
  const e = await until(async () => (await transcript(b, code, hostToken)).find((s) => s.text === 'Thank you very much.'), 5000);
  must(e && e.lang === 'en', 'English push-to-talk final: ' + JSON.stringify(e));
  must(await host.isVisible('[data-test=mic]'), 'continuous mic mode must remain available');
  await host.screenshot({ path: 'evidence/grill-4-host-ptt.png' });
});

// ================= G5 =================
await scenario('G5 MyMemory quota: the host banner names MYMEMORY_EMAIL', async (pages) => {
  const mymemory = await import('../src/translate/mymemory.js');
  globalThis.fetch = async (url, init) => /mymemory/.test(String(url))
    ? new Response(JSON.stringify({ responseStatus: 429, responseDetails: 'MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY' }), { status: 200, headers: { 'content-type': 'application/json' } })
    : realFetch(url, init);
  cleanup.push(() => { globalThis.fetch = realFetch; });
  const { b, close } = await up(mymemory); cleanup.push(close);
  const { code, hostToken } = await room(b, 'en-zh');
  const host = await hostPage(b, code, hostToken); pages.push(host);
  await host.evaluate(() => { Promise.resolve(window.__liveTranslateTest.feed('Hello there.', true)).catch(() => {}); });
  await host.waitForSelector('[data-test=translate-banner]', { state: 'visible', timeout: 5000 });
  const t = await host.innerText('[data-test=translate-banner]');
  must(/MYMEMORY_EMAIL/.test(t) && /quota/i.test(t), 'banner text: ' + t);
  await host.screenshot({ path: 'evidence/grill-5-quota-banner.png' });
});

await scenario('G5 spike: the host translates on-device with the Translator API when available', async (pages) => {
  const tr = delayed(0); const { b, close } = await up(tr); cleanup.push(close);
  const { code, hostToken } = await room(b, 'en-zh');
  const host = await hostPage(b, code, hostToken, [fakeSpeech, fakeTranslatorApi]); pages.push(host);
  await host.click('[data-test=mic]'); await sleep(300);
  await host.fill('[data-test=type-input]', 'Hello there.'); await host.press('[data-test=type-input]', 'Enter');
  const t = await until(async () => (await transcript(b, code, hostToken)).find((s) => s.text === 'Hello there.'), 5000);
  must(t, 'typed line not saved');
  must(t.translation === '本地:Hello there.', 'translation did not come from the device Translator API: ' + t.translation);
  must(tr.calls.length === 0, 'server translator was called although the device translated');
});

// ================= G6 =================
await scenario('G6 guest UI is Chinese-first in an en-zh room and has a 2x text step', async (pages) => {
  const { b, close } = await up(); cleanup.push(close);
  const { code, hostToken } = await room(b, 'en-zh');
  const guest = await guestPage(b, code); pages.push(guest);
  await sleep(600);
  must(CJK.test(await guest.innerText('[data-test=status]')), 'status pill has no Chinese: ' + await guest.innerText('[data-test=status]'));
  await seg(b, code, { hostToken, text: 'Where is the train station?', lang: 'en', final: true });
  await guest.waitForFunction(() => document.body.innerText.includes('火车站在哪里？'), null, { timeout: 5000 });
  must(CJK.test(await guest.innerText('[data-test=status]')), 'live status pill has no Chinese');
  const size = () => guest.$eval('[data-test=segments] li:last-child [lang="zh-CN"], [data-test=segments] li:last-child .g-tr', (n) => parseFloat(getComputedStyle(n).fontSize));
  const base = await size();
  for (let i = 0; i < 10 && !(await guest.isDisabled('[data-test=font-up]')); i++) await guest.click('[data-test=font-up]');
  const big = await size();
  must(big / base >= 1.95, `largest text is ${(big / base).toFixed(2)}x the default (need 2x)`);
  await guest.screenshot({ path: 'evidence/grill-6-guest-2x.png' });
});

await scenario('G6 read-aloud speaks each final translation once (zh-CN), never an interim', async (pages) => {
  const { b, close } = await up(delayed((t) => (t === 'Slow line.' ? 1500 : 0))); cleanup.push(close);
  const { code, hostToken } = await room(b, 'en-zh');
  const guest = await guestPage(b, code, [fakeTts]); pages.push(guest);
  await guest.waitForSelector('[data-test=read-aloud]', { state: 'visible', timeout: 4000 });
  must(/朗读/.test(await guest.innerText('[data-test=read-aloud]')), 'read-aloud label lacks 朗读');
  await guest.click('[data-test=read-aloud]');
  must((await guest.getAttribute('[data-test=read-aloud]', 'aria-pressed')) === 'true', 'read-aloud toggle must set aria-pressed=true');
  await sleep(300);
  await seg(b, code, { hostToken, text: 'Hel', lang: 'en', final: false });
  await seg(b, code, { hostToken, text: 'Hello.', lang: 'en', final: true });
  await seg(b, code, { hostToken, text: 'Slo', lang: 'en', final: false });
  await seg(b, code, { hostToken, text: 'Slow line.', lang: 'en', final: true });
  await sleep(1200);
  const spoken = await guest.evaluate(() => window.__spoken);
  const want = [['你好。', 'zh-CN'], [await mock.translate('Slow line.', 'en', 'zh'), 'zh-CN']];
  must(JSON.stringify(spoken.map((s) => [s.text, s.lang])) === JSON.stringify(want), 'spoken: ' + JSON.stringify(spoken));
  await guest.screenshot({ path: 'evidence/grill-6-guest-read-aloud.png' });
  const zr = await room(b, 'zh-en');
  const g2 = await guestPage(b, zr.code, [fakeTts]); pages.push(g2);
  await g2.click('[data-test=read-aloud]'); await sleep(300);
  await seg(b, zr.code, { hostToken: zr.hostToken, text: '不客气。', lang: 'zh', final: true });
  await until(() => g2.evaluate(() => window.__spoken.length), 3000);
  const s2 = await g2.evaluate(() => window.__spoken);
  must(s2.length === 1 && s2[0].lang === 'en-US' && s2[0].text === "You're welcome.", 'zh-en room spoken: ' + JSON.stringify(s2));
});

// ================= G7 =================
await scenario('G7 host: recognition that ended while the screen was locked is explained on return', async (pages) => {
  const { b, close } = await up(); cleanup.push(close);
  const { code, hostToken } = await room(b, 'en-zh');
  const host = await hostPage(b, code, hostToken, [fakeSpeech, fakeVisibility]); pages.push(host);
  await host.click('[data-test=mic]');
  await host.waitForFunction(() => window.__recs.some((r) => r.running), null, { timeout: 3000 });
  await host.evaluate(() => { window.__setVisibility('hidden'); window.__killRunning(); });
  await sleep(800);
  must(!(await host.evaluate(() => window.__recs.some((r) => r.running))), 'recognition restarted while the page was hidden');
  await host.evaluate(() => window.__setVisibility('visible'));
  await sleep(500);
  const s = await host.innerText('[data-test=status]');
  must(/screen/i.test(s) && /lock/i.test(s), 'status after return: ' + s);
  must((await host.getAttribute('[data-test=mic]', 'aria-pressed')) === 'false', 'mic must show as off until the host taps it');
  await host.screenshot({ path: 'evidence/grill-7-host-screen-locked.png' });
});

await scenario('G7 host shows how many readers are connected', async (pages) => {
  const { b, close } = await up(); cleanup.push(close);
  const { code, hostToken } = await room(b, 'en-zh');
  const host = await hostPage(b, code, hostToken); pages.push(host);
  const readers = () => host.$eval('[data-test=readers]', (n) => n.textContent.trim()).catch(() => null);
  must(await until(async () => (await readers()) === '0', 4000), 'readers before any guest: ' + await readers());
  const guest = await guestPage(b, code);
  must(await until(async () => (await readers()) === '1', 4000), 'readers with one guest: ' + await readers());
  await host.screenshot({ path: 'evidence/grill-7-host-readers.png' });
  await guest.context().close();
  must(await until(async () => (await readers()) === '0', 5000), 'readers after the guest left: ' + await readers());
});

await scenario('G7 guest shows Speaker paused after 60 s without new lines', async (pages) => {
  const { b, close } = await up(); cleanup.push(close);
  const { code, hostToken } = await room(b, 'en-zh');
  const guest = await guestPage(b, code, [], true); pages.push(guest);
  await sleep(500);
  await seg(b, code, { hostToken, text: 'Hello.', lang: 'en', final: true });
  await guest.waitForFunction(() => document.body.innerText.includes('你好。'), null, { timeout: 5000 });
  must(!/paused|暂停/i.test(await guest.innerText('[data-test=status]')), 'paused shown too early');
  await guest.clock.fastForward(61000); await sleep(300);
  const s = await guest.innerText('[data-test=status]');
  must(/paused/i.test(s) || /暂停/.test(s), 'status after 61 s without events: ' + s);
  await guest.screenshot({ path: 'evidence/grill-7-guest-paused.png' });
  await seg(b, code, { hostToken, text: 'Goodbye.', lang: 'en', final: true });
  await guest.waitForFunction(() => document.body.innerText.includes('再见。'), null, { timeout: 5000 });
  must(!/paused|暂停/i.test(await guest.innerText('[data-test=status]')), 'paused not cleared by a new line');
});

// ================= G8 =================
await scenario('G8 host downloads carry a token, End room ends it for the guest at once', async (pages) => {
  const { b, close } = await up(); cleanup.push(close);
  const { code, hostToken } = await room(b, 'en-zh');
  const guest = await guestPage(b, code); pages.push(guest);
  const host = await hostPage(b, code, hostToken); pages.push(host);
  await seg(b, code, { hostToken, text: 'Hello.', lang: 'en', final: true });
  await guest.waitForFunction(() => document.body.innerText.includes('你好。'), null, { timeout: 5000 });
  must((await api(b, `/api/rooms/${code}/transcript?format=md`)).status === 403, 'transcript readable without a token');
  const href = await host.getAttribute('[data-test=download-md]', 'href');
  const r = await realFetch(new URL(href, b)); must(r.status === 200 && (await r.text()).includes('你好。'), 'host download link does not work: ' + href);
  host.on('dialog', (d) => d.accept());
  await host.click('[data-test=end-room]');
  const confirm = host.locator('[data-test=end-room-confirm]');
  if (await confirm.isVisible().catch(() => false)) await confirm.click();
  else await sleep(300).then(async () => { if (await confirm.isVisible().catch(() => false)) await confirm.click(); });
  const t0 = Date.now();
  await guest.waitForFunction(() => /ended|结束/i.test(document.querySelector('[data-test=status]')?.innerText || ''), null, { timeout: 2500 });
  must(Date.now() - t0 < 2500, 'guest did not see the end within 2.5 s');
  must((await api(b, `/api/rooms/${code}`)).status === 404, 'room still exists after End room');
  await guest.screenshot({ path: 'evidence/grill-8-guest-ended.png' });
});

await br.close();
const failed = results.filter((r) => !r[0]);
console.log(`\nGRILL E2E: ${results.length - failed.length}/${results.length} passed`);
if (failed.length) { for (const f of failed) console.error(' -', f[1]); process.exit(1); }
console.log('GRILL E2E PASS');
