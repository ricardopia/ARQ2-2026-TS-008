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

export interface Db {
  getAttachment(attachmentId: string): Promise<AttachmentRow | null>;
  claimAttachment(attachmentId: string): Promise<boolean>;
  completeAttachment(attachmentId: string): Promise<void>;
  failAttachment(attachmentId: string, failureReason: string): Promise<void>;
  insertOutboxEvent(eventId: string, exchange: string, routingKey: string, payload: unknown): Promise<void>;
  close(): Promise<void>;
}

export function createDb(connectionString: string): Db {
  const pool = new Pool({ connectionString, max: 2 });

  return {
    async getAttachment(attachmentId) {
      const { rows } = await pool.query(
        `SELECT id, task_id AS "taskId", board_id AS "boardId", uploaded_by AS "uploadedBy",
                file_name AS "fileName", content_type AS "contentType", size_bytes AS "sizeBytes",
                storage_key AS "storageKey", preview_key AS "previewKey", status, failure_reason AS "failureReason",
                upload_confirmed_at AS "uploadConfirmedAt", created_at AS "createdAt", updated_at AS "updatedAt"
           FROM attachments
          WHERE id = $1`,
        [attachmentId],
      );
      const row = rows[0];
      if (!row) return null;
      return {
        id: row.id,
        taskId: row.taskId,
        boardId: row.boardId,
        uploadedBy: row.uploadedBy,
        fileName: row.fileName,
        contentType: row.contentType,
        sizeBytes: Number(row.sizeBytes),
        storageKey: row.storageKey,
        previewKey: row.previewKey,
        status: row.status,
        failureReason: row.failureReason,
        uploadConfirmedAt: row.uploadConfirmedAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    },

    async claimAttachment(attachmentId) {
      // Guarded transition: only PENDING attachments can be claimed, so a
      // redelivered job can never move a finished attachment (spec 4.4).
      const { rows } = await pool.query(
        `UPDATE attachments
            SET status = 'PROCESSING', updated_at = now()
          WHERE id = $1 AND status = 'PENDING'
          RETURNING id`,
        [attachmentId],
      );
      return rows.length > 0;
    },

    async completeAttachment(attachmentId) {
      await pool.query(
        `UPDATE attachments SET status = 'COMPLETED', updated_at = now() WHERE id = $1`,
        [attachmentId],
      );
    },

    async failAttachment(attachmentId, failureReason) {
      await pool.query(
        `UPDATE attachments
            SET status = 'FAILED', failure_reason = $2, updated_at = now()
          WHERE id = $1`,
        [attachmentId, failureReason],
      );
    },

    async insertOutboxEvent(eventId, exchange, routingKey, payload) {
      await pool.query(
        `INSERT INTO outbox_events (event_id, exchange, routing_key, payload)
         VALUES ($1, $2, $3, $4)`,
        [eventId, exchange, routingKey, JSON.stringify(payload)],
      );
    },

    async close() {
      await pool.end();
    },
  };
}
