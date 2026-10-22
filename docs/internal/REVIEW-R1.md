# REVIEW-R1: live-translate (T1 + T2)

Reviewer: fresh-context senior review, 2026-10-20. No code changed.

What I ran:
- `npm test`: 21/21 pass.
- `bash checks/slow.sh`: common_check OK, E2E PASS.
- Read evidence/01..04 PNGs. They are clean, calm and legible. The host and guest layouts look launch quality.
- Scratch scripts against `createServer` (deleted afterwards) for the rate limit, interim race, content type and `final` validation findings below.
- QR: I could not decode it here (no zbar, cv2 or BarcodeDetector available). I compared `src/qr.js` line by line with Nayuki's reference and found no difference in tables, RS, placement, masks or format/version bits. A decode test is still missing (see MINOR).

Overall: the code is clean, all rendering goes through textContent, the CSP is strict, keys stay server side, path traversal is blocked, and the tests pass. The main problems: the rate limiter can silently drop final lines during normal speech, there are no abuse limits for a public deploy, and the guest experience and privacy copy fall short for the main use case (a Chinese reader).

---

## BLOCKER

### B1. Interim traffic uses up the per-room rate limit, so final lines get 429 and are lost
- Where: `src/rooms.js:46` (one `RateLimiter(5, 20)` shared by interim and final), `src/server.js:146`, `public/app.js:230-232` (an interim is POSTed on every `onresult` whenever no final is in flight), `public/app.js:217-219` (no retry on 429; the line is gone).
- Why: Chrome fires interim results several times a second during continuous speech. I measured with 20 s of speech and one final every 3 s. At 6 interim/s all finals returned 200. At 8/s, 3 of 6 finals returned 429. At 10/s, 3 of 6 returned 429. Lost finals never reach the guest or the transcript, and this happens on the core path of the product.
- Fix: (a) on the client, throttle interims to at most 2 to 3 per second (trailing edge, latest text wins); (b) on the server, check the limit separately for interim (drop with 429, no harm) and final (own bucket, more generous); (c) on the client, retry a final on 429/5xx/network error with backoff and keep it queued in order.
- Acceptance test: in a fast test, POST interims at 10/s for 20 s with a final every 3 s. Every final returns 200 and the JSON transcript contains every final. In E2E, call `feed(partial,false)` 50 times in a tight loop and then `feed(full,true)`, and assert the guest shows the translation.

---

## MAJOR

### M1. No abuse limits: anyone can fill all rooms (global 503) and spend the translation budget
- Where: `src/server.js:195-202` (room creation is not limited), `src/rooms.js:7` (`MAX_ROOMS = 10000`), `src/rooms.js:75`, `src/server.js:158` (every final calls the paid provider).
- Why: 10,000 POSTs make every new room fail with 503 for 12 h. Each room accepts 5 finals/s of 2000 chars, and the server forwards them to DeepL or Google (paid keys) or MyMemory (shared IP quota). One script can run up a Google bill or use up the free quota for all users. Memory also has no bound: 10k rooms x 5000 segments x 2000 chars.
- Fix: per-IP token bucket on `POST /api/rooms` (e.g. 10/hour) and on finals across all rooms per IP; a global daily character budget per provider (env `TRANSLATE_DAILY_CHAR_LIMIT`) that returns a clear error; a cap on total stored chars per room. Document the limits.
- Acceptance test: with an injected clock, the 11th room from one IP within an hour returns 429 while another IP still gets 201. Once the char budget is used up, finals are saved with `error:true`, the translator is not called, and the response includes a reason.

### M2. Anyone who knows or guesses a 6-char code can read a private conversation live and download the transcript
- Where: `src/server.js:204-216` (events and transcript need only the code), `src/rooms.js:10-12`; lookups and 404s have no rate limit.
- Why: 32^6 is about 1.07e9 codes. With 10k live rooms, about 100k unthrottled GETs find one live room on average. The 6-char code is fine for typing, but it is the only secret protecting the transcript.
- Fix: rate-limit 404s per IP (e.g. 30/min, then 429). Make the transcript download require `hostToken` (host only) or a separate high-entropy `readToken` embedded in the QR/link (`/j/CODE#t=...`), with the typed code still allowed for SSE. Say so in the privacy copy (see M4).
- Acceptance test: 40 lookups of random codes from one IP return 429 after the limit. `GET /transcript` without a token returns 403 and with `hostToken` returns 200.

### M3. The QR and link point to an address the guest's phone cannot reach in the normal local setup; there is no README
- Where: `src/server.js:61-66` (join URL taken from the Host header), `public/app.js:187` (the visible link uses `location.origin` and ignores `PUBLIC_URL`, so the link and the QR can differ). `PUBLIC_URL` is documented nowhere. The repo has no README.
- Why: browsers allow microphone access only on secure origins (https or localhost), so the host naturally opens `http://localhost:3000`. The QR then encodes `http://localhost:3000/j/XXXX`, which does nothing on the friend's phone. Opening the host page over the LAN IP over http usually fails with `not-allowed`. A first-time user gets stuck and cannot see why.
- Fix: add a README covering setup, the `TRANSLATOR` and key env vars, `PUBLIC_URL`, the https/tunnel requirement, limits and privacy. Add `GET /api/config` `joinBase` so the client renders the same URL the QR encodes. When the host page runs on localhost/127.0.0.1 and `PUBLIC_URL` is unset, show a warning: "Phones cannot open localhost. Set PUBLIC_URL to this computer's LAN address or an https tunnel." Optionally log the LAN IPs at startup.
- Acceptance test: with `PUBLIC_URL=http://192.168.1.5:3000`, the host page link text equals the QR target. When the host page loads from `localhost` without `PUBLIC_URL`, `[data-test=localhost-warning]` is visible.

### M4. The privacy copy is incomplete and somewhat misleading
- Where: `public/index.html:53`, `public/host.html:63`, `public/guest.html:32`, `public/join.html:28`; `public/index.html:19` ("The whole conversation is saved").
- Why: "audio is processed by your browser's speech service, never by this server" is literally true, but in Chrome and Edge the audio goes to Google or Microsoft cloud servers. Users will read it as on-device. The copy also leaves out that anyone with the room code can read the conversation and download the transcript. "Saved" suggests durable storage, but the transcript disappears on server restart or after 12 h idle.
- Fix: "Chrome and Edge send your audio to Google or Microsoft for speech recognition; this server never receives audio. Recognized text is sent to this server and to <provider>. Anyone with the room code can read along and download the transcript. Rooms are kept in memory only and are deleted after 12 hours idle or when the server restarts. Download your transcript before you leave." Also add an "End room" button on the host page that deletes the room and segments (`DELETE /api/rooms/:code` with hostToken).
- Acceptance test: grep the pages for "Google" and "Anyone with the room code". A fast test: `DELETE` with hostToken returns 204, then GET returns 404 and SSE clients are closed. A wrong token returns 403.

### M5. The guest UI is English-only, but the main guest reads Chinese
- Where: `public/guest.html:2,17-19,24-28`, `public/app.js:13,126,136-141`, `public/join.html` throughout.
- Why: in the default en-zh case the reader on the phone reads Chinese. "Waiting for the speaker", "Reconnecting", "Room ended", "Listening...", "Translation unavailable for this line", "Join a room" and the join errors are all English. The guest cannot tell what state the app is in.
- Fix: show guest and join UI strings in both languages (e.g. "等待对方说话 / Waiting for the speaker"), or choose them from the room direction (Chinese UI for en-zh guests). Set `lang` on the elements.
- Acceptance test: in E2E, after joining an en-zh room, the waiting text contains a CJK character (`/[一-鿿]/`). After a translator error, the unavailable label also contains CJK.

### M6. The host device's screen sleeps and stops recognition
- Where: `public/app.js:172-363` (the guest requests a wake lock at `app.js:160-168`, the host does not).
- Why: for in-person use the host is often a phone. The screen timeout (30 to 60 s with no touch) locks the phone, recognition ends, and `onend` restart fails while the page is hidden. Speech stops without the host noticing.
- Fix: request `navigator.wakeLock` while `wantListening` is true, re-request on `visibilitychange`, and show "Listening stopped because the screen locked" if the page was hidden while listening.
- Acceptance test: in E2E, stub `navigator.wakeLock.request` with `addInitScript`, click the mic with a fake SpeechRecognition, and assert `request('screen')` was called once.

### M7. When the default provider (MyMemory) runs out of quota, every line just says "Translation unavailable"
- Where: `src/translate/mymemory.js:12-16`, `src/server.js:132-136`, `public/app.js:13`.
- Why: MyMemory's anonymous quota is small (per its docs about 5,000 chars/day per IP, more with the `de` email). Every room on one server shares that quota, so a single 30 minute conversation can use it up. After that, every line silently shows "unavailable". The host gets no reason and no hint about `MYMEMORY_EMAIL` or switching providers. (Verify the current quota numbers against the MyMemory docs.)
- Fix: classify translator errors (`quota`, `auth`, `timeout`, `other`) and include `errorKind` in the segment. Show a one-time banner on the host ("Translation quota reached for MyMemory today. Set MYMEMORY_EMAIL or another TRANSLATOR."). Log a startup warning when `MYMEMORY_EMAIL` is unset, and when `TRANSLATOR=deepl|google|libretranslate` has no key or URL (`src/server.js:244-249`).
- Acceptance test: stub fetch to return `{responseStatus:429,responseDetails:'MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS'}`. The segment has `errorKind:'quota'`, and the host page shows `[data-test=translate-banner]`.

### M8. The tests do not exercise the real speech result handler or the failure paths that matter
- Where: `checks/e2e.mjs` calls `feed` directly; `public/app.js:281-289` (`onresult`) has no test. `test/server.test.js:118-125` checks only finder patterns. There are no XSS, reconnect, no-speech-browser or 429 tests.
- Why: plausible wrong implementations pass every test: an off-by-one on `resultIndex` that duplicates or drops finals, B1, a QR that does not decode, a regression to `innerHTML`, or a broken Firefox fallback notice.
- Fix (in test/, since checks/ is planner-owned): (1) a Playwright test that installs a fake `webkitSpeechRecognition` via `addInitScript` and dispatches realistic `SpeechRecognitionEvent`-like sequences (growing interims, final at index 0 then index 1 with `resultIndex` advancing, then an Android-style repeat). Assert each final appears exactly once on the guest. (2) Feed `<img src=x onerror=window.__x=1>` and assert `window.__x` is undefined and the literal text is visible on the guest. (3) Delete `webkitSpeechRecognition` and assert `[data-test=nospeech]` is visible and typing still works. (4) A golden QR test: compare `encodeQR('https://example.com/j/ABC234')` to a committed matrix produced by a reference encoder (Nayuki, same ECL M and fixed mask), or decode with a small pure-JS decoder in devDeps if the planner allows.
- Acceptance test: the tests above exist and fail on a deliberately broken variant (e.g. change `i >= e.resultIndex` to `i > e.resultIndex`).

---

## MINOR

### m1. A stale interim can stay on the guest screen as "Listening..."
- Where: `src/server.js:151-155`, `public/app.js:232`, `public/app.js:314-318` (`restart` uses `abort`, so the pending interim is never finalized).
- Why: I confirmed an interim that arrives after its final gets id N+1 and is broadcast with the stale text. Switching language or stopping mid-utterance also leaves an interim card. On a quiet room it stays until the next speech.
- Fix: send a `clear` interim (empty text, `final:false`) on stop and language switch. On the server, drop an interim whose text equals the last final's text, or tag interims with a client utterance counter and drop older ones. On the guest, expire interim cards after about 8 s with no update.
- Acceptance test: POST final "Where is the" and then interim "Where is the". The guest list shows no `.interim` element after 1 s.

### m2. `final` is not validated as a boolean
- Where: `src/server.js:147,150`.
- Why: `final:"yes"` returned 200 as an interim, and a truthy non-boolean hits the MAX_SEGMENTS check but is treated as interim.
- Fix: `if (typeof b.final !== 'boolean') 400`.
- Acceptance test: `final:"yes"` returns 400.

### m3. JSON endpoints accept any content type (cross-site room creation)
- Where: `src/server.js:41-59,197`.
- Why: a `text/plain` POST (no CORS preflight) created a room (201). Any web page can make visitors' browsers create rooms, which feeds into M1.
- Fix: require `content-type: application/json` on POST, else 415.
- Acceptance test: a `text/plain` POST to `/api/rooms` returns 415.

### m4. The QR is publicly cacheable and built from the Host header and X-Forwarded-Proto
- Where: `src/server.js:63-64,208`.
- Why: behind a shared cache or proxy, a forged Host or proto can leave a poisoned QR in the cache for an hour. Proto is trusted even without a proxy.
- Fix: `cache-control: private, max-age=3600`; trust `x-forwarded-proto` only when `TRUST_PROXY=1`; recommend `PUBLIC_URL` in production.
- Acceptance test: QR response header is `private`. With `TRUST_PROXY` unset, `x-forwarded-proto: https` does not change the URL.

### m5. Typed text is lost when sending fails
- Where: `public/app.js:335-341`.
- Why: the input is cleared before the POST, so a 429, 5xx or offline error throws the text away.
- Fix: clear the input only after success, or restore it in `catch`.
- Acceptance test: in E2E, route segments to return 500 once. After submit, the input still holds the text.

### m6. "Both ways" rooms show the guest the English line big when the guest speaks Chinese
- Where: `public/app.js:119-128`; visible in `evidence/04-guest-live.png` (cards 3 and 5).
- Why: the guest reads Chinese, but half the cards show English large and Chinese small, which is hard to scan.
- Fix: in `both` rooms let the guest choose "I read: 中文 / English" and always show that language big.
- Acceptance test: with reader set to zh, every card's `.g-tr` or large line contains CJK.

### m7. Possible duplicate finals on Android Chrome
- Where: `public/app.js:281-289`.
- Why: Android Chrome in `continuous` mode is known to repeat or accumulate final results, which would duplicate lines for the guest. Needs a check on a real device.
- Fix: keep the last N sent finals and skip an exact repeat within about 3 s.
- Acceptance test: covered by the fake-recognition test in M8 with a repeated final.

### m8. Screen reader noise and minor accessibility issues
- Where: `public/host.html:57` (`aria-live` on the list, which re-announces every interim update), `public/app.js:73` (`alert()`).
- Fix: drop `aria-live` from the list and announce only finals through a separate visually hidden live region; replace `alert` with an inline error.
- Acceptance test: the `segments` list has no `aria-live`; a live region gets exactly one update per final.

### m9. Pasting a code with a dash or space is truncated
- Where: `public/join.html:20` (`maxlength="6"` runs before the input handler cleans the value).
- Why: pasting "ABC-234" becomes "ABC-23" and then "ABC23".
- Fix: remove `maxlength` and let the handler strip and slice.
- Acceptance test: fill "abc-234" and the input value is "ABC234".

### m10. Open source hygiene
- Where: `src/qr.js:2` says "Ported in spirit from Project Nayuki ... (MIT)", but the structure and tables match Nayuki closely. There is no LICENSE, README or DECISIONS.md.
- Why: MIT requires keeping the copyright notice in derived code. Launching without a license or README is embarrassing.
- Fix: add Nayuki's copyright and MIT text to the qr.js header (or THIRD_PARTY_NOTICES), add a LICENSE, and add DECISIONS.md recording "inline QR, no dep".
- Acceptance test: `grep -q "Copyright (c) Project Nayuki" src/qr.js` and `test -f LICENSE`.

### m11. Smaller items
- The guest is not told the speaker paused. Show "Speaker paused" when no event arrives for 60 s while connected.
- The host has no confirmation before "New room" (`public/host.html:13`). Leaving loses the token (sessionStorage only) and with it host control. Add a `beforeunload` prompt while segments exist.
- MyMemory sometimes returns HTML entities (e.g. `&#39;`) in `translatedText`, and they are shown literally (`src/translate/mymemory.js:15`). Verify with `LIVE=1` and decode basic entities in the provider if so.
- Browsers that expose `webkitSpeechRecognition` but have no backend (Brave, some Chromium builds) fail with `network`. The message at `public/app.js:261` says "check your connection" when it should also suggest Chrome or Edge.
