import assert from 'node:assert/strict';
import test from 'node:test';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.ts';
import { startEmbeddedDatabase } from '../server/embeddedDb.ts';
import { startSourceSync } from '../server/sources/scheduler.ts';

test('embedded database applies every migration and serves Prisma with no external Postgres', async () => {
  const db = await startEmbeddedDatabase();
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: db.connectionString }) });
  try {
    assert.equal(await prisma.channel.count(), 0);
    await prisma.channel.create({ data: { slug: 'standalone-check', name: 'Standalone Check', type: 'ON_DEMAND' } });
    await prisma.podcastEpisode.create({ data: { channel: { connect: { slug: 'standalone-check' } }, title: 'E1', audioUrl: 'https://audio.test/e1.mp3', source: 'test', guid: 'g1', showSlug: 'alex-jones' } });
    assert.equal(await prisma.podcastEpisode.count({ where: { source: 'test' } }), 1);
    assert.equal(await prisma.contentSource.count(), 0); // table from the content_sources migration exists
  } finally { await prisma.$disconnect(); await db.stop(); }
});

test('source scheduler runs now, never overlaps, and survives a failing run', async () => {
  const logs: string[] = [];
  let calls = 0; let release: () => void = () => undefined;
  const run = async () => { calls++; if (calls === 1) await new Promise<void>(resolve => { release = resolve; }); if (calls === 2) throw new Error('feed down'); return []; };
  const log = { info: (message: string) => logs.push(message), error: (message: string) => logs.push(String(message)) };
  const scheduler = startSourceSync({ prisma: {} as never, intervalMinutes: 0, run, log });
  assert.equal(calls, 1);
  release(); await scheduler.firstRun;
  const second = startSourceSync({ prisma: {} as never, intervalMinutes: 0, run, log });
  await second.firstRun; // run 2 throws; must not reject
  assert.ok(logs.some(line => line.includes('will retry')));
  scheduler.stop(); second.stop();
});
