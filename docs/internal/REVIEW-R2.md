# REVIEW-R2

Fresh-context review of 25dfaea (T4). I read CLAUDE.md, tasks/*.md, docs/GRILL.md, checks/, src/, public/, README.md, DECISIONS.md and evidence/*.png. I did not change any code.

Checks run by the reviewer (2026-10-20):
- `npm test`: 89 tests, 85 pass, 2 fail (`checks/grill.test.js` G8 transcript token, `checks/review-R1.test.js` M1 daily budget), 2 skipped.
- `bash checks/slow.sh`: `E2E PASS`, `GRILL E2E: 15/16 passed` (fails G8 "transcript readable without a token"). Running it rewrote the evidence/*.png files in the working tree.
- One extra browser probe (described in MAJOR 1) and one server probe (BLOCKER 2), both run from /tmp and not committed.

No em dashes in tracked files. No secrets in git (the logs are gitignored). All rendering goes through textContent, the CSP has no inline script, and keys never reach the client.

## BLOCKER

### B1. Planner checks contradict each other on transcript access, so the suite cannot go green and the transcript is open to anyone with the code
- What: `checks/grill.test.js:365` and `checks/grill_e2e.mjs` (G8) require 403 without `?token=`. `checks/acceptance.test.js:25-26` and the `transcript()` helper at `checks/review-R1.test.js:74` read transcripts without a token. The coder correctly left `src/server.js:362-368` open, as the brief says to. Result: red fast and slow suites, and the privacy gap stays (anyone who knows the 6-char code can download the full bilingual record).
- Why: you can't launch with a red suite, and the transcript is the most sensitive data in the app (GRILL scenario 2, doctor visit).
- Fix (planner first): update `acceptance.test.js` and the R1 `transcript()` helper to pass `&token=hostToken`, and delete or enable the skipped R1 M2 test. Then the coder enforces `room.checkReadToken(url.searchParams.get('token'))` at `src/server.js:362`. `room.checkReadToken` already exists at `src/rooms.js:87` and is never called.
- Acceptance: `npm test` 0 failures. G8 passes. `curl /api/rooms/CODE/transcript` returns 403, and the host's Markdown link downloads.

### B2. `checks/review-R1.test.js` M1 daily-budget test is wrong: it advances the clock past the 12 h idle expiry
- What: `checks/review-R1.test.js:231` calls `c.adv(24h)` and then posts to the same room. `RoomStore` uses the same clock and `IDLE_MS` is 12 h (`src/rooms.js:6,141`), so the room has expired and the POST returns 404. `n.json.translation` is `undefined`. I reproduced this outside the test: status 404, `{"error":"room not found"}`. The code is right and the check is wrong. It is planner-owned, so the coder must not touch it.
- Fix (planner): after the day rollover, create a new room (with the same server, so the same budget) or post a keep-alive every <12 h of fake time. Another option is `new RoomStore({now, idleMs: 48h})` in that test.
- Acceptance: the M1 budget test passes against unchanged `src/`, and still fails if `budgetAllows` stops resetting on the UTC day (try `day !== budget.day` -> `false`).

## MAJOR

### M1. POSTs wait for the translation, so Chrome's 6-connection limit re-freezes the live view (G1 regression under load)
- What: `src/server.js:270-279` keeps every final's POST open until the translation finishes. The client sends the next final once the previous one "landed" (`public/app.js:147-164,222`), so many POSTs stay open at once. Plain-http LAN (the default join path) is HTTP/1.1, which allows 6 connections per origin, and the SSE stream takes one of them.
- Evidence (my probe): with a 6 s translator and a final fed every 300 ms, lines 1 to 5 reached the guest at about 2.5 s. Line 6 (fed at about 1.5 s) appeared at 6.4 s and line 8 at 7.3 s. Interims queue behind them too. MyMemory with its 8 s timeout, or a slow DeepL, hits this whenever someone talks fast.
- Fix: let the client opt out of waiting, e.g. body `wait:false`. The server returns `{id, pending:true}` right after storing, and the translation arrives on SSE. This is additive and keeps the planner interface for callers that don't send it. Alternatively, cap in-flight finals at 3 in `createSender`.
- Acceptance (browser): translator delayed 6 s, 10 finals fed 300 ms apart. Every original is on the guest page within 1 s of its feed, and every interim sent in between is broadcast within 1 s.

### M2. A retried final can be stored twice (no idempotency)
- What: the server stores the segment before it waits for the translation (`src/server.js:261-266`). If the response is lost (phone switches network, proxy timeout, tab throttled), the client retries on a network error (`public/app.js:138-139,182-188`) and the server stores a second copy with a new id. Holding the POST open for the whole translation (M1) makes this window seconds long. The m7 repeat filter (`app.js:688-691`) runs only at feed time, not on retries. DECISIONS.md "Client send queue" already admits retried lines can get a later id.
- Fix: the client sends a random `clientId` per final, and the server keeps a per-room map `clientId -> seg` and returns the existing segment on a repeat.
- Acceptance (server): two POSTs with the same `clientId` give the same `id`, one transcript line and one translator call. Browser: route the first segments POST so it reaches the server but the response is aborted. The transcript has the line exactly once.

### M3. `?role=host` is unauthenticated, so a silent eavesdropper is invisible to the readers indicator
- What: `src/server.js:301` lets any stream that sends `?role=host` drop out of the count. The readers indicator (G7) exists so the host notices unexpected readers. Anyone with the code can read along while the host sees "No one is reading yet". DECISIONS.md "Presence" calls this harmless, but it defeats the feature's purpose.
- Fix: count a stream as the host only with a valid token, e.g. `?role=host&token=<hostToken>` checked with `room.checkToken`. Otherwise it counts as a reader.
- Acceptance: `events?role=host` without a token counts as a reader (`presence.readers` goes 0 -> 1). With the hostToken it is not counted.

### M4. No limit on SSE streams per room or per IP
- What: `events()` (`src/server.js:282-315`) accepts unlimited streams. Each one holds a socket, a heartbeat timer and backlog writes of up to 200k chars. One client with the code can exhaust file descriptors or memory, and can inflate the presence count.
- Fix: cap streams per room (e.g. 50) and per IP (e.g. 20) and answer 429 above that. Document it in the README limits table.
- Acceptance: from one IP, stream 21 gets 429, and after closing one a new stream is accepted. Room cap: stream 51 gets 429.

### M5. The translation-problem banner is off-screen when it matters
- What: `[data-test=translate-banner]` sits at the top of `public/host.html:16`. Each new line calls `scrollIntoView` (`public/app.js:978`), so by the time a quota error arrives the host is looking at the transcript. `evidence/grill-5-quota-banner.png` shows no banner at all, only the italic line "Not translated: the translation quota is used up". The e2e test checks `visible`, not "in the viewport".
- Fix: make the banner `position: sticky; top: 0` (or fixed), or repeat it next to the status line in the Speak card.
- Acceptance (browser): 20 lines, then a quota error. The banner's bounding box is inside the viewport (`boundingBox().y >= 0 && y < innerHeight`), and the evidence screenshot shows it.

### M6. Host and guest interims share one id, and one side's "clear" wipes the other's live card
- What: an interim uses `id: room.nextId` whoever sends it (`src/server.js:251`). When host and guest speak at the same time (a both-ways room, host push-to-talk plus guest hold-to-talk), both write into the same `li[data-id]` and overwrite each other. An empty clear interim from either side removes every `.interim` card on both pages (`public/app.js:374,958`, `clearInterims`). No test covers two speakers at once.
- Fix: key interim cards by `speaker` plus id, and clear only the sender's own speaker's card (the server already sends `speaker` on interims).
- Acceptance (browser): the host interim "Hello" and the guest interim "你好" are both visible as separate cards. A guest clear removes only the guest card.

### M7. A guest token can attach its own "translation"
- What: `src/server.js:240-245` accepts `translation` from any speaker. A guest can show the host a translation that doesn't match what the guest actually said, e.g. original "我同意" with an invented English line. DECISIONS.md "On-device translation" argues trust only for the host. The guest page never sends `translation`, so nothing needs it.
- Fix: accept `translation` only together with a valid hostToken. For guests, ignore it or return 400.
- Acceptance: a guest POST with `translation:"fake"` gets a server translation (the translator is called once) or a 400, never `"fake"`.

## MINOR

### m1. The daily budget is spent even when the provider fails
- Where: `src/server.js:195-220`. `budgetAllows` reserves the chars before the call, and a timeout, auth or quota error doesn't give them back, so a provider outage drains the budget.
- Fix: refund `seg.text.length` in the `catch`.
- Acceptance: limit 50, a 30-char line whose provider throws, then a 30-char line. The second one is translated.

### m2. The send-queue docs don't match the code, and "landed" matches by text only
- Where: DECISIONS.md "Client send queue" says the next final goes out after "150 ms on the wire". The code waits for the SSE echo, matched by text alone (`public/app.js:222-227`). A backlog replay on reconnect, or an older identical line ("OK"), can release the next final early.
- Fix: match on `speaker` plus a `clientId` echo (see M2), and update DECISIONS.md.
- Acceptance: unit test of `createSender`: a broadcast of an older segment with the same text does not release the queue.

### m3. The README `PUBLIC_URL` row is out of date
- Where: README.md, env table: "Without it, the address of the host's request is used."
- Fix: say that the LAN address is used when the host page is on localhost (as the "Joining from a phone" section explains).
- Acceptance: a grep of README for the env row mentions the LAN address.

### m4. Anyone with the code can use up the 20 guest tokens, and a bodyless POST skips the JSON check
- Where: `src/rooms.js:89-94` (the cap is per room, but 30 per IP per hour is more than 20), `src/server.js:352-354` (`requireJson` runs only when there is a body, so a cross-site `<form method=post>` can mint tokens).
- Fix: always `requireJson` on `/guests`, give a page that reloads its old token back (it already uses sessionStorage), and let the host reset guests.
- Acceptance: `POST /guests` with no content type returns 415. Twenty-one tokens from one IP: the 21st gets 429, and a host "reset guests" call frees the slots.

### m5. The Google API key travels in the query string
- Where: `src/translate/google.js` (`u.searchParams.set('key', key)`). Proxies and egress logs record URLs.
- Fix: send it in the `x-goog-api-key` header.
- Acceptance: provider test: the request URL has no `key=`, and the header is set.

### m6. Guest footer: a wall of text, and it promises a download the guest doesn't have
- Where: `public/guest.html:45`. `evidence/04-guest-live.png` and `evidence/grill-6-guest-2x.png` show bilingual privacy paragraphs filling most of a 390 px screen. They say "download the transcript" and "Download your transcript before you leave", but the guest page has no download.
- Fix: collapse the copy into a `<details>` labelled "隐私 Privacy", with guest-specific wording ("the speaker can download the transcript").
- Acceptance: on a 390x844 screen with one line, the footer is under 120 px tall when collapsed. The guest copy doesn't contain "Download your transcript".

### m7. Copy that overclaims
- Where: `public/host.html:94` ("so the text does not go to a translation service"), but lines whose device translation fails, and every guest reply, still go to the provider. The footers say "Safari sends it to Apple", which is not true in every case (Apple may process speech on the device), so "may send" is accurate. README "the most natural English and Chinese" (DeepL) is an unsourced quality claim.
- Fix: "Lines translated on this device are not sent to a translation service". Use "may send it to Apple". Drop or source the DeepL claim.
- Acceptance: grep tests for the new strings.

### m8. Host copy still tells the host to "tap the mic" although push-to-talk is now the main control
- Where: `public/host.html:89` (empty state), `public/app.js:704`. `evidence/03-host-live.png` shows "Ready to listen in Chinese. Tap the mic." right under the two hold buttons.
- Fix: "Hold a button while you speak, or tap the mic to keep listening." everywhere.
- Acceptance: none of the host status or empty texts starts with "Tap the mic" while the PTT buttons are visible.

### m9. Stale failure screenshots in evidence/
- Where: `evidence/grill-fail-g1-0.png` to `grill-fail-g7-0.png` (10:18, from the T3 run, committed in cce6fd2), next to current passing screenshots.
- Fix: delete `evidence/grill-fail-*` at the start of `grill_e2e.mjs` (planner), or remove them by hand before each commit.
- Acceptance: after a green slow run, `ls evidence/grill-fail-*` is empty.

### m10. Markdown transcript lets speech or reply text inject links and images
- Where: `src/server.js:129-130`. A guest reply such as `![x](https://tracker/p.png)` loads a remote image when the host opens the .md in a previewer.
- Fix: escape `\ ` `` ` `` `* _ [ ] ( ) ! < > #` in md output.
- Acceptance: a final with that text produces md containing `\!\[x\]` and no unescaped `](`.

### m11. In both-ways rooms the guest still sees every line's translation, including English for the host's Chinese lines
- Where: `public/app.js:392-397`. `evidence/04-guest-live.png` shows "The train station is just ahead." large for a Chinese reader. This is R1 m6, deferred and still open.
- Fix: a reader-language toggle on the guest page, so the big text is always in the reader's language.
- Acceptance: a guest with reader language zh sees 火车站在前面。 large for a ZH host line.

### m12. Worst-case memory is far beyond a small server
- Where: `src/rooms.js:7-9`. 10,000 rooms times 200,000 chars is about 2e9 chars before indexes. The per-IP room limit only slows this down.
- Fix: add a global stored-chars cap (e.g. 50M) and return 503 above it.
- Acceptance: unit test with a lowered cap: a final over the global cap returns 503, and other rooms still read fine.
