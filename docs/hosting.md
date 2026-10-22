# Hosting

Short answer: you do not need hosting. The app is built to run on the host's own laptop (`npm start`), with the guest's phone on the same Wi-Fi or a phone hotspot. That costs nothing and needs no maintenance.

If you want a public URL anyway:

| Option | Fits this app? | Why |
| --- | --- | --- |
| GitHub Pages / Cloudflare Pages | No | Static files only. This app is a Node server with in-memory rooms and Server-Sent Events. GitHub Pages on a free plan also needs a public repo. |
| Cloudflare Workers | Only after a rewrite | Rooms would need Durable Objects, which is a rewrite of `src/rooms.js` and `src/server.js`. |
| Render web service (free) | Yes, as is | One Node process, https included. Free instances sleep after idle time and lose their rooms. Config: `deploy/render.yaml` (inert). |
| Fly.io (one small machine) | Yes, as is | Same shape as Render, does not sleep if you keep one machine running, but needs a card. |

Pick: Render, because it runs the server unchanged, gives https (needed for the microphone on phones), and has a free tier. To use it, create a Render Blueprint pointing at `deploy/render.yaml`, set `PUBLIC_URL` to the service URL, and keep `TRANSLATE_DAILY_CHAR_LIMIT` set so a public instance cannot run up a translator bill. Nothing in this repo deploys on its own.
