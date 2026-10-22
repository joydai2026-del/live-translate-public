// PLANNER-OWNED. Do not edit. Pre-publish heavy QA pass (QA lead, 2026-10-20). Report: QA.md. Coder brief if red: tasks/T7-qa.md.
// playwright 1.64.1, in-process servers (one per scenario, so the per-IP limits never interfere), deterministic
// translators, no network. Web Speech and speechSynthesis are stubbed (absent in headless browsers).
// Sections: A main flow on three profiles (iPhone 15 webkit, Pixel 7 chromium, desktop chromium 1280x800),
// B offline/PWA, C error paths, D basic a11y, E console errors. Every scenario runs; exit 1 if any failed.
// Screenshots: evidence/qa-<profile>-<step>.png. Machine-readable results: evidence/qa-results.json.
import { chromium, webkit, devices } from 'playwright';
import fs from 'node:fs';
import { createServer } from '../src/server.js';
import * as mock from '../src/translate/mock.js';

for (const k of ['PUBLIC_URL', 'TRUST_PROXY', 'TRANSLATE_DAILY_CHAR_LIMIT', 'MYMEMORY_EMAIL']) delete process.env[k];
fs.mkdirSync('evidence', { recursive: true });
for (const f of fs.readdirSync('evidence')) if (/^qa-.*-fail-.*\.png$/.test(f)) fs.rmSync('evidence/' + f);
const realFetch = globalThis.fetch;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const must = (c, m) => { if (!c) throw new Error(m); };

// ---- servers: translator modes ok | fail | quota | slow (1500 ms) ----
async function up() {
  const ctl = { mode: 'ok' };
  const translator = {
    name: 'mock',
    async translate(t, f, to) {
      if (ctl.mode === 'fail') throw new Error('upstream 502');
      if (ctl.mode === 'quota') throw Object.assign(new Error('quota'), { kind: 'quota' });
      if (ctl.mode === 'slow') await sleep(1500);
      return mock.translate(t, f, to);
    },
  };
  const s = createServer({ translator });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${s.address().port}`;
  return { s, b, ctl, close: () => { s.close(); s.closeAllConnections?.(); } };
}
const api = (b, p, method = 'GET', body, headers) => realFetch(b + p, { method, headers: headers || (body !== undefined ? { 'content-type': 'application/json' } : {}), body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
const newRoom = async (b, direction = 'both') => (await api(b, '/api/rooms', 'POST', { direction })).json();
const transcript = async (b, code, token) => ((await (await api(b, `/api/rooms/${code}/transcript?format=json&token=${encodeURIComponent(token)}`)).json().catch(() => ({}))).segments || []);

// ---- page stubs (init scripts) ----
function fakeSpeech() {
  window.__recs = []; window.__finalOnStop = null;
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
      if (!this.running) return; this.running = false;
      const t = window.__finalOnStop; window.__finalOnStop = null;
      setTimeout(() => { if (t) result(this, 0, [[t, true]]); setTimeout(() => fire(this, 'end', new Event('end')), 10); }, 30);
    }
    abort() { if (!this.running) return; this.running = false; setTimeout(() => fire(this, 'end', new Event('end')), 0); }
  }
  window.SpeechRecognition = FakeSR; window.webkitSpeechRecognition = FakeSR;
  window.__emit = (resultIndex, items) => { const rec = [...window.__recs].reverse().find((r) => r.running); if (!rec) throw new Error('no running recognizer'); result(rec, resultIndex, items); };
}
function fakeTts() {
  window.__spoken = [];
  window.SpeechSynthesisUtterance = window.SpeechSynthesisUtterance || class { constructor(t) { this.text = t; } };
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: { speak: (u) => window.__spoken.push({ text: u.text, lang: u.lang }), cancel() {}, pause() {}, resume() {}, getVoices: () => [], speaking: false, pending: false, paused: false, addEventListener() {}, removeEventListener() {} } });
}
function noSpeech() { delete window.SpeechRecognition; delete window.webkitSpeechRecognition; try { window.SpeechRecognition = undefined; window.webkitSpeechRecognition = undefined; } catch {} }

// ---- profiles ----
const PROFILES = {
  iphone15: { type: webkit, opts: { ...devices['iPhone 15'] }, mobile: true, label: "devices['iPhone 15'] on webkit" },
  pixel7: { type: chromium, opts: { ...devices['Pixel 7'] }, mobile: true, label: "devices['Pixel 7'] on chromium" },
  desktop: { type: chromium, opts: { viewport: { width: 1280, height: 800 } }, mobile: false, label: 'desktop chromium 1280x800' },
  c375: { type: chromium, opts: { viewport: { width: 375, height: 667 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, mobile: true, label: 'chromium 375x667 touch' },
  w375: { type: webkit, opts: { viewport: { width: 375, height: 667 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, mobile: true, label: 'webkit 375x667 touch' },
};
const browsers = { chromium: await chromium.launch(), webkit: await webkit.launch() };
const browserFor = (p) => (PROFILES[p].type === webkit ? browsers.webkit : browsers.chromium);

// Console errors and uncaught page errors, per page. `expectNoise` pages (error-path tests) may log failed loads.
const consoleLog = []; // {profile, scenario, url, kind, text, noisy}
let current = { profile: '-', scenario: '-' };
async function ctxFor(profile, { init = [fakeSpeech, fakeTts], locale, hostToken, offlineOk = false } = {}) {
  const ctx = await browserFor(profile).newContext({ ...PROFILES[profile].opts, ...(locale ? { locale } : {}) });
  ctx.setDefaultTimeout(15000); // generous: the shared test machine can be heavily loaded
  if (hostToken) await ctx.addInitScript(([c, t]) => { try { sessionStorage.setItem('hostToken:' + c, t); } catch {} }, hostToken);
  for (const f of init) await ctx.addInitScript(f);
  const tag = { ...current, noisy: offlineOk };
  ctx.on('page', (p) => watch(p, tag));
  return ctx;
}
function watch(page, tag) {
  page.on('console', (m) => { if (m.type() === 'error') consoleLog.push({ ...tag, url: page.url(), kind: 'console', text: m.text() }); });
  page.on('pageerror', (e) => consoleLog.push({ ...tag, url: page.url(), kind: 'pageerror', text: String(e?.message || e) }));
  page.on('dialog', (d) => { page.__dialogs = (page.__dialogs || 0) + 1; d.accept().catch(() => {}); });
}
const shot = (page, profile, step) => page.screenshot({ path: `evidence/qa-${profile}-${step}.png`, fullPage: true }).catch(() => {});
const seen = (page, text, ms = 15000) => page.waitForFunction((t) => document.body.innerText.includes(t), text, { timeout: ms });
async function hold(page, sel, during) {
  const l = page.locator(sel); await l.scrollIntoViewIfNeeded(); const bx = await l.boundingBox();
  await page.mouse.move(bx.x + bx.width / 2, bx.y + bx.height / 2); await page.mouse.down();
  try { await sleep(80); await during(); } finally { await page.mouse.up(); }
}
const statusText = (page) => page.locator('[data-test=status]').innerText();

// ---- runner ----
const results = []; // {id, section, profile, name, status: pass|fail|na, severity, detail, ms}
const ONLY = process.env.QA_ONLY ? new RegExp(process.env.QA_ONLY) : null; // debugging aid, e.g. QA_ONLY='A1:iphone15'
// WPE WebKit history navigation can stall on a heavily loaded machine. A webkit scenario that fails only with a
// playwright Timeout runs once more; the row says so (retried + first error), so a real hang still shows twice.
async function scenario(id, section, profile, name, severity, fn) {
  if (ONLY && !ONLY.test(`${id}:${profile}`)) return;
  const t0 = Date.now();
  let r = await attempt(id, profile, fn, '');
  if (r.status === 'fail' && /Timeout \d+ms exceeded/.test(r.detail) && PROFILES[profile]?.type === webkit) {
    const first = r.detail;
    r = await attempt(id, profile, fn, '-retry');
    r.detail = [r.detail, `retried once after webkit timeout: ${first}`].filter(Boolean).join('; ');
    r.retried = true;
  }
  const row = { id, section, profile, name, severity, ms: Date.now() - t0, ...r };
  results.push(row);
  console.log(`${row.status === 'pass' ? 'ok  ' : row.status === 'na' ? 'n/a ' : 'FAIL'} [${section}] ${id} ${profile}: ${name} (${row.ms} ms)${row.detail ? '\n       ' + row.detail : ''}`);
}
async function attempt(id, profile, fn, suffix) {
  current = { profile, scenario: id };
  const cleanup = []; const ctxs = [];
  const env = { cleanup, ctxs, notes: [], ctx: async (o) => { const c = await ctxFor(profile, o); ctxs.push(c); return c; } };
  let r;
  try {
    const na = await fn(env);
    r = { status: typeof na === 'string' && na.startsWith('NA:') ? 'na' : 'pass', detail: [typeof na === 'string' ? na : '', ...env.notes.map((n) => 'note: ' + n)].filter(Boolean).join('; ') };
  } catch (e) {
    const at = [...String(e?.stack || '').matchAll(/^\s*at (?!(?:must|seen) )[^\n]*qa_heavy\.mjs:(\d+)/gm)].map((x) => x[1]).slice(0, 2).join('<-');
    r = { status: 'fail', detail: String(e?.message || e).split('\n')[0].slice(0, 600) + (at ? ` (qa_heavy.mjs:${at})` : '') };
    for (const [i, c] of ctxs.entries()) for (const [j, p] of c.pages().entries()) await p.screenshot({ path: `evidence/qa-${profile}-fail-${id}${suffix}-${i}${j}.png`, fullPage: true }).catch(() => {});
  } finally {
    for (const c of ctxs) await c.close().catch(() => {});
    while (cleanup.length) { try { await cleanup.pop()(); } catch {} }
  }
  return r;
}

// ======================= A. main flow, three profiles =======================
for (const P of ['iphone15', 'pixel7', 'desktop']) {
  await scenario('A1', 'A', P, 'start room, join by code, speak (ptt en+zh, typed, test hook), guest reply, read aloud, download, End room', 'high', async (env) => {
    const { b, close } = await up(); env.cleanup.push(close);
    const hctx = await env.ctx(); const host = await hctx.newPage();
    await host.goto(b + '/'); await host.locator('[data-test=start-both]').waitFor();
    await seen(host, 'the offline test dictionary'); await shot(host, P, '01-home');
    await host.locator('[data-test=start-both]').click();
    await host.waitForURL(/\/host\/[A-Z2-9]{6}$/);
    const code = (await host.locator('[data-test=room-code]').innerText()).trim();
    must(/^[A-HJ-NP-Z2-9]{6}$/.test(code), 'room code not 6 chars from A-Z2-9 without 0/O/1/I: ' + code);
    await host.waitForFunction(() => { const i = document.querySelector('img[data-test=qr]'); return i && i.complete && i.naturalWidth > 0; });
    must(!(await host.locator('[data-test=type-input]').isDisabled()), 'host type input disabled in the room this browser started');
    await shot(host, P, '02-host-new');

    const gctx = await env.ctx({ locale: 'zh-CN' }); const guest = await gctx.newPage();
    await guest.goto(b + '/join'); await shot(guest, P, '03-join');
    await guest.locator('[data-test=code-input]').fill(code.toLowerCase());
    must((await guest.locator('[data-test=code-input]').inputValue()) === code, 'join input did not upper-case the code');
    await guest.locator('[data-test=join]').click();
    await guest.waitForURL(new RegExp(`/j/${code}$`));
    await host.waitForFunction(() => document.querySelector('[data-test=readers]')?.textContent === '1', null, { timeout: 8000 });
    await shot(guest, P, '04-guest-waiting');

    // hold to talk, English: interim on the guest, then the final on release
    await hold(host, '[data-test=ptt-en]', async () => {
      await sleep(100);
      await host.evaluate(() => window.__emit(0, [['Where is', false]]));
      await guest.locator('[data-test=segments] li.interim').first().waitFor({ timeout: 5000 });
      await host.evaluate(() => { window.__finalOnStop = 'Where is the train station?'; });
    });
    await seen(guest, '火车站在哪里？');
    // typed
    await host.locator('[data-test=type-input]').fill('Hello, nice to meet you.');
    await host.locator('[data-test=type-input]').press('Enter');
    await seen(guest, '你好，很高兴认识你。');
    await host.waitForFunction(() => document.querySelector('[data-test=type-input]').value === '', null, { timeout: 5000 });
    // test hook
    await host.evaluate(() => window.__liveTranslateTest.feed('Thank you very much.', true));
    await seen(guest, '非常感谢。');
    // hold to talk, Chinese
    await hold(host, '[data-test=ptt-zh]', async () => { await sleep(100); await host.evaluate(() => { window.__finalOnStop = '火车站在前面。'; }); });
    await seen(guest, 'The train station is just ahead.');
    await seen(host, 'The train station is just ahead.');
    const big = await guest.locator('[data-test=segments] li [data-test=big]').allInnerTexts();
    must(big.length === 4, `guest shows ${big.length} line cards, expected 4: ${JSON.stringify(big)}`);
    must(big[0] === '火车站在哪里？' && big[3] === '火车站在前面。', 'guest big text order/language wrong: ' + JSON.stringify(big));
    await shot(guest, P, '05-guest-live'); await shot(host, P, '06-host-live');

    // guest reply (tap the send button)
    await guest.locator('[data-test=reply-input]').fill('不客气。');
    await guest.locator('.reply .send').click();
    await host.locator('[data-test=segments] li.from-guest', { hasText: "You're welcome." }).waitFor();
    await guest.waitForFunction(() => document.querySelector('[data-test=reply-input]').value === '', null, { timeout: 5000 });
    await shot(guest, P, '07-guest-reply'); await shot(host, P, '08-host-sees-reply');

    // larger text + read aloud
    const before = await guest.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--guest-scale').trim());
    await guest.locator('[data-test=font-up]').click(); await guest.locator('[data-test=font-up]').click();
    const after = await guest.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--guest-scale').trim());
    must(Number(after) > Number(before), `font-up did not grow the text (${before} -> ${after})`);
    await guest.locator('[data-test=read-aloud]').click();
    must((await guest.locator('[data-test=read-aloud]').getAttribute('aria-pressed')) === 'true', 'read-aloud did not toggle on');
    await host.evaluate(() => window.__liveTranslateTest.feed('Thank you.', true));
    await seen(guest, '谢谢。');
    await guest.waitForFunction(() => window.__spoken.some((s) => s.text === '谢谢。'), null, { timeout: 5000 });
    const spoken = await guest.evaluate(() => window.__spoken.map((s) => s.text));
    must(spoken.length === 1, 'read aloud spoke more than the one new line: ' + JSON.stringify(spoken));
    await shot(guest, P, '09-guest-bigger-text');

    // downloads (host links carry the token)
    for (const f of ['md', 'txt', 'json']) {
      const href = await host.getAttribute(`[data-test=download-${f}]`, 'href');
      const r = await hctx.request.get(new URL(href, b).href);
      const body = await r.text();
      must(r.status() === 200, `download ${f}: HTTP ${r.status()}`);
      must(/attachment/.test(r.headers()['content-disposition'] || ''), `download ${f}: no attachment header`);
      for (const t of ['Where is the train station?', '火车站在哪里？', '火车站在前面。', 'The train station is just ahead.', '不客气。', "You're welcome."]) must(body.includes(t), `download ${f} misses "${t}"`);
    }
    if (P === 'desktop') {
      const [dl] = await Promise.all([host.waitForEvent('download'), host.locator('[data-test=download-md]').click()]);
      must(/transcript-[A-Z2-9]{6}\.md$/.test(dl.suggestedFilename()), 'download file name: ' + dl.suggestedFilename());
    }

    // End room
    await host.locator('[data-test=end-room]').click();
    await host.locator('[data-test=end-room-confirm]').click();
    await guest.waitForFunction(() => /结束/.test(document.querySelector('[data-test=status]')?.innerText || ''), null, { timeout: 4000 });
    must(await guest.locator('[data-test=reply-input]').isDisabled(), 'guest reply input still enabled after End room');
    await host.waitForFunction(() => /ended/i.test(document.querySelector('[data-test=status]').textContent), null, { timeout: 5000 }).catch(() => {});
    must(/ended/i.test(await statusText(host)), 'host status after End room: ' + (await statusText(host)));
    if (!/Room ended/.test(await statusText(host))) env.notes.push('host shows the generic "This room has ended" text, not the End-room confirmation (SSE end event wins the race)');
    must((await api(b, `/api/rooms/${code}`)).status === 404, 'room still exists after End room');
    await shot(host, P, '10-host-ended'); await shot(guest, P, '11-guest-ended');
  });

  await scenario('A2', 'A', P, 'refresh mid-flow (guest and host) keeps lines, tokens and the live stream', 'high', async (env) => {
    const { b, close } = await up(); env.cleanup.push(close);
    const hctx = await env.ctx(); const host = await hctx.newPage();
    await host.goto(b + '/'); await host.locator('[data-test=start-both]').click(); await host.waitForURL(/\/host\//);
    const code = (await host.locator('[data-test=room-code]').innerText()).trim();
    await host.evaluate(() => window.__liveTranslateTest.feed('Hello.', true));
    await host.evaluate(() => window.__liveTranslateTest.feed('Goodbye.', true));
    const gctx = await env.ctx({ locale: 'zh-CN' }); const guest = await gctx.newPage();
    let guestTokens = 0; guest.on('request', (q) => { if (q.method() === 'POST' && /\/guests$/.test(q.url())) guestTokens++; });
    await guest.goto(`${b}/j/${code}`); await seen(guest, '再见。');
    await guest.locator('[data-test=reply-input]').fill('谢谢。'); await guest.locator('[data-test=reply-input]').press('Enter');
    await seen(host, 'Thank you.');
    await guest.reload(); await seen(guest, '再见。');
    must((await guest.locator('[data-test=segments] li').count()) === 3, 'guest after reload shows ' + (await guest.locator('[data-test=segments] li').count()) + ' lines, expected 3');
    must(await guest.locator('[data-test=waiting]').isHidden(), 'guest after reload still shows the waiting panel');
    await guest.locator('[data-test=reply-input]').fill('再见。'); await guest.locator('[data-test=reply-input]').press('Enter');
    await host.locator('li.from-guest', { hasText: 'Goodbye.' }).waitFor();
    must(guestTokens === 1, `guest asked for ${guestTokens} guest tokens across a reload, expected 1 (sessionStorage reuse)`);
    await shot(guest, P, '12-guest-after-reload');
    await host.reload(); await host.locator('[data-test=segments] li').nth(3).waitFor();
    must((await host.locator('[data-test=segments] li').count()) === 4, 'host after reload shows ' + (await host.locator('[data-test=segments] li').count()) + ' lines, expected 4');
    must(!(await host.locator('[data-test=type-input]').isDisabled()), 'host lost control of the room after a reload');
    await host.waitForFunction(() => document.querySelector('[data-test=readers]')?.textContent === '1', null, { timeout: 8000 });
    await host.evaluate(() => window.__liveTranslateTest.feed('Thank you.', true));
    await seen(guest, '谢谢。');
    await shot(host, P, '13-host-after-reload');
    must((await transcript(b, code, await host.evaluate((c) => sessionStorage.getItem('hostToken:' + c), code))).length === 5, 'transcript should have 5 lines');
  });

  await scenario('A3', 'A', P, 'back and forward on host and guest keep the live stream working', 'high', async (env) => {
    const { b, close } = await up(); env.cleanup.push(close);
    const hctx = await env.ctx(); const host = await hctx.newPage();
    await host.goto(b + '/'); await host.locator('[data-test=start-both]').click(); await host.waitForURL(/\/host\//);
    const code = (await host.locator('[data-test=room-code]').innerText()).trim();
    const gctx = await env.ctx({ locale: 'zh-CN' }); const guest = await gctx.newPage();
    await guest.goto(b + '/join'); await guest.locator('[data-test=code-input]').fill(code); await guest.locator('[data-test=join]').click();
    await guest.waitForURL(/\/j\//);
    await host.evaluate(() => window.__liveTranslateTest.feed('Hello.', true)); await seen(guest, '你好。');
    // guest back to /join, forward to the room
    await guest.goBack(); await guest.locator('[data-test=code-input]').waitFor();
    await guest.goForward(); await guest.waitForURL(/\/j\//); await seen(guest, '你好。');
    await host.evaluate(() => window.__liveTranslateTest.feed('Goodbye.', true));
    await seen(guest, '再见。').catch(() => { throw new Error('guest stopped receiving lines after back + forward'); });
    must((await guest.locator('[data-test=segments] li').count()) === 2, 'guest shows ' + (await guest.locator('[data-test=segments] li').count()) + ' lines after back + forward, expected 2 (duplicates?)');
    // host back to home, forward to the room
    await host.goBack(); await host.locator('[data-test=start-both]').waitFor();
    await host.goForward(); await host.waitForURL(/\/host\//); await host.locator('[data-test=room-code]').waitFor();
    await guest.locator('[data-test=reply-input]').fill('谢谢。'); await guest.locator('[data-test=reply-input]').press('Enter');
    await seen(host, 'Thank you.').catch(() => { throw new Error('host stopped receiving lines after back + forward'); });
    must(!(await host.locator('[data-test=type-input]').isDisabled()), 'host lost control after back + forward');
    await host.locator('[data-test=type-input]').fill('Thank you very much.'); await host.locator('[data-test=type-input]').press('Enter');
    await seen(guest, '非常感谢。');
    await shot(host, P, '14-host-after-back-forward'); await shot(guest, P, '15-guest-after-back-forward');
  });
}

// ======================= B. offline / PWA =======================
for (const P of ['pixel7', 'iphone15', 'desktop']) {
  await scenario('B1', 'B', P, 'web app manifest is linked and valid', 'low', async (env) => {
    const { b, close } = await up(); env.cleanup.push(close);
    const ctx = await env.ctx(); const page = await ctx.newPage();
    const found = [];
    for (const path of ['/', '/join', '/j/ABCDEF']) {
      await page.goto(b + path);
      const href = await page.evaluate(() => document.querySelector('link[rel=manifest]')?.getAttribute('href') || null);
      if (href) found.push([path, href]);
    }
    if (!found.length) return 'NA: no <link rel=manifest> on any page; the app is not a PWA (not required by CLAUDE.md)';
    for (const [path, href] of found) {
      const r = await ctx.request.get(new URL(href, b).href);
      must(r.ok(), `manifest ${href} from ${path}: HTTP ${r.status()}`);
      const m = await r.json().catch(() => null);
      must(m && (m.name || m.short_name) && m.start_url && m.display && Array.isArray(m.icons) && m.icons.length, `manifest ${href} lacks name/start_url/display/icons`);
    }
  });
  await scenario('B2', 'B', P, 'service worker registers and the app shell loads offline', 'low', async (env) => {
    const { b, close } = await up(); env.cleanup.push(close);
    const ctx = await env.ctx({ offlineOk: true }); const page = await ctx.newPage();
    await page.goto(b + '/'); await sleep(1500);
    const n = await page.evaluate(async () => (navigator.serviceWorker ? (await navigator.serviceWorker.getRegistrations()).length : -1));
    if (n <= 0) return `NA: no service worker registered (${n === -1 ? 'API absent' : '0 registrations'}); offline reload shows the browser error page`;
    await page.evaluate(() => navigator.serviceWorker.ready);
    await ctx.setOffline(true);
    await page.reload().catch(() => {});
    must(await page.evaluate(() => document.body?.dataset.page === 'home'), 'app shell not served offline');
  });
  await scenario('B3', 'B', P, 'guest offline mid-session: shows reconnecting, catches up when back online', 'medium', async (env) => {
    const { b, close } = await up(); env.cleanup.push(close);
    const { code, hostToken } = await newRoom(b, 'en-zh');
    const gctx = await env.ctx({ locale: 'zh-CN', offlineOk: true }); const guest = await gctx.newPage();
    await guest.goto(`${b}/j/${code}`);
    await api(b, `/api/rooms/${code}/segments`, 'POST', { hostToken, text: 'Hello.', lang: 'en', final: true }); await seen(guest, '你好。');
    await gctx.setOffline(true);
    // break the open stream too (setOffline may leave an established connection alone)
    await guest.evaluate(() => window.dispatchEvent(new Event('offline')));
    await api(b, `/api/rooms/${code}/segments`, 'POST', { hostToken, text: 'Goodbye.', lang: 'en', final: true });
    await sleep(1500);
    const offlineBody = await guest.innerText('body');
    await shot(guest, P, '16-guest-offline');
    await gctx.setOffline(false);
    await seen(guest, '再见。', 15000).catch(() => { throw new Error('guest never caught up with the line sent while it was offline'); });
    must((await guest.locator('[data-test=segments] li').count()) === 2, 'guest has duplicate or missing lines after reconnect');
    await guest.waitForFunction(() => /实时|Live/.test(document.querySelector('[data-test=status]').innerText), null, { timeout: 8000 });
    await shot(guest, P, '17-guest-back-online');
    if (offlineBody.includes('再见。')) return 'pass (note: the established SSE stream survived setOffline, so the reconnecting state was not exercised)';
  });
  await scenario('B4', 'B', P, 'host offline: typed line is kept, retried and arrives once', 'medium', async (env) => {
    const { b, close } = await up(); env.cleanup.push(close);
    const { code, hostToken } = await newRoom(b, 'en-zh');
    const hctx = await env.ctx({ hostToken: [code, hostToken], offlineOk: true }); const host = await hctx.newPage();
    await host.goto(`${b}/host/${code}`); await host.locator('[data-test=room-code]').waitFor();
    await hctx.setOffline(true);
    await host.locator('[data-test=type-input]').fill('Hello.'); await host.locator('[data-test=type-input]').press('Enter');
    await sleep(1200);
    const st = await statusText(host);
    must(/Retrying|slow/i.test(st), 'host status while offline does not say it is retrying: ' + st);
    must((await host.locator('[data-test=type-input]').inputValue()) === 'Hello.', 'typed text left the input before the server had it');
    await shot(host, P, '18-host-offline-retrying');
    await hctx.setOffline(false);
    await host.waitForFunction(() => document.body.innerText.includes('你好。'), null, { timeout: 15000 });
    const segs = await transcript(b, code, hostToken);
    must(segs.length === 1, `transcript has ${segs.length} lines after the retry, expected 1`);
  });
}

// ======================= C. error paths =======================
await scenario('C1', 'C', 'api', 'API rejects bad input and missing/invalid params with the right 4xx', 'high', async () => {
  const { b, close } = await up();
  try {
    const { code, hostToken } = await newRoom(b, 'en-zh');
    const S = `/api/rooms/${code}/segments`;
    const cases = [
      ['POST /api/rooms bad direction', () => api(b, '/api/rooms', 'POST', { direction: 'fr-de' }), 400],
      ['POST /api/rooms invalid JSON', () => api(b, '/api/rooms', 'POST', '{nope', { 'content-type': 'application/json' }), 400],
      ['POST /api/rooms text/plain', () => api(b, '/api/rooms', 'POST', '{"direction":"en-zh"}', { 'content-type': 'text/plain' }), 415],
      ['GET /api/rooms (list)', () => api(b, '/api/rooms'), 405],
      ['GET unknown room', () => api(b, '/api/rooms/ZZZZZZ'), 404],
      ['GET malformed room code', () => api(b, '/api/rooms/ab'), 404],
      ['qr.svg unknown room', () => api(b, '/api/rooms/ZZZZZZ/qr.svg'), 404],
      ['segment wrong token', () => api(b, S, 'POST', { hostToken: 'x', text: 'Hi', lang: 'en', final: true }), 403],
      ['segment no token', () => api(b, S, 'POST', { text: 'Hi', lang: 'en', final: true }), 403],
      ['segment 2001 chars', () => api(b, S, 'POST', { hostToken, text: 'a'.repeat(2001), lang: 'en', final: true }), 413],
      ['segment missing final', () => api(b, S, 'POST', { hostToken, text: 'Hi', lang: 'en' }), 400],
      ['segment final as string', () => api(b, S, 'POST', { hostToken, text: 'Hi', lang: 'en', final: 'true' }), 400],
      ['segment bad lang', () => api(b, S, 'POST', { hostToken, text: 'Hi', lang: 'fr', final: true }), 400],
      ['segment empty final', () => api(b, S, 'POST', { hostToken, text: '   ', lang: 'en', final: true }), 400],
      ['segment text not string', () => api(b, S, 'POST', { hostToken, text: 42, lang: 'en', final: true }), 400],
      ['segment zh in en-zh room', () => api(b, S, 'POST', { hostToken, text: '你好', lang: 'zh', final: true }), 400],
      ['segment unknown room', () => api(b, '/api/rooms/ZZZZZZ/segments', 'POST', { hostToken, text: 'Hi', lang: 'en', final: true }), 404],
      ['transcript no token', () => api(b, `/api/rooms/${code}/transcript?format=md`), 403],
      ['transcript bad format', () => api(b, `/api/rooms/${code}/transcript?format=pdf&token=${hostToken}`), 400],
      ['DELETE room wrong token', () => api(b, `/api/rooms/${code}`, 'DELETE', { hostToken: 'x' }), 403],
      ['unknown sub-resource', () => api(b, `/api/rooms/${code}/nope`), 404],
      ['unknown api path', () => api(b, '/api/nope'), 404],
      ['path traversal', () => api(b, '/..%2fsrc%2fserver.js'), 404],
      ['path traversal 2', () => api(b, '/%2e%2e/package.json'), 404],
      ['bad page code', () => api(b, '/host/ab'), 404],
      ['POST to a page', () => api(b, '/join', 'POST', {}), 405],
    ];
    const bad = [];
    for (const [name, p, want] of cases) {
      let r;
      try { r = await p(); } catch (e) { bad.push(`${name}: no HTTP answer (${e.cause?.code || e.message})`); continue; } const body = await r.text();
      if (r.status !== want) bad.push(`${name}: got ${r.status}, want ${want}`);
      else if (r.status >= 400 && /^\/api|json/.test(r.headers.get('content-type') || '') && !/"error"/.test(body)) bad.push(`${name}: no {error} body`);
      if (/at .*\.js:\d+/.test(body)) bad.push(`${name}: stack trace in body`);
    }
    must(!bad.length, bad.join('; '));
    must((await transcript(b, code, hostToken)).length === 0, 'a rejected segment was stored');
  } finally { close(); }
});

await scenario('C1b', 'C', 'api', 'a body over 64 KB (text far over 2000 chars) gets an HTTP 413 answer, not a connection reset', 'low', async () => {
  const { b, close } = await up();
  try {
    const { code, hostToken } = await newRoom(b, 'en-zh');
    let r;
    try { r = await api(b, `/api/rooms/${code}/segments`, 'POST', JSON.stringify({ hostToken, text: 'a'.repeat(70000), lang: 'en', final: true }), { 'content-type': 'application/json' }); }
    catch (e) { throw new Error(`no HTTP answer, connection reset (${e.cause?.code || e.message}); contract: text > 2000 chars -> 413`); }
    must(r.status === 413, 'status ' + r.status);
    must((await api(b, `/api/rooms/${code}`)).status === 200, 'server unhealthy after the oversize body');
  } finally { close(); }
});

await scenario('C2', 'C', 'desktop', 'join page: empty, short, unknown, pasted, server 500, 429 and offline', 'medium', async (env) => {
  const { b, close } = await up(); env.cleanup.push(close);
  const { code } = await newRoom(b, 'en-zh');
  const ctx = await env.ctx({ offlineOk: true }); const page = await ctx.newPage();
  await page.goto(b + '/join');
  const err = page.locator('[data-test=error]'); const input = page.locator('[data-test=code-input]'); const go = page.locator('[data-test=join]');
  await go.click(); await err.filter({ hasText: 'six characters' }).waitFor();
  await input.fill('AB2'); await go.click(); await err.filter({ hasText: 'six characters' }).waitFor();
  await input.fill('ZZZZZZ'); await go.click(); await err.filter({ hasText: 'No room with that code' }).waitFor();
  await shot(page, 'desktop', 'err-join-unknown');
  await input.fill(''); await input.pressSequentially(`${code.slice(0, 3).toLowerCase()}-${code.slice(3)}`);
  must((await input.inputValue()) === code, 'pasted "abc-234" style code not cleaned: ' + (await input.inputValue()));
  await page.route('**/api/rooms/*', (r) => r.fulfill({ status: 500, body: '{"error":"internal error"}', contentType: 'application/json' }));
  await go.click(); await err.filter({ hasText: 'Something went wrong' }).waitFor();
  await page.unroute('**/api/rooms/*');
  await page.route('**/api/rooms/*', (r) => r.fulfill({ status: 429, body: '{"error":"slow"}', contentType: 'application/json' }));
  await go.click(); await err.filter({ hasText: 'Too many tries' }).waitFor();
  await page.unroute('**/api/rooms/*');
  await page.route('**/api/rooms/*', (r) => r.abort('internetdisconnected'));
  await go.click(); await err.filter({ hasText: 'offline' }).waitFor();
  await shot(page, 'desktop', 'err-join-offline');
  await page.unroute('**/api/rooms/*');
  await go.click(); await page.waitForURL(new RegExp(`/j/${code}$`));
});

for (const P of ['desktop', 'iphone15']) {
  await scenario('C3', 'C', P, 'home: start fails with 500, 429, offline; button recovers; double click starts one room', 'medium', async (env) => {
    const { b, close } = await up(); env.cleanup.push(close);
    const ctx = await env.ctx({ offlineOk: true }); const page = await ctx.newPage();
    await page.goto(b + '/');
    const btn = page.locator('[data-test=start-en-zh]'); const err = page.locator('[data-test=start-error]');
    for (const [status, text] of [[500, 'HTTP 500'], [429, 'many rooms'], [0, 'offline']]) {
      await page.route('**/api/rooms', (r) => (status ? r.fulfill({ status, body: '{}', contentType: 'application/json' }) : r.abort('internetdisconnected')));
      await btn.click(); await err.filter({ hasText: text }).waitFor();
      must(!(await btn.isDisabled()), `start button stays disabled after ${status || 'offline'}`);
      await page.unroute('**/api/rooms');
    }
    await shot(page, P, 'err-home-offline');
    let posts = 0; page.on('request', (q) => { if (q.method() === 'POST' && /\/api\/rooms$/.test(q.url())) posts++; });
    if (PROFILES[P].mobile) { await btn.tap(); await btn.tap({ force: true }).catch(() => {}); } else await btn.dblclick();
    await page.waitForURL(/\/host\//); await sleep(300);
    must(posts === 1, `double ${PROFILES[P].mobile ? 'tap' : 'click'} on Start created ${posts} rooms`);
  });

  await scenario('C4', 'C', P, 'double submit on host Send and guest reply stores one line each', 'medium', async (env) => {
    const { b, close } = await up(); env.cleanup.push(close);
    const { code, hostToken } = await newRoom(b, 'both');
    const host = await (await env.ctx({ hostToken: [code, hostToken] })).newPage();
    await host.goto(`${b}/host/${code}`); await host.locator('[data-test=room-code]').waitFor();
    const guest = await (await env.ctx({ locale: 'zh-CN' })).newPage();
    await guest.goto(`${b}/j/${code}`); await guest.locator('[data-test=reply-input]').waitFor();
    await host.locator('[data-test=type-input]').fill('Hello.');
    const send = host.locator('[data-test=type-form] button[type=submit]');
    if (PROFILES[P].mobile) await Promise.all([send.tap(), send.tap()]); else await send.dblclick();
    await host.locator('[data-test=type-input]').press('Enter').catch(() => {});
    await seen(guest, '你好。');
    await guest.locator('[data-test=reply-input]').fill('谢谢。');
    const gs = guest.locator('.reply .send');
    if (PROFILES[P].mobile) await Promise.all([gs.tap(), gs.tap()]); else await gs.dblclick();
    await seen(host, 'Thank you.'); await sleep(800);
    const segs = await transcript(b, code, hostToken);
    must(segs.length === 2, `double submit stored ${segs.length} lines, expected 2: ${JSON.stringify(segs.map((s) => s.text))}`);
    must((await guest.locator('[data-test=segments] li').count()) === 2, 'guest shows duplicate cards');
  });
}

await scenario('C5', 'C', 'desktop', 'translator failures: error line, quota banner, slow provider pending then translated', 'high', async (env) => {
  const { b, ctl, close } = await up(); env.cleanup.push(close);
  const { code, hostToken } = await newRoom(b, 'en-zh');
  const host = await (await env.ctx({ hostToken: [code, hostToken] })).newPage();
  await host.goto(`${b}/host/${code}`); await host.locator('[data-test=room-code]').waitFor();
  const guest = await (await env.ctx({ locale: 'zh-CN' })).newPage();
  await guest.goto(`${b}/j/${code}`); await guest.locator('[data-test=reply-input]').waitFor();
  ctl.mode = 'fail';
  await host.evaluate(() => window.__liveTranslateTest.feed('Hello.', true));
  await seen(host, 'Translation unavailable for this line'); await seen(guest, '此句暂无翻译');
  must(await host.locator('[data-test=translate-banner]').isHidden(), 'banner shown for a generic upstream error');
  ctl.mode = 'quota';
  await host.evaluate(() => window.__liveTranslateTest.feed('Goodbye.', true));
  await host.locator('[data-test=translate-banner]').waitFor({ state: 'visible' });
  must(/quota/i.test(await host.locator('[data-test=banner-text]').innerText()), 'quota banner text');
  await shot(host, 'desktop', 'err-translator-quota'); await shot(guest, 'desktop', 'err-translator-guest');
  await host.locator('[data-test=banner-close]').click(); must(await host.locator('[data-test=translate-banner]').isHidden(), 'banner did not dismiss');
  ctl.mode = 'slow';
  await host.evaluate(() => window.__liveTranslateTest.feed('Thank you.', true));
  await guest.locator('.pending', { hasText: '翻译中' }).first().waitFor({ timeout: 3000 });
  await seen(guest, '谢谢。', 6000);
  must((await guest.locator('.pending').count()) === 0, 'pending placeholder left after the translation arrived');
  ctl.mode = 'ok';
  const segs = await transcript(b, code, hostToken);
  must(segs.length === 3 && segs[0].error && segs[1].errorKind === 'quota' && segs[2].translation === '谢谢。', 'transcript errors: ' + JSON.stringify(segs.map((s) => [s.text, s.translation, s.errorKind])));
  const md = await (await api(b, `/api/rooms/${code}/transcript?format=md&token=${hostToken}`)).text();
  must(md.includes('translation unavailable'), 'md transcript does not mark the untranslated line');
});

await scenario('C6', 'C', 'desktop', 'server 5xx on POST segments and on the event stream: retried, recovers, no duplicates', 'high', async (env) => {
  const { b, close } = await up(); env.cleanup.push(close);
  const { code, hostToken } = await newRoom(b, 'en-zh');
  const host = await (await env.ctx({ hostToken: [code, hostToken], offlineOk: true })).newPage();
  await host.goto(`${b}/host/${code}`); await host.locator('[data-test=room-code]').waitFor();
  let fails = 2;
  await host.route('**/segments', (r) => { const j = r.request().postDataJSON?.() || {}; if (j.final && fails-- > 0) return r.fulfill({ status: 503, body: '{"error":"busy"}', contentType: 'application/json' }); return r.continue(); });
  await host.evaluate(() => { const st = document.querySelector('[data-test=status]'); window.__st = []; new MutationObserver(() => window.__st.push(st.textContent)).observe(st, { childList: true, characterData: true, subtree: true }); });
  await host.evaluate(() => window.__liveTranslateTest.feed('Hello.', true));
  await seen(host, '你好。', 15000);
  must(await host.evaluate(() => window.__st.some((t) => /Retrying/.test(t))), 'host never said it was retrying: ' + JSON.stringify(await host.evaluate(() => window.__st)));
  const guestCtx = await env.ctx({ locale: 'zh-CN', offlineOk: true }); const guest = await guestCtx.newPage();
  let sseFails = 2;
  await guest.route('**/events*', (r) => (sseFails-- > 0 ? r.fulfill({ status: 500, body: 'x' }) : r.continue()));
  await guest.goto(`${b}/j/${code}`);
  await guest.waitForFunction(() => /重新连接|Reconnecting/.test(document.querySelector('[data-test=status]').innerText), null, { timeout: 5000 });
  await shot(guest, 'desktop', 'err-guest-sse-500');
  await seen(guest, '你好。', 15000);
  await guest.waitForFunction(() => /实时|Live/.test(document.querySelector('[data-test=status]').innerText), null, { timeout: 5000 });
  must((await transcript(b, code, hostToken)).length === 1, 'retried line stored twice');
});

await scenario('C7', 'C', 'desktop', 'missing/invalid page params: unknown room host+guest, host without token, lowercase link, bad code', 'medium', async (env) => {
  const { b, close } = await up(); env.cleanup.push(close);
  const { code, hostToken } = await newRoom(b, 'en-zh');
  await api(b, `/api/rooms/${code}/segments`, 'POST', { hostToken, text: 'Hello.', lang: 'en', final: true });
  const ctx = await env.ctx({ offlineOk: true });
  const p1 = await ctx.newPage(); await p1.goto(`${b}/host/ZZZZZZ`);
  await p1.waitForFunction(() => /expired|ended/.test(document.querySelector('[data-test=status]').textContent), null, { timeout: 5000 });
  must(await p1.locator('[data-test=type-input]').isDisabled(), 'unknown-room host page still lets you type');
  await shot(p1, 'desktop', 'err-host-unknown-room');
  const p2 = await ctx.newPage(); await p2.goto(`${b}/j/ZZZZZZ`);
  await p2.waitForFunction(() => /结束/.test(document.querySelector('[data-test=status]').innerText), null, { timeout: 8000 });
  await shot(p2, 'desktop', 'err-guest-unknown-room');
  const p3 = await ctx.newPage(); await p3.goto(`${b}/host/${code}`);
  await p3.waitForFunction(() => /did not create this room/.test(document.querySelector('[data-test=status]').textContent), null, { timeout: 5000 });
  must(await p3.locator('[data-test=type-input]').isDisabled() && await p3.locator('[data-test=end-room]').isDisabled(), 'host page without token still has controls');
  must(!(await p3.getAttribute('[data-test=download-md]', 'href')).includes('token='), 'download link carries a token in a browser without one');
  const p4 = await ctx.newPage(); await p4.goto(`${b}/j/${code.toLowerCase()}`); await seen(p4, '你好。');
  const p5 = await ctx.newPage(); const r5 = await p5.goto(`${b}/j/AB`);
  must(r5.status() === 404, '/j/AB status ' + r5.status());
  const p6 = await ctx.newPage(); const r6 = await p6.goto(`${b}/nowhere`);
  must(r6.status() === 404, '/nowhere status ' + r6.status());
  await shot(p5, 'desktop', 'err-bad-code-404');
});

await scenario('C8', 'C', 'desktop', 'hostile and oversized text: rendered as text, capped at 2000 chars, no layout break', 'high', async (env) => {
  const { b, close } = await up(); env.cleanup.push(close);
  const { code, hostToken } = await newRoom(b, 'both');
  const host = await (await env.ctx({ hostToken: [code, hostToken] })).newPage();
  await host.goto(`${b}/host/${code}`); await host.locator('[data-test=room-code]').waitFor();
  const guest = await (await env.ctx({ locale: 'zh-CN' })).newPage();
  await guest.goto(`${b}/j/${code}`); await guest.locator('[data-test=reply-input]').waitFor();
  const evil = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>';
  await host.evaluate((t) => window.__liveTranslateTest.feed(t, true), evil);
  await seen(guest, '<img src=x');
  await guest.locator('[data-test=reply-input]').fill('<b onmouseover="window.__xss=3">hi</b>'); await guest.locator('[data-test=reply-input]').press('Enter');
  await seen(host, '<b onmouseover');
  must(!(await guest.evaluate(() => window.__xss)) && !(await host.evaluate(() => window.__xss)), 'markup in speech text executed');
  must((await guest.locator('[data-test=segments] img').count()) === 0, 'markup in speech text became elements');
  await host.evaluate(() => window.__liveTranslateTest.feed('x'.repeat(2500), true));
  await host.waitForFunction(() => [...document.querySelectorAll('.seg-text')].some((p) => /^x{2000}$/.test(p.textContent)), null, { timeout: 5000 });
  const segs = await transcript(b, code, hostToken);
  must(segs.length === 3 && segs[1].speaker === 'guest' && segs[2].text.length === 2000, 'oversize line not capped at 2000: ' + segs.map((s) => s.text.length));
  must((await host.locator('[data-test=type-input]').getAttribute('maxlength')) === '2000', 'host input has no maxlength');
});

// ======================= D. basic a11y =======================
// Accessible name per the browser's own accessibility tree (ariaSnapshot), for every visible control.
async function unnamed(page) {
  const out = [];
  for (const l of await page.locator('button, a[href], input:not([type=hidden]), [role=button], summary').all()) {
    if (!(await l.isVisible().catch(() => false))) continue;
    const snap = (await l.ariaSnapshot().catch(() => '')).split('\n')[0];
    if (!/^- '?[\w ]+ ("[^"]*\S[^"]*"|'[^']*\S[^']*'|"[^"]*\S)/.test(snap) && !/^- [\w ]+: \S/.test(snap)) {
      const desc = await l.evaluate((n) => n.outerHTML.slice(0, 120));
      out.push(`${snap || '(no snapshot)'} ${desc}`);
    }
  }
  return out;
}
const MAIN = {
  home: ['[data-test=start-en-zh]', '[data-test=start-zh-en]', '[data-test=start-both]'],
  join: ['[data-test=code-input]', '[data-test=join]'],
  host: ['[data-test=ptt-en]', '[data-test=ptt-zh]', '[data-test=mic]', '[data-test=lang-en]', '[data-test=lang-zh]', '[data-test=type-input]', '[data-test=type-form] button[type=submit]'],
  guest: ['[data-test=reply-input]', '.reply .send', '[data-test=guest-talk]', '[data-test=read-aloud]', '[data-test=font-up]', '[data-test=font-down]', '[data-test=reader-lang]'],
};
const SECONDARY = { host: ['[data-test=copy]', '[data-test=end-room]', '[data-test=reset-guests]', '[data-test=download-md]', '[data-test=download-txt]', '[data-test=download-json]'], guest: ['.privacy summary'], join: [], home: [] };
async function small(page, sels) {
  const out = [];
  for (const s of sels) {
    const l = page.locator(s).first();
    if (!(await l.isVisible().catch(() => false))) continue;
    const bx = await l.boundingBox();
    if (bx.width < 44 - 0.5 || bx.height < 44 - 0.5) out.push(`${s} ${Math.round(bx.width)}x${Math.round(bx.height)}`);
  }
  return out;
}
const hscroll = (page) => page.evaluate(() => {
  const d = document.documentElement; const over = [];
  if (d.scrollWidth > d.clientWidth + 1) for (const n of document.querySelectorAll('body *')) { const r = n.getBoundingClientRect(); if (r.right > d.clientWidth + 1 && r.width > 0 && getComputedStyle(n).position !== 'fixed') over.push(`${n.tagName.toLowerCase()}${n.dataset.test ? '[' + n.dataset.test + ']' : n.className ? '.' + String(n.className).split(' ')[0] : ''} right=${Math.round(r.right)}`); }
  return { sw: d.scrollWidth, cw: d.clientWidth, over: over.slice(0, 4) };
});

// Opens all four pages with realistic, worst-case content (long unbroken text, max font) for the a11y checks.
async function a11yPages(env, b) {
  const { code, hostToken } = await newRoom(b, 'both');
  const ctx = await env.ctx({ hostToken: [code, hostToken], locale: 'zh-CN' });
  const home = await ctx.newPage(); await home.goto(b + '/'); await home.locator('[data-test=start-both]').waitFor();
  const join = await ctx.newPage(); await join.goto(b + '/join');
  await join.locator('[data-test=code-input]').fill('AB2'); await join.locator('[data-test=join]').click(); await join.locator('[data-test=error]').filter({ hasText: 'six characters' }).waitFor();
  const host = await ctx.newPage(); await host.goto(`${b}/host/${code}`); await host.locator('img[data-test=qr]').waitFor();
  const gctx = await env.ctx({ locale: 'zh-CN' }); const guest = await gctx.newPage(); await guest.goto(`${b}/j/${code}`);
  await host.evaluate(() => window.__liveTranslateTest.feed('Hello, nice to meet you.', true));
  await host.evaluate(() => window.__liveTranslateTest.feed('Please open https://example.com/a/very/long/path/' + 'segment'.repeat(20) + '?query=1 now.', true));
  await guest.locator('[data-test=reply-input]').fill('请看这个链接：' + 'abcdefghij'.repeat(15)); await guest.locator('[data-test=reply-input]').press('Enter');
  await host.locator('li.from-guest').waitFor();
  await seen(guest, '你好，很高兴认识你。');
  for (let i = 0; i < 6; i++) if (!(await guest.locator('[data-test=font-up]').isDisabled())) await guest.locator('[data-test=font-up]').click();
  await guest.locator('[data-test=reader-lang]').waitFor({ state: 'visible' });
  return { home, join, host, guest };
}

for (const P of ['iphone15', 'pixel7', 'desktop']) {
  await scenario('D1', 'D', P, 'every visible button, link and input has an accessible name', 'medium', async (env) => {
    const { b, close } = await up(); env.cleanup.push(close);
    const pages = await a11yPages(env, b); const bad = [];
    for (const [k, p] of Object.entries(pages)) for (const u of await unnamed(p)) bad.push(`${k}: ${u}`);
    must(!bad.length, bad.join(' | '));
  });
}
for (const P of ['iphone15', 'pixel7', 'c375']) {
  await scenario('D2', 'D', P, 'main controls are at least 44x44 CSS px', 'low', async (env) => {
    const { b, close } = await up(); env.cleanup.push(close);
    const pages = await a11yPages(env, b); const bad = []; const notes = [];
    for (const [k, p] of Object.entries(pages)) { for (const s of await small(p, MAIN[k])) bad.push(`${k}: ${s}`); for (const s of await small(p, SECONDARY[k])) notes.push(`${k}: ${s}`); }
    must(!bad.length, 'main controls under 44 px: ' + bad.join(', ') + (notes.length ? ` (secondary, info only: ${notes.join(', ')})` : ''));
    if (notes.length) return 'pass (secondary controls under 44 px, info only: ' + notes.join(', ') + ')';
  });
}
for (const P of ['c375', 'w375', 'pixel7', 'iphone15']) {
  await scenario('D3', 'D', P, `no horizontal scroll at ${PROFILES[P].opts.viewport.width} px on all pages (long text, max font, ended state)`, 'medium', async (env) => {
    const { b, close } = await up(); env.cleanup.push(close);
    const pages = await a11yPages(env, b); const bad = [];
    for (const [k, p] of Object.entries(pages)) {
      const h = await hscroll(p); await shot(p, P, `a11y-${k}`);
      if (h.sw > h.cw + 1) bad.push(`${k}: scrollWidth ${h.sw} > ${h.cw} (${h.over.join(', ')})`);
    }
    await pages.host.locator('[data-test=end-room]').click(); await pages.host.locator('[data-test=end-room-confirm]').click();
    await pages.guest.waitForFunction(() => /结束/.test(document.querySelector('[data-test=status]').innerText));
    for (const k of ['host', 'guest']) { const h = await hscroll(pages[k]); if (h.sw > h.cw + 1) bad.push(`${k} ended: scrollWidth ${h.sw} > ${h.cw} (${h.over.join(', ')})`); }
    await shot(pages.guest, P, 'a11y-guest-ended');
    must(!bad.length, bad.join(' | '));
  });
}
await scenario('D4', 'D', 'desktop', 'pages declare lang, have a title and one h1 or a labelled main heading; status regions are live', 'low', async (env) => {
  const { b, close } = await up(); env.cleanup.push(close);
  const pages = await a11yPages(env, b); const bad = [];
  for (const [k, p] of Object.entries(pages)) {
    const info = await p.evaluate(() => ({ lang: document.documentElement.lang, title: document.title, h: document.querySelectorAll('h1, h2').length, live: [...document.querySelectorAll('[data-test=status]')].every((n) => n.getAttribute('role') === 'status' || n.getAttribute('aria-live')) }));
    if (!info.lang) bad.push(`${k}: no html lang`); if (!info.title) bad.push(`${k}: no title`); if (!info.h) bad.push(`${k}: no heading`); if (!info.live) bad.push(`${k}: status not live`);
  }
  must(!bad.length, bad.join(', '));
});

// ======================= E. console errors =======================
const mainScen = new Set(['A1', 'A2', 'A3', 'D1', 'D2', 'D3', 'D4']);
for (const P of ['iphone15', 'pixel7', 'desktop', 'c375', 'w375']) {
  const mine = consoleLog.filter((c) => c.profile === P && mainScen.has(c.scenario));
  if (!results.some((r) => r.profile === P && mainScen.has(r.id))) continue;
  current = { profile: P, scenario: 'E1' };
  await scenario('E1', 'E', P, 'no console errors or uncaught exceptions on the main pages (home, join, host, guest)', 'medium', async () => {
    must(!mine.length, mine.slice(0, 6).map((c) => `${c.scenario} ${c.kind} ${new URL(c.url || 'about:blank', 'http://x').pathname}: ${c.text.slice(0, 160)}`).join(' | '));
  });
}
const uncaught = consoleLog.filter((c) => c.kind === 'pageerror');
await scenario('E2', 'E', 'all', 'no uncaught page exceptions in any scenario, error paths included', 'high', async () => {
  must(!uncaught.length, uncaught.slice(0, 6).map((c) => `${c.profile}/${c.scenario} ${c.text.slice(0, 160)}`).join(' | '));
});

await browsers.chromium.close(); await browsers.webkit.close();
fs.writeFileSync('evidence/qa-results.json', JSON.stringify({ when: new Date().toISOString(), profiles: Object.fromEntries(Object.entries(PROFILES).map(([k, v]) => [k, v.label])), results, console: consoleLog }, null, 2));
const failed = results.filter((r) => r.status === 'fail');
const na = results.filter((r) => r.status === 'na');
console.log(`\nQA HEAVY: ${results.length - failed.length - na.length} passed, ${failed.length} failed, ${na.length} n/a, of ${results.length}`);
if (failed.length) { for (const f of failed) console.error(` - [${f.severity}] ${f.id} ${f.profile}: ${f.name}`); process.exit(1); }
console.log('QA HEAVY PASS');
