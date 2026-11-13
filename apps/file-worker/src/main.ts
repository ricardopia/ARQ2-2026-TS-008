import { Writable, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { S3Client, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { shutdownTracing } from './tracing.js';
import { jobsDlq, jobsFailed, jobsProcessed, jobsReceived, startMetricsServer } from './metrics.js';
import { createDb, type Db } from './db.js';
import { createConsumer } from './rabbit.js';
import { runCleanup, runJobWithRetry, type AttachmentJobEnvelope, type ProcessJobDeps } from './processor.js';
import { log } from './log.js';

// spec FR-4.4: stale attachments are cleaned up every 10 minutes
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

function readConfig() {
  const databaseUrl = process.env.DATABASE_URL;
  const rabbitUrl = process.env.RABBITMQ_URL;
  const rustfsEndpoint = process.env.RUSTFS_ENDPOINT ?? 'http://rustfs:9000';
  if (!databaseUrl || !rabbitUrl) {
    log({ level: 'fatal', msg: 'DATABASE_URL and RABBITMQ_URL are required' });
    process.exit(1);
  }
  return {
    databaseUrl,
    rabbitUrl,
    port: Number(process.env.PORT ?? 8082),
    rustfsEndpoint,
    bucket: process.env.RUSTFS_BUCKET ?? 'taskmaster-attachments',
  };
}

const config = readConfig();

const db: Db = createDb(config.databaseUrl);
const s3 = new S3Client({
  region: 'us-east-1',
  endpoint: config.rustfsEndpoint,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.RUSTFS_ACCESS_KEY ?? '',
    secretAccessKey: process.env.RUSTFS_SECRET_KEY ?? '',
  },
});

const deps: ProcessJobDeps = {
  getAttachment: (id) => db.getAttachment(id),
  claimAttachment: (id) => db.claimAttachment(id),
  finishAttachment: (id, finish, event) => db.finishAttachment(id, finish, event),
  cleanupStale: () => db.cleanupStale(),
  fetchHead: async (storageKey) => {
    const head = await s3.send(new HeadObjectCommand({ Bucket: config.bucket, Key: storageKey }));
    const sizeBytes = head.ContentLength ?? 0;
    if (sizeBytes === 0) {
      return { sizeBytes, header: new Uint8Array(0) };
    }
    const res = await s3.send(
      new GetObjectCommand({ Bucket: config.bucket, Key: storageKey, Range: 'bytes=0-15' }),
    );
    if (!res.Body) throw new Error('object body missing');
    // A compliant store answers bytes=0-15 with at most 16 bytes (FR-4.3).
    const header = (await res.Body.transformToByteArray()).subarray(0, 16);
    return { sizeBytes, header };
  },
  decodePreview: async (storageKey) => {
    const res = await s3.send(new GetObjectCommand({ Bucket: config.bucket, Key: storageKey }));
    if (!res.Body) throw new Error('object body missing');
    // The SDK types Body as a generic Blob; the Node runtime hands us a Readable.
    const body = res.Body as unknown as Readable;
    const chunks: Buffer[] = [];
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk);
        callback();
      },
    });
    // shortcut: animated images keep their first frame only; upgrade to a gif-aware pipeline if needed
    await pipeline(
      body,
      sharp({ failOn: 'error' })
        .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
        .webp(),
      sink,
    );
    return Buffer.concat(chunks);
  },
  putObject: async (storageKey, body, contentType) => {
    await s3.send(
      new PutObjectCommand({ Bucket: config.bucket, Key: storageKey, Body: body, ContentType: contentType }),
    );
  },
  deleteObject: async (storageKey) => {
    await s3.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: storageKey }));
  },
};

async function main(): Promise<void> {
  startMetricsServer(config.port);
  const consumer = await createConsumer(config.rabbitUrl, async (msg: unknown) => {
    jobsReceived.inc();
    const envelope = msg as AttachmentJobEnvelope;
    const result = await runJobWithRetry(deps, envelope);
    if (result === 'COMPLETED' || result === 'FAILED') jobsProcessed.inc();
    if (result === 'FAILED' || result === 'DLQ') jobsFailed.inc();
    if (result === 'DLQ') jobsDlq.inc();
    log({ msg: 'file worker job done', eventId: envelope.eventId, result });
    return result === 'DLQ';
  });

  const cleanupTimer = setInterval(() => {
    runCleanup(deps)
      .then((cleaned) => {
        if (cleaned > 0) log({ msg: 'stale attachments cleaned', cleaned });
      })
      .catch((err) =>
        log({
          level: 'error',
          msg: 'attachment cleanup failed',
          error: err instanceof Error ? err.message : String(err),
        }),
      );
  }, CLEANUP_INTERVAL_MS);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      clearInterval(cleanupTimer);
      void shutdownTracing().finally(() => consumer.close()).finally(() => process.exit(0));
    });
  }
}

void main();
