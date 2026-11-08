import { Pool } from 'pg';
import type { OutboxRow } from './relay.js';

export interface Db {
  fetchPending(limit: number): Promise<OutboxRow[]>;
  markPublished(seq: string): Promise<void>;
  markAttempt(seq: string): Promise<void>;
  countPending(): Promise<number>;
  purgePublished(): Promise<number>;
  close(): Promise<void>;
}

export function createDb(connectionString: string): Db {
  const pool = new Pool({ connectionString, max: 2 });

  return {
    async fetchPending(limit) {
      const { rows } = await pool.query(
        `SELECT seq, event_id, exchange, routing_key, payload
           FROM outbox_events
          WHERE published_at IS NULL
          ORDER BY seq
          LIMIT $1`,
        [limit],
      );
      return rows.map((row) => ({
        seq: String(row.seq),
        eventId: row.event_id,
        exchange: row.exchange,
        routingKey: row.routing_key,
        payload: row.payload,
      }));
    },

    async markPublished(seq) {
      await pool.query(
        `UPDATE outbox_events SET published_at = now()
          WHERE seq = $1 AND published_at IS NULL`,
        [seq],
      );
    },

    async markAttempt(seq) {
      await pool.query(`UPDATE outbox_events SET attempts = attempts + 1 WHERE seq = $1`, [seq]);
    },

    async countPending() {
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM outbox_events WHERE published_at IS NULL`,
      );
      return rows[0].n as number;
    },

    async purgePublished() {
      const { rowCount } = await pool.query(
        `DELETE FROM outbox_events
          WHERE published_at < now() - interval '7 days'`,
      );
      return rowCount ?? 0;
    },

    close() {
      return pool.end();
    },
  };
}
