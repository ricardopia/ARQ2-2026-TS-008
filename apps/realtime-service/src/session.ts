import { Hub, type HubClient } from './hub.js';

export type AccessResult = 'ok' | 'forbidden' | 'unavailable';
export type SubscribeResult = 'subscribed' | 'forbidden' | 'invalid' | 'unavailable';

export interface SessionDeps {
  hub: Hub;
  checkAccess(boardId: string, userId: string): Promise<AccessResult>;
  onSubscribe?(result: SubscribeResult): void;
  maxSubscriptions?: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Close code for malformed messages (spec 3.5). */
export const CLOSE_MALFORMED = 1008;

/**
 * Handles one client frame (spec 3.5). Returns a close code when the
 * connection must be closed, otherwise undefined.
 */
export async function handleClientMessage(
  client: HubClient,
  raw: string,
  deps: SessionDeps,
): Promise<number | undefined> {
  let msg: { type?: unknown; requestId?: unknown; boardId?: unknown };
  try {
    msg = JSON.parse(raw);
  } catch {
    return CLOSE_MALFORMED;
  }
  if (typeof msg !== 'object' || msg === null || msg.type !== 'subscribe' || typeof msg.requestId !== 'string') {
    return CLOSE_MALFORMED;
  }
  const requestId = msg.requestId;
  const reply = (frame: object) => client.send(JSON.stringify(frame));
  const error = (code: string, message: string) => reply({ type: 'error', requestId, code, message });

  if (typeof msg.boardId !== 'string' || !UUID.test(msg.boardId)) {
    deps.onSubscribe?.('invalid');
    error('VALIDATION_ERROR', 'boardId must be a UUID.');
    return undefined;
  }
  const boardId = msg.boardId.toLowerCase();

  if (deps.hub.subscriptionCount(client) >= (deps.maxSubscriptions ?? 50)) {
    deps.onSubscribe?.('invalid');
    error('VALIDATION_ERROR', 'Too many subscriptions on this connection.');
    return undefined;
  }

  // Access is checked against Core API on every subscribe, so a role change
  // applies on the next subscribe (spec section 7).
  const access = await deps.checkAccess(boardId, client.userId);
  if (access === 'ok') {
    deps.hub.subscribe(client, boardId);
    deps.onSubscribe?.('subscribed');
    reply({ type: 'subscribed', requestId, boardId });
  } else if (access === 'forbidden') {
    deps.onSubscribe?.('forbidden');
    error('FORBIDDEN', 'You do not have access to this board.');
  } else {
    // Fail closed. The contract only defines FORBIDDEN and VALIDATION_ERROR.
    deps.onSubscribe?.('unavailable');
    error('FORBIDDEN', 'Access could not be verified.');
  }
  return undefined;
}
