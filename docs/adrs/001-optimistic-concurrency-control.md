# ADR 001: Optimistic Concurrency Control with Task Versioning

**Context and Problem:** Developer A and Manager B open the same task. A edits the technical description and saves. Two seconds later, B moves the task from "To Do" to "In Progress", and B's client resends the entire payload it loaded earlier, which still contains the old description. The server accepts it and A's changes are silently overwritten (the "Lost Update" problem). Enterprise clients have many users editing the same cards, so these conflicts are frequent and the data loss goes unnoticed.

**Considered Alternatives:**
1. Last-write-wins (current behavior, the cause of the problem).
2. Pessimistic locking (`SELECT ... FOR UPDATE` or an application-level edit lock on the card).
3. Optimistic Concurrency Control (OCC) with an integer `version` column exposed to clients as an ETag.

**Decision:** Each task has an integer `version` column in PostgreSQL. The API returns it in the `ETag` response header, and every write request must send it in the `If-Match` header. The update is applied atomically:

```sql
UPDATE tasks
SET title = $3, description = $4, version = version + 1
WHERE id = $1 AND version = $2;
```

If no row is affected, another user modified the task first, and the API responds `412 Precondition Failed` (or `428 Precondition Required` if the `If-Match` header is missing). The response includes the current task state so the client can refresh before retrying. Write operations express the intended change (for example, `PATCH` to move a task to another column) instead of replacing the whole entity, so unrelated fields are not overwritten.

**Trade-offs:**
- **Positives (What we gain):**
  - Lost updates are impossible, because the guarantee is enforced by the database itself.
  - No locks are held, so there are no deadlocks and no cards blocked by a user who left a tab open.
  - It scales well because conflicts are rare compared to reads.
  - Partial operations reduce the surface of unintended overwrites.
  - The check lives in the SQL `WHERE` clause, so it remains correct with multiple API instances.
- **Negatives (Risks / What we lose):**
  - Users may see a conflict error and must refresh and retry, which affects the user experience.
  - Every client must handle the `412` flow correctly.
  - Mitigation: the `412` response carries the current task state so the UI can show a diff or re-apply the change. Changes on disjoint fields (for example, moving a card while another user edits its description) can be auto-merged in a future iteration.

**Final Justification:** Conflicts on the same card are infrequent but costly, so optimistic control gives the best balance for TaskMaster. Pessimistic locking would block entire teams and add operational risk. Last-write-wins is exactly the behavior that caused the incident. OCC directly satisfies mandatory feature 3 and removes the silent overwrite from the problematic scenario.
