Everything passes now. `npm test` shows 118 passed, 0 failed and 1 skipped. `bash checks/slow.sh` passes too: common_check OK, E2E PASS, and the grill E2E passes 16/16. All 12 earlier failures came from the checks, not the product, so there is no bug for the coder to fix.

**What I changed (only in the checks; no assertion loosened or removed, no product code touched):**
- **`checks/acceptance.test.js`:** the transcript test now sends `&token=${hostToken}` when it reads the json and md transcripts.
- **`checks/review-R1.test.js`:**
  - The `transcript()` helper now takes a token, using a `tUrl()` helper copied from R2, and every call passes the room's host token. Eight tests (B1 ×3, M1 budget, M7, M8 ×2) were failing only because of this.
  - The M2 "transcript requires hostToken or readToken" test is no longer skipped, as the B1 gate asks. It still checks for 403 without a token and 200 with one.
  - M4 now checks for 404 after "End room" while passing the host token, so a 403 can't hide a room that is still alive.
  - The M1 daily-budget test sends its next-day line to a new room, because the old room has expired after 12 hours idle. That is what the B2 gate asks, and the assertions are unchanged.
- **`checks/grill.test.js`:** the G7 presence test opens the host event stream with the host token, as the M3 gate asks.
- **`checks/review-R2.test.js`:** I didn't edit it. Its gates B1, B2 and M3 pass now that the other files are fixed.

`checks/e2e.mjs` and `checks/grill_e2e.mjs` needed no changes, because they already used tokens or the host page's download link.

**What's left:**
- The 1 skipped test is R1 "m10: project LICENSE file". It's waiting for the owner to choose a license, so it isn't a product bug or a check bug.

I wrote `tasks/T6-remaining.md` as a coder brief (Goal/Change/Don't touch checks//Check/Done when); it says there is no coder work to do. None of the changed files contain em dashes.

I haven't committed anything. Running slow.sh also regenerated the screenshots in `evidence/`, and the untracked `.planfix.log` is untouched.
