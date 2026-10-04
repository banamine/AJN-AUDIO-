# AJN Radio (radio-platform/)

A small web app that plays the owner's own AJN audio: recorded shows from four AJN RSS feeds, six live stream links, and a Daily News Digest ticker. Deployable to Google Cloud Run. Everything in this file was true when written; re-check with the code before relying on it.

## Scope: keep it simple
- One Node/Express server (`server/lite.ts`) plus a React SPA (`src/`). **No database, no accounts, no secrets, no Firebase.** State lives in memory and is refreshed in the background (default every 15 min, `REFRESH_MINUTES`). A failing source keeps its previous data.
- Keep the existing look and feel. Add to the app; do not rebuild or restyle it wholesale.
- Only the sources below are contacted. Do not add station directories, other feeds or scrapers. Affiliate directories default OFF; no station import without license resolution.
- `server/index.ts`, `prisma/`, `Dockerfile.db`, `cloudbuild.cloudsql.yaml` are the old Postgres variant. Leave them alone. Never edit `prisma/migrations/20261001000000_radio_channels/` (additive migrations only).
- The repo root (`../src`, `../webpack.config.js`, other workflows) is a legacy app. Do not modify it or its workflows. The only workflow that belongs to this app is `.github/workflows/radio-platform.yml`.

## Sources (hard-coded allowlists in `server/lite.ts`)
- Podcast feeds: `https://rss.alexjones.media/{Alex,WarRoom,SundayLive,AJNHourlyAudio}.xml`, plus `AJNHourlyVideo.xml` for video pairing. The feeds publish **no durations**, only enclosure byte size (`sizeBytes`).
- Audio and video files: `archive.alexjoneslive.com`, https only. That host sends **no CORS headers**, so recorded audio cannot be read by Web Audio.
- Live streams (6): `stream.alexjones.media` (verified `Access-Control-Allow-Origin: *`) and two `audio.alexjoneslive.com:8443` links (**unverified**, unreachable from the sandbox).
- News: `https://banamine.github.io/Daily-News-Digest-/data/current/data.json`. Links must be https; entities are decoded.
- Setting `crossOrigin` on an element whose host lacks CORS stops the audio loading. `RadioAudioEngine` only uses CORS mode for `CORS_LIVE_HOSTS`; keep it that way.

## Commands (run in `radio-platform/`, Node 22)
- `npm run dev` (Vite middleware, no build needed; AI Studio uses this), `npm run build`, `npm start`.
- `npm test` (node test runner with `--experimental-strip-types`; `.tsx` files cannot be imported by tests, so keep testable logic in plain `.ts`), `npx tsc --noEmit`.
- `SKIP_INITIAL_REFRESH=true` skips the startup fetch (tests use it). `scripts/smoke-lite.sh` is the container smoke test CI runs.
- `npm run package:zip` writes `dist-zip/ajn-radio-preview-<sha>.zip` (gitignored). The owner uploads this zip to Google AI Studio and to Cloud Shell, so a delivered zip must contain `Dockerfile`, `public/art/` and everything needed to build.
- The server resolves `dist/` from its own file location (not the working directory) and answers 503, not a crash, when the build is missing (the old `ENOENT .../dist/index.html` bug).

## Behaviour worth knowing
- API: `/api/health`, `/api/channels`, `/api/channels/:slug/episodes` (`order=newest|oldest`, show/type filters, cursor, 400 on bad input), `/episodes/facets`, `/now-playing` and `/events` (live only), `/api/news`, `/api/sources`.
- Channels: 2 on-demand (AJN Radio, AJN Exclusive; Exclusive = filename variant `Special`, configurable via `AJN_EXCLUSIVE_VARIANTS`, **assumption not confirmed by the owner**) and 6 live.
- Live audio is marked red (`LIVE AUDIO`), recorded audio green (`RECORDED`).
- The audio elements and `RadioAudioEngine` live at the app root so playback survives any UI change. Live streams reconnect with backoff; the analyser is a read-only `captureStream` tap that never reaches the speakers.
- Episode progress is remembered in the browser (`localStorage`, wrapped in try/catch). Length sort uses file size because durations are unknown.
- Artwork: `public/art/*.webp` (served at `/art/<name>.webp`). Not yet used beyond being served.
- The video/Watch UI, mobile compact view and main-app deep link are separate pieces of work; check the open prompts before assuming they exist.

## Working rules (the owner's standing preferences)
- **Evidence first.** Run it, read the output, then report. Never invent results, metadata, URLs, durations or test outcomes. Say "not run" or "unverified" for anything you did not run. The sandbox Chromium has no AAC decoder, so real live-stream audio cannot be heard there; the `:8443` links were never reachable.
- **Google Cloud commands are UNVERIFIED** until the owner runs them. Billing status is unknown.
- **Do not publish a GitHub Release. Do not merge PRs** (PR #4 `radio-lite` is open) unless the owner explicitly says so. Check real CI results with `gh api` (GraphQL is blocked); do not trust a notification alone.
- Never put secrets or connection strings in chat or the repo. Never enter passwords or credentials anywhere; if a sign-in wall appears, ask the owner to attach files or paste output.
- Keep changes isolated to the failing component. Prefer small, additive changes. Do not edit generated or lock files by hand.
- Commits end with the `Co-Authored-By` and `Claude-Session` lines; PR bodies end with the Claude Code line plus the session URL.
- Sandbox tips: outbound fetch needs `NODE_USE_ENV_PROXY=1` and `NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt`. Do not `pkill -f` a pattern that appears in your own command line; kill by port (`fuser -k PORT/tcp`).
- The owner works from Windows (`N:\AJN-AUDIO\AJN-AUDIO-`), prefers short PowerShell commands, and hands UI work to Google AI Studio via pasteable prompts. Write those prompts so they say what NOT to touch and ask for "not run" reporting.

## Branches
`radio-lite` (PR #4 head), then `radio-lite-polish`, `radio-lite-video`, `radio-lite-enoent`, `radio-lite-patched` (latest: share, progress bar, sort dropdown, visualizer). Confirm the current state with `git log` before assuming.
