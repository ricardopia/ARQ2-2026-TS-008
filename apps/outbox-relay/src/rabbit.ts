import { connect } from 'amqplib';
import type { ConfirmChannel, RecoveringChannelModel } from 'amqplib';
import { log } from './log.js';
import type { OutboxRow } from './relay.js';

const EXCHANGES: ReadonlyArray<readonly [string, 'topic' | 'direct']> = [
  ['taskmaster.domain-events', 'topic'],
  ['taskmaster.file-jobs', 'direct'],
  ['taskmaster.dlx', 'direct'],
];

export interface Publisher {
  publish(row: OutboxRow): Promise<void>;
  close(): Promise<void>;
}

export async function createPublisher(url: string): Promise<Publisher> {
  // Built-in recovery reconnects with 1 s doubling up to 30 s (spec 4.2).
  const model: RecoveringChannelModel = await connect(url, {
    recovery: { initialDelay: 1000, maxDelay: 30000, factor: 2 },
  });
  // EventEmitter throws on an unhandled 'error'; these also log the broker's
  // state while the loop waits inside createConfirmChannel during an outage.
  model.on('error', (err) => log({ level: 'error', msg: 'broker error', error: err.message }));
  model.on('disconnect', (err) => log({ level: 'error', msg: 'broker connection lost', error: err.message }));
  model.on('reconnect-scheduled', (info) =>
    log({ msg: 'broker reconnect scheduled', attempt: info.attempt, delayMs: info.delay }),
  );
  let channel: ConfirmChannel | null = null;

  async function getChannel(): Promise<ConfirmChannel> {
    if (channel) return channel;
    const ch = await model.createConfirmChannel();
    for (const [name, type] of EXCHANGES) {
      await ch.assertExchange(name, type, { durable: true });
    }
    channel = ch;
    return ch;
  }

  return {
    async publish(row) {
      const ch = await getChannel();
      try {
        const correlationId = row.payload.correlationId;
        ch.publish(row.exchange, row.routingKey, Buffer.from(JSON.stringify(row.payload)), {
          persistent: true,
          messageId: row.eventId,
          contentType: 'application/json',
          ...(typeof correlationId === 'string'
            ? { headers: { 'x-correlation-id': correlationId } }
            : {}),
        });
        // Marking the row happens only after this confirm (spec 4.2).
        await ch.waitForConfirms();
      } catch (err) {
        channel = null; // the channel died with its connection; the next attempt opens a new one
        throw err;
      }
    },

    close() {
      return model.close();
    },
  };
}
