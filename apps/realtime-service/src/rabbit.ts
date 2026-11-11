import { connect } from 'amqplib';
import type { ChannelModel, ConsumeMessage } from 'amqplib';
import { log } from './log.js';
import { brokerConnected } from './metrics.js';

export const DOMAIN_EVENTS_EXCHANGE = 'taskmaster.domain-events';
const BINDINGS = ['task.*', 'attachment.processed'];

export interface Consumer {
  close(): Promise<void>;
}

/**
 * Consumes domain events into this instance's own exclusive, auto-delete
 * queue `realtime.{instanceId}` so every instance sees every event (spec 4.1).
 * Reconnects with 1 s doubling up to 30 s. Events published while the service
 * was down are not replayed: clients reload the summary on reconnect (spec 3.5).
 */
export function startConsumer(
  url: string,
  instanceId: string,
  handler: (msg: ConsumeMessage) => void,
): Consumer {
  let stopped = false;
  let connection: ChannelModel | null = null;
  let delay = 1000;

  async function run(): Promise<void> {
    while (!stopped) {
      try {
        const conn = await connect(url);
        connection = conn;
        conn.on('error', (err: Error) => log({ level: 'error', msg: 'broker error', error: err.message }));
        const closed = new Promise<void>((resolve) => conn.on('close', () => resolve()));

        const channel = await conn.createChannel();
        await channel.assertExchange(DOMAIN_EVENTS_EXCHANGE, 'topic', { durable: true });
        const queue = `realtime.${instanceId}`;
        await channel.assertQueue(queue, { exclusive: true, autoDelete: true });
        for (const key of BINDINGS) await channel.bindQueue(queue, DOMAIN_EVENTS_EXCHANGE, key);
        // Auto-ack: pushing to sockets is best-effort, a redelivery would only duplicate.
        await channel.consume(queue, (msg) => msg && handler(msg), { noAck: true });

        brokerConnected.set(1);
        delay = 1000;
        log({ msg: 'broker consumer ready', queue });

        await closed;
        brokerConnected.set(0);
        if (!stopped) log({ level: 'error', msg: 'broker connection lost' });
      } catch (err) {
        brokerConnected.set(0);
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
