# T4 grill: make real conversations work (PLANNER-OWNED brief)

Goal: implement the "Top 8 changes" in `docs/GRILL.md` (the planner approved all of them, including the interface changes marked (I)), so that `checks/grill.test.js` and `checks/grill_e2e.mjs` pass together with every existing check. Read `docs/GRILL.md` and `docs/RESEARCH.md` first. The header comments of `checks/grill.test.js` and `checks/grill_e2e.mjs` are the exact interface spec; if this brief and a test disagree, the test wins. Start only after T3 (`tasks/T3-review-R1.md`) has landed. T4 builds on T3's `errorKind`, joinBase, DELETE, wake lock, retry queue and bilingual strings, and must keep `checks/review-R1.test.js` green.

## Change

### G1. Original first, translation as an update; never lose a final (I)
- Server: store every final at once (transcript and SSE backlog), in id order, with `translation:null, pending:true`. Start translating in the background. If the translation is ready within a short grace window (at most 250 ms), broadcast one `segment` event with the translation and no `pending`. This keeps `checks/acceptance.test.js` valid. Otherwise broadcast the pending `segment` at once, and later broadcast `segment` again with the same `id` and `final:true`, carrying the translation or `translation:null, error:true, errorKind`. Translations of different lines run concurrently.
- The POST response still waits for the translation and keeps its shape (`{id, text, translation[, error, errorKind]}`).
- Late joiners get pending lines in the backlog, then the update. Should (not tested): an EventSource that reconnects with `Last-Event-ID` after seeing only the pending event must still get the update, for example by re-sending lines updated since then.
- Client: do not wait for one final's POST response before sending the next one. Ids must follow feed order. Keep the T3 retry with backoff on 429, 5xx and network errors, and the interim throttle (about 3/s, newest text wins).
- Guest and host render a pending line as the original text plus a calm "翻译中 Translating" placeholder, never as "unavailable". The update replaces it in place by id.
- md and txt transcripts show "(translating)" for pending lines.

### G2. Zero-config join URL
- Only `node src/server.js` (the CLI path) detects the LAN address. Pass it into `createServer` as an option. Do not detect inside `createServer` by default, because `checks/review-R1.test.js` (M3, m4) expects joinBase to be the request host for in-process servers, and this machine has a private 172.30.x address. Read `os.networkInterfaces()` at startup (the tests fake it with `--import checks/fixtures/fake-ifaces.mjs`). Pick a non-internal private IPv4, preferring 192.168/16, then 10/8, then 172.16/12. Use none if there is no private address.
- When `PUBLIC_URL` is unset and the request's Host is localhost, 127.x or [::1], joinBase is `http://<lan-ip>:<port from the Host header>`. This applies to `/api/config`, `qr.svg` and the host link. Any other Host is used as is. `PUBLIC_URL` always wins.
- Print the join URL at startup, for example `Guests join at http://192.168.1.5:3000 (same Wi-Fi, or a phone hotspot)`.
- Host page: `[data-test=network-hint]` with short, friendly copy: both devices on the same Wi-Fi, or turn on a phone hotspot if the guest cannot open the link (hotel and guest Wi-Fi often block this). Keep the T3 `[data-test=localhost-warning]`, which shows only when joinBase is still local. The visible link text shows the LAN URL (dropping the protocol is fine).
- README: a "Joining from a phone" section with the same Wi-Fi and hotspot advice, plus the tunnel one-liner `cloudflared tunnel --url http://localhost:3000` (and say it is needed when the host itself is a phone, because the mic needs https).

### G3. The guest can reply (I)
- `POST /api/rooms/:code/guests {}` -> 201 `{guestToken}` (random and high-entropy, at most about 20 per room, rate-limited like other writes). `POST segments` accepts `guestToken` in place of `hostToken`. Guest language: an `en-zh` room accepts only `zh`, a `zh-en` room only `en`, and `both` accepts either. Anything else is 400. Host rules are unchanged. Bad token -> 403.
- Segments carry `speaker:'host'|'guest'` in SSE, the transcript json and the POST response. The md and txt transcripts may label guest lines.
- Guest page: a reply bar `[data-test=reply-form]` with `[data-test=reply-input]` that is always available (typing works over plain LAN http). Placeholder in the guest's language, for example "输入回复 Type a reply". It sends through the same retry queue as the host, keeps the text until the send succeeds, then clears it. In `both` rooms, pick `zh` if the text contains CJK, else `en`. Get the guest token on page load and keep it in sessionStorage.
- Guest hold-to-speak `[data-test=guest-talk]` ("按住说话 Hold to talk"), shown only when SpeechRecognition exists and `isSecureContext`. Press starts a recognizer in the guest's language (`zh-CN` for en-zh rooms). Release calls `stop()`, never `abort()`, and the final goes out as a guest line.
- The host list shows guest lines with a small "Guest 对方" tag. The guest's own lines are visually distinct (for example right-aligned or a softer card) so the reader can tell who said what.

### G4. Host push-to-talk
- Two large hold-to-talk buttons: `[data-test=ptt-en]` "I speak English" and `[data-test=ptt-zh]` "对方说中文 / Partner speaks Chinese". Show the ones the room allows (both buttons in `both` rooms). Each press creates a recognizer with `lang` `en-US` or `zh-CN`. Release calls `stop()` (not `abort()`) so the last words are finalized, and the final is sent with that button's `lang`. Use pointer events (mouse and touch), and also hold-Space or keyboard press-and-hold for accessibility. Clear any interim card on release (T3 clear interim), so that no `.interim` card is left 1 s after release.
- The continuous mic `[data-test=mic]` and the `lang-en`/`lang-zh` toggles stay as an option. `checks/e2e.mjs` and `checks/review-R1.test.js` use them.

### G5. Honest translation budget and a better free default (spike is (I))
- Keep T3's error kinds and banner. For MyMemory quota, the banner text names `MYMEMORY_EMAIL` and suggests a keyed provider (`DEEPL_API_KEY` or `AZURE_TRANSLATOR_KEY`). Never show key values.
- New provider `src/translate/azure.js`, registered in `src/translate/index.js`. Env `AZURE_TRANSLATOR_KEY` (required) and `AZURE_TRANSLATOR_REGION` (optional). Request shape, language codes (`zh-Hans`) and error kinds are in the test header. Startup warns naming `AZURE_TRANSLATOR_KEY` when it is missing. Add unit tests in `test/` for anything beyond the contract.
- README: document Azure F0 (2M chars/month, card at signup) and DeepL API Free (500k/month, card required) as the better free options, with `TRANSLATOR=azure` and the env vars. Recheck the numbers against RESEARCH section 2 and do not hardcode them in UI copy.
- Spike, on-device translation: a final POST may carry `translation` (string, at most 4000 chars, else 413; non-string 400). The server stores and broadcasts it and does not call the translator. It is ignored for interims. Host page: if `self.Translator` exists and `Translator.availability({sourceLanguage, targetLanguage})` resolves `'available'` for the current pair, create the translator on a user gesture (mic tap, push-to-talk press or typed send). Translate finals locally and send `translation` with the POST. On any failure, send without it and let the server translate. Do not trigger model downloads in this task. Add one line to the footer when on-device translation is in use, for example "Translated on this device".

### G6. Guest UI in Chinese, plus read-aloud
- In en-zh rooms the guest status pill and waiting text are Chinese-first and bilingual. T3 already covers the waiting text. The pill must contain Chinese in every state (waiting, live, reconnecting, ended, paused).
- Text size: add a step at 2x the default (the default is level 1, the scale 1 step). The largest step must be at least 1.95x the default font size of the translation line.
- `[data-test=read-aloud]` toggle "朗读 Read aloud" with `aria-pressed`, off by default and remembered on the phone. While on, call `speechSynthesis.speak` once per final translation with `utterance.lang` = `zh-CN` (en-zh) or `en-US` (zh-en). For pending lines, speak when the update arrives, still only once per id. Never speak interims, the backlog on join, or the guest's own replies. Call `cancel()` when it is turned off.

### G7. Keep the host alive
- T3 adds the wake lock and the screen-lock message. In addition: if recognition ends while the page is hidden, do not restart it while hidden. On return, show "Listening stopped because the screen locked. Tap the mic to continue." with the mic shown as off.
- Server: SSE `event: presence` with data `{readers:N}`. N counts the room's open streams except those opened with `?role=host`. Send it to every stream on connect and when N changes. The host page opens its stream with `?role=host` and shows `[data-test=readers]`, whose text is the bare number, with a label next to it ("1 reader connected" or "No one is reading yet").
- Guest: after 60 s without a `segment` event (only once at least one line has arrived), the status pill shows "对方暂停 Speaker paused". The next line clears it.

### G8. Privacy, End room, host-only transcript (I)
- **Blocked on the planner first:** the transcript token requirement breaks the planner-owned `checks/acceptance.test.js` (the SSE/transcript test fetches transcripts without a token) and the `transcript()` helper in `checks/review-R1.test.js`. The planner will update those checks (and enable or remove the skipped R1 M2 test). If they still read transcripts without a token when you get here, do everything else in T4, leave the 403, and report. Do not work around it.
- `POST /api/rooms` also returns `readToken`. `GET transcript` requires `?token=<hostToken|readToken>`, else 403. The host download links include the host token. The guest page has no download for now. Putting the readToken in the QR fragment is deferred, because the QR must stay exactly `${joinBase}/j/${code}` for the R1 checks.
- `DELETE /api/rooms/:code` sends `event: end` to every stream before closing it. The guest switches to "房间已结束 Room ended" right away, without waiting for a reconnect.
- Privacy copy on all four pages names Apple (Safari) as well as Google and Microsoft. It also says anyone with the room code can read along, and (for G3) that guest replies are sent and stored the same way.

### Design and copy (visual polish required)
The new UI is the guest reply bar, hold-to-talk buttons on host and guest, the read-aloud toggle, the 2x text step, the readers indicator, the network hint, pending "Translating" lines, paused and ended states, and the guest-line styling. It must look as calm and polished as T2: large touch targets (at least 48 px, hold buttons bigger), a clear pressed or recording state (colour plus a subtle pulse), no layout jump when the reply bar appears, readable at 2x on a 390 px wide phone, good contrast, bilingual labels with `lang` set on the Chinese text, natural Simplified Chinese, and no em dashes. After `bash checks/slow.sh`, Read every `evidence/grill-*.png` and polish until each one looks good.

## Don't touch
- `checks/` (all of it is PLANNER-OWNED, including `checks/grill.test.js`, `checks/grill_e2e.mjs`, `checks/fixtures/fake-ifaces.mjs`, `checks/review-R1.test.js`, `checks/acceptance.test.js`, `checks/e2e.mjs`, `checks/slow.sh`). If a check looks wrong, stop and explain.
- Existing data-test hooks and `window.__liveTranslateTest.feed` (same code path as recognition results).
- Planner-fixed interfaces other than the approved additions above. No new runtime deps, no em dashes, no secrets, no deploy, never run `playwright install`.

## Check
- Fast: `npm test` (includes `checks/grill.test.js`).
- Slow: `bash checks/slow.sh` (runs `checks/e2e.mjs` and then `checks/grill_e2e.mjs`, which prints `GRILL E2E: n/16 passed`). Then Read the `evidence/grill-*.png` screenshots.

## Done when
- `npm test` passes with 0 failures (the owner-decision skips in `checks/review-R1.test.js` may remain).
- `bash checks/slow.sh` prints `E2E PASS` and `GRILL E2E PASS`.
- README covers joining from a phone (Wi-Fi, hotspot, tunnel), Azure and DeepL Free, and the transcript token. DECISIONS.md records the grace window, LAN detection order, guest tokens, presence and on-device translation.
- Short report: what changed per item (G1 to G8), any deviation, whether G8 was blocked, and the polish done after looking at the screenshots.

## Still not tested offline (in scope, verify by hand where possible)
Real Chrome Translator API availability and download behaviour, real iPhone or Android recognition with push-to-talk, real wake-lock and screen-lock behaviour on phones, `speechSynthesis` voice availability for zh-CN on the guest phone, and hotel Wi-Fi client isolation.
