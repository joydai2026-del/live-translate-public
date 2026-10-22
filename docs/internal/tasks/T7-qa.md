# T7 QA fixes (planner QA lead, 2026-10-20)

Source: QA.md (pre-publish heavy pass). New planner check: checks/qa_heavy.mjs, run by checks/slow.sh. It is red only for the items below.

## Goal
The host page fits phone screens in Chrome, the language toggle is a full-size tap target, and an oversized POST body gets a 413 answer.

## Change
1. **Host page horizontal scroll on Android widths (medium; qa_heavy D3 pixel7, D3 c375).** In chromium under about 441 px the single-column `.host-grid` (`grid-template-columns: 1fr`) grows to the min-content width of the Speak card (424 px). That width comes from the "Or type what you want to say" row: the text input's intrinsic width plus Send. Make the column and the row shrink: for example `.host-grid { grid-template-columns: minmax(0, 1fr); }` (keep the 860 px two-column rule) and let the `.row input` shrink from a zero basis (`flex: 1 1 0; width: 0` or equivalent). Check the result at 375 and 412 px in chromium and at 375 in webkit: nothing past the right edge, Send still visible next to the input. Evidence: evidence/qa-pixel7-a11y-host.png, evidence/qa-c375-a11y-host.png.
2. **Language toggle tap target (low; qa_heavy D2 iphone15, pixel7, c375).** `.seg` buttons (`data-test=lang-en`, `lang-zh`) are 40 px tall. Make them at least 44x44 CSS px (for example `min-height: 2.75rem`), keeping the pill look.
3. **413 for bodies over 64 KB (low; qa_heavy C1b).** In `src/server.js` `readJson`, a body over MAX_BODY rejects with 413 and then calls `req.destroy()` at once, so the client gets a connection reset and never sees the 413. Stop buffering but keep the socket until the error answer is written: for example stop collecting chunks, let the handler send the 413 with `connection: close`, and close the socket after the response finishes. The server must still never buffer more than MAX_BODY, and the 2001-char 413 must stay as it is.
4. Optional, cosmetic (no check): when the host ends the room, the host's own SSE `end` event runs `endRoomUi('This room has ended. Start a new room.')` before the DELETE answer, so the more useful "Room ended. The transcript was deleted from the server..." text never shows. If you fix it, keep the guest side unchanged (it must still end at once).

## Don't touch
checks/ (PLANNER-OWNED). If a check looks wrong, stop and explain. No em dashes, no secrets, no owner emails. No new runtime deps.

## Check
`npm test` then `bash checks/slow.sh`.

## Done when
`npm test` stays at 0 fail (only the m10 LICENSE skip) and `bash checks/slow.sh` ends with `QA HEAVY PASS`: 0 failed. The B1/B2 PWA rows may stay n/a (no manifest or service worker is required). The earlier stages (common_check, E2E, GRILL E2E 16/16) stay green.
