# T3-review-R2: fix REVIEW-R2 (PLANNER-OWNED brief)

Goal: fix every BLOCKER and MAJOR item in `REVIEW-R2.md` and the MINOR items listed below, so that `checks/review-R2.test.js` passes together with every existing check. The header comment of `checks/review-R2.test.js` is the exact interface spec. If this brief and the test disagree, the test wins. Read `REVIEW-R2.md`, `CLAUDE.md`, `DECISIONS.md` and the T4 brief (`tasks/T4-grill.md`) first. This builds on T4 (25dfaea).

## Planner first (not the coder's job)
Three tests in `checks/review-R2.test.js` are planner gates. They fail until the planner fixes other planner-owned checks. Do not edit `checks/` to make them pass.
- B1 gate: `checks/acceptance.test.js` and the `transcript()` helper in `checks/review-R1.test.js` must read transcripts with `&token=<hostToken>`, and the skipped R1 "M2: transcript requires hostToken or readToken" test must be enabled or removed.
- B2 gate: the R1 "M1: daily translation char budget" test advances the clock 24 h and then posts to a room that expired after `IDLE_MS` (12 h), so it gets 404. The planner makes it use a fresh room (same server) or `idleMs`. `src/` is correct here. Do not change `IDLE_MS` or the budget code to "fix" it.
- M3 gate: the G7 presence test in `checks/grill.test.js` opens its host stream as `?role=host` with no token. After M3 that stream counts as a reader, so the planner adds `&token=<hostToken>`.
- m9: the planner may also make `checks/grill_e2e.mjs` delete `evidence/grill-fail-*` at start. Until then, delete stale ones by hand (see m9).

If the gates are still red when you start, do everything else and say so in your report. Do not work around them.

## Change

### B1. Enforce the transcript token
- `GET /api/rooms/:code/transcript` returns 403 unless `?token=` is the hostToken or the readToken. Use the existing `room.checkReadToken` (`src/rooms.js`) at `src/server.js` in the transcript route. The host download links already carry the host token. Keep them working (the test downloads the Markdown link).
- Update README (API summary, privacy) and the "Transcript token" entry in DECISIONS.md, which says it is not enforced yet.

### B2. No code change
Covered by the planner gate above. `checks/review-R2.test.js` also has a correct version of the budget day-reset test. It passes today and must keep passing.

### M1. Do not hold POSTs open for the translation
- New optional body field `wait:false` on finals. With it, answer 200 right after storing and broadcasting: `{id, text, speaker, translation:null, pending:true}`, or `{id, text, speaker, translation}` with no `pending` when the translation is already known (on-device translation, or ready within the grace window if you prefer). The translation still arrives on SSE as the same-id update.
- Without `wait`, or with `wait:true`, the behaviour is unchanged. The response waits and carries the translation. `checks/acceptance.test.js` and `checks/grill.test.js` G1 rely on this.
- Host and guest pages send `wait:false` on every final. So no more than one or two POSTs are ever open per page, even with a 4 to 8 s provider. Interims must not queue behind finals either.
- Keep the T4 guarantees: ids follow feed order, retry with backoff on 429, 5xx and network errors, typed text stays until the server has it.

### M2. Idempotent finals (`clientId`)
- Finals may carry `clientId` (1 to 64 chars from `[A-Za-z0-9_-]`, else 400). Keep a per-room map keyed by speaker and clientId. A repeat returns 200 with the same segment (same `id`, `text`, `speaker`, current `translation`, `pending`, `error`, `errorKind`). It is not stored, translated or broadcast again, and should not use up rate-limit tokens. This must also hold while the first POST is still translating.
- SSE `segment` events (pending, update and backlog) of a final posted with a clientId include `clientId`.
- Client: `createSender` gives each final a random clientId (for example `crypto.randomUUID()` without the dashes, or base64url random bytes). It reuses the same id on every retry of that final.
- m2 (do it here): `landed()` matches the page's own echo by `clientId`, not by text. An older line with the same text ("OK"), or a backlog replay, must not release the queue. Update the DECISIONS.md "Client send queue" entry. It still says "150 ms on the wire" and "retried lines can get a later id".

### M3. Authenticate the host stream
- `events?role=host&token=<hostToken>`, checked with `room.checkToken`, is the host stream and is not counted. `?role=host` with a missing or wrong token counts as a reader.
- The host page opens its EventSource with the token, including on reconnect (`listen()` in `public/app.js`). Update the DECISIONS.md "Presence" entry.

### M4. Cap SSE streams
- Export `MAX_STREAMS_PER_IP = 20` and `MAX_STREAMS_PER_ROOM = 50` from `src/server.js`. Count open streams per client IP (use the existing `clientIp`, which honours TRUST_PROXY) across all rooms, and per room. Above either cap, answer 429 JSON `{error}` with `retry-after`, before writing SSE headers. Free the slot when a stream closes (req or res `close`, room deleted, server closing). Make sure nothing is counted twice or leaked.
- A stream opened with a valid host token (M3) is exempt from both caps, so the host always gets its stream.
- README "Limits" table: add both numbers.

### M5. Banner stays in view
- `[data-test=translate-banner]` must be inside the viewport whenever it is shown, also after 20+ lines have scrolled the page, for example `position: sticky; top: 0` with a solid background and z-index. Keep the Dismiss button. Check `evidence/grill-5-quota-banner.png` after the slow run: the banner must be visible in it.

### M6. Interim cards per speaker
- Host and guest pages key interim cards by speaker and id (for example `li[data-id][data-speaker]`, or a `speaker:id` key for interims). An empty "clear" interim removes only the interim cards of `seg.speaker`. The TTL expiry and "repeat of last final" rules stay. When a final arrives, it replaces the interim card of its own speaker only.

### M7. Only the host may attach a translation
- `translation` on a final is honoured only with a valid hostToken. With a guestToken, ignore it and translate on the server (preferred) or return 400. Never store or broadcast the guest's value. Update the DECISIONS.md "On-device translation" entry.

## MINOR items to fix too
- m1: refund the reserved characters to the daily budget when the provider call fails. That covers every error kind except `budget`, and only for the day it was reserved in.
- m2: see M2.
- m3: fix the README `PUBLIC_URL` env row. Without it, the LAN (private network) address is used when the host page is on localhost, else the request's address.
- m4: always `requireJson` on `POST /api/rooms/:code/guests` (415 even with no body). New `DELETE /api/rooms/:code/guests` JSON `{hostToken}`: 204, revokes all guest tokens and frees the slots. A wrong token gets 403. The host page gets a small "Reset guests" control in the share card (optional, `data-test=reset-guests`, with a confirm). The guest page drops a saved guest token that gets 403 and requests a new one once. README: document the endpoint.
- m5: `src/translate/google.js` sends the key in the `x-goog-api-key` header, never in the URL. Update its header comment.
- m6: put the guest footer privacy copy in `<details>` with a `<summary>` reading "隐私 Privacy" (Chinese with `lang="zh-CN"`). Use guest-specific wording: the speaker can download the transcript, and the guest has no download. Collapsed, the footer is under 120 px tall at 390x844. Keep what `checks/review-R1.test.js` M4 and `checks/grill.test.js` G8 grep for in guest.html: Google, Microsoft, Apple, "anyone with the (room) code", "12 hours", "restart".
- m7: the device note on the host page reads "Lines translated on this device are not sent to a translation service." English privacy copy on all four pages says "Safari may send it to Apple", and the Chinese copy uses 可能 (for example "Safari 可能发送给 Apple"). README says "Safari may send". Drop the DeepL "the most natural English and Chinese" claim, or replace it with a sourced statement.
- m8: while the push-to-talk buttons are visible, the host empty-transcript text and status lines mention holding a button. For example the empty text "Nothing yet. Hold a button while you speak, or tap the mic to keep listening." and the `setLang` status "Ready to listen in Chinese. Hold a button while you speak, or tap the mic to keep listening." Keep the exact screen-lock message that `checks/grill_e2e.mjs` G7 expects.
- m9: delete the stale `evidence/grill-fail-*.png` files (they are committed). After a green slow run, none may remain.
- m10: in the md transcript, escape user text and translations so they cannot form links, images or raw HTML. Escape `!` before `[`, `]` before `(` (or the `(`), and `<` and `>`, plus backticks and backslashes. **Do not** escape plain `[` and `]` globally: `checks/acceptance.test.js` expects the md to contain `[zh]Thank you very much.`. This is narrower than the review's list on purpose. txt and json stay verbatim.
- m11: guest reader-language toggle `[data-test=reader-lang]` with `data-lang="zh"|"en"`, shown only in both-ways rooms. Default is `zh` when `navigator.language` starts with `zh`, else `en`. en-zh rooms are always `zh`, zh-en rooms always `en`. Remember it in localStorage. On every final card that is not this guest's own reply, `[data-test=big]` is the text in the reader language: the original when `seg.lang` equals it, else the translation or its pending or unavailable placeholder. `[data-test=small]` is the other text. Re-render the existing cards on toggle. Read-aloud speaks only lines whose big text is a translation. Bilingual label, 48 px touch target.
- m12: `src/rooms.js` exports `MAX_TOTAL_CHARS = 50_000_000`, and `new RoomStore({maxTotalChars})` tracks the stored final text across all rooms. A final that would go over it gets 503 JSON `{error}`. Deleting or expiring a room frees its characters. Check the per-room 409 first. Add a README limits row.

Deferred (not in this task): none of the MINOR items. All m1 to m12 are in scope.

## Needs owner (do not decide, do not implement beyond what is above)
- Guest transcript access: should guests get the readToken (for example in the QR fragment) so they can download their own copy? For now the guest has no download (m6 copy says so).
- Privacy copy as a legal statement: the owner to approve the final wording of the collapsed guest notice and the "may send it to Apple" phrasing before a public launch.
- DeepL quality claim: keep it only if the owner has a source they are willing to cite. Otherwise drop it (default: drop).
- Project license (still open from R1 m10, the test in `checks/review-R1.test.js` stays skipped).

## Don't touch
- `checks/`, all of it PLANNER-OWNED: `checks/review-R2.test.js`, `checks/review-R1.test.js`, `checks/grill.test.js`, `checks/grill_e2e.mjs`, `checks/acceptance.test.js`, `checks/e2e.mjs`, `checks/slow.sh`, `checks/fixtures/`. If a check looks wrong, stop and explain.
- Planner-fixed interfaces, except the additive changes above (`wait`, `clientId`, the token on the host stream, the stream caps, `DELETE /guests`, `maxTotalChars`). Default POST behaviour stays as is. The QR stays exactly `${joinBase}/j/${code}`.
- Existing data-test hooks and `window.__liveTranslateTest.feed` (same code path as recognition results).
- No new runtime deps, no em dashes in any file, no secrets in git, no deploy, never run `playwright install`.

## Check
- Fast: `npm test` (includes `checks/review-R2.test.js`. Its browser tests use headless Chromium, and the M1 browser test takes about 10 s).
- Slow: `bash checks/slow.sh` (`E2E PASS`, then `GRILL E2E: n/16 passed`). Then Read `evidence/03-host-live.png`, `04-guest-live.png`, `grill-5-quota-banner.png`, `grill-6-guest-2x.png`, and polish the guest footer, the banner and the reader-language toggle until they look good.

## Done when
- `npm test` passes with 0 failures (the R1 owner-decision skip for LICENSE may remain). If the planner gates (B1, B2 and M3 gates in `checks/review-R2.test.js`) are still red because the planner has not fixed the other checks yet, every other test passes and the report says so.
- `bash checks/slow.sh` prints `E2E PASS` and `GRILL E2E PASS`, and `ls evidence/grill-fail-*` is empty.
- README and DECISIONS.md are updated: transcript token enforced, `wait:false`, `clientId` and the send queue, host stream token, stream caps, global char cap, `DELETE /guests`, PUBLIC_URL row, copy fixes.
- Short report: what changed per item (B1, M1 to M7, m1 to m12), any deviation from this brief, and which gates were still red.
