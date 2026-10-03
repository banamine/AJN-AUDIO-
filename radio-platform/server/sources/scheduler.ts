import type { PrismaClient } from '../../src/generated/prisma/client.ts';
import { syncAllSources, type SyncReport } from './sync.ts';

export type SyncScheduler = { stop: () => void; firstRun: Promise<void> };

/**
 * Imports the feeds now and then every `intervalMinutes`. Runs never overlap and never throw:
 * a failed source is logged and retried on the next tick. `run` is injectable for tests.
 */
export function startSourceSync(options: {
  prisma: PrismaClient;
  intervalMinutes: number;
  run?: (prisma: PrismaClient) => Promise<SyncReport[]>;
  log?: Pick<Console, 'info' | 'error'>;
}): SyncScheduler {
  const run = options.run ?? (prisma => syncAllSources({ prisma }));
  const log = options.log ?? console;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const reports = await run(options.prisma);
      for (const report of reports) log.info(`Feed sync ${report.slug}: ${report.status}`);
    } catch (error) {
      log.error('Feed sync failed; will retry on the next interval', error);
    } finally { running = false; }
  };
  const firstRun = tick();
  const timer = options.intervalMinutes > 0 ? setInterval(() => { void tick(); }, options.intervalMinutes * 60_000) : null;
  timer?.unref();
  return { stop: () => { if (timer) clearInterval(timer); }, firstRun };
}
