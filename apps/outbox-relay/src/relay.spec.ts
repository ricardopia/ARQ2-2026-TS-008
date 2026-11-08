import type { OutboxRow, RelayDeps } from './relay.js';
import { runOnce } from './relay.js';

function row(seq: string): OutboxRow {
  return {
    seq,
    eventId: `event-${seq}`,
    exchange: 'taskmaster.domain-events',
    routingKey: 'task.updated',
    payload: { correlationId: 'c-1' },
  };
}

describe('runOnce', () => {
  it('marks each row published only after its publish confirm', async () => {
    const order: string[] = [];
    const deps: RelayDeps = {
      fetchPending: async () => [row('1'), row('2')],
      publish: async (r) => {
        order.push(`publish:${r.seq}`);
      },
      markPublished: async (seq) => {
        order.push(`marked:${seq}`);
      },
      markAttempt: async (seq) => {
        order.push(`attempt:${seq}`);
      },
    };

    await expect(runOnce(deps, 10)).resolves.toBe(2);
    expect(order).toEqual(['publish:1', 'marked:1', 'publish:2', 'marked:2']);
  });

  it('records the attempt, keeps the failed row pending and stops the batch', async () => {
    const calls: string[] = [];
    const deps: RelayDeps = {
      fetchPending: async () => [row('1'), row('2'), row('3')],
      publish: async (r) => {
        calls.push(`publish:${r.seq}`);
        if (r.seq === '2') throw new Error('broker down');
      },
      markPublished: async (seq) => {
        calls.push(`marked:${seq}`);
      },
      markAttempt: async (seq) => {
        calls.push(`attempt:${seq}`);
      },
    };

    await expect(runOnce(deps, 10)).rejects.toThrow('broker down');
    expect(calls).toEqual(['publish:1', 'marked:1', 'publish:2', 'attempt:2']);
  });
});
