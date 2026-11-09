import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { shutdownTracing } from './tracing.js';
import { jobsFailed, jobsProcessed, jobsReceived, startMetricsServer } from './metrics.js';
import { createDb, type Db } from './db.js';
import { createConsumer } from './rabbit.js';
import { runJob, type AttachmentJobEnvelope, type ProcessJobDeps } from './processor.js';
import { log } from './log.js';

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
  completeAttachment: (id) => db.completeAttachment(id),
  failAttachment: (id, failureReason) => db.failAttachment(id, failureReason),
  insertOutboxEvent: (eventId, exchange, routingKey, payload) =>
    db.insertOutboxEvent(eventId, exchange, routingKey, payload),
  fetchObject: async (storageKey) => {
    const object = await s3.send(new GetObjectCommand({ Bucket: config.bucket, Key: storageKey }));
    // The body is streamed, never buffered whole in memory (ADR 002).
    const contentType = object.ContentType ?? 'application/octet-stream';
    const sizeBytes = object.ContentLength ?? 0;
    return { contentType, sizeBytes };
  },
};

async function main(): Promise<void> {
  startMetricsServer(config.port);
  const consumer = await createConsumer(config.rabbitUrl, async (msg: unknown) => {
    jobsReceived.inc();
    const envelope = msg as AttachmentJobEnvelope;
    const result = await runJob(deps, envelope);
    if (result === 'COMPLETED' || result === 'FAILED') {
      jobsProcessed.inc();
    }
    if (result === 'FAILED') {
      jobsFailed.inc();
    }
    log({ msg: 'file worker job done', eventId: envelope.eventId, result });
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void shutdownTracing().finally(() => consumer.close()).finally(() => process.exit(0));
    });
  }
}

void main();
