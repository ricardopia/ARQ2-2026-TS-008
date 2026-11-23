import { connect } from 'amqplib';
import type { ChannelModel, ConsumeMessage } from 'amqplib';
import { log } from './log.js';

export const FILE_JOBS_EXCHANGE = 'taskmaster.file-jobs';
export const ATTACHMENT_PROCESS_ROUTING_KEY = 'attachment.process';
export const FILE_WORKER_QUEUE = 'file-worker.attachment-process';
export const DLQ_EXCHANGE = 'taskmaster.dlx';
export const FILE_WORKER_DLQ = 'file-worker.attachment-process.dlq';

export interface Consumer {
  close(): Promise<void>;
}

/**
 * Consumes file-processing jobs from `taskmaster.file-jobs` (direct) bound to
 * the `attachment.process` routing key (spec 4.1, 4.4). Ack happens after the
 * handler: the guarded status transition makes redeliveries idempotent. A
 * handler returning true means retries were exhausted: the original message is
 * republished to `taskmaster.dlx` before the ack, because the work queue has no
 * dead-letter arguments to do it for us (spec 4.1).
 *
 * Reconnects with 1 s doubling up to 30 s when the broker restarts (NFR-4): the
 * queue is durable, so jobs published meanwhile wait and are consumed once the
 * connection is back. A job interrupted by the outage is redelivered by the
 * broker (its ack never arrived) and the guarded transition keeps it idempotent.
 */
export function createConsumer(
  rabbitUrl: string,
  handler: (msg: unknown) => Promise<boolean>,
): Consumer {
  let stopped = false;
  let connection: ChannelModel | null = null;
  let delay = 1000;

  async function run(): Promise<void> {
    while (!stopped) {
      try {
        const conn = await connect(rabbitUrl);
        connection = conn;
        conn.on('error', (err: Error) => log({ level: 'error', msg: 'broker error', error: err.message }));
        const closed = new Promise<void>((resolve) => conn.on('close', () => resolve()));

        const channel = await conn.createConfirmChannel();
        channel.on('error', (err: Error) => log({ level: 'error', msg: 'broker channel error', error: err.message }));
        await channel.assertExchange(FILE_JOBS_EXCHANGE, 'direct', { durable: true });
        await channel.assertExchange(DLQ_EXCHANGE, 'direct', { durable: true });
        await channel.assertQueue(FILE_WORKER_QUEUE, { durable: true });
        await channel.bindQueue(FILE_WORKER_QUEUE, FILE_JOBS_EXCHANGE, ATTACHMENT_PROCESS_ROUTING_KEY);
        await channel.assertQueue(FILE_WORKER_DLQ, { durable: true });
        await channel.bindQueue(FILE_WORKER_DLQ, DLQ_EXCHANGE, ATTACHMENT_PROCESS_ROUTING_KEY);

        await channel.consume(
          FILE_WORKER_QUEUE,
          async (msg: ConsumeMessage | null) => {
            if (!msg) return;
            let toDlq = false;
            try {
              const payload = JSON.parse(msg.content.toString()) as Record<string, unknown>;
              toDlq = await handler(payload);
            } catch (err) {
              log({
                level: 'error',
                msg: 'file worker job failed',
                error: err instanceof Error ? err.message : String(err),
                eventId: msg.properties.messageId,
              });
            } finally {
              if (toDlq) {
                try {
                  channel.publish(DLQ_EXCHANGE, ATTACHMENT_PROCESS_ROUTING_KEY, msg.content, {
                    persistent: true,
                    messageId: msg.properties.messageId,
                    contentType: msg.properties.contentType,
                    headers: msg.properties.headers,
                  });
                  await channel.waitForConfirms();
                } catch (err) {
                  // The attachment is already FAILED in the database; acking keeps the
                  // queue from looping, and this log carries the lost message id.
                  log({
                    level: 'error',
                    msg: 'could not publish job to dlq',
                    eventId: msg.properties.messageId,
                    error: err instanceof Error ? err.message : String(err),
                  });
                }
              }
              try {
                channel.ack(msg);
              } catch (err) {
                // The channel died during the job: the broker redelivers it on the next connection.
                log({
                  level: 'error',
                  msg: 'could not ack job (connection lost); it will be redelivered',
                  eventId: msg.properties.messageId,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }
          },
          { noAck: false },
        );

        delay = 1000;
        log({ msg: 'broker consumer ready', queue: FILE_WORKER_QUEUE });

        await closed;
        if (!stopped) log({ level: 'error', msg: 'broker connection lost' });
      } catch (err) {
        log({
          level: 'error',
          msg: 'broker connect failed',
          error: err instanceof Error ? err.message : String(err),
          retryInMs: delay,
        });
      }
      if (stopped) return;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 30_000);
    }
  }

  void run();
  return {
    async close() {
      stopped = true;
      await connection?.close().catch(() => undefined);
    },
  };
}
