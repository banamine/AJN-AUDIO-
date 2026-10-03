// Simple server: fetches your AJN podcast feeds and the Daily News Digest into memory and serves them
// to the web player. No database, no secrets. Only the hosts listed below are ever contacted.
import 'dotenv/config';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { channelSlugFor, classifyItem, parseFeedXml, type ClassifiedItem } from './sources/ajn.ts';
import { parseNewsDigest, type NewsDigest } from './news.ts';
import { noindexMiddleware, robotsTxtHandler } from './preview.ts';

export const FEEDS = [
  { slug: 'ajn-alex', name: 'Alex Jones Show', url: 'https://rss.alexjones.media/Alex.xml' },
  { slug: 'ajn-warroom', name: 'War Room', url: 'https://rss.alexjones.media/WarRoom.xml' },
  { slug: 'ajn-sundaylive', name: 'Sunday Night Live', url: 'https://rss.alexjones.media/SundayLive.xml' },
  { slug: 'ajn-hourly-audio', name: 'AJN Hourly Audio', url: 'https://rss.alexjones.media/AJNHourlyAudio.xml' },
];
export const VIDEO_FEED_URL = 'https://rss.alexjones.media/AJNHourlyVideo.xml';
export const NEWS_URL = process.env.NEWS_DIGEST_URL ?? 'https://banamine.github.io/Daily-News-Digest-/data/current/data.json';
const ALLOWED_AUDIO_HOSTS = ['archive.alexjoneslive.com'];
const ALLOWED_FETCH_HOSTS = ['rss.alexjones.media', new URL(NEWS_URL).hostname];
export function refreshMinutes(value: string | undefined, fallback = 15): number {
  const minutes = Number(value);
  return value !== undefined && Number.isFinite(minutes) && minutes >= 1 && minutes <= 1440 ? minutes : fallback; // invalid input falls back instead of becoming NaN
}
const REFRESH_MS = refreshMinutes(process.env.REFRESH_MINUTES) * 60_000;
const EXCLUSIVE = (process.env.AJN_EXCLUSIVE_VARIANTS ?? 'Special').split(',').map(value => value.trim()).filter(Boolean);
const CHANNELS = {
  'ajn-radio': { name: 'AJN Radio', description: 'Completed shows and hours from the AJN feeds.' },
  'ajn-exclusive': { name: 'AJN Exclusive', description: 'Special editions from the AJN feeds.' },
} as const;
type ChannelSlug = keyof typeof CHANNELS;
/** Live audio streams, exactly as listed on https://rss.alexjones.media/ ("Live Audio Stream Links"). Played by the browser directly. */
export const LIVE_CHANNELS = [
  { slug: 'live-alex-aac', name: 'Alex Jones Show (AAC)', url: 'https://stream.alexjones.media/alexjonesshow' },
  { slug: 'live-alex-mp3', name: 'Alex Jones Show (MP3)', url: 'https://stream.alexjones.media/alexjonesshow.mp3' },
  { slug: 'live-alex-opus', name: 'Alex Jones Show (OPUS)', url: 'https://audio.alexjoneslive.com:8443/alexjonesshow.opus' },
  { slug: 'live-alex-aac-alt', name: 'Alex Jones Show (alternate AAC)', url: 'https://audio.alexjoneslive.com:8443/alexjonesshow.aac' },
  { slug: 'live-warroom', name: 'War Room with Harrison Smith', url: 'https://stream.alexjones.media/warroom/' },
  { slug: 'live-network', name: 'Network Feed - All Live Shows', url: 'https://stream.alexjones.media/stream/7/' },
] as const;
const liveChannel = (slug: string) => LIVE_CHANNELS.find(channel => channel.slug === slug);
const SHOW_TYPES = ['full_show', 'hour', 'segment', 'special', 'live'];

export type Episode = {
  id: string; title: string; rawTitle: string; description: null; audioUrl: string; durationSeconds: null; publishedAt: string | null;
  airDate: string | null; showSlug: string | null; showType: string | null; hourNumber: number | null; variant: string | null; needsReview: boolean; channel: ChannelSlug;
  /** Matching AJN hourly video (.m4v) when the video feed has the same file key; otherwise null. Never guessed. */
  videoUrl: string | null;
};
/** `https://host/hourly-mp3/20261002_Fri_WarRoom-Hr3.mp3` -> `20261002_Fri_WarRoom-Hr3`. */
export const fileKey = (url: string): string | null => { try { const name = new URL(url).pathname.split('/').pop() ?? ''; const stem = name.replace(/\.[A-Za-z0-9]+$/, ''); return stem || null; } catch { return null; } };
const isVideoUrl = (value: string): boolean => { try { const u = new URL(value); return u.protocol === 'https:' && ALLOWED_AUDIO_HOSTS.includes(u.hostname) && /\.(m4v|mp4)$/i.test(u.pathname); } catch { return false; } };
type FeedStatus = { slug: string; name: string; feedUrl: string; lastSyncAt: string | null; lastStatus: 'ok' | 'error' | 'pending'; lastError: string | null; episodes: number };

export const store = {
  episodes: [] as Episode[],
  byFeed: new Map<string, Episode[]>(),
  news: null as NewsDigest | null,
  newsFetchedAt: null as string | null,
  lastPodcastSuccess: null as string | null,
  videoByKey: new Map<string, string>(),
  videoStatus: { lastSyncAt: null as string | null, lastStatus: 'pending' as 'ok' | 'error' | 'pending', lastError: null as string | null, items: 0 },
  feeds: new Map<string, FeedStatus>(FEEDS.map(feed => [feed.slug, { slug: feed.slug, name: feed.name, feedUrl: feed.url, lastSyncAt: null, lastStatus: 'pending', lastError: null, episodes: 0 }])),
  newsStatus: { lastSyncAt: null as string | null, lastStatus: 'pending' as 'ok' | 'error' | 'pending', lastError: null as string | null },
  lastRefresh: 0,
};

const byEpisodeOrder = (a: Episode, b: Episode) =>
  (b.airDate ?? '').localeCompare(a.airDate ?? '') || (b.publishedAt ?? '').localeCompare(a.publishedAt ?? '') || (b.hourNumber ?? -1) - (a.hourNumber ?? -1) || a.id.localeCompare(b.id);
const message = (error: unknown) => (error instanceof Error ? (error.name === 'TimeoutError' ? 'request timed out' : error.message) : String(error));

export async function getText(url: string, fetchImpl: typeof fetch, maxBytes = 5_000_000): Promise<string> {
  const target = new URL(url);
  if (target.protocol !== 'https:' || !ALLOWED_FETCH_HOSTS.includes(target.hostname)) throw new Error('host is not allowed');
  const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { 'user-agent': 'ajn-radio/1.0' } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('response too large');
  if (!response.body) return '';
  // Read as a stream and stop at the cap, so an oversized body is never fully buffered.
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) { await reader.cancel().catch(() => undefined); throw new Error('response too large'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Re-reads every source. A failing source keeps its previous data and never affects the others. */
export async function refresh(fetchImpl: typeof fetch = fetch): Promise<void> {
  const next = new Map<string, Episode[]>();
  await Promise.all(FEEDS.map(async feed => {
    const status = store.feeds.get(feed.slug)!;
    try {
      const items = parseFeedXml(await getText(feed.url, fetchImpl));
      const episodes: Episode[] = [];
      for (const raw of items) {
        const item: ClassifiedItem | null = classifyItem(raw, { exclusiveVariants: EXCLUSIVE });
        if (!item) continue;
        try { const audio = new URL(item.audioUrl); if (audio.protocol !== 'https:' || !ALLOWED_AUDIO_HOSTS.includes(audio.hostname)) continue; } catch { continue; }
        episodes.push({
          id: createHash('sha1').update(`${feed.slug}:${item.guid}`).digest('hex').slice(0, 16), title: item.cleanTitle, rawTitle: item.rawTitle.slice(0, 512),
          description: null, audioUrl: item.audioUrl, durationSeconds: null, publishedAt: item.publishedAt ? item.publishedAt.toISOString() : null, airDate: item.airDate,
          showSlug: item.showSlug, showType: item.showType, hourNumber: item.hourNumber, variant: item.variant, needsReview: item.needsReview, channel: channelSlugFor(item, EXCLUSIVE), videoUrl: null,
        });
      }
      if (items.length > 0 && episodes.length === 0) throw new Error('feed had items but none were playable');
      next.set(feed.slug, episodes);
      Object.assign(status, { lastSyncAt: new Date().toISOString(), lastStatus: 'ok', lastError: null, episodes: episodes.length });
    } catch (error) {
      Object.assign(status, { lastSyncAt: new Date().toISOString(), lastStatus: 'error', lastError: message(error) });
    }
  }));
  // A feed that failed keeps its previous episodes; only a successful read replaces them.
  for (const [slug, episodes] of next) store.byFeed.set(slug, episodes);
  if (next.size > 0) store.lastPodcastSuccess = new Date().toISOString();
  // Optional: pair each episode with its hourly video by file key. A failing video feed keeps the previous pairing and never affects audio.
  try {
    const videos = new Map<string, string>();
    for (const item of parseFeedXml(await getText(VIDEO_FEED_URL, fetchImpl))) {
      const key = item.enclosureUrl ? fileKey(item.enclosureUrl) : null;
      if (key && item.enclosureUrl && isVideoUrl(item.enclosureUrl)) videos.set(key, item.enclosureUrl);
    }
    store.videoByKey = videos;
    Object.assign(store.videoStatus, { lastSyncAt: new Date().toISOString(), lastStatus: 'ok', lastError: null, items: videos.size });
  } catch (error) {
    Object.assign(store.videoStatus, { lastSyncAt: new Date().toISOString(), lastStatus: 'error', lastError: message(error) });
  }
  for (const episodes of store.byFeed.values()) for (const episode of episodes) { const key = fileKey(episode.audioUrl); episode.videoUrl = key ? store.videoByKey.get(key) ?? null : null; }
  store.episodes = [...store.byFeed.values()].flat().sort(byEpisodeOrder);
  try {
    store.news = parseNewsDigest(JSON.parse(await getText(NEWS_URL, fetchImpl)));
    store.newsFetchedAt = new Date().toISOString();
    Object.assign(store.newsStatus, { lastSyncAt: new Date().toISOString(), lastStatus: 'ok', lastError: null });
  } catch (error) {
    Object.assign(store.newsStatus, { lastSyncAt: new Date().toISOString(), lastStatus: 'error', lastError: message(error) });
  }
  store.lastRefresh = Date.now();
}
let refreshing: Promise<void> | null = null;
const refreshOnce = () => (refreshing ??= refresh().finally(() => { refreshing = null; }));
/** Stale-while-revalidate: serve what we have, refresh in the background when it is older than the interval. */
const refreshIfStale = () => { if (Date.now() - store.lastRefresh > REFRESH_MS) void refreshOnce(); };

const publicEpisode = ({ channel: _channel, ...episode }: Episode) => episode;

export const app = express();
app.disable('x-powered-by');
app.use(noindexMiddleware());
app.get('/robots.txt', robotsTxtHandler());

// Liveness: always 200 while the process runs, so an upstream outage never makes Cloud Run restart a healthy server.
// `content` says whether what we serve is complete: ok | degraded (a source is failing, old data is served) | empty (nothing loaded yet).
app.get('/api/health', (_req, res) => {
  const failing = [...store.feeds.values()].filter(feed => feed.lastStatus === 'error').map(feed => feed.slug).concat(store.newsStatus.lastStatus === 'error' ? ['news'] : []);
  const content = store.episodes.length === 0 && !store.news ? 'empty' : failing.length ? 'degraded' : 'ok';
  res.json({
    status: 'ok', content, failing, episodes: store.episodes.length, news: store.news?.top.length ?? 0,
    lastRefresh: store.lastRefresh ? new Date(store.lastRefresh).toISOString() : null, lastPodcastSuccess: store.lastPodcastSuccess, lastNewsSuccess: store.newsFetchedAt,
  });
});

app.get('/api/channels', (_req, res) => {
  refreshIfStale();
  res.setHeader('Cache-Control', 'public, max-age=10');
  const base = { genre: 'Talk', city: null, frequency: null, cycleStart: null, currentTitle: null, currentArtist: null, currentAlbum: null, segments: [], episodes: [] };
  res.json({
    channels: [
      ...(Object.keys(CHANNELS) as ChannelSlug[]).map(slug => ({ ...base, id: slug, slug, name: CHANNELS[slug].name, description: CHANNELS[slug].description, type: 'on_demand', streamUrl: null })),
      ...LIVE_CHANNELS.map(live => ({ ...base, id: live.slug, slug: live.slug, name: live.name, description: 'Live AJN audio stream.', type: 'live', streamUrl: live.url })),
    ],
    nextCursor: null, serverTime: new Date().toISOString(),
  });
});

// The page asks for now-playing / events when a live channel is selected. The streams carry no metadata we can read,
// so nothing is invented: title/artist stay null and the page shows the channel name.
app.get('/api/channels/:slug/now-playing', (req, res) => {
  if (!liveChannel(req.params.slug)) return res.status(404).json({ error: 'Channel not found' });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ type: 'live', title: null, artist: null, album: null, metadataUpdatedAt: null, serverTime: new Date().toISOString() });
});
app.get('/api/channels/:slug/events', (req, res) => {
  if (!liveChannel(req.params.slug)) return res.status(404).json({ error: 'Channel not found' });
  res.status(204).end(); // no event stream in the simple server; 204 tells the browser not to reconnect
});

function channelEpisodes(slug: string, show?: string, type?: string) {
  if (!(slug in CHANNELS)) return null;
  return store.episodes.filter(episode => episode.channel === slug && (!show || episode.showSlug === show) && (!type || episode.showType === type));
}

app.get('/api/channels/:slug/episodes', (req, res) => {
  refreshIfStale();
  const show = typeof req.query.show === 'string' ? req.query.show : undefined;
  const type = typeof req.query.type === 'string' ? req.query.type : undefined;
  if ((show && !/^[a-z0-9-]{1,64}$/.test(show)) || (type && !SHOW_TYPES.includes(type))) return res.status(400).json({ error: 'Invalid show or type filter' });
  const orderParam = req.query.order;
  if (orderParam !== undefined && orderParam !== 'newest' && orderParam !== 'oldest') return res.status(400).json({ error: 'order must be newest or oldest' });
  const found = channelEpisodes(req.params.slug, show, type);
  if (!found) return res.status(404).json({ error: 'Podcast channel not found' });
  const list = orderParam === 'oldest' ? [...found].reverse() : found;
  const limitParam = Number(req.query.limit ?? 24);
  const limit = Number.isInteger(limitParam) ? Math.min(100, Math.max(1, limitParam)) : 24;
  const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : null;
  const cursorIndex = cursor ? list.findIndex(episode => episode.id === cursor) : -1;
  if (cursor && cursorIndex < 0) return res.status(400).json({ error: 'Invalid or expired cursor; reload the list' });
  const start = cursor ? cursorIndex + 1 : 0;
  const page = list.slice(start, start + limit);
  res.setHeader('Cache-Control', 'public, max-age=30');
  res.json({ episodes: page.map(publicEpisode), nextCursor: start + limit < list.length && page.length ? page[page.length - 1].id : null });
});

app.get('/api/channels/:slug/episodes/facets', (req, res) => {
  const list = channelEpisodes(req.params.slug);
  if (!list) return res.status(404).json({ error: 'Podcast channel not found' });
  const counts = new Map<string, { show: string | null; type: string | null; count: number }>();
  for (const episode of list) {
    const key = `${episode.showSlug}|${episode.showType}`;
    const entry = counts.get(key) ?? { show: episode.showSlug, type: episode.showType, count: 0 };
    entry.count += 1; counts.set(key, entry);
  }
  res.json({ facets: [...counts.values()] });
});

app.get('/api/news', (_req, res) => {
  refreshIfStale();
  if (!store.news) return res.status(503).json({ error: 'News is not available yet' });
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.json({ ...store.news, fetchedAt: store.newsFetchedAt, stale: store.newsStatus.lastStatus === 'error' });
});

app.get('/api/sources', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ sources: [...store.feeds.values()], news: { url: NEWS_URL, ...store.newsStatus }, video: { url: VIDEO_FEED_URL, ...store.videoStatus } });
});

app.use(express.static(path.resolve('dist')));
app.get('*', (_req, res) => res.sendFile(path.resolve('dist/index.html')));

const port = Number(process.env.PORT ?? 3000);
async function start() {
  // Give the first read a head start so the page is not empty, but never hold the server hostage to a slow host.
  if (process.env.SKIP_INITIAL_REFRESH === 'true') void refreshOnce();
  else await Promise.race([refreshOnce(), new Promise(resolve => setTimeout(resolve, 20_000).unref())]);
  const server = app.listen(port, '0.0.0.0', () => console.info(`AJN Radio ready on http://localhost:${port} (${store.episodes.length} episodes, ${store.news?.top.length ?? 0} top stories)`));
  const timer = setInterval(() => { void refreshOnce(); }, REFRESH_MS);
  timer.unref();
  const stop = (signal: string) => { console.info(`${signal} received; shutting down`); clearInterval(timer); server.close(() => process.exit(0)); server.closeAllConnections?.(); setTimeout(() => process.exit(1), 8000).unref(); };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  start().catch(error => { console.error('Unable to start AJN Radio', error); process.exitCode = 1; });
}
