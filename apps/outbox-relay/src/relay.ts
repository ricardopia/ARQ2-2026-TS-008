export interface OutboxRow {
  seq: string;
  eventId: string;
  exchange: string;
  routingKey: string;
  payload: Record<string, unknown>;
}

export interface RelayDeps {
  fetchPending(limit: number): Promise<OutboxRow[]>;
  publish(row: OutboxRow): Promise<void>;
  markPublished(seq: string): Promise<void>;
  markAttempt(seq: string): Promise<void>;
}

/**
 * One poll cycle: publish pending rows in seq order, marking each row only
 * after its confirm (spec 4.2). On failure the attempt is recorded and the
 * error is rethrown so the caller backs off; the remaining rows stay pending
 * because a publish failure almost always means the connection is gone.
 * Returns how many rows were published.
 */
export async function runOnce(deps: RelayDeps, limit: number): Promise<number> {
  const rows = await deps.fetchPending(limit);
  let published = 0;
  for (const row of rows) {
    try {
      await deps.publish(row);
    } catch (err) {
      await deps.markAttempt(row.seq);
      throw err;
    }
    await deps.markPublished(row.seq);
    published += 1;
  }
  return published;
}
