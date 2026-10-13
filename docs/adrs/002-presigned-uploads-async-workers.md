# ADR 002: Direct-to-Storage Uploads with Pre-signed URLs and Asynchronous Workers

**Context and Problem:** When a user uploads a ~150 MB graphic design file to a card, the Node.js API receives the full stream in memory. This fills the available RAM and degrades the service, disconnecting the rest of the team who only wanted to read tasks. The API must remain responsive for reads and task edits while large uploads happen.

**Considered Alternatives:**
1. Stream the file through the API to object storage (Multer or stream piping).
2. Pre-signed URLs: the client uploads directly to Amazon S3, and the API only authorizes the upload and stores metadata.
3. Chunked or resumable uploads handled by the API (tus protocol).

**Decision:** Use pre-signed direct uploads to Amazon S3 combined with asynchronous processing:
1. The client requests an upload. The API authorizes the user against the board permissions, creates a file metadata record with status `PENDING` in PostgreSQL, and returns a short-lived pre-signed S3 upload URL with size and content-type constraints.
2. The browser uploads the file directly to S3. The file body never passes through the API.
3. The client confirms the upload. The API verifies the object in S3 and publishes a processing job to RabbitMQ.
4. A Background Worker (Node.js) consumes the job, validates the file, generates previews, and updates the status (`PENDING → PROCESSING → COMPLETED / FAILED`) in PostgreSQL.
5. Clients check the status through the API to know whether processing is pending, completed, or failed.

**Trade-offs:**
- **Positives (What we gain):**
  - The API never touches the file body, so its memory usage stays constant regardless of file size.
  - S3 provides durability and bandwidth at scale.
  - Heavy processing is isolated in workers that can scale independently of the API.
  - Clients can track the processing status of each file.
- **Negatives (Risks / What we lose):**
  - There are more moving parts (S3, a queue, a worker) and the upload flow has extra steps.
  - Orphan objects can remain in S3 if the client never confirms the upload.
  - Mitigation: short URL expiration, size and content-type restrictions in the signed policy, a periodic cleanup job for stale `PENDING` records, and idempotent, retryable worker jobs with a dead-letter queue for repeated failures.

**Final Justification:** Option 1 keeps the exact bottleneck described in the case, because the file still flows through the API. Option 3 also burdens the API with each chunk. Pre-signed URLs remove the problem at the root, since the 150 MB never reaches the Node.js process, and they fit the queue-based processing required by mandatory feature 4. S3 and RabbitMQ are already part of the container diagram.
