// Records the real local app (mock translator, fixture speech fed through window.__liveTranslateTest.feed)
// with Playwright recordVideo: one host page (desktop) and one guest page (phone, zh-CN) in the same browser.
// Each scene lasts at least as long as its voiceover; scene start times go to /tmp/lt-demo/marks.json.
// usage: node scripts/demo/record.mjs   (run scripts/demo/tts.sh first)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from '../../src/server.js';
import * as mock from '../../src/translate/mock.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = '/tmp/lt-demo';
const scenes = JSON.parse(fs.readFileSync(path.join(HERE, 'scenes.json'), 'utf8'));
const vo = JSON.parse(fs.readFileSync(path.join(OUT, 'vo/durations.json'), 'utf8'));
const GAP = 0.6; // breathing room after each line, seconds
export const HOST = { width: 1000, height: 760 };
export const PHONE = { width: 375, height: 760 };

const server = createServer({ translator: mock });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

fs.rmSync(path.join(OUT, 'raw'), { recursive: true, force: true });
const browser = await chromium.launch({ slowMo: 40 });
// Visible pointer with a press ripple, since recorded video has no OS pointer.
const cursor = () => {
  addEventListener('DOMContentLoaded', () => {
    const c = document.createElement('div');
    c.style.cssText = 'position:fixed;z-index:99999;left:-40px;top:-40px;width:18px;height:18px;border-radius:50%;background:rgba(27,36,50,.55);border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.35);pointer-events:none;transform:translate(-50%,-50%);transition:width .12s,height .12s';
    document.body.appendChild(c);
    const p = JSON.parse(sessionStorage.getItem('__demo_cursor') || 'null');
    if (p) { c.style.left = p[0] + 'px'; c.style.top = p[1] + 'px'; }
    addEventListener('mousemove', (e) => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; sessionStorage.setItem('__demo_cursor', JSON.stringify([e.clientX, e.clientY])); }, true);
    addEventListener('mousedown', () => { c.style.width = c.style.height = '30px'; }, true);
    addEventListener('mouseup', () => { c.style.width = c.style.height = '18px'; }, true);
  });
};
const hostCtx = await browser.newContext({ viewport: HOST, recordVideo: { dir: path.join(OUT, 'raw/host'), size: HOST }, locale: 'en-US' });
const guestCtx = await browser.newContext({
  viewport: PHONE, isMobile: true, hasTouch: true, deviceScaleFactor: 1, locale: 'zh-CN',
  recordVideo: { dir: path.join(OUT, 'raw/guest'), size: PHONE },
});
await hostCtx.addInitScript(cursor);
await guestCtx.addInitScript(cursor);
const t0 = Date.now();
const now = () => (Date.now() - t0) / 1000;
const host = await hostCtx.newPage();
const guest = await guestCtx.newPage();
for (const p of [host, guest]) p.setDefaultTimeout(120000); // the shared box can be very busy
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function click(page, sel) {
  const el = page.locator(sel).first();
  await el.scrollIntoViewIfNeeded();
  const b = await el.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 22 });
  await sleep(250);
  await page.mouse.down(); await sleep(90); await page.mouse.up();
}
async function scrollTo(page, y, ms = 1200) {
  await page.evaluate(([y, ms]) => new Promise((done) => {
    const from = scrollY, to = Math.max(0, Math.min(y, document.documentElement.scrollHeight - innerHeight)), start = performance.now();
    const step = (t) => { const k = Math.min(1, (t - start) / ms); const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; scrollTo(0, from + (to - from) * e); k < 1 ? requestAnimationFrame(step) : done(); };
    requestAnimationFrame(step);
  }), [y, ms]);
}
const topOf = (page, sel, offset = 20) => page.locator(sel).first().evaluate((el, o) => el.getBoundingClientRect().top + scrollY - o, offset);
const guestShows = (text) => guest.waitForFunction((x) => document.body.innerText.includes(x), text, { timeout: 120000 });

// Speak a line the way recognition delivers it: growing interim results, then the final one.
async function say(text, lang) {
  await click(host, `[data-test=lang-${lang}]`);
  await sleep(300);
  const parts = lang === 'zh' ? [...text] : text.split(' ');
  for (let i = 1; i < parts.length; i++) {
    await host.evaluate(([t]) => window.__liveTranslateTest.feed(t, false), [parts.slice(0, i).join(lang === 'zh' ? '' : ' ')]);
    await sleep(lang === 'zh' ? 180 : 260);
  }
  await host.evaluate(([t]) => window.__liveTranslateTest.feed(t, true), [text]);
  await guestShows(await mock.translate(text, lang, lang === 'en' ? 'zh' : 'en'));
}

let code;
const actions = {
  async home() {
    await host.mouse.move(500, 300, { steps: 20 });
    await sleep(1500);
    await click(host, '[data-test=start-both]');
  },
  async share() {
    await host.waitForURL(/\/host\//);
    code = host.url().split('/host/')[1].slice(0, 6);
    await host.waitForSelector('[data-test=qr] svg, img[data-test=qr]');
    await sleep(600);
    await host.mouse.move(260, 200, { steps: 25 });
    await sleep(900);
    await host.mouse.move(250, 330, { steps: 25 });
  },
  async join() {
    await click(guest, '[data-test=code-input]');
    await guest.keyboard.type(code, { delay: 160 });
    await sleep(400);
    await click(guest, '[data-test=join]');
    await guest.waitForURL(/\/j\//);
    await host.waitForSelector('[data-test=presence]:visible, [data-test=readers]:visible').catch(() => {});
  },
  async speak() {
    await scrollTo(host, await topOf(host, '[data-test=lang-en]', 120), 1200);
    await sleep(1500);
    await say('Hello, nice to meet you.', 'en');
    await sleep(1400);
    await say('Where is the train station?', 'en');
  },
  async zh() { await sleep(300); await say('火车站在前面。', 'zh'); },
  async reply() {
    await say('Thank you very much.', 'en');
    await sleep(600);
    await click(guest, '[data-test=reply-input]');
    await guest.keyboard.type('不客气。', { delay: 220 });
    await sleep(400);
    await guest.keyboard.press('Enter');
    await host.waitForFunction(() => document.body.innerText.includes("You're welcome."), null, { timeout: 120000 });
  },
  async bigtext() { await click(guest, '[data-test=font-up]'); await sleep(500); await click(guest, '[data-test=font-up]'); },
  async transcript() {
    await scrollTo(host, await topOf(host, 'h2:text-matches("transcript", "i"), [data-test=segments]', 70), 1400);
    await sleep(600);
    const a = host.locator('[data-test=download-md]');
    const b = await a.boundingBox();
    await host.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 20 });
    await sleep(900);
    // Show the real Markdown export (same URL as the link, without the download flag).
    const href = (await a.getAttribute('href')).replace('&download=1', '');
    try { await host.goto(base + href); } catch { await host.goto(base + href.replace('format=md', 'format=txt')); } // if the browser downloads text/markdown
    await sleep(400);
    await host.evaluate(() => { document.body.style.cssText = 'font:17px/1.55 ui-monospace,monospace;padding:28px 40px;background:#fff'; document.querySelector('pre')?.style.setProperty('white-space', 'pre-wrap'); });
  },
};

await host.goto(base + '/');
await guest.goto(base + '/join');
await host.waitForLoadState('networkidle');
await sleep(500);
// Sync flash: a magenta frame on both pages. Recording starts a little after page creation, so build.py finds
// this frame in each video and uses it to line the video up with the scene marks.
const marks = {};
for (const [name, page] of [['host', host], ['guest', guest]]) {
  const a = now();
  await page.evaluate(() => { const d = document.createElement('div'); d.id = '__sync'; d.style.cssText = 'position:fixed;inset:0;z-index:999999;background:#f0f'; document.body.appendChild(d); });
  marks[`_sync_${name}`] = (a + now()) / 2;
}
await sleep(700);
for (const page of [host, guest]) await page.evaluate(() => document.getElementById('__sync').remove());
await sleep(800);
const overruns = [];
for (const s of scenes) {
  if (!actions[s.id]) continue;
  const start = now();
  marks[s.id] = start;
  await actions[s.id]();
  const left = vo[s.id] + GAP - (now() - start);
  if (left > 0) await sleep(left * 1000);
  const took = now() - start;
  if (took > vo[s.id] + GAP + 2.5) overruns.push(`${s.id} ${took.toFixed(1)}s`);
  console.log(s.id, start.toFixed(2), took.toFixed(2));
}
marks._end = now() + 0.8;
await sleep(1200);
const hv = host.video(), gv = guest.video();
await hostCtx.close();
await guestCtx.close();
await browser.close();
server.close();
fs.copyFileSync(await hv.path(), path.join(OUT, 'host.webm'));
fs.copyFileSync(await gv.path(), path.join(OUT, 'guest.webm'));
fs.writeFileSync(path.join(OUT, 'marks.json'), JSON.stringify(marks, null, 1));
console.log('wrote', OUT, marks);
// Stalls (the shared box can run out of CPU and memory) show up as frozen stretches; build.py trims them.
if (overruns.length) console.log('stalled scenes (trimmed in build.py):', overruns.join(', '));
