import { shutdownTracing } from './tracing.js';

import { cycleDuration, cycleFailuresTotal, pendingRows, publishedTotal, startMetricsServer } from './metrics.js';
import { createDb } from './db.js';
import { log } from './log.js';
import { createPublisher } from './rabbit.js';
import { runOnce } from './relay.js';

function readConfig() {
  const databaseUrl = process.env.DATABASE_URL;
  const rabbitUrl = process.env.RABBITMQ_URL;
  if (!databaseUrl || !rabbitUrl) {
    log({ level: 'fatal', msg: 'DATABASE_URL and RABBITMQ_URL are required' });
    process.exit(1);
  }
  return {
    databaseUrl,
    rabbitUrl,
    port: Number(process.env.PORT ?? 8081),
    pollMs: Number(process.env.POLL_INTERVAL_MS ?? 500),
    batchSize: Number(process.env.BATCH_SIZE ?? 50),
  };
}

const config = readConfig();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  startMetricsServer(config.port);
  const db = createDb(config.databaseUrl);
  const publisher = await createPublisher(config.rabbitUrl);
  const deps = {
    fetchPending: db.fetchPending,
    publish: publisher.publish,
    markPublished: db.markPublished,
    markAttempt: db.markAttempt,
  };

  let backoffMs = 1000;
  let lastPurgeAt = 0;

  for (;;) {
    const startedAt = Date.now();
    let sleepMs = config.pollMs;
    try {
      pendingRows.set(await db.countPending());
      const published = await runOnce(deps, config.batchSize);
      publishedTotal.inc(published);
      if (published > 0) log({ msg: 'published events', count: published });

      if (Date.now() - lastPurgeAt >= 60 * 60 * 1000) {
        lastPurgeAt = Date.now();
        const purged = await db.purgePublished();
        if (purged > 0) log({ msg: 'purged published rows', count: purged });
      }

      backoffMs = 1000;
    } catch (err) {
      cycleFailuresTotal.inc();
      log({
        level: 'error',
        msg: 'relay cycle failed',
        error: err instanceof Error ? err.message : String(err),
        backoffMs,
      });
      sleepMs = backoffMs;
      backoffMs = Math.min(backoffMs * 2, 30_000); // spec 4.2: 1 s doubling up to 30 s
    } finally {
      cycleDuration.observe((Date.now() - startedAt) / 1000);
    }
    await sleep(sleepMs);
  }
}

void main();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdownTracing().finally(() => process.exit(0));
  });
}
