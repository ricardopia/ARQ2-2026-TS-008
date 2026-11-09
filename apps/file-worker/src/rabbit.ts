import { connect } from 'amqplib';
import type { ConsumeMessage } from 'amqplib';
import { log } from './log.js';

export const FILE_JOBS_EXCHANGE = 'taskmaster.file-jobs';
export const ATTACHMENT_PROCESS_ROUTING_KEY = 'attachment.process';
export const FILE_WORKER_QUEUE = 'file-worker.attachment-process';

export interface Consumer {
  close(): Promise<void>;
}

/**
 * Consumes file-processing jobs from `taskmaster.file-jobs` (direct) bound to
 * the `attachment.process` routing key (spec 4.2, 4.4). Ack happens after the
 * handler: the guarded status transition makes redeliveries idempotent.
 */
export async function createConsumer(
  rabbitUrl: string,
  handler: (msg: unknown) => Promise<void>,
): Promise<Consumer> {
  const connection = await connect(rabbitUrl);
  const channel = await connection.createChannel();
  await channel.assertExchange(FILE_JOBS_EXCHANGE, 'direct', { durable: true });
  await channel.assertQueue(FILE_WORKER_QUEUE, { durable: true });
  await channel.bindQueue(FILE_WORKER_QUEUE, FILE_JOBS_EXCHANGE, ATTACHMENT_PROCESS_ROUTING_KEY);

  channel.consume(
    FILE_WORKER_QUEUE,
    async (msg: ConsumeMessage | null) => {
      if (!msg) return;
      try {
        const payload = JSON.parse(msg.content.toString()) as Record<string, unknown>;
        await handler(payload);
      } catch (err) {
        log({
          level: 'error',
          msg: 'file worker job failed',
          error: err instanceof Error ? err.message : String(err),
          eventId: msg.properties.messageId,
        });
      } finally {
        channel.ack(msg);
      }
    },
    { noAck: false },
  );

  return {
    close: async () => {
      await channel.close();
      await connection.close();
    },
  };
}
