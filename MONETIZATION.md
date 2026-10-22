# Monetization

Recommendation: open source it to show the work. Do not plan on selling it.

## Why selling is weak

- Free, polished competitors already do this: Google Translate's conversation mode, Microsoft Translator's multi-device conversations, Apple Translate, and phone-maker live translation features. They run on the phone the user already has.
- The real cost of a hosted version is translation. MyMemory's free quota is about 6 minutes of speech a day; paid providers bill per character. A paid tier would have to resell DeepL, Azure or Google at a margin, against free apps.
- Speech recognition happens in the browser and goes to Google, Microsoft or Apple. A paid product would inherit that privacy story without controlling it.
- Rooms live in one server's memory. A hosted paid version needs persistent storage, accounts and billing before anyone pays, which is real work for an unproven demand.

## If you still want to try

- Free open source core (this repo, MIT) plus a small hosted version: free for short sessions, then a flat monthly plan (for example 5 to 9 USD) that bundles a translation quota. Billing through Stripe Checkout, built and tested in Stripe TEST mode first. A narrow audience (tutors, small clinics, churches or community groups doing English and Chinese events) is the only place it could beat the free apps, through the no-install QR join and the downloadable bilingual transcript.
- Validate first: share the open source version, see if anyone asks for a hosted one, then build billing.

## Why open source helps

It is a clean, well-tested example (about 120 tests, browser end-to-end tests, rate limits, privacy notes) of a real-time web app with pluggable translation providers. That is a better portfolio piece than a product with no customers.
