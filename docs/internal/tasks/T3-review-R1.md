# T3 review R1 fixes

Goal: fix every BLOCKER and MAJOR item in REVIEW-R1.md plus the MINOR items listed below, so that `checks/review-R1.test.js` passes (35 tests, 2 are skipped on purpose for the owner) together with all existing checks. Read REVIEW-R1.md first; the header comment of `checks/review-R1.test.js` is the exact interface spec and wins if this brief and the test disagree.

## Change

### B1. Finals must never be lost to interim traffic
- Server: separate per-room buckets for interims and finals (finals: burst >= 10, refill >= 1/s). Interims may get 429; finals must not be starved by interims.
- Client (`public/app.js`): throttle interim POSTs to at most 2 to 3 per second (trailing edge, latest text wins). Retry finals on 429, 5xx and network errors with backoff (about 0.5, 1, 2, 4, 8 s), keep them queued in order, show a calm status while retrying. `window.__liveTranslateTest.feed` must keep going through the exact same path as recognition results.

### Clock and IP (needed by the tests)
- `new RoomStore({now})` must use `now` for per-room rate limiters too (today `Room` uses `Date.now`).
- `createServer({translator, store, now, dailyCharLimit, log})`: `now` defaults to `store.now` and drives every server-level limiter and the daily budget.
- Client IP = `req.socket.remoteAddress`. Use `X-Forwarded-For` (first hop) and `X-Forwarded-Proto` only when `TRUST_PROXY=1`.

### M1. Abuse limits
- `POST /api/rooms`: 10 per IP per hour (bucket burst 10, refill 10/h), then 429.
- Finals per IP across all rooms: burst 30, refill 1/s, then 429.
- Daily translation char budget: option `dailyCharLimit`, else env `TRANSLATE_DAILY_CHAR_LIMIT` read at `createServer` time; unset or 0 means unlimited. Count characters of final text sent to the translator per UTC day (of `now`). When a final would exceed it: save and broadcast it with `translation:null, error:true, errorKind:'budget'`, do not call the translator, POST returns 200 with `errorKind`.
- `rooms.js` exports `MAX_ROOM_CHARS` (suggest 200000; must be <= 500000): total chars of stored final text per room; a final that would exceed it returns 409.
- Keep limiter maps bounded (sweep idle IP entries) so the limiter itself cannot grow without bound.
- Document all limits in README.

### M2. Code guessing
- Room-not-found responses per IP: burst 30, refill 0.5/s. Once empty, any `/api/rooms/:code*` request from that IP that would 404 returns 429.
- Do NOT change transcript access (token requirement) in this task. See Needs owner.

### M3. Join URL and README
- `GET /api/config` returns `{translator, joinBase}`. `joinBase` = `PUBLIC_URL` without trailing slash, else `proto://host` from the request (same logic as the QR). `qr.svg` must encode exactly `${joinBase}/j/${code}`.
- Host page builds the visible link and copy button from `joinBase`, not `location.origin`.
- Host page shows `[data-test=localhost-warning]` (text mentions `PUBLIC_URL`) when the page itself is on localhost, 127.x or [::1] and `joinBase` is local too. Hidden otherwise. Wording: "Phones cannot open localhost. Set PUBLIC_URL to this computer's LAN address or an https tunnel."
- Optionally log LAN IPs at startup.
- Add `README.md`: what it is, setup (`npm install`, `npm start`, `npm test`), `TRANSLATOR` and every key/URL env var (`MYMEMORY_EMAIL`, `DEEPL_API_KEY`, `GOOGLE_TRANSLATE_API_KEY`, `LIBRETRANSLATE_URL`), `PUBLIC_URL`, `TRUST_PROXY`, `TRANSLATE_DAILY_CHAR_LIMIT`, the https/tunnel requirement for the microphone, limits, privacy.

### M4. Privacy copy and End room
- Footer copy on all four pages must state, in substance: Chrome and Edge send audio to Google or Microsoft for speech recognition, this server never receives audio; recognized text goes to this server and to the translation provider; anyone with the room code can read along and download the transcript; rooms are kept in memory only and are deleted after 12 hours idle or when the server restarts; download your transcript before leaving. Use the wording in REVIEW-R1.md M4 as the starting point. Fix "The whole conversation is saved" on the home page (say it can be downloaded).
- `DELETE /api/rooms/:code` with JSON `{hostToken}`: 204, room and segments removed, SSE streams ended; wrong token 403. Host page gets `[data-test=end-room]` with a confirm step; guests then see the existing "room ended" state.

### M5. Chinese guest and join UI
- Guest page and join page strings bilingual (e.g. "等待对方说话 / Waiting for the speaker"): waiting state, status pill (Live, Reconnecting, Room ended, Speaking), "Listening...", translation-unavailable label, join heading, join errors, font buttons' labels, privacy footer. Set `lang` on Chinese text. Simplified Chinese, natural phrasing.

### M6. Host wake lock
- Request `navigator.wakeLock.request('screen')` when listening starts, release when stopped, re-request on `visibilitychange` to visible while listening. If the page was hidden while listening, show "Listening stopped because the screen locked. Tap the mic to continue." when it returns (if recognition ended).

### M7. Translator error kinds
- Providers throw errors with `err.kind` in `'quota' | 'auth' | 'timeout' | 'other'` (helper in `langs.js` is fine). MyMemory: `responseStatus` 429 or quota text, or HTTP 429 -> quota. DeepL: 456 -> quota, 403 -> auth. Google: 403 with quota/rate reasons -> quota, 401/403 otherwise -> auth. LibreTranslate: 429 -> quota, 400/403 with key message -> auth. `AbortSignal.timeout` -> timeout.
- Server adds `errorKind` (missing kind -> `'other'`) to the segment everywhere `error:true` appears: POST response, SSE, transcript json.
- Host page shows a one-time `[data-test=translate-banner]` for `quota`, `auth` and `budget` with a reason and a hint (text must include the word "quota" for quota errors), e.g. "Translation quota reached for MyMemory today. Set MYMEMORY_EMAIL or choose another TRANSLATOR." Never show keys.
- Startup (`node src/server.js`) warns (stderr is fine) when the translator is mymemory and `MYMEMORY_EMAIL` is unset, and names the missing var when `TRANSLATOR=deepl|google|libretranslate` lacks its key or URL. Do not hardcode MyMemory quota numbers in UI copy.

### M8. Tests for the real paths
- `checks/review-R1.test.js` already covers: fake SpeechRecognition with advancing `resultIndex` and an Android repeat, XSS, no-speech fallback, golden QR. Also add your own unit tests in `test/` for anything new (limiters, error classification, dedupe). Sanity-check once: change `i >= e.resultIndex` to `i > e.resultIndex` and confirm the M8 test fails, then revert.

### MINOR items to fix in this task
- m1: on stop and language switch send a clear interim (`text:''`, `final:false`; server accepts empty text only for interims and broadcasts it); server drops an interim whose text equals the room's last final text; guest and host remove the interim card on clear and expire it after about 8 s without update.
- m2: `final` must be a boolean, else 400.
- m3: POST (and DELETE with body) require `content-type: application/json` (parameters like charset allowed), else 415. Update `test/server.test.js` cases that post without a content type.
- m4: `qr.svg` uses `cache-control: private, max-age=3600`; `x-forwarded-proto` only with `TRUST_PROXY=1`.
- m5: typed text stays in the input until its POST succeeds (restore it if the line is finally given up).
- m7: skip an exact repeat of one of the last few finals within about 3 s (covered by the M8 test).
- m8: remove `aria-live` from the host segments list; announce finals via a separate visually hidden live region; replace `alert()` with an inline error.
- m9: remove `maxlength` from the join input; the input handler strips and slices.
- m10: put Project Nayuki's copyright line and MIT permission notice in the `src/qr.js` header (`Copyright (c) Project Nayuki`); add `DECISIONS.md` recording "inline QR encoder, no dependency" and the limit defaults above.
- m11: decode basic HTML entities in MyMemory `translatedText` (`&#39;`, `&quot;`, `&amp;`, `&lt;`, `&gt;`, numeric); the `network` speech error message also suggests Chrome or Edge; `beforeunload` prompt on the host while segments exist and the room was not ended.
- Not in this task: m6 (reader language choice in both-ways rooms), "speaker paused" indicator.

## Don't touch
- `checks/` (all of it, PLANNER-OWNED, including `checks/review-R1.test.js`). If a check looks wrong, stop and explain instead of working around it.
- Planner-fixed interfaces in CLAUDE.md, except the additions listed here (new fields and endpoints are additive). `GET /api/rooms/:code/transcript` stays readable with only the code.
- No new runtime deps. No em dashes. No secrets. No deploy. Do not run `playwright install`.

## Check
- `npm test`
- `bash checks/slow.sh`, then Read the evidence/ screenshots and make sure the new banner, warning and bilingual strings still look calm and legible.

## Done when
- `npm test` passes with 0 failures (the 2 owner-decision skips in `checks/review-R1.test.js` stay skipped).
- `bash checks/slow.sh` prints `E2E PASS`.
- README.md and DECISIONS.md exist; no em dashes anywhere.
- Short report: what changed per item ID, any deviation from this brief, and anything you could not verify.

## Needs owner (do not decide these; leave as is)
1. Transcript access (M2): require `hostToken` or a separate high-entropy `readToken` (in the QR link `/j/CODE#t=...`) to download the transcript? This changes the planner-fixed interface and `checks/acceptance.test.js`; a skipped test in `checks/review-R1.test.js` is ready to enable. Also: may guests download at all?
2. Project LICENSE choice (m10). A skipped test is ready.
3. Final privacy wording and whether a separate privacy notice is needed before public use (M4). The coder writes factual copy as specified; the owner signs off.
4. Limit values for a public deploy (10 rooms/IP/hour, 30 finals burst per IP, `TRANSLATE_DAILY_CHAR_LIMIT` default and per-provider budget for paid DeepL/Google keys) and whether a public deploy happens at all.
5. Which email (if any) to use for `MYMEMORY_EMAIL` in production, and whether MyMemory stays the default provider given its shared quota.
