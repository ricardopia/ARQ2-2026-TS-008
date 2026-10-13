# ADR 003: Transactional Outbox with RabbitMQ and WebSockets for Real-Time Notifications

**Context and Problem:** Users viewing a board must be notified when it is modified. Notification delivery must not block or fail the main task operation. In addition, no event can be lost when the database transaction succeeds but publishing to the message broker fails (the "dual-write" problem). Notifications must only reach users authorized to access the affected board.

**Considered Alternatives:**
1. Publish directly to the broker after the database commit (no outbox).
2. Client-side polling of the board.
3. Transactional outbox + RabbitMQ + WebSocket delivery.

**Decision:** In the same PostgreSQL transaction that updates the task, the API inserts an event row into an `outbox_events` table. A relay process reads pending rows, publishes them to RabbitMQ, and marks them as sent. The notification module consumes the events and pushes them over WebSockets only to connected users who are authorized for that board (permissions are verified when the connection is opened and when subscribing to a board). Each event carries a unique ID so consumers and clients can process it idempotently.

**Trade-offs:**
- **Positives (What we gain):**
  - Events are never lost, because they are persisted atomically with the data change.
  - Task operations stay fast and independent of broker or notification-service failures.
  - Polling traffic is eliminated.
  - The same events can later be used to invalidate a board-summary cache.
- **Negatives (Risks / What we lose):**
  - Delivery is at-least-once, so duplicate events are possible.
  - There is a small delay introduced by the relay, and extra complexity (outbox table, relay process, cleanup).
  - Mitigation: events include a unique ID and are handled idempotently, outbox rows are purged periodically, and the relay uses retries with exponential backoff.

**Final Justification:** Direct publishing fails exactly in the crash scenario the case is concerned about: the task is saved but the event is lost forever. Polling does not scale with many open boards and delays updates. The transactional outbox gives reliable delivery using technologies already in our stack (PostgreSQL and RabbitMQ), and it satisfies mandatory feature 5 while keeping the main task operation decoupled from notification delivery.
