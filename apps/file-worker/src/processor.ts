import { randomUUID } from 'node:crypto';
import type { AttachmentRow } from './db.js';

export type JobResult = 'COMPLETED' | 'FAILED' | 'SKIPPED';

export interface AttachmentJobData {
  attachmentId: string;
  taskId: string;
  storageKey: string;
  declaredContentType: string;
  declaredSizeBytes: number;
}

export interface AttachmentJobEnvelope {
  eventId: string;
  eventType: string;
  eventVersion: number;
  occurredAt: string;
  producer: string;
  correlationId: string;
  actorId: string | null;
  workspaceId: string;
  boardId: string;
  aggregate: { type: string; id: string; version: number | null };
  data: AttachmentJobData;
}

export interface ProcessJobDeps {
  getAttachment(attachmentId: string): Promise<AttachmentRow | null>;
  claimAttachment(attachmentId: string): Promise<boolean>;
  completeAttachment(attachmentId: string): Promise<void>;
  failAttachment(attachmentId: string, failureReason: string): Promise<void>;
  insertOutboxEvent(eventId: string, exchange: string, routingKey: string, payload: unknown): Promise<void>;
  fetchObject(storageKey: string): Promise<{ contentType: string; sizeBytes: number }>;
}

const OUTBOX_EXCHANGE = 'taskmaster.domain-events';
const OUTBOX_ROUTING_KEY = 'attachment.processed';

/**
 * Consumes one `attachment.process` job (FR-4.2/ADR 002): runs the guarded
 * PENDING -> PROCESSING -> COMPLETED/FAILED transition and writes the
 * `attachment.processed` outbox event in the same worker step, so realtime can
 * push the outcome (spec 4.2, 4.4).
 */
export async function runJob(
  deps: ProcessJobDeps,
  envelope: AttachmentJobEnvelope,
): Promise<JobResult> {
  const attachmentId = envelope.data.attachmentId;
  if (envelope.eventType !== 'attachment.process') {
    return 'SKIPPED';
  }
  const attachment = await deps.getAttachment(attachmentId);
  if (!attachment || attachment.status !== 'PENDING') {
    // Already finished (or never confirmed): nothing to do.
    return 'SKIPPED';
  }
  const claimed = await deps.claimAttachment(attachmentId);
  if (!claimed) {
    return 'SKIPPED';
  }

  let object: { contentType: string; sizeBytes: number } | null = null;
  try {
    object = await deps.fetchObject(attachment.storageKey);
  } catch {
    object = null;
  }
  const sizeMatches = object != null && object.sizeBytes === attachment.sizeBytes;
  const contentTypeMatches = object != null && object.contentType === attachment.contentType;
  const completed = object != null && sizeMatches && contentTypeMatches;
  const status: JobResult = completed ? 'COMPLETED' : 'FAILED';
  const failureReason = completed
    ? null
    : object
      ? sizeMatches
        ? 'CONTENT_TYPE_MISMATCH'
        : 'SIZE_MISMATCH'
      : 'PROCESSING_ERROR';

  if (completed) {
    await deps.completeAttachment(attachmentId);
  } else {
    await deps.failAttachment(attachmentId, failureReason ?? 'PROCESSING_ERROR');
  }

  const outcome: 'COMPLETED' | 'FAILED' = completed ? 'COMPLETED' : 'FAILED';
  await emitProcessed(deps, envelope, attachmentId, attachment, outcome, failureReason);
  return outcome;
}

async function emitProcessed(
  deps: ProcessJobDeps,
  envelope: AttachmentJobEnvelope,
  attachmentId: string,
  attachment: AttachmentRow,
  status: 'COMPLETED' | 'FAILED',
  failureReason: string | null,
): Promise<void> {
  const eventId = randomUUID();
  const payload = {
    eventId,
    eventType: 'attachment.processed',
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    producer: 'file-worker',
    correlationId: envelope.correlationId,
    actorId: envelope.actorId,
    workspaceId: envelope.workspaceId,
    boardId: envelope.boardId,
    aggregate: { type: 'attachment', id: attachmentId, version: null },
    data: {
      taskId: attachment.taskId,
      attachment: {
        id: attachment.id,
        taskId: attachment.taskId,
        boardId: attachment.boardId,
        fileName: attachment.fileName,
        contentType: attachment.contentType,
        sizeBytes: attachment.sizeBytes,
        status,
        failureReason,
        hasPreview: Boolean(attachment.previewKey),
        uploadedBy: attachment.uploadedBy,
        createdAt: attachment.createdAt,
        updatedAt: attachment.updatedAt,
      },
    },
  };
  await deps.insertOutboxEvent(eventId, OUTBOX_EXCHANGE, OUTBOX_ROUTING_KEY, payload);
}
