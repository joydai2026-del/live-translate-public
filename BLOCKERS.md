# Blockers

Open items that need a person. Updated 2026-10-21.

| Item | Why it is blocked | What to do |
| --- | --- | --- |
| `bash checks/slow.sh` fails in a fresh clone | It runs `node ../common_check.mjs .`, a file from the original build harness that lives outside this repo. `checks/` is planner-owned, so it was not edited. | CI runs the three E2E scripts directly (`npm run test:e2e`). Either add `common_check.mjs` to the repo or drop that line from `slow.sh`. |
| 5 per-IP limit tests fail on macOS | They connect from `127.0.0.2`; macOS has only `127.0.0.1` unless an alias is added (a system network change). | They pass on Linux CI. On a Mac, `sudo ifconfig lo0 alias 127.0.0.2 up` makes them pass locally (not done here). |
| Local browser tests on this Mac | Playwright 1.64.1 wants Chromium build 1248; only build 1223 was cached, and WebKit is not cached at all, so `checks/qa_heavy.mjs` could not run locally. | CI installs the right browsers. Locally run `npx playwright install chromium webkit` once. |
| Public-deploy limits | `DECISIONS.md` says the abuse-limit values for a public deploy are still open. | Only matters if the app is hosted publicly. Review the Limits table in README.md first. |
| Making the repo public | Needs Rowan's decision. Nothing in history needs a rewrite (see the audit report). | `gh repo edit joydai2026-del/live-translate --visibility public --accept-visibility-change-consequences` after the PR is merged. |
