# T1 server + translators
Goal: implement src/server.js, src/rooms.js, src/translate/{index,mock,mymemory,libretranslate,deepl,google}.js and QR per CLAUDE.md interfaces so `npm test` (checks/acceptance.test.js) passes.
Notes: mock.js has a small dictionary covering checks/fixtures/conversation.json (correct simplified Chinese / English), fallback deterministic `[zh] text`. mymemory: https://api.mymemory.translated.net/get?q=&langpair=en|zh-CN (verify from its docs; free, no key, rate limited; optional MYMEMORY_EMAIL env for higher quota). libretranslate: LIBRETRANSLATE_URL. deepl: DEEPL_API_KEY, api-free.deepl.com when key ends with :fx. google: v2 REST. index.js picks by TRANSLATOR env (default mymemory, tests inject). Translation errors: segment still saved, translation null + error flag, never crash. Rooms in memory, expire after 12h idle; rate-limit segments per room (e.g. 5/s). Escape everything rendered.
package.json: type module, "test": "node --test checks/ test/". Your own tests in test/.
Write a minimal placeholder public/ (index, host, guest, join) only enough to serve; T2 (fable) does the real UI.
Don't touch: checks/. Check: `npm test`.
