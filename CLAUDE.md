# live-translate
Web app for in-person interpreting. Host device listens (browser Web Speech API, en-US or zh-CN) and transcribes; friend's phone joins with a 6-char code or QR and sees live translation (EN->ZH simplified, optional ZH->EN reverse). Bilingual transcript saved and downloadable.
Node 20, ESM, zero runtime deps preferred (node:http, SSE). QR generation may use one small dep (note in DECISIONS.md) or inline implementation.
Translation is pluggable: src/translate/<provider>.js with `async translate(text, from, to) -> string`. Providers: mock (deterministic, tests), mymemory (free, no key, default when online), libretranslate (self-hostable, free, URL via env), deepl (DEEPL_API_KEY, free tier exists), google (GOOGLE_TRANSLATE_API_KEY, paid). Select with env TRANSLATOR. Keys only from env, never sent to the browser.
## Checks
- Fast: `npm test`
- Slow: `bash checks/slow.sh` (browser E2E with fixtures + screenshots to evidence/)
## Hard rules
- Never edit checks/ (PLANNER-OWNED); if wrong, stop and explain. No network in fast tests. No em dashes in any file. No secrets in git. No deploy.
- Web Speech API cannot run in headless tests, so the host page must expose `window.__liveTranslateTest.feed(text, isFinal)` which goes through the exact same code path as a recognition result.
- Dev dep allowed: playwright@1.64.1 exactly (browsers preinstalled; never run playwright install).
## Interfaces (planner-fixed)
- `node src/server.js` (PORT env, default 3000). `import {createServer} from './src/server.js'` -> createServer({translator}) returns node http.Server.
- POST /api/rooms {direction:'en-zh'|'zh-en'|'both'} -> 201 {code, hostToken}; code is 6 chars from A-Z2-9 without 0/O/1/I.
- GET /api/rooms/:code -> 200 {code, direction} or 404. GET /api/rooms/:code/qr.svg -> image/svg+xml encoding the join URL.
- POST /api/rooms/:code/segments {hostToken, text, lang:'en'|'zh', final:boolean} -> 200 {id, text, translation} (translation only computed for final=true; interim broadcast without translation). Wrong token -> 403. Text > 2000 chars -> 413.
- GET /api/rooms/:code/events -> text/event-stream; events `segment` with JSON {id,lang,text,translation,final}. New joiners get the backlog of final segments first.
- GET /api/rooms/:code/transcript?format=json|md|txt -> bilingual transcript (each final segment: original + translation, timestamps).
- Pages: / (host start), /host/:code (host view), /j/:code (guest view, mobile-first, big text), /join (enter code).
