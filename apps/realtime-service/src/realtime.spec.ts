import { dispatchEvent, SeenEvents } from './events';
import { Hub, type HubClient } from './hub';
import { handleClientMessage, type AccessResult } from './session';

const BOARD = 'b7e4d1c2-8a3f-4b6e-9d05-1c2e3f4a5b6c';
const OTHER_BOARD = 'b0000000-0000-4000-8000-000000000009';

function client(userId: string) {
  const sent: any[] = [];
  const c: HubClient = { id: userId, userId, send: (f) => sent.push(JSON.parse(f)) };
  return { c, sent };
}

const event = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    eventId: 'e0000000-0000-4000-8000-000000000001',
    eventType: 'task.moved',
    occurredAt: new Date().toISOString(),
    boardId: BOARD,
    aggregate: { type: 'task', id: 't1', version: 9 },
    ...over,
  });

describe('session (subscribe)', () => {
  const run = (access: AccessResult, raw: string, hub = new Hub()) => {
    const { c, sent } = client('bob');
    const checkAccess = jest.fn().mockResolvedValue(access);
    return handleClientMessage(c, raw, { hub, checkAccess }).then((close) => ({ close, sent, hub, c, checkAccess }));
  };
  const subscribe = (boardId: unknown = BOARD) => JSON.stringify({ type: 'subscribe', requestId: '1', boardId });

  it('subscribes when the user has a role (FR-5.3)', async () => {
    const r = await run('ok', subscribe());
    expect(r.sent).toEqual([{ type: 'subscribed', requestId: '1', boardId: BOARD }]);
    expect(r.hub.subscriptionCount(r.c)).toBe(1);
    expect(r.checkAccess).toHaveBeenCalledWith(BOARD, 'bob');
  });

  it('answers FORBIDDEN and does not subscribe without a role', async () => {
    const r = await run('forbidden', subscribe());
    expect(r.sent[0]).toMatchObject({ type: 'error', requestId: '1', code: 'FORBIDDEN' });
    expect(r.hub.subscriptionCount(r.c)).toBe(0);
  });

  it('fails closed when Core API is unavailable', async () => {
    const r = await run('unavailable', subscribe());
    expect(r.sent[0]).toMatchObject({ type: 'error', code: 'FORBIDDEN' });
    expect(r.hub.subscriptionCount(r.c)).toBe(0);
  });

  it('answers VALIDATION_ERROR for a bad boardId without calling Core API', async () => {
    const r = await run('ok', subscribe('not-a-uuid'));
    expect(r.sent[0]).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(r.checkAccess).not.toHaveBeenCalled();
  });

  it('closes with 1008 on malformed messages', async () => {
    expect((await run('ok', 'not json')).close).toBe(1008);
    expect((await run('ok', JSON.stringify({ type: 'ping' }))).close).toBe(1008);
  });
});

describe('event dispatch', () => {
  it('pushes only to sockets subscribed to the event board (FR-5.3)', () => {
    const hub = new Hub();
    const bob = client('bob');
    const carol = client('carol');
    const dave = client('dave');
    hub.subscribe(bob.c, BOARD);
    hub.subscribe(carol.c, BOARD);
    hub.subscribe(dave.c, OTHER_BOARD);

    const result = dispatchEvent(event(), hub, new SeenEvents());

    expect(result).toMatchObject({ outcome: 'delivered', recipients: 2 });
    expect(bob.sent[0]).toMatchObject({ type: 'event', boardId: BOARD, event: { eventType: 'task.moved' } });
    expect(carol.sent).toHaveLength(1);
    expect(dave.sent).toHaveLength(0);
  });

  it('ignores a duplicated eventId (FR-5.4)', () => {
    const hub = new Hub();
    const bob = client('bob');
    hub.subscribe(bob.c, BOARD);
    const seen = new SeenEvents();

    expect(dispatchEvent(event(), hub, seen).outcome).toBe('delivered');
    expect(dispatchEvent(event(), hub, seen).outcome).toBe('duplicate');
    expect(bob.sent).toHaveLength(1);
  });

  it('drops invalid and unrelated messages', () => {
    const hub = new Hub();
    const seen = new SeenEvents();
    expect(dispatchEvent('garbage', hub, seen).outcome).toBe('invalid');
    expect(dispatchEvent(event({ eventType: 'attachment.process' }), hub, seen).outcome).toBe('invalid');
  });

  it('stops delivering after a client disconnects', () => {
    const hub = new Hub();
    const bob = client('bob');
    hub.subscribe(bob.c, BOARD);
    expect(hub.remove(bob.c)).toBe(1);
    expect(dispatchEvent(event(), hub, new SeenEvents()).recipients).toBe(0);
  });
});
