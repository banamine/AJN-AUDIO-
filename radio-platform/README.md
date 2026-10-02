# AJN Radio Platform

An independent radio app built alongside the AmplitudeJS library. It uses one `Channel` catalog for live streams, clock-synchronized simulated broadcasts, and on-demand podcast channels.

## Run locally

1. Install Node.js 22.6 or newer and PostgreSQL 15 or newer.
2. Copy `.env.example` to `.env` and set `DATABASE_URL`. Set `RADIO_INGEST_TOKEN` if a live metadata source will call the ingest endpoint.
3. Create the database and install dependencies with `npm install`.
4. Generate Prisma Client and apply the checked-in schema: `npm run db:generate`, then `npm run db:migrate -- --name radio_channels`.
5. Load the demonstration channels: `npm run db:seed`.
6. Start the app with `npm run dev`; the React app and API are served at `http://localhost:3000`.

Run `npm test` for timeline/audio-engine checks and a PostgreSQL-wire integration test. The database test uses an ephemeral PGlite instance to apply the SQL migration, exercise Prisma relations and seed idempotency, and call the HTTP and SSE APIs. Production continues to use PostgreSQL through `DATABASE_URL`.

The client falls back to a small demonstration catalog while the API is unavailable. PostgreSQL is required for persisted channels, metadata ingestion, and server-sent events.

## Playback and metadata

- `prisma/schema.prisma` models live, simulated, and on-demand channels plus ordered radio segments and podcast episodes.
- `shared/timeline.ts` resolves `(now - cycleStart) % totalDuration` to the active segment and its in-file offset. The API is authoritative; the client uses the same resolver while the API is offline.
- `src/audioEngine.ts` keeps stream, segment, and episode loading outside the UI and warms the following segment in a second audio element.
- `src/playerStore.ts` keeps catalog, station selection, playback state, and now-playing metadata in a shared Zustand store.
- `GET /api/channels/:slug/events` sends now-playing updates to listeners. The server shares one polling loop per channel in each server process.
- `POST /api/ingest/channels/:slug/now-playing` accepts live metadata with `Authorization: Bearer $RADIO_INGEST_TOKEN` and sends an immediate SSE update.
- The browser Media Session API provides lock-screen metadata and play, pause, previous, and next actions.

For multiple server instances, run an SSE-capable load balancer with connection affinity and keep PostgreSQL `LISTEN/NOTIFY` available to each app instance. Live metadata ingestion publishes a channel event through PostgreSQL so every instance updates its own connected listeners; simulated schedules are calculated and emitted per subscribed channel instance.
