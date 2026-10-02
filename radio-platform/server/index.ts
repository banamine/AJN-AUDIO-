import 'dotenv/config';
import cors from 'cors';
import express, { type Response } from 'express';
import { Client } from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createServer as createViteServer } from 'vite';
import { prisma } from './db.ts';
import { resolveTimelinePosition } from '../shared/timeline.ts';

export const app = express();
const port = Number(process.env.PORT ?? 3000);
app.use(cors());
app.use(express.json({ limit: '32kb' }));

function toChannelDto(channel: any) {
  return {
    id: channel.id, slug: channel.slug, name: channel.name, description: channel.description,
    genre: channel.genre, city: channel.city, frequency: channel.frequency,
    type: String(channel.type).toLowerCase(), streamUrl: channel.streamUrl,
    cycleStart: channel.cycleStart, currentTitle: channel.currentTitle,
    currentArtist: channel.currentArtist, currentAlbum: channel.currentAlbum,
    segments: (channel.segments ?? []).map((segment: any) => ({
      id: segment.id, position: segment.position, title: segment.title, artist: segment.artist,
      audioUrl: segment.audioUrl, durationSeconds: segment.durationSeconds,
    })),
    episodes: (channel.episodes ?? []).map((episode: any) => ({
      id: episode.id, title: episode.title, description: episode.description,
      audioUrl: episode.audioUrl, durationSeconds: episode.durationSeconds, publishedAt: episode.publishedAt,
    })),
  };
}

app.get('/api/health', async (_req, res) => {
  try { await prisma.$queryRaw`SELECT 1`; res.json({ status: 'ok', database: 'connected' }); }
  catch { res.status(503).json({ status: 'degraded', database: 'unavailable' }); }
});

app.get('/api/channels', async (req, res) => {
  try {
    const parsedLimit = Number(req.query.limit ?? 100);
    const limit = Number.isInteger(parsedLimit) ? Math.min(100, Math.max(1, parsedLimit)) : 100;
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    const channels = await prisma.channel.findMany({
      where: { active: true },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    const hasMore = channels.length > limit;
    const page = hasMore ? channels.slice(0, limit) : channels;
    res.setHeader('Cache-Control', 'public, max-age=10, stale-while-revalidate=30');
    res.json({ channels: page.map(toChannelDto), nextCursor: hasMore ? page[page.length - 1].id : null, serverTime: new Date().toISOString() });
  } catch (error) { res.status(503).json({ error: 'Radio catalog is unavailable', detail: (error as Error).message }); }
});

app.get('/api/channels/:slug/content', async (req, res) => {
  try {
    const channel = await prisma.channel.findFirst({ where: { slug: req.params.slug, active: true }, include: { segments: { orderBy: { position: 'asc' } } } });
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
    res.json({ segments: channel.segments.map(segment => ({ id: segment.id, position: segment.position, title: segment.title, artist: segment.artist, audioUrl: segment.audioUrl, durationSeconds: segment.durationSeconds })) });
  } catch (error) { res.status(503).json({ error: 'Channel content is unavailable', detail: (error as Error).message }); }
});

app.get('/api/channels/:slug/episodes', async (req, res) => {
  try {
    const limitParam = Number(req.query.limit ?? 24);
    const limit = Number.isInteger(limitParam) ? Math.min(100, Math.max(1, limitParam)) : 24;
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    const channel = await prisma.channel.findFirst({ where: { slug: req.params.slug, active: true, type: 'ON_DEMAND' }, select: { id: true } });
    if (!channel) return res.status(404).json({ error: 'Podcast channel not found' });
    const episodes = await prisma.podcastEpisode.findMany({
      where: { channelId: channel.id }, take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: [{ publishedAt: 'desc' }, { id: 'asc' }],
    });
    const hasMore = episodes.length > limit;
    const page = hasMore ? episodes.slice(0, limit) : episodes;
    res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
    res.json({ episodes: page, nextCursor: hasMore ? page[page.length - 1].id : null });
  } catch (error) { res.status(503).json({ error: 'Podcast episodes are unavailable', detail: (error as Error).message }); }
});

async function resolveNowPlaying(slug: string) {
  const channel = await prisma.channel.findUnique({ where: { slug }, include: { segments: { orderBy: { position: 'asc' } } } });
  if (!channel || !channel.active) return null;
  if (channel.type === 'SIMULATED') {
    if (!channel.cycleStart || !channel.segments.length) throw new Error('Simulated channel has no cycle start or timed segments');
    const timeline = resolveTimelinePosition(channel.segments.map(segment => ({
      id: segment.id, position: segment.position, title: segment.title, artist: segment.artist,
      audioUrl: segment.audioUrl, durationSeconds: segment.durationSeconds,
    })), channel.cycleStart);
    if (!timeline) throw new Error('Simulated channel has no valid timed segments');
    return { type: 'simulated', ...timeline, serverTime: new Date().toISOString() };
  }
  return {
    type: String(channel.type).toLowerCase(), title: channel.currentTitle,
    artist: channel.currentArtist, album: channel.currentAlbum,
    metadataUpdatedAt: channel.metadataUpdatedAt, serverTime: new Date().toISOString(),
  };
}

app.get('/api/channels/:slug/now-playing', async (req, res) => {
  try {
    const nowPlaying = await resolveNowPlaying(req.params.slug);
    if (!nowPlaying) return res.status(404).json({ error: 'Channel not found' });
    res.setHeader('Cache-Control', 'no-store');
    res.json(nowPlaying);
  } catch (error) { res.status(409).json({ error: (error as Error).message }); }
});

const subscribers = new Map<string, Set<Response>>();
const timers = new Map<string, ReturnType<typeof setTimeout> | null>();
const frames = new Map<string, { body: string; created: number }>();
const fingerprints = new Map<string, string>();
let metadataListener: Client | null = null;

async function broadcast(slug: string) {
  const channelClients = subscribers.get(slug);
  if (!channelClients?.size) return;
  try {
    const nowPlaying = await resolveNowPlaying(slug);
    if (!nowPlaying) throw new Error('Channel not found');
    const fingerprint = 'segmentIndex' in nowPlaying
      ? JSON.stringify([nowPlaying.segmentIndex, nowPlaying.segment?.id, nowPlaying.segment?.title, nowPlaying.segment?.artist])
      : JSON.stringify([nowPlaying.title, nowPlaying.artist, nowPlaying.album, nowPlaying.metadataUpdatedAt]);
    if (fingerprints.get(slug) === fingerprint) return;
    fingerprints.set(slug, fingerprint);
    const frame = `event: now-playing\ndata: ${JSON.stringify(nowPlaying)}\n\n`;
    frames.set(slug, { body: frame, created: Date.now() });
    channelClients.forEach(client => { if (!client.writableEnded) client.write(frame); });
  } catch (error) {
    const frame = `event: error\ndata: ${JSON.stringify({ error: (error as Error).message })}\n\n`;
    channelClients.forEach(client => { if (!client.writableEnded) client.write(frame); });
  }
}

export async function startMetadataNotifications() {
  if (metadataListener) return;
  const client = new Client({ connectionString: process.env.DATABASE_URL ?? 'postgresql://radio:radio@localhost:5432/ajn_radio?schema=public' });
  try {
    await client.connect();
    await client.query('LISTEN radio_metadata');
    client.on('notification', notification => {
      if (notification.channel === 'radio_metadata' && notification.payload) void broadcast(notification.payload);
    });
    metadataListener = client;
  } catch (error) {
    await client.end().catch(() => undefined);
    console.warn('Cross-instance live metadata notifications are unavailable.', error);
  }
}

export async function stopMetadataNotifications() {
  const client = metadataListener;
  metadataListener = null;
  if (client) await client.end();
}

async function scheduleNextUpdate(slug: string) {
  if (timers.has(slug) || !subscribers.get(slug)?.size) return;
  timers.set(slug, null);
  try {
    const nowPlaying = await resolveNowPlaying(slug);
    if (!subscribers.get(slug)?.size) { timers.delete(slug); return; }
    if (!nowPlaying || !('segment' in nowPlaying)) { timers.delete(slug); return; }
    const remainingSeconds = nowPlaying.segment.durationSeconds - nowPlaying.offsetSeconds;
    const delayMs = Math.max(250, remainingSeconds * 1000);
    const timer = setTimeout(() => {
      timers.delete(slug);
      void broadcast(slug).then(() => scheduleNextUpdate(slug));
    }, delayMs);
    timers.set(slug, timer);
  } catch {
    timers.delete(slug);
  }
}

app.get('/api/channels/:slug/events', async (req, res) => {
  const slug = req.params.slug;
  res.status(200).set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  let channelClients = subscribers.get(slug);
  if (!channelClients) { channelClients = new Set<Response>(); subscribers.set(slug, channelClients); }
  channelClients.add(res);
  const cached = frames.get(slug);
  if (cached && Date.now() - cached.created < 15000) res.write(cached.body);
  else await broadcast(slug);
  void scheduleNextUpdate(slug);
  const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': keepalive\n\n'); }, 25000);
  res.on('close', () => {
    clearInterval(heartbeat);
    const clients = subscribers.get(slug);
    clients?.delete(res);
    if (!clients?.size) {
      subscribers.delete(slug); frames.delete(slug); fingerprints.delete(slug);
      const timer = timers.get(slug);
      if (timer) clearTimeout(timer);
      timers.delete(slug);
    }
  });
});

const liveMetadataSchema = z.object({
  title: z.string().trim().min(1).max(255),
  artist: z.string().trim().max(255).optional(),
  album: z.string().trim().max(255).optional(),
});

app.post('/api/ingest/channels/:slug/now-playing', async (req, res) => {
  const expectedToken = process.env.RADIO_INGEST_TOKEN;
  if (!expectedToken) return res.status(503).json({ error: 'Metadata ingest is not configured' });
  if (req.get('authorization') !== `Bearer ${expectedToken}`) return res.status(401).json({ error: 'Unauthorized' });
  const parsed = liveMetadataSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const existing = await prisma.channel.findUnique({ where: { slug: req.params.slug }, select: { type: true } });
    if (!existing) return res.status(404).json({ error: 'Channel not found' });
    if (existing.type !== 'LIVE') return res.status(409).json({ error: 'Metadata ingest is for live channels only' });
    const channel = await prisma.channel.update({
      where: { slug: req.params.slug },
      data: { currentTitle: parsed.data.title, currentArtist: parsed.data.artist, currentAlbum: parsed.data.album, metadataUpdatedAt: new Date() },
    });
    await prisma.$queryRaw`SELECT pg_notify('radio_metadata', ${channel.slug}) IS NULL AS notified`;
    void broadcast(channel.slug);
    res.json({ updated: true });
  } catch (error) { res.status(503).json({ error: 'Live metadata could not be published', detail: (error as Error).message }); }
});

async function start() {
  if (process.env.NODE_ENV === 'production') {
    app.use(express.static(path.resolve('dist')));
    app.get('*', (_req, res) => res.sendFile(path.resolve('dist/index.html')));
  } else {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  }
  await startMetadataNotifications();
  app.listen(port, '0.0.0.0', () => console.info(`AJN Radio ready on http://localhost:${port}`));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  start().catch(error => { console.error('Unable to start AJN Radio', error); process.exitCode = 1; });
}
