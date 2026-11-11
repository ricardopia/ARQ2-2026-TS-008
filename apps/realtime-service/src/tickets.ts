import type { Redis } from 'ioredis';

/** Consumes a one-time ticket with GETDEL (spec 2.5). Returns the userId, or null. */
export function createTicketStore(redis: Redis) {
  return async function consumeTicket(ticket: string): Promise<string | null> {
    if (!/^wst_[0-9a-f-]{36}$/i.test(ticket)) return null;
    const value = await redis.getdel(`ws-ticket:${ticket}`);
    if (!value) return null;
    try {
      const { userId } = JSON.parse(value) as { userId?: unknown };
      return typeof userId === 'string' ? userId : null;
    } catch {
      return null;
    }
  };
}
