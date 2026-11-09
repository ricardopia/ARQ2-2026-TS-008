import { Injectable, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { ProblemException } from '../common/problem';

export type RealtimeTicket = {
  ticket: string;
  expiresAt: string;
  url: string;
};

/** Ticket lifetime and storage key prefix (spec section 3.5). */
const TICKET_TTL_SECONDS = 30;
const TICKET_KEY_PREFIX = 'ws-ticket:';
const WS_URL = 'ws://localhost:8080/ws';

/**
 * One-time WebSocket tickets (FR-5.1/FR-5.2): the Core API stores the user the
 * ticket identifies in Redis for a short TTL; the Realtime Service consumes it
 * with GETDEL when a socket opens.
 */
@Injectable()
export class RealtimeService {
  private readonly redis: Redis;

  constructor(private readonly config: ConfigService) {
    this.redis = new Redis(
      this.config.get<string>('REDIS_URL') ?? 'redis://localhost:6379',
    );
  }

  async issue(userId: string) {
    const ticket = `wst_${randomUUID()}`;
    try {
      // SET ... EX makes the ticket valid for 30 s; the Realtime Service
      // consumes it once (GETDEL) when the socket opens.
      await this.redis.set(
        `${TICKET_KEY_PREFIX}${ticket}`,
        JSON.stringify({ userId }),
        'EX',
        TICKET_TTL_SECONDS,
      );
    } catch {
      throw new ProblemException(
        HttpStatus.SERVICE_UNAVAILABLE,
        'SERVICE_UNAVAILABLE',
        'Service unavailable',
        'The ticket store is not available.',
      );
    }

    return {
      ticket,
      expiresAt: new Date(Date.now() + TICKET_TTL_SECONDS * 1000).toISOString(),
      url: WS_URL,
    };
  }
}
