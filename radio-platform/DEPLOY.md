# Deploying AJN Radio to Google Cloud (Cloud Build -> Cloud Run)

**Status legend.** `VERIFIED` = I ran it and saw the output (local Docker, in this repo's CI-equivalent run).
`UNVERIFIED` = written from Google's documentation, never run against a real Google Cloud project.
Nothing in the Google Cloud sections below has been run on Google Cloud yet. Treat the first deploy as the test.

## What was verified locally (VERIFIED)

On the exact `Dockerfile` in this folder, Docker 29.8 + `postgres:16-alpine`:

- `docker build` succeeds (image ~940 MB, runs as non-root `node` user).
- Container with `RUN_MIGRATIONS_ON_START=true SEED_DEMO=true` applies the migration, seeds, and listens.
- `scripts/smoke.sh http://localhost:8080` printed: `PASS health`, `PASS catalog: 5 channels`, `PASS sse: initial now-playing frame`, `PASS ingest without token -> 401`, `PASS noindex`, `ALL CHECKS PASSED`.
- `docker stop` shut the container down in 0.2 s with exit code 0 (graceful SIGTERM).
- `PREVIEW_ACCESS=authenticated`: 401 without the password, all checks pass with `SMOKE_PASSWORD`.

(The build in my sandbox needed a proxy CA; that is a sandbox detail and is not in the committed Dockerfile.)


**Standalone mode (the default) — VERIFIED locally, 2026-10-03:** with no `DATABASE_URL` and `EMBEDDED_DB=true`, the server started its own embedded Postgres, imported the four AJN feeds (all four `ok`), and served `/api/channels`, `/api/channels/ajn-radio/episodes` (newest: War Room Hour 3, 2026-10-02) and facets. `/api/health` returned `{"status":"ok","database":"connected"}`; SIGTERM exited 0. Tests: 36/36. The container build of this mode is exercised by the `standalone-smoke` CI job.

## 1. What this deploys (standalone, the default)

One Cloud Run service. It serves the app and your AJN audio links, runs its own embedded database, and re-reads your four AJN feeds itself every 30 minutes. **No Cloud SQL, no Secret Manager, no third-party service.** The only outside things it contacts are your own feed host (`rss.alexjones.media`) and your audio host (`archive.alexjoneslive.com`); any other host in a feed is skipped.

Because the catalog is rebuilt from your feeds on every start, nothing needs to survive a restart. If you want persistent external Postgres instead, see section 8.

| Item | What | Notes |
|---|---|---|
| APIs to enable | `run.googleapis.com`, `cloudbuild.googleapis.com`, `artifactregistry.googleapis.com` | `gcloud services enable ...` |
| Artifact Registry | A Docker repository, e.g. `ajn-radio` in your region | `_AR_REPO` substitution |
| Billing | Cloud Run and Cloud Build need billing enabled on the project | check: `gcloud billing projects describe PROJECT` |
| Cloud Build service account roles | `roles/run.admin`, `roles/iam.serviceAccountUser`, `roles/artifactregistry.writer` | to deploy and push |
| Cost drivers | Cloud Run `--min-instances=1` with `--no-cpu-throttling` (an always-on instance, 1 GiB), Artifact Registry storage, egress | No prices here (any number would be unverified). https://cloud.google.com/run/pricing |

## 2. One-time setup (UNVERIFIED)

```bash
PROJECT=your-project-id
REGION=us-central1
gcloud config set project $PROJECT
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com
gcloud artifacts repositories create ajn-radio --repository-format=docker --location=$REGION
```

Then grant the Cloud Build service account the roles in the table (`gcloud projects add-iam-policy-binding ...`).

## 3. Path A: build from the zip (UNVERIFIED)

1. Open **Cloud Shell**, use the three-dot menu -> **Upload**, choose the zip, then:

```bash
unzip ajn-radio-preview-*.zip -d ajn-radio && cd ajn-radio
gcloud builds submit . --config=cloudbuild.yaml
```

2. Expected on success: the three steps `build`, `push`, `deploy` all green, then
   `Service [ajn-radio-preview] revision [...] has been deployed and is serving 100 percent of traffic.` and a `Service URL: https://...run.app`.
3. Open the Service URL. The first load may show a short "Loading channels" while the first import finishes (the server waits up to 25 s for it before listening).

## 4. Path B: Cloud Build trigger on GitHub (UNVERIFIED)

One-time: connect the GitHub repo to Cloud Build in the console (Cloud Build -> Triggers -> Connect repository). Then:

```bash
gcloud builds triggers create github --name=ajn-radio-preview \
  --repo-owner=banamine --repo-name=AJN-AUDIO- --branch-pattern='^master$' \
  --build-config=radio-platform/cloudbuild.yaml \
  --included-files='radio-platform/**' \
  --substitutions=_APP_DIR=radio-platform,_REGION=us-central1
```

## 5. After the first deploy: check the real URL

```bash
curl -s https://YOUR-SERVICE-URL.run.app/api/health      # expect {"status":"ok","database":"connected",...}
curl -s https://YOUR-SERVICE-URL.run.app/api/sources     # last sync status of each of your four feeds
curl -s "https://YOUR-SERVICE-URL.run.app/api/channels/ajn-radio/episodes?limit=3"
```

## 6. Configuration reference

| Variable | Default | Meaning |
|---|---|---|
| `EMBEDDED_DB` | `true` in cloudbuild.yaml | run Postgres inside the app (no external database). Optional `EMBEDDED_DB_DIR` keeps its files on disk |
| `SYNC_INTERVAL_MINUTES` | `30` (standalone) / `0` (external DB) | how often the server re-reads your feeds. `SYNC_DISABLED=true` turns the importer off |
| `PREVIEW_ACCESS` | `public` | `public` or `authenticated` (HTTP Basic, password = `PREVIEW_PASSWORD`; fails closed if missing) |
| `PREVIEW_PASSWORD` | none | used when `PREVIEW_ACCESS=authenticated` |
| `ROBOTS_INDEX` | unset | set to `allow` to remove `noindex` |
| `AJN_EXCLUSIVE_VARIANTS` | `Special` | which filename variants route to the `ajn-exclusive` channel |
| `SEED_DEMO` | `false` | demo content; leave off, you want only your feeds |
| `PORT` | `8080` | Cloud Run sets it |

Public preview means anyone with the URL can use it, but it is served with `X-Robots-Tag: noindex, nofollow` and a disallow-all `robots.txt`.

## 7. Adding more podcasts later

Your four feeds are listed in `server/sources/sync.ts` (`FEED_SOURCES`), with the only hosts allowed to appear in them in `ALLOWED_FEED_HOSTS` and `ALLOWED_ENCLOSURE_HOSTS`. Adding a podcast means adding its feed link and its audio host there; nothing else imports or contacts anything outside those lists.

## 8. Optional: persistent external Postgres (UNVERIFIED)

Not needed for the default. If you later want one, use `cloudbuild.cloudsql.yaml`: it needs Cloud SQL, Secret Manager secrets `ajn-radio-database-url` and `ajn-radio-ingest-token`, and runs migrations and the importer through the container entrypoint (`RUN_MIGRATIONS_ON_START`, `SYNC_SOURCES_ON_START`). The unix-socket `DATABASE_URL` form (`?host=/cloudsql/...`) is UNVERIFIED with Prisma, and the `--add-cloudsql-instances` substitution `_CLOUDSQL_INSTANCE` is required.

## 9. Things to know

- **SSE and the 3600 s limit.** Cloud Run closes any request at its timeout (maximum 3600 s). The player reconnects.
- **Always-on CPU.** `--no-cpu-throttling` lets the background feed refresh run between requests.
- **More than one instance.** Each instance holds its own copy of the catalog; they all read the same feeds, so they agree. `--max-instances` defaults to 2.
- **Mixed content.** An `https://` page blocks `http://` audio. Your AJN audio links are https.
- **Do not publish a GitHub Release** to deploy. Releases trigger the repo's old `npm publish` workflows.

## 10. Rollback (UNVERIFIED)

```bash
gcloud run revisions list --service=ajn-radio-preview --region=us-central1
gcloud run services update-traffic ajn-radio-preview --region=us-central1 --to-revisions=PREVIOUS_REVISION=100
```
