# RESEARCH: live-translate platform and market facts

Compiled 2026-10-20. Every claim has a source and a date. "Unverified" means I found only secondary or conflicting sources. Free tiers change often, so recheck the official pages before relying on any number here.

## 1. Web Speech API (SpeechRecognition)

| Browser | Status (Oct 2026) | Notes |
|---|---|---|
| Chrome desktop | Supported since Chrome 25, `webkitSpeechRecognition` | By default the audio goes to a Google server, so it does not work offline [MDN, mod. 2026-08-19][mdn-sr]. On-device mode since Chrome 139 (Aug 2025) [micdrop, 2026-09-09][micdrop]. |
| Chrome Android | Supported | Same server path. The `continuous` mode on Android is known to be quirky (repeated finals), see REVIEW-R1 m7. Unverified: I found no current primary source. |
| Edge desktop | Supported, but unreliable | Edge 134 broke recognition with `network` errors until a patch [micdrop][micdrop]. A Microsoft Q&A thread reports `language-not-supported` in Edge for every language [MS Q&A][msqa]. |
| Edge Android/iOS | Probably not exposed | Only a secondary source says so [testmu][testmu]. Unverified. |
| Safari macOS 14.1+ / iOS 14.5+ | Supported, prefixed | Audio goes to Apple's recognizer. On iPhone, `continuous` "keeps the microphone open ... without ever returning the final text" [micdrop][micdrop]. Home-screen web apps historically had no SpeechRecognition [WebKit bug 225298][webkit]. Apple forum reports of continuous-mode bugs go back to iOS 15 [Apple forum][applef]. |
| Firefox | Not usable | Exposed since 142 (Aug 2025), but only behind `media.webspeech.recognition.enable`, which ships off [micdrop][micdrop]. Treat it as unsupported. |

- **zh-CN**: recognized by the Chrome and Safari server engines. On-device: Chrome `SpeechRecognition.available({langs:['zh-CN'], processLocally:true})` returns `downloadable` on Windows 11 and macOS. One developer saw `install()` hang forever, and no one I found has confirmed real zh-CN speech output on-device [glossa #47][glossa], [openinterviewer PR 100][oi]. Each pack is about 60 MB (same source).
- **On-device API** (`processLocally`, `available()`, `install()`): Experimental, Chrome only. `processLocally` defaults to `false`, so audio goes to the cloud unless the page opts in. `start()` without the pack fails with `language-not-supported`. `install()` is gated by the `on-device-speech-recognition` Permissions-Policy [MDN processLocally][mdn-pl], [MDN available()][mdn-av].
- **Continuous mode**: the spec sets no limit, and browsers end sessions on their own after silence or a time limit. The only portable pattern is the one this repo already uses: restart in `onend` while the user still wants to listen [Chrome blog][chromeblog]. I found no authoritative current number for Chrome's session cap.
- **Mainland China**: the Chrome engine needs Google servers. I found no direct source on Web Speech inside China, but Google Translate voice modes fail there without a VPN [chinasurvivalkit][csk], [koracn][kora]. Assume Chrome speech recognition fails on mainland networks, and Safari is the only recognizer likely to work there. Unverified.

**Takeaway**: the realistic host is Chrome on a laptop or Android phone, or Safari on a Mac. iPhone Safari continuous mode is risky. Firefox and most Edge mobile users get the typing fallback. "Offline" is possible only on Chrome 139+ with a manually installed pack, and that path is experimental.

## 2. Translation EN <-> zh-Hans

| Option | Free amount | Key / signup | zh-Hans | Notes |
|---|---|---|---|---|
| MyMemory | 5,000 chars/day anonymous (per IP), 50,000 chars/day with `de=email` [MyMemory limits][mm] | None (email optional) | `zh-CN` | Translation memory plus MT. Quality varies. The repo default. |
| LibreTranslate (self-host) | Unlimited, your CPU | None if self-hosted | Argos model, `zh` code. Mapping trouble reported for zh_CN vs zh_Hant [Discourse][disc] | Users report poor zh->en quality and bad punctuation [LT community, Jan 2025][ltc]. Needs Docker and a server, so it is not for non-technical users. |
| DeepL API Free | 500,000 chars/month [MS connector docs][deeplms] | Account plus credit card (anti-abuse). Mainland China cards are not accepted [saladict][salad] | Target `ZH-HANS`, source `ZH` [DeepL langs][deepllang] | Best quality for natural EN<->ZH in general. The quota resets per billing period. |
| Google Cloud Translation | First 500,000 chars/month free ($10 credit, shared Basic+Advanced), then $20/M [Google pricing][gcp] | Billing account and card | `zh-CN` | Paid after the credit runs out. A leaked key costs real money. |
| Azure Translator F0 | 2,000,000 chars/month [Azure pricing][azure] | Azure account (card at signup) | `zh-Hans` | Largest free tier. The repo has no provider for it yet. |
| Chrome Translator API (built-in) | Unlimited, on-device | None | `zh` and `zh-Hant` listed | Chrome 138+ **desktop only**, "don't work on mobile devices". `create()` needs user activation. Translations run one at a time. Packs download on demand [Chrome docs, upd. 2025-05-20][ctr]. Stable since Chrome 138, about 37 languages [locize, Jun 2026][locize]. |
| Chrome built-in AI (Prompt API, Gemini Nano) | Unlimited, on-device | None | General LLM | Desktop only: about 22 GB free disk, plus a GPU with more than 4 GB VRAM or 16 GB RAM [Chrome AI docs via search][ctr]. One secondary source says it is stable in Chrome 148 [pillitteri][gn148]. Overkill and unpredictable for this app. |

**Budget reality**: English speech runs about 150 words/min, or about 800 chars/min. Anonymous MyMemory (5,000/day) lasts **about 6 minutes** of one-way talk per server IP per day, and the `de` email (50,000) lasts about 1 hour. DeepL Free covers about 10 hours a month, and Azure F0 about 40.

**Truly free, no card**: MyMemory (tiny quota), self-hosted LibreTranslate (weak zh), and the Chrome Translator API (free, on-device, desktop Chrome only).
**Best quality for free**: DeepL API Free (card required). **Most free volume**: Azure F0.
**Recommendation**: (1) when the host runs desktop Chrome, translate on the host with the Translator API and send the translation with the segment. That is free, keeps text away from third parties, and has no quota. (2) Otherwise use DeepL Free if a key exists. (3) Fall back to MyMemory with `MYMEMORY_EMAIL` set, and warn about the quota. Item (1) changes the planner-fixed segment interface, so the planner has to decide it.

## 3. Competitors

| Product | Model | What users complain about |
|---|---|---|
| Google Translate conversation mode | One phone between two people, turn-taking | Cuts off mid-sentence, picks the wrong language, needs strict turn-taking [unstar 2026][unstar]. It can translate its own spoken output in a loop [Play reviews][play]. Voice needs internet and fails on mainland China networks [csk][csk]. |
| Microsoft Translator | Multi-device "Converse" via shared code | **Converse retired 2026-06-30** [WhistleOut, upd. 2026-03-04][wo], [APKMirror release notes][apkm]. This is the closest analogue to live-translate, and it is gone. Text, voice and camera features remain. |
| Apple Translate / AirPods Live Translation | Single device or AirPods. iOS 26+, iPhone 15 Pro+, Apple Intelligence | Live Translation with AirPods is "not available in China mainland" [Apple support][apple]. It needs recent hardware. Reviews say conversation mode is weak at language detection and needs mic taps [MacStories][macstories]. |
| iTranslate Converse | Single device, subscription | Billing traps (weekly charges, hard to cancel), no offline use, Apple Watch failures [Trustpilot][tp], [kimola][kimola], [justuseapp][jua]. |
| Timekettle earbuds (M3, W4 Pro) | Paid hardware ($150+) | 5 to 9 s delay, "works well about 60% of the time", needs strong Wi-Fi, M3 listening mode is weak for zh->en, disconnects [ShopSavvy W4][ssw4], [ShopSavvy M3][ssm3]. Earbuds fail and warranty service is poor [productreview][pr]. |

**Gap we can fill**: each person reads on their own screen, with no app install, no account, no subscription, and a downloadable bilingual transcript. Microsoft dropped exactly this in June 2026. Our weak points against rivals: no text-to-speech, the guest cannot speak back, and the app does not work offline or in mainland China.

## 4. How the guest phone reaches the host

Facts:
- The microphone (`getUserMedia`, and in practice SpeechRecognition) works only in secure contexts: https or `localhost` [MDN getUserMedia][gum]. **The guest page needs no mic**, so a plain `http://192.168.x.y:3000/j/CODE` works for the guest. Only the host needs a secure origin.
- Cloudflare Quick Tunnel: `cloudflared tunnel --url http://localhost:3000` gives a random `https://*.trycloudflare.com` URL. It needs no account, and the URL dies when the process stops. Anyone with the URL can reach the app [Cloudflare docs][cf].
- mkcert plus LAN https needs a root CA installed on every phone. That is unrealistic for non-technical users. (General knowledge, not sourced.)

What is realistic, ranked:
1. **Host on a laptop at `http://localhost:3000`, guest over LAN http.** The server prints `http://<LAN-IP>:3000` and uses it for the QR when `PUBLIC_URL` is unset. Needs both devices on the same Wi-Fi without client isolation. Hotel, cafe and hospital guest Wi-Fi often isolate clients (not sourced; common experience), and then a phone hotspot is the fallback.
2. **Any host device, via a quick tunnel.** One command, and both sides get https. The host can then be a phone. Translation and SSE go through Cloudflare, which needs internet and adds a third party.
3. **A hosted deployment.** Simplest for users, but CLAUDE.md forbids deploying, and REVIEW-R1 M1/M2 (abuse, code guessing) must be fixed first.

A non-technical user cannot be expected to set `PUBLIC_URL`. LAN IP detection must be automatic.

## Sources
[mdn-sr]: https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition
[mdn-pl]: https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition/processLocally
[mdn-av]: https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition/available_static
[micdrop]: https://micdrop.dev/blog/web-speech-api
[msqa]: https://learn.microsoft.com/en-us/answers/a/2054895
[testmu]: https://www.testmuai.com/learning-hub/speech-recognition-api-browser-support/
[webkit]: https://bugs.webkit.org/show_bug.cgi?id=225298
[applef]: https://developer.apple.com/forums/thread/699881
[glossa]: https://github.com/amngy/glossa/issues/47
[oi]: https://github.com/linxule/openinterviewer/pull/100
[chromeblog]: https://developer.chrome.com/blog/voice-driven-web-apps-introduction-to-the-web-speech-api
[csk]: https://chinasurvivalkit.com/blog/does-google-translate-work-china
[kora]: https://koracn.com/guides/google-translate-in-china
[mm]: https://mymemory.translated.net/doc/usagelimits.php
[disc]: https://meta.discourse.org/t/discourse-translator/32630/449
[ltc]: https://community.libretranslate.com/tag/support
[deeplms]: https://learn.microsoft.com/en-us/connectors/deepl/
[salad]: https://saladict.net/docs/apply-services/services/deepl
[deepllang]: https://developers.deepl.com/docs/getting-started/supported-languages
[gcp]: https://cloud.google.com/translate/pricing
[azure]: https://azure.microsoft.com/en-us/pricing/details/cognitive-services/translator/
[ctr]: https://developer.chrome.com/docs/ai/translator-api
[locize]: https://www.locize.com/blog/browser-translates
[gn148]: https://pasqualepillitteri.it/en/news/3145/gemini-nano-chrome-built-in-ai-client-side-en
[unstar]: https://unstar.app/blog/google-translate-deepl-itranslate-microsoft-translator-translation-apps-ranked-2026
[play]: https://play.google.com/store/apps/details?id=com.google.android.apps.translate&hl=en_US
[wo]: https://www.whistleout.com/CellPhones/Guides/is-microsoft-translator-worth-downloading
[apkm]: https://www.apkmirror.com/apk/microsoft/microsoft-translator/
[apple]: https://support.apple.com/en-lamr/123185
[macstories]: https://www.macstories.net/reviews/is-apples-translate-app-still-getting-lost-in-translation/
[tp]: https://pt.trustpilot.com/review/www.itranslate.com
[kimola]: https://kimola.com/reports/revolutionize-your-app-with-our-itranslate-feedback-analysis-app-store-us-147626
[jua]: https://justuseapp.com/en/app/1241264761/itranslate-converse/reviews
[ssw4]: https://shopsavvy.com/products/timekettle-w4-pro-earbuds
[ssm3]: https://www.shopsavvy.com/reviews-tldr/timekettle-m3-translator-earbuds
[pr]: https://www.productreview.com.au/listings/timekettle-m3
[gum]: https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
[cf]: https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/

All URLs were accessed 2026-10-20.
