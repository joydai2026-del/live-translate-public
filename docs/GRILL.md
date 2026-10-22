# GRILL: where live-translate breaks for real people

2026-10-20. Based on the code at 17eb83e plus the working tree, REVIEW-R1.md, and docs/RESEARCH.md. File references point to the current code.

## Five facts in the code that cause most of the failures

1. **Finals block each other and wait for the translator.** `feed()` chains every final behind the previous POST (`public/app.js:221-231`). The server broadcasts a final only after `translateSegment` returns (`src/server.js:158-163`), which can take up to `TIMEOUT_MS` = 8 s (`src/translate/langs.js:2`). Interims also wait for the chain. So one slow MyMemory call freezes the guest screen for up to 8 s, and the lines queued behind it wait as well.
2. **Only the host can speak, in one language at a time, chosen by hand** (`app.js:237-251`, `rec.lang` at `:280`). The guest page has no way to speak or type a reply.
3. **A lost line stays lost.** A 429, 5xx or network error drops the final with no retry (`app.js:217-219`). See REVIEW-R1 B1.
4. **The default quota covers minutes.** Anonymous MyMemory allows 5,000 chars/day per server IP, about 6 minutes of English speech (RESEARCH section 2). After that every line says "Translation unavailable", with no reason given.
5. **The QR points to localhost** unless the user knows about `PUBLIC_URL` (`src/server.js:61-66`). See REVIEW-R1 M3.

## 10 hardest scenarios

| # | Scenario | What breaks today |
|---|---|---|
| 1 | **Noisy restaurant.** The host's laptop is on the table, with clatter, music and a neighbour talking. | The recognizer transcribes the neighbour too, and every garbage final gets translated and shown in big text on the guest phone. There is no way to see confidence or to delete or fix a line (host and guest lists are append-only). `no-speech` restarts loop silently. Interims at 8 to 10/s hit the room rate limit, and real finals return 429 and are lost (fact 3). |
| 2 | **Doctor visit.** An English-speaking doctor, a Chinese-speaking patient on their own phone. | The patient cannot answer: there is no guest mic or reply box (fact 2). Medical terms go through MyMemory, a crowd translation memory, with no quality warning. Chrome sends the audio to Google, but the privacy copy suggests otherwise (REVIEW-R1 M4). Anyone who guesses the 6-char code can download the transcript (M2). If the server restarts, the record is gone. |
| 3 | **Elderly grandparent, Chinese reader, with an unfamiliar phone.** | The guest UI is English only: "Waiting for the speaker", "Reconnecting", "Room ended" (`public/guest.html:17-19`, REVIEW-R1 M5). The biggest text step is only 1.45x. There is no read-aloud, so poor eyesight or low literacy means no access. They may not know how to scan a QR code. The 6-char code is typed into an English page. |
| 4 | **Both people speak Chinese**, for example a Mandarin speaker and a Cantonese grandparent, or a reply in Chinese inside an `en-zh` room. | In an `en-zh` room the ZH button is disabled and the server rejects `lang:'zh'` with 400 (`src/server.js:145`). So the reply cannot be captured at all, and the room has to be recreated as `both`. Only `zh-CN` (Mandarin) is wired, with no `zh-HK`/`yue`. Traditional characters are never offered. |
| 5 | **Turn-taking in a `both` room.** | The host has to press EN or ZH before every turn. If they forget, the `zh-CN` recognizer turns English into confident nonsense Chinese, which is then "translated" back. The language switch calls `abort()` and drops the utterance in progress (`app.js:314-318`), and a stale interim card stays on screen (REVIEW-R1 m1). |
| 6 | **Overlapping talk and interruptions.** | There is one recognizer and one language. Two voices merge into one final, which is attributed to the selected language. Code-switching ("我们 meeting 改到 Friday") is recognized badly by a single-language recognizer, and nothing marks the line as unreliable. |
| 7 | **Bad Wi-Fi or a hotel network with client isolation.** | The guest cannot reach the host's LAN IP at all. The app gives no hint and suggests no hotspot. On flaky links, host POSTs fail and finals vanish (fact 3). Typed text is cleared before it is sent (REVIEW-R1 m5). The guest SSE reconnect and backlog are fine (`app.js:39-60`), so the guest side holds up. |
| 8 | **Host is a phone** (walking tour, market). | Phone browsers block the mic on `http://LAN-IP`. Only a tunnel or https works (RESEARCH section 4). The screen locks after 30 to 60 s and recognition stops, because there is no host wake lock (REVIEW-R1 M6). On iPhone Safari, `continuous` may never return finals (RESEARCH section 1), so the host sees "Listening" and nothing arrives. |
| 9 | **Battery: a one-hour conversation.** | The host runs continuous cloud recognition and the guest keeps the screen awake with a wake lock (`app.js:160-168`), with no dim or low-power option and no warning. Nothing tells the host that the guest phone has gone away (no presence or "1 reader connected" indicator). |
| 10 | **Long session or a second conversation in one day.** | After about 6 minutes of anonymous MyMemory, every line reads "Translation unavailable" with no reason (fact 4, REVIEW-R1 M7). The host sees no reason either, and nothing suggests `MYMEMORY_EMAIL` or DeepL. If the guest closes the tab and rejoins, the backlog works. If the host closes the tab, the hostToken in sessionStorage is gone and the room cannot be continued. |

Also: Firefox hosts and most Edge-mobile hosts get the typing fallback only. Chrome recognition probably fails on mainland China networks (RESEARCH section 1, unverified).

## Top 8 changes, ranked

Ranked by how much each one decides whether a real conversation succeeds. Changes marked (I) touch a planner-fixed interface and need the planner's sign-off first.

1. **Show the original right away and send the translation as an update; never lose a final. (I)**
   Why: facts 1 and 3. Today a slow or failed translation freezes or loses the guest's screen. The fix: broadcast the final with `translation:null` immediately, then rebroadcast the same `id` with the translation. On the client, send finals concurrently (with order kept by id), throttle interims to 3/s, retry on 429/5xx/network with backoff, and use separate rate buckets for interim and final (REVIEW-R1 B1).
   Effort: M.
   Accept: with a mock translator delayed 5 s, the guest shows the original of line 2 within 500 ms of `feed(...,true)`, before line 1's translation arrives. With interims at 10/s for 20 s and a final every 3 s, every final is in `transcript?format=json`. With the first segments POST routed to 500, the line still appears after a retry.

2. **Make the join URL work with zero configuration.**
   Why: fact 5. Most first-time users fail here.
   Fix: at startup, detect a private IPv4 address and use `http://<lan-ip>:PORT` for the QR and the link when the host is on localhost and `PUBLIC_URL` is unset. Show the same URL in both places (`GET /api/config` `joinBase`). Print it on the console. Show a "same Wi-Fi, or use a phone hotspot" hint, plus a tunnel one-liner in the README.
   Effort: S.
   Accept: in a fast test, with `os.networkInterfaces` stubbed to 192.168.1.5, the QR payload and the `[data-test=join-url]` text are both `http://192.168.1.5:3000/j/CODE`. With `PUBLIC_URL` set, `PUBLIC_URL` wins.

3. **Let the guest reply (type now, speak where possible). (I)**
   Why: scenarios 2, 3, 4 and 6. A conversation is two-way, and today half of it cannot be captured. Typing needs no mic, so it works over plain LAN http. On https origins, a "hold to speak 按住说话" button can use the guest phone's own recognizer.
   Fix: give the guest a `guestToken` from the join flow, accept `POST segments` with it (lang `zh` for en-zh guests), and add a guest reply box.
   Effort: M.
   Accept: in E2E, the guest types "你好" and the host list shows "你好" with an English translation. A forged guestToken returns 403. In an `en-zh` room a guest `zh` line is accepted, but a host `zh` line is still rejected.

4. **Two-button push-to-talk on the host: "I speak English" and "对方说中文".**
   Why: scenario 5. A single language toggle is the main source of garbage output. Large hold-to-talk buttons set `rec.lang` per press, finalize on release (`stop()`, not `abort()`), and tag the speaker. The continuous mode stays available as an option.
   Effort: S.
   Accept: with a fake SpeechRecognition in E2E, pressing and holding the ZH button creates a recognizer with `lang==='zh-CN'`. Releasing it calls `stop()`, and the final sent has `lang:'zh'`. No `.interim` card is left 1 s after release.

5. **Honest translation budget and a better free default.**
   Why: fact 4 and scenario 10.
   Fix: classify translator errors (`quota|auth|timeout|other`) and show a host banner with the fix. Warn at startup when `MYMEMORY_EMAIL` is unset (quota 5k vs 50k/day). Add an `azure` provider (F0 is 2M chars/month) and document DeepL Free (500k/month) as the quality choice. Spike: translate on the host with the Chrome desktop Translator API (free and on-device, RESEARCH section 2). (I)
   Effort: M.
   Accept: with fetch stubbed to MyMemory's quota response, the segment has `errorKind:'quota'` and `[data-test=translate-banner]` names `MYMEMORY_EMAIL`. With `TRANSLATOR=azure` and no key, the server logs a warning at startup. The azure provider passes the shared provider contract test with fetch mocked.

6. **Guest UI in Chinese, plus read-aloud.**
   Why: scenario 3. The main reader is Chinese, may be elderly, and may not read small text.
   Fix: show bilingual or zh-first status strings (`lang` set), add a 2x text step, and add a "朗读 Read aloud" toggle that calls `speechSynthesis.speak` with `lang` `zh-CN` (or `en-US`) for each new final translation.
   Effort: S.
   Accept: in an en-zh room in E2E, the waiting and status text match `/[一-鿿]/`. With `speechSynthesis` stubbed and read-aloud on, `speak` is called once per final with `utterance.lang==='zh-CN'` and never for an interim.

7. **Keep the host alive: wake lock, screen-lock detection, presence.**
   Why: scenarios 8 and 9. Silent stops are the worst failure, because nobody notices.
   Fix: request a host wake lock while listening. Show "Listening stopped because the screen locked" after the page was hidden. Show "1 reader connected" from the SSE client count, and "Speaker paused" on the guest after 60 s with no events.
   Effort: S.
   Accept: with `navigator.wakeLock.request` stubbed in E2E, it is called with `'screen'` once listening starts. After a simulated `visibilitychange` to hidden and back, `[data-test=status]` mentions the screen lock. While one guest is connected, the host shows `[data-test=readers]` = "1".

8. **Privacy that matches reality, End room, and a transcript only the host can download. (I)**
   Why: scenario 2. Medical and family conversations are sensitive, and the code is guessable (REVIEW-R1 M2, M4).
   Fix: correct copy (Google or Apple receives the audio, and anyone with the code can read). `DELETE /api/rooms/:code` with hostToken. The transcript needs the hostToken or a readToken in the QR fragment. Rate-limit 404 lookups per IP.
   Effort: M.
   Accept: `GET /transcript` without a token returns 403, and with hostToken returns 200. `DELETE` returns 204, then `GET` returns 404, and the SSE clients receive an `end`. 40 random-code lookups from one IP get 429. A grep of the pages finds "Google" and "Anyone with the room code".

Not in the top 8, but worth a spike: editing or deleting a line before or after it is sent (scenario 1); `zh-HK`/Traditional output (scenario 4); an on-device speech toggle via `processLocally` on Chrome 139+ for offline or private use (RESEARCH section 1); a measured battery drain over a 30-minute session on a mid-range Android phone.
