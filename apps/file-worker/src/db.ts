import { Pool } from 'pg';

export interface AttachmentRow {
  id: string;
  taskId: string;
  boardId: string;
  uploadedBy: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  storageKey: string;
  previewKey: string | null;
  status: string;
  failureReason: string | null;
  uploadConfirmedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AttachmentFinish {
  status: 'COMPLETED' | 'FAILED';
  failureReason: string | null;
  previewKey: string | null;
}

export interface Db {
  getAttachment(attachmentId: string): Promise<AttachmentRow | null>;
  claimAttachment(attachmentId: string): Promise<boolean>;
  /** Status update + attachment.processed outbox row, one transaction (FR-4.3). */
  finishAttachment(
    attachmentId: string,
    finish: AttachmentFinish,
    processedEvent: { eventId: string; [key: string]: unknown },
  ): Promise<boolean>;
  cleanupStale(): Promise<Array<AttachmentRow & { workspaceId: string | null }>>;
  close(): Promise<void>;
}

const SELECT_COLUMNS = `id, task_id AS "taskId", board_id AS "boardId", uploaded_by AS "uploadedBy",
  file_name AS "fileName", content_type AS "contentType", size_bytes AS "sizeBytes",
  storage_key AS "storageKey", preview_key AS "previewKey", status, failure_reason AS "failureReason",
  upload_confirmed_at AS "uploadConfirmedAt", created_at AS "createdAt", updated_at AS "updatedAt"`;

function toRow(row: Record<string, unknown>): AttachmentRow {
  return {
    id: row.id as string,
    taskId: row.taskId as string,
    boardId: row.boardId as string,
    uploadedBy: row.uploadedBy as string,
    fileName: row.fileName as string,
    contentType: row.contentType as string,
    sizeBytes: Number(row.sizeBytes),
    storageKey: row.storageKey as string,
    previewKey: row.previewKey as string | null,
    status: row.status as string,
    failureReason: row.failureReason as string | null,
    uploadConfirmedAt: row.uploadConfirmedAt as Date | null,
    createdAt: row.createdAt as Date,
    updatedAt: row.updatedAt as Date,
  };
}

export function createDb(connectionString: string): Db {
  const pool = new Pool({ connectionString, max: 2 });

  return {
    async getAttachment(attachmentId) {
      const { rows } = await pool.query(
        `SELECT ${SELECT_COLUMNS} FROM attachments WHERE id = $1`,
        [attachmentId],
      );
      return rows[0] ? toRow(rows[0]) : null;
    },

    async claimAttachment(attachmentId) {
      // Guarded transition: finished attachments can never be moved again, but
      // PENDING and PROCESSING may both be (re)claimed so a retried or
      // redelivered job resumes instead of stranding the row (spec 4.4).
      const { rows } = await pool.query(
        `UPDATE attachments
            SET status = 'PROCESSING', updated_at = now()
          WHERE id = $1 AND status IN ('PENDING', 'PROCESSING')
          RETURNING id`,
        [attachmentId],
      );
      return rows.length > 0;
    },

    async finishAttachment(attachmentId, finish, processedEvent) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query(
          `UPDATE attachments
              SET status = $2, failure_reason = $3, preview_key = $4, updated_at = now()
            WHERE id = $1 AND status IN ('PENDING', 'PROCESSING')
            RETURNING id`,
          [attachmentId, finish.status, finish.failureReason, finish.previewKey],
        );
        // The event is written only when this call actually moved the row, so
        // a raced duplicate can never announce a transition that did not happen.
        if (rows.length > 0) {
          await client.query(
            `INSERT INTO outbox_events (event_id, exchange, routing_key, payload)
             VALUES ($1, $2, $3, $4)`,
            [processedEvent.eventId, 'taskmaster.domain-events', 'attachment.processed', JSON.stringify(processedEvent)],
          );
        }
        await client.query('COMMIT');
        return rows.length > 0;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },

    async cleanupStale() {
      // Selection only: the transition itself happens in finishAttachment so
      // status change and outbox event stay atomic (spec 4.4 cleanup, every
      // 10 minutes: PENDING > 60 min, PROCESSING with no update > 30 min).
      const { rows } = await pool.query(
        `SELECT ${SELECT_COLUMNS},
                (SELECT workspace_id FROM boards WHERE boards.id = attachments.board_id) AS "workspaceId"
           FROM attachments
          WHERE (status = 'PENDING'     AND created_at < now() - interval '60 minutes')
             OR (status = 'PROCESSING'  AND updated_at < now() - interval '30 minutes')`,
      );
      return rows.map((row) => ({
        ...toRow(row),
        workspaceId: (row.workspaceId as string | null) ?? null,
      }));
    },

    async close() {
      await pool.end();
    },
  };
}
