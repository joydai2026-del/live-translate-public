# Demo script: Live Translate

Voiceover for evidence/demo.mp4 (61 s, 1280x720, 24 fps, Kokoro af_heart, no music). Rebuild with `bash scripts/demo/make.sh`. Source of truth for the lines is scripts/demo/scenes.json.
Recorded on a local server with the mock translator (offline test dictionary) and fixture speech fed through window.__liveTranslateTest.feed, the same code path as a speech recognition result. Nothing here uses a real translation provider or a real microphone.

Layout: host page (desktop) on the left, guest page in a phone frame on the right.

| # | Caption | Shows | Voiceover |
| --- | --- | --- | --- |
| 0 | (card) | Title card | This is Live Translate, running locally in test mode, with an offline test dictionary standing in for the translator. |
| 1 | 1 · Pick a direction | Host home page, click Both ways | On the host computer, pick a direction. We'll go both ways, English and Chinese. |
| 2 | 2 · Share the code | Room code and QR code | The room gets a six character code, and a QR code for the other person. |
| 3 | 3 · Join on the phone | Phone types the code on /join and joins | On their phone, they type the code. No app, and no account. |
| 4 | 4 · Speak, they read | Host speaks two English lines (interim, then final); phone shows Chinese | A recording can't use the microphone, so a test hook feeds in the same results speech recognition would. Words show up as you talk, and the Chinese lands on the phone a moment later. |
| 5 | 5 · Chinese back to English | Host switches to 中文, partner line appears in English | When your friend answers in Chinese, switch the language, and you read it in English. |
| 6 | 6 · Reply from the phone | Host says thanks; phone types 不客气。, host sees You're welcome. | You say thanks, and they can type a reply right on the phone. |
| 7 | 7 · Bigger text | Phone taps A+ twice | Bigger text is one tap away. |
| 8 | 8 · Bilingual transcript | Host transcript, then the real Markdown export | Every final line is saved with its translation and a time stamp. Download it as Markdown, text, or JSON. |
| 9 | (card) | End card | Live Translate. Speak here, and they read it there. |
