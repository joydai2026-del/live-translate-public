# T6 remaining after the G8 check update (planner test maintainer, 2026-10-20)

Goal: nothing open for the coder. After the planner updated the older checks for the approved G8 interface (transcript downloads and the host event stream need the host token), every check passes against the current product code.

Change: none in product code. For the record, the check-side changes were:
- checks/acceptance.test.js: the SSE/transcript test reads json and md with `&token=${hostToken}`.
- checks/review-R1.test.js: `transcript()` helper takes a token (new `tUrl()` helper, same as R2); every call passes the room's hostToken. M2 "transcript requires hostToken or readToken" is no longer skipped. M4 checks the 404 after End room with the hostToken (so a 403 cannot hide a still-living room). M1 daily budget posts the next-day line to a fresh room, because the old one expired after IDLE_MS (12 h); all assertions unchanged.
- checks/grill.test.js: G7 opens the host stream with `?role=host&token=<hostToken>`.
- checks/review-R2.test.js planner gates B1, B2, M3 now pass without edits to that file.

Remaining failures, with owner:
- none. `npm test`: 118 pass, 0 fail, 1 skipped. `bash checks/slow.sh`: common_check OK, E2E PASS, GRILL E2E 16/16.
- Skipped (not a failure, not for the coder): R1 "m10: project LICENSE file" waits for the owner to choose a license.

Don't touch checks/ (PLANNER-OWNED). If a check looks wrong, stop and explain.

Check: `npm test` then `bash checks/slow.sh`.

Done when: both stay green (0 fail, only the m10 LICENSE skip). No coder work needed unless a later change breaks them.
