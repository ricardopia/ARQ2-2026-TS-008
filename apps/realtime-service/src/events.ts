import { Hub } from './hub.js';

/** Event types this service forwards (spec 4.1 bindings: task.* and attachment.processed). */
const FORWARDED = /^(task\.[a-z_]+|attachment\.processed)$/;

export interface DomainEvent {
  eventId: string;
  eventType: string;
  occurredAt: string;
  correlationId?: string;
  boardId: string;
  [key: string]: unknown;
}

export function parseEvent(raw: Buffer | string): DomainEvent | null {
  try {
    const e = JSON.parse(raw.toString()) as Record<string, unknown>;
    if (
      typeof e.eventId === 'string' &&
      typeof e.eventType === 'string' &&
      FORWARDED.test(e.eventType) &&
      typeof e.boardId === 'string' &&
      typeof e.occurredAt === 'string'
    ) {
      return e as DomainEvent;
    }
  } catch {
    // fall through
  }
  return null;
}

/** Bounded set of recently seen eventIds (consumer-side idempotency, spec 4.3). */
export class SeenEvents {
  private readonly ids = new Set<string>();
  constructor(private readonly capacity = 10_000) {}

  /** Returns true if the id was already seen; records it otherwise. */
  check(id: string): boolean {
    if (this.ids.has(id)) return true;
    this.ids.add(id);
    if (this.ids.size > this.capacity) {
      this.ids.delete(this.ids.values().next().value as string);
    }
    return false;
  }
}

export type EventOutcome = 'delivered' | 'duplicate' | 'invalid';

export interface EventResult {
  outcome: EventOutcome;
  event?: DomainEvent;
  recipients: number;
}

/** Forwards a broker message to the sockets subscribed to its board. */
export function dispatchEvent(raw: Buffer | string, hub: Hub, seen: SeenEvents): EventResult {
  const event = parseEvent(raw);
  if (!event) return { outcome: 'invalid', recipients: 0 };
  if (seen.check(event.eventId)) return { outcome: 'duplicate', event, recipients: 0 };
  const frame = JSON.stringify({ type: 'event', boardId: event.boardId, event });
  return { outcome: 'delivered', event, recipients: hub.broadcast(event.boardId, frame) };
}
