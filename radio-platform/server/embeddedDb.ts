// Standalone mode: runs PostgreSQL (PGlite) inside this process so the app needs no outside database.
// Enabled with EMBEDDED_DB=true. The catalog is rebuilt from the AJN feeds on every start (see scheduler),
// so nothing here has to survive a restart. Set EMBEDDED_DB_DIR to keep the data on disk if you want it to.
// Imported before ./db.ts so DATABASE_URL points at the embedded server when Prisma is created.
import { readdir, readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { Client } from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

export type EmbeddedDatabase = { connectionString: string; stop: () => Promise<void> };

const migrationsDir = new URL('../prisma/migrations/', import.meta.url);

async function freePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('Unable to reserve a local port');
  await new Promise<void>((resolve, reject) => probe.close(error => (error ? reject(error) : resolve())));
  return address.port;
}

export async function startEmbeddedDatabase(options: { dataDir?: string } = {}): Promise<EmbeddedDatabase> {
  const db = options.dataDir ? await PGlite.create(options.dataDir) : await PGlite.create();
  const port = await freePort();
  const socketServer = new PGLiteSocketServer({ db, host: '127.0.0.1', port, maxConnections: 8 });
  const connectionString = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres?sslmode=disable`;
  await socketServer.start();
  const client = new Client({ connectionString });
  client.on('error', () => undefined);
  try {
    await client.connect();
    const applied = new Set<string>();
    await client.query('CREATE TABLE IF NOT EXISTS _embedded_migrations (name text PRIMARY KEY)');
    for (const row of (await client.query('SELECT name FROM _embedded_migrations')).rows) applied.add(row.name as string);
    for (const dir of (await readdir(migrationsDir)).filter(name => /^\d+_/.test(name)).sort()) {
      if (applied.has(dir)) continue;
      await client.query(await readFile(new URL(`${dir}/migration.sql`, migrationsDir), 'utf8'));
      await client.query('INSERT INTO _embedded_migrations (name) VALUES ($1)', [dir]);
    }
  } catch (error) {
    await client.end().catch(() => undefined);
    await socketServer.stop().catch(() => undefined);
    await db.close().catch(() => undefined);
    throw error;
  }
  await client.end().catch(() => undefined);
  return {
    connectionString,
    stop: async () => { await socketServer.stop().catch(() => undefined); await db.close().catch(() => undefined); },
  };
}

export const embeddedMode = process.env.EMBEDDED_DB === 'true';
let embedded: EmbeddedDatabase | null = null;
if (embeddedMode) {
  embedded = await startEmbeddedDatabase({ dataDir: process.env.EMBEDDED_DB_DIR || undefined });
  process.env.DATABASE_URL = embedded.connectionString;
  console.info('Embedded database started (standalone mode, no external Postgres).');
}
export async function stopEmbeddedDatabase() { const db = embedded; embedded = null; await db?.stop(); }
