# QA: pre-publish heavy test pass (2026-10-20)

QA lead, fresh context, planner side. No product code was changed. New check: `checks/qa_heavy.mjs` (PLANNER-OWNED), now the last step of `checks/slow.sh`. Raw results: `evidence/qa-results.json`. Screenshots: `evidence/qa-<profile>-<step>.png`.

How it runs: playwright 1.64.1, an in-process server per scenario (so the per-IP rate limits never interfere), a deterministic mock translator with switchable failure modes (ok, fail, quota, slow), no network. Web Speech and speechSynthesis are stubbed with init scripts (a fake recognizer that finalizes on `stop()`, a recording `speechSynthesis`). Hold-to-talk is driven with real pointer down/up on the buttons.

Profiles: `iphone15` = devices['iPhone 15'] on webkit, `pixel7` = devices['Pixel 7'] on chromium, `desktop` = chromium 1280x800. Extra a11y profiles: `c375` = chromium 375x667 touch, `w375` = webkit 375x667 touch.

## Result

`npm test`: 118 pass, 0 fail, 1 skipped (m10 LICENSE, unchanged).
`bash checks/slow.sh`: common_check OK, E2E PASS, GRILL E2E 16/16, then **QA HEAVY: 37 passed, 6 failed, 6 n/a, of 49** (the stable result over several runs). So slow.sh is red until tasks/T7-qa.md is done. In the last full run the machine hit load average 296, and D3 iphone15 timed out on both tries (page.goto over 15 s). It passed in 15 s when re-run alone right after (`QA_ONLY='D3:iphone15' node checks/qa_heavy.mjs`), so that run read 36/7. It was the machine, not a product bug.

No high-severity bugs. The main flow works end to end on all three profiles. The failures are two layout/a11y defects on phones and one API contract gap.

## Failed (bugs), by severity

| # | Severity | Check | What happens | Evidence |
|---|----------|-------|--------------|----------|
| 1 | medium | D3 pixel7, D3 c375 | **The host page scrolls sideways on every phone-width chromium viewport under about 441 px (Pixel 7 at 412 px, any 375 px Android).** The single-column `.host-grid` uses `1fr`, which is `minmax(auto, 1fr)`, so the column grows to the min-content width of the Speak card (424 px). That width comes from the "Or type" row: the text input's intrinsic width (about 294 px) plus the Send button. The Share and Speak cards are cut at the right edge. WebKit (iPhone 15, 375 px webkit) is not affected. The guest, join and home pages are fine at 375 px. | `evidence/qa-pixel7-a11y-host.png`, `evidence/qa-c375-a11y-host.png` (cards run past the right edge), `evidence/qa-w375-a11y-host.png` (webkit, correct) |
| 2 | low | D2 iphone15, pixel7, c375 | **The continuous-mode language toggle (English / 中文, `lang-en`, `lang-zh`) is 40 px tall**, under the 44 px tap target minimum. Every other main control passes (start choices, join, both hold-to-talk buttons, mic, type field + Send, guest reply field, send, hold-to-talk, read aloud, A-/A+, big-text toggle). | `evidence/qa-iphone15-02-host-new.png` |
| 3 | low | C1b | **A segment POST with a body over 64 KB gets a connection reset, not an HTTP answer.** `readJson` calls `req.destroy()` right after rejecting with 413, so the socket is gone before the error handler can write the 413. The contract says text over 2000 chars gets 413; that holds up to 64 KB of body (C1 checks 2001 chars and passes) but not above. Browsers never hit this (inputs are capped at 2000), only scripted clients. The server stays healthy afterwards. | `node checks/qa_heavy.mjs` output, row C1b |

## Notes (not failing, worth knowing)

- **Host End-room message is lost (low, cosmetic).** After the host taps "End room and delete", the host's own event stream gets the `end` event before the DELETE answer, so `endRoomUi` runs with the generic "This room has ended. Start a new room." and the more useful "Room ended. The transcript was deleted from the server..." never shows. Seen in every A1 run on every profile. `evidence/qa-desktop-10-host-ended.png`. Optional item in T7.
- **Small secondary controls (info).** Copy link, Reset guests and End room are 35 px tall; the Markdown/Text/JSON download links are 22 px tall. Not main controls, so not failed. Worth enlarging if the host page is used on a phone.
- **Offline / PWA: not applicable.** There is no web app manifest and no service worker (B1, B2 report n/a on all three profiles); CLAUDE.md does not ask for one. A reload while offline shows the browser's own error page. For a live interpreting app that needs the server anyway this is acceptable; a PWA would be a feature, not a fix.
- **setOffline does not cut an open event stream** in either engine, so B3 could not show the guest's "Reconnecting" state through true offline. That state is covered by C6 instead (event stream answers 500 twice: the guest shows 正在重新连接 / Reconnecting, then Live, with the backlog). B3 still checks the guest catches up with no duplicates.
- **Machine load.** The test machine ran at load average 40 to 110 on 8 cores during this pass (other projects' checks in parallel). WPE WebKit history navigation sometimes stalled under that load (goBack waiting over 15 s). The check retries a webkit scenario once only when it failed with a playwright timeout, and says so in the row (`retried`). Most final runs needed no retry; at load average near 300 a webkit row can still time out twice (see Result). A real hang fails twice every time, also when re-run alone with QA_ONLY.

## Passed

A. Main flow (iPhone 15 webkit, Pixel 7 chromium, desktop chromium), all pass:
- A1 home -> Both ways -> host page with 6-char code (A-Z2-9 without 0/O/1/I) and a loading QR; guest /join with the code typed in lower case (upper-cased) -> /j/CODE; host reader count shows 1; English hold-to-talk shows an interim card on the guest, then the final 火车站在哪里？; typed line; test hook line; Chinese hold-to-talk with the original as big text and the English below; 4 cards in order; guest reply 不客气。 reaches the host as "You're welcome."; A+ grows the text; read aloud speaks only the new line (once); md/txt/json downloads (with the host token, attachment header, both languages, the reply); End room ends the guest at once (reply disabled) and the room is 404. Screenshots `qa-<profile>-01-home` to `11-guest-ended`.
- A2 refresh mid-flow: guest reload keeps all lines, hides the waiting panel and reuses its guest token (one POST /guests across the reload); host reload keeps all lines and control of the room, the reader count comes back, sending continues. `12-guest-after-reload`, `13-host-after-reload`.
- A3 back and forward: guest /join <- /j/CODE -> forward and host / <- /host/CODE -> forward; both keep receiving, no duplicate cards, the host keeps control. `14-host-after-back-forward`, `15-guest-after-back-forward`.

B. Offline: B3 guest offline then online catches up with no duplicates and returns to Live (`16-guest-offline`, `17-guest-back-online`); B4 host offline: the typed line stays in the input, the status says it is retrying, it arrives exactly once when back online (`18-host-offline-retrying`). All three profiles.

C. Error paths:
- C1 27 API cases: bad direction, invalid JSON, text/plain (415), list rooms (405), unknown and malformed codes, QR for an unknown room, wrong/missing token (403), 2001 chars (413), missing or string `final`, bad lang, empty final, non-string text, zh in an en-zh room, unknown room, transcript without token (403) and bad format, DELETE with a wrong token, unknown sub-resource and API path, two path traversals, bad page code, POST to a page. All answer the right status with an `{error}` body, no stack traces, nothing stored.
- C2 join page: empty and short code, unknown code, pasted "abc-234" cleaned to six characters, server 500, 429 and offline each give the right bilingual message; a later click still joins.
- C3 home (desktop and iPhone): start with 500, 429 and offline shows a message and the button works again; double click / double tap creates exactly one room.
- C4 (desktop and iPhone): double submit on the host Send and on the guest send stores one line each, no duplicate cards.
- C5 translator failures: a generic upstream error gives "Translation unavailable for this line" on the host and 此句暂无翻译 on the guest without a banner; a quota error shows the quota banner, which dismisses; a slow provider shows 翻译中 then the translation; the transcript records error kinds and the md file marks the untranslated line. `qa-desktop-err-translator-quota`, `qa-desktop-err-translator-guest`.
- C6 POST segments answers 503 twice: the host says it is retrying, the line arrives once; the guest event stream answers 500 twice: Reconnecting, then Live with the backlog. `qa-desktop-err-guest-sse-500`.
- C7 /host/ZZZZZZ says expired and disables typing; /j/ZZZZZZ shows the ended state; /host/CODE in a browser without the token explains why and disables the controls, its download links carry no token; a lower-case /j/ link works; /j/AB and /nowhere are 404. `qa-desktop-err-host-unknown-room`, `qa-desktop-err-guest-unknown-room`.
- C8 markup in speech and replies is shown as text and never runs; a 2500-char line is capped at 2000 and stored; the host input has maxlength 2000.

D. a11y:
- D1 every visible button, link, input and summary has an accessible name (from the browser's own accessibility tree) on home, join, host and guest, all three profiles.
- D3 no horizontal scroll at 375 px in webkit on any page, and in chromium on home, join and guest (long unbroken text, max font, ended state). Only the chromium host page fails (bug 1).
- D4 every page has html lang, a title, headings, and live status regions.

E. Console: E1 no console errors and no uncaught exceptions on home, join, host and guest during the main-flow and a11y scenarios, all five profiles. E2 no uncaught page exceptions in any scenario, error paths included.

## Coder brief

tasks/T7-qa.md: bugs 1 to 3, plus the optional End-room message.
