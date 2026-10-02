import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { Client } from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.ts';
import { resolveTimelinePosition } from '../shared/timeline.ts';
import { seedDemoData } from '../prisma/seed.ts';
import test from 'node:test';

const migrationPath = new URL('../prisma/migrations/20261001000000_radio_channels/migration.sql', import.meta.url);

test('PostgreSQL migration and Prisma relations support catalog, timeline, and episodes', async () => {
  const db = await PGlite.create();
  const portProbe = createServer();
  portProbe.listen(0, '127.0.0.1');
  await once(portProbe, 'listening');
  const portAddress = portProbe.address();
  assert.ok(portAddress && typeof portAddress !== 'string');
  const port = portAddress.port;
  await new Promise<void>((resolve, reject) => portProbe.close(error => error ? reject(error) : resolve()));
  const socketServer = new PGLiteSocketServer({ db, host: '127.0.0.1', port, maxConnections: 8 });
  const connectionString = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres?sslmode=disable`;
  const wireClient = new Client({ connectionString });
  wireClient.on('error', () => undefined);
  let prisma: PrismaClient | undefined;
  try {
    await socketServer.start();
    await wireClient.connect();
    await wireClient.query(await readFile(migrationPath, 'utf8'));
    process.env.DATABASE_URL = connectionString;
    process.env.RADIO_INGEST_TOKEN = 'integration-token';
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

    const simulated = await prisma.channel.create({
      data: {
        slug: 'integration-clock', name: 'Integration Clock', type: 'SIMULATED',
        cycleStart: new Date('2026-01-01T00:00:00Z'),
        segments: { create: [
          { position: 0, title: 'First', audioUrl: 'https://audio.test/first.mp3', durationSeconds: 10 },
          { position: 1, title: 'Second', audioUrl: 'https://audio.test/second.mp3', durationSeconds: 20 },
        ] },
      },
      include: { segments: { orderBy: { position: 'asc' } } },
    });
    assert.deepEqual(simulated.segments.map(segment => segment.position), [0, 1]);
    const point = resolveTimelinePosition(simulated.segments, simulated.cycleStart!, Date.parse('2026-01-01T00:00:17.500Z'));
    assert.equal(point?.segment.title, 'Second');
    assert.equal(point?.offsetSeconds, 7.5);

    const podcast = await prisma.channel.create({
      data: {
        slug: 'integration-podcast', name: 'Integration Podcast', type: 'ON_DEMAND',
        episodes: { create: [{ title: 'Episode 1', audioUrl: 'https://audio.test/ep1.mp3', publishedAt: new Date('2026-01-01T00:00:00Z') }] },
      },
      include: { episodes: true },
    });
    assert.equal(podcast.episodes.length, 1);
    assert.equal(podcast.episodes[0].channelId, podcast.id);

    await seedDemoData(prisma);
    await seedDemoData(prisma);
    const demoAfterHours = await prisma.channel.findUnique({ where: { slug: 'after-hours' }, include: { segments: true } });
    const demoPodcasts = await prisma.channel.findUnique({ where: { slug: 'ajn-podcasts' }, include: { episodes: true } });
    assert.equal(demoAfterHours?.segments.length, 4);
    assert.equal(demoPodcasts?.episodes.length, 2);
    assert.equal(await prisma.channel.count({ where: { type: 'LIVE', streamUrl: { not: null } } }), 3);
    await prisma.channel.create({
      data: {
        slug: 'integration-schedule', name: 'Integration Schedule', type: 'SIMULATED', cycleStart: new Date(Date.now() - 100),
        segments: { create: [
          { position: 0, title: 'Timer First', audioUrl: 'https://audio.test/timer-first.mp3', durationSeconds: 2 },
          { position: 1, title: 'Timer Second', audioUrl: 'https://audio.test/timer-second.mp3', durationSeconds: 2 },
        ] },
      },
    });

    const { app, startMetadataNotifications, stopMetadataNotifications } = await import('../server/index.ts');
    await startMetadataNotifications();
      const { getMetadataNotificationStatus } = await import('../server/index.ts');
      assert.equal(getMetadataNotificationStatus(), 'listening');
    const httpServer = app.listen(0, '127.0.0.1');
    await once(httpServer, 'listening');
    const address = httpServer.address();
    assert.ok(address && typeof address !== 'string');
    const api = `http://127.0.0.1:${address.port}`;
    try {
      const health = await fetch(`${api}/api/health`);
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), { status: 'ok', database: 'connected', notifications: 'listening' });

      const catalogResponse = await fetch(`${api}/api/channels?limit=2`);
      assert.equal(catalogResponse.status, 200);
      const catalog = await catalogResponse.json() as { channels: Array<{ slug: string }>; nextCursor: string | null };
      assert.equal(catalog.channels.length, 2);
      assert.ok(catalog.nextCursor);
      const nextCatalog = await fetch(`${api}/api/channels?limit=2&cursor=${encodeURIComponent(catalog.nextCursor)}`);
      assert.equal(nextCatalog.status, 200);
      assert.equal((await nextCatalog.json() as { channels: unknown[] }).channels.length, 2);

      const contentResponse = await fetch(`${api}/api/channels/after-hours/content`);
      assert.equal(contentResponse.status, 200);
      assert.equal((await contentResponse.json() as { segments: unknown[] }).segments.length, 4);

      const timelineResponse = await fetch(`${api}/api/channels/after-hours/now-playing`);
      assert.equal(timelineResponse.status, 200);
      const timeline = await timelineResponse.json() as { segment: { title: string }; offsetSeconds: number };
      assert.ok(timeline.segment.title);
      assert.ok(timeline.offsetSeconds >= 0);

      const episodesResponse = await fetch(`${api}/api/channels/ajn-podcasts/episodes?limit=1`);
      assert.equal(episodesResponse.status, 200);
      const episodes = await episodesResponse.json() as { episodes: Array<{ title: string }>; nextCursor: string | null };
      assert.equal(episodes.episodes.length, 1);
      assert.ok(episodes.nextCursor);

      const eventsAbort = new AbortController();
      const eventsResponse = await fetch(`${api}/api/channels/forma/events`, { signal: eventsAbort.signal });
      assert.equal(eventsResponse.status, 200);
      assert.match(eventsResponse.headers.get('content-type') ?? '', /text\/event-stream/);
      const reader = eventsResponse.body?.getReader();
      assert.ok(reader);
      const firstFrame = await reader.read();
      assert.match(new TextDecoder().decode(firstFrame.value), /event: now-playing/);

      const denied = await fetch(`${api}/api/ingest/channels/forma/now-playing`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Unauthorized' }),
      });
      assert.equal(denied.status, 401);
      const update = await fetch(`${api}/api/ingest/channels/forma/now-playing`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer integration-token' },
        body: JSON.stringify({ title: 'Live API Test', artist: 'Integration Artist', album: 'Test Album' }),
      });
      assert.equal(update.status, 200);
      const liveMetadata = await (await fetch(`${api}/api/channels/forma/now-playing`)).json() as { title: string; artist: string };
      assert.equal(liveMetadata.title, 'Live API Test');
      assert.equal(liveMetadata.artist, 'Integration Artist');
      const pushedFrame = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for live SSE metadata')), 3000)),
      ]);
      assert.match(new TextDecoder().decode(pushedFrame.value), /Live API Test/);

      const uncaughtErrors: unknown[] = [];
      const captureUncaught = (error: unknown) => uncaughtErrors.push(error);
      process.on('uncaughtExceptionMonitor', captureUncaught);
      await socketServer.stop();
      const waitForStatus = async (status: string) => {
        const deadline = Date.now() + 5000;
        while (getMetadataNotificationStatus() !== status && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        assert.equal(getMetadataNotificationStatus(), status);
      };
      try {
        await waitForStatus('reconnecting');
        await socketServer.start();
        await waitForStatus('listening');
        const reconnectUpdate = await fetch(`${api}/api/ingest/channels/forma/now-playing`, {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer integration-token' },
          body: JSON.stringify({ title: 'After reconnect', artist: 'Recovered Artist' }),
        });
        assert.equal(reconnectUpdate.status, 200);
        const reconnectFrame = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => { const timeout = setTimeout(() => reject(new Error('Timed out waiting for SSE after LISTEN reconnect')), 3000); timeout.unref(); }),
        ]);
        assert.match(new TextDecoder().decode(reconnectFrame.value), /After reconnect/);
        assert.deepEqual(uncaughtErrors, []);
      } finally {
        process.off('uncaughtExceptionMonitor', captureUncaught);
      }
      await reader.cancel();
      eventsAbort.abort();

      const scheduleAbort = new AbortController();
      const scheduleResponse = await fetch(`${api}/api/channels/integration-schedule/events`, { signal: scheduleAbort.signal });
      const scheduleReader = scheduleResponse.body?.getReader();
      assert.ok(scheduleReader);
      const scheduleFirst = await scheduleReader.read();
      assert.match(new TextDecoder().decode(scheduleFirst.value), /Timer First/);
      const scheduleNext = await Promise.race([
        scheduleReader.read(),
        new Promise<never>((_, reject) => { const timeout = setTimeout(() => reject(new Error('Timed out waiting for scheduled track transition')), 4000); timeout.unref(); }),
      ]);
      assert.match(new TextDecoder().decode(scheduleNext.value), /Timer Second/);
      await scheduleReader.cancel();
      scheduleAbort.abort();
    } finally {
      await new Promise<void>((resolve, reject) => httpServer.close(error => error ? reject(error) : resolve()));
      await stopMetadataNotifications();
    }

    await assert.rejects(
      prisma.channel.create({ data: { slug: 'invalid-live', name: 'Invalid Live', type: 'LIVE' } }),
    );
  } finally {
    await prisma?.$disconnect();
    await wireClient.end().catch(() => undefined);
    await socketServer.stop().catch(() => undefined);
    await db.close();
    delete process.env.DATABASE_URL;
    delete process.env.RADIO_INGEST_TOKEN;
  }
});
