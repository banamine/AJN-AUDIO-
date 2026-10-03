# Deploying AJN Radio to Google Cloud (Cloud Build -> Cloud Run)

**What this is.** One small container. It fetches your four AJN podcast feeds and the Daily News Digest, keeps them in memory,
and serves them to the web player. **No database, no secrets, no Cloud SQL.** Google Cloud steps below are **UNVERIFIED**
(written from Google's docs, never run on a real project). The container itself was verified locally.

## Verified locally (2026-10-03)

- `docker build` of this `Dockerfile`: image 336 MB, only 5 MB of dependencies, runs as non-root `node`.
- Container started with no database and no secrets: healthy after 9 s, `GET /api/health` -> `{"status":"ok","episodes":280,"news":8}`.
- Real sources read: Alex 90, War Room 66, Sunday Night Live 14, AJN Hourly Audio 110 episodes; Daily News Digest: 8 top stories from 11 news sources.
- Page served with `X-Robots-Tag: noindex, nofollow`; `docker stop` exits 0.
- Tests: 35/35. Look at the page in a browser at desktop and phone width: ticker, news cards, podcast cards, no console errors.

## What it contacts (and nothing else)

| Host | Why |
|---|---|
| `rss.alexjones.media` | your four AJN feeds (`Alex.xml`, `WarRoom.xml`, `SundayLive.xml`, `AJNHourlyAudio.xml`) |
| `banamine.github.io` | the Daily News Digest data (`/Daily-News-Digest-/data/current/data.json`) |
| `archive.alexjoneslive.com` | the audio files; the *browser* plays them directly, an episode link to any other host is dropped |

News headlines link out to the original article; the app does not copy article text beyond the short excerpt the digest provides.

## 1. One-time setup (UNVERIFIED)

You need a Google Cloud project with billing enabled (`gcloud billing projects describe PROJECT` to check).

```bash
PROJECT=your-project-id
REGION=us-central1
gcloud config set project $PROJECT
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com
gcloud artifacts repositories create ajn-radio --repository-format=docker --location=$REGION
```

If the first build fails with a permission error, grant the Cloud Build service account `roles/run.admin`,
`roles/iam.serviceAccountUser` and `roles/artifactregistry.writer`.

## 2. Path A: deploy from the zip (UNVERIFIED)

In **Cloud Shell**: three-dot menu -> **Upload** -> pick the zip, then:

```bash
unzip ajn-radio-preview-*.zip -d ajn-radio && cd ajn-radio
gcloud builds submit . --config=cloudbuild.yaml
```

Success looks like: steps `build`, `push`, `deploy` all green, then
`Service [ajn-radio] revision [...] has been deployed and is serving 100 percent of traffic.` and a `Service URL: https://...run.app`.

## 3. Path B: Cloud Build trigger on GitHub (UNVERIFIED)

Connect the repo in the console (Cloud Build -> Triggers -> Connect repository), then:

```bash
gcloud builds triggers create github --name=ajn-radio \
  --repo-owner=banamine --repo-name=AJN-AUDIO- --branch-pattern='^master$' \
  --build-config=radio-platform/cloudbuild.yaml --included-files='radio-platform/**' \
  --substitutions=_APP_DIR=radio-platform
```

## 4. Check the live URL

```bash
curl -s https://YOUR-SERVICE.run.app/api/health     # {"status":"ok","episodes":~280,"news":8,...}
curl -s https://YOUR-SERVICE.run.app/api/sources    # last status of each of your 4 feeds and the news
```

## 5. Settings (all optional)

| Variable | Default | Meaning |
|---|---|---|
| `REFRESH_MINUTES` | `15` | how often feeds and news are re-read (also refreshed on demand when stale) |
| `NEWS_DIGEST_URL` | the digest's `data/current/data.json` | where the news comes from (must be https) |
| `AJN_EXCLUSIVE_VARIANTS` | `Special` | which filename variants go to the "AJN Exclusive" channel |
| `ROBOTS_INDEX` | unset | `allow` removes the `noindex` header |
| `PORT` | `8080` | Cloud Run sets it |

## 6. Adding more podcasts or news later

- **Podcast feed:** add it to `FEEDS` in `server/lite.ts` and its audio host to `ALLOWED_AUDIO_HOSTS` (and its feed host to the fetch list).
- **News:** the news list comes from your Daily News Digest repo; add sources there.

## 7. Things to know

- **Memory only.** The catalog is rebuilt from your feeds on every start, so nothing is lost on a restart. The first request after a cold start waits for that (up to 20 s).
- **Scale to zero is fine.** No always-on instance is configured; the first visit after idle starts the container.
- **Mixed content.** An `https://` page blocks `http://` audio. Your AJN audio links are https.
- **Do not publish a GitHub Release** to deploy. Releases trigger the repo's old `npm publish` workflows.

## 8. Rollback (UNVERIFIED)

```bash
gcloud run revisions list --service=ajn-radio --region=us-central1
gcloud run services update-traffic ajn-radio --region=us-central1 --to-revisions=PREVIOUS_REVISION=100
```

## Optional: the older Postgres version

`Dockerfile.db`, `cloudbuild.cloudsql.yaml`, `npm run start:db` and `server/index.ts` are the earlier database-backed variant
(Cloud SQL, migrations, importer job). It is kept in the repo, not used by default, and its Google Cloud steps are UNVERIFIED.
