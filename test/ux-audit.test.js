// Regression tests for the hands-on UX audit of 2026-10-21 (docs/UX-AUDIT-2026-10-21.md).
import test, { after } from 'node:test'; import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from '../src/server.js';
import { MAX_GUESTS } from '../src/rooms.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function up() {
  const s = createServer({ translator: { translate: async (t, f, to) => `[${to}]${t}` } });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { b: `http://127.0.0.1:${s.address().port}`, close: () => { s.close(); s.closeAllConnections?.(); } };
}
const post = (u, body) => fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
let br;
const browser = async () => (br ??= await chromium.launch());
after(async () => { await br?.close(); });

test('a guest who gets no reply slot (room full) is told so, not "Connection is slow"', async () => {
  const { b, close } = await up(); let ctx;
  try {
    const { code } = await (await post(`${b}/api/rooms`, { direction: 'en-zh' })).json();
    for (let i = 0; i < MAX_GUESTS; i++) assert.equal((await post(`${b}/api/rooms/${code}/guests`, {})).status, 201);
    ctx = await (await browser()).newContext({ viewport: { width: 390, height: 844 }, isMobile: true, locale: 'zh-CN' });
    const page = await ctx.newPage();
    await page.goto(`${b}/j/${code}`);
    await page.fill('[data-test=reply-input]', '我可以回复吗');
    await page.press('[data-test=reply-input]', 'Enter');
    await page.waitForFunction(() => /no free reply slots|Retrying/.test(document.querySelector('[data-test=reply-status]').textContent), null, { timeout: 5000 });
    const msg = await page.locator('[data-test=reply-status]').innerText();
    assert.match(msg, /no free reply slots/, msg);
    assert.doesNotMatch(msg, /Retrying/, msg);
    assert.equal(await page.inputValue('[data-test=reply-input]'), '我可以回复吗', 'the unsent reply stays in the box');
  } finally { await ctx?.close(); close(); }
});

test('host typing in a both-ways room uses the language of the text, not the mic toggle', async () => {
  const { b, close } = await up(); let ctx;
  try {
    const { code, hostToken } = await (await post(`${b}/api/rooms`, { direction: 'both' })).json();
    ctx = await (await browser()).newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.addInitScript(([c, t]) => { sessionStorage.setItem('hostToken:' + c, t); }, [code, hostToken]);
    const page = await ctx.newPage();
    await page.goto(`${b}/host/${code}`);
    await page.click('[data-test=lang-zh]'); // the mic is set to Chinese
    for (const text of ['Where is the station?', '火车站在前面。']) {
      await page.fill('[data-test=type-input]', text);
      await page.press('[data-test=type-input]', 'Enter');
      await page.waitForFunction((t) => [...document.querySelectorAll('[data-test=segments] li .seg-text')].some((x) => x.textContent === t), text, { timeout: 5000 });
    }
    const json = await (await fetch(`${b}/api/rooms/${code}/transcript?format=json&token=${hostToken}`)).json();
    const segs = json.segments || json;
    assert.deepEqual(segs.map((s) => [s.text, s.lang, s.translation]), [
      ['Where is the station?', 'en', '[zh]Where is the station?'],
      ['火车站在前面。', 'zh', '[en]火车站在前面。'],
    ]);
  } finally { await ctx?.close(); close(); }
});
