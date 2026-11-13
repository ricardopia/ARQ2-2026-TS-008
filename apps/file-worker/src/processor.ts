import { randomUUID } from 'node:crypto';
import type { AttachmentFinish, AttachmentRow } from './db.js';
import { log } from './log.js';

export type JobResult = 'COMPLETED' | 'FAILED' | 'SKIPPED';
export type RetryResult = JobResult | 'DLQ';

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

/** Correlation data every `attachment.processed` event carries; the cleanup job builds its own. */
export interface ProcessedContext {
  correlationId: string;
  actorId: string | null;
  workspaceId: string;
  boardId: string;
}

export interface ProcessJobDeps {
  getAttachment(attachmentId: string): Promise<AttachmentRow | null>;
  claimAttachment(attachmentId: string): Promise<boolean>;
  /** Status update + `attachment.processed` outbox row in one transaction; false when the row was already finished. */
  finishAttachment(
    attachmentId: string,
    finish: AttachmentFinish,
    processedEvent: { eventId: string; [key: string]: unknown },
  ): Promise<boolean>;
  cleanupStale(): Promise<Array<AttachmentRow & { workspaceId: string | null }>>;
  /** Object size plus its first bytes (at most 16, spec FR-4.3). */
  fetchHead(storageKey: string): Promise<{ sizeBytes: number; header: Uint8Array }>;
  decodePreview(storageKey: string): Promise<Buffer>;
  putObject(storageKey: string, body: Buffer, contentType: string): Promise<void>;
  deleteObject(storageKey: string): Promise<void>;
}

/** FR-4.4: 10 s, 60 s, 300 s (initial values), then the message goes to the DLQ. */
export const RETRY_DELAYS_MS = [10_000, 60_000, 300_000];

/**
 * Consumes one `attachment.process` job (FR-4.2/ADR 002): validates the object,
 * generates the preview, then runs the guarded transition and the
 * `attachment.processed` outbox row in one transaction. Storage/database errors
 * propagate so `runJobWithRetry` can retry them; signature and size failures are
 * permanent and finish the attachment in one attempt (spec 4.4).
 */
export async function runJob(
  deps: ProcessJobDeps,
  envelope: AttachmentJobEnvelope,
): Promise<JobResult> {
  if (envelope.eventType !== 'attachment.process') {
    return 'SKIPPED';
  }
  const attachment = await deps.getAttachment(envelope.data.attachmentId);
  if (!attachment || (attachment.status !== 'PENDING' && attachment.status !== 'PROCESSING')) {
    // Already finished (or never confirmed): nothing to do.
    return 'SKIPPED';
  }
  if (!(await deps.claimAttachment(attachment.id))) {
    return 'SKIPPED';
  }

  const head = await deps.fetchHead(attachment.storageKey);
  if (head.sizeBytes !== attachment.sizeBytes) {
    return reject(deps, envelope, attachment, 'SIZE_MISMATCH');
  }
  if (!signatureMatches(attachment.contentType, head.header)) {
    return reject(deps, envelope, attachment, 'CONTENT_TYPE_MISMATCH');
  }

  let previewKey = attachment.previewKey;
  if (PREVIEWABLE.has(attachment.contentType)) {
    previewKey = previewKeyOf(attachment);
    const preview = await deps.decodePreview(attachment.storageKey);
    await deps.putObject(previewKey, preview, 'image/webp');
  }
  const finished = await deps.finishAttachment(
    attachment.id,
    { status: 'COMPLETED', failureReason: null, previewKey },
    buildProcessed(envelope, attachment, 'COMPLETED', null, previewKey),
  );
  return finished ? 'COMPLETED' : 'SKIPPED';
}

/** Retries temporary failures with the FR-4.4 delays, then dead-letters the message. */
export async function runJobWithRetry(
  deps: ProcessJobDeps,
  envelope: AttachmentJobEnvelope,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<RetryResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await runJob(deps, envelope);
    } catch (err) {
      if (attempt >= RETRY_DELAYS_MS.length) {
        await failExhausted(deps, envelope);
        return 'DLQ';
      }
      log({
        level: 'warn',
        msg: 'file job attempt failed, retrying',
        eventId: envelope.eventId,
        attempt: attempt + 1,
        delayMs: RETRY_DELAYS_MS[attempt],
        error: err instanceof Error ? err.message : String(err),
      });
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
}

/** Runs the FR-4.4 cleanup over the stale rows found by `cleanupStale`; returns how many it finished. */
export async function runCleanup(deps: ProcessJobDeps): Promise<number> {
  const stale = await deps.cleanupStale();
  let cleaned = 0;
  for (const row of stale) {
    const uploadExpired = row.status === 'PENDING';
    const failureReason = uploadExpired ? 'UPLOAD_NOT_CONFIRMED' : 'PROCESSING_ERROR';
    const ctx: ProcessedContext = {
      correlationId: randomUUID(),
      actorId: null,
      workspaceId: row.workspaceId ?? row.boardId,
      boardId: row.boardId,
    };
    const finished = await deps.finishAttachment(
      row.id,
      { status: 'FAILED', failureReason, previewKey: row.previewKey },
      buildProcessed(ctx, row, 'FAILED', failureReason, row.previewKey),
    );
    if (!finished) {
      continue; // a concurrent job finished it first; its object must stay
    }
    cleaned++;
    if (uploadExpired) {
      await deleteBestEffort(deps, row.storageKey);
    }
  }
  return cleaned;
}

async function reject(
  deps: ProcessJobDeps,
  envelope: AttachmentJobEnvelope,
  attachment: AttachmentRow,
  failureReason: 'SIZE_MISMATCH' | 'CONTENT_TYPE_MISMATCH',
): Promise<JobResult> {
  const finished = await deps.finishAttachment(
    attachment.id,
    { status: 'FAILED', failureReason, previewKey: attachment.previewKey },
    buildProcessed(envelope, attachment, 'FAILED', failureReason, attachment.previewKey),
  );
  if (!finished) {
    return 'SKIPPED'; // raced a concurrent finish; only that writer may delete
  }
  await deleteBestEffort(deps, attachment.storageKey);
  return 'FAILED';
}

/** After the last retry the attachment is FAILED too, but the object stays so the DLQ job can be replayed. */
async function failExhausted(deps: ProcessJobDeps, envelope: AttachmentJobEnvelope): Promise<void> {
  try {
    const row = await deps.getAttachment(envelope.data.attachmentId);
    if (!row || (row.status !== 'PENDING' && row.status !== 'PROCESSING')) {
      return;
    }
    await deps.finishAttachment(
      row.id,
      { status: 'FAILED', failureReason: 'PROCESSING_ERROR', previewKey: row.previewKey },
      buildProcessed(envelope, row, 'FAILED', 'PROCESSING_ERROR', row.previewKey),
    );
  } catch (err) {
    log({
      level: 'error',
      msg: 'could not mark attachment failed after retries',
      eventId: envelope.eventId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function deleteBestEffort(deps: ProcessJobDeps, storageKey: string): Promise<void> {
  try {
    await deps.deleteObject(storageKey);
  } catch (err) {
    log({
      level: 'warn',
      msg: 'could not delete rejected object',
      storageKey,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function buildProcessed(
  ctx: ProcessedContext,
  attachment: AttachmentRow,
  status: 'COMPLETED' | 'FAILED',
  failureReason: string | null,
  previewKey: string | null,
) {
  return {
    eventId: randomUUID(),
    eventType: 'attachment.processed',
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    producer: 'file-worker',
    correlationId: ctx.correlationId,
    actorId: ctx.actorId,
    workspaceId: ctx.workspaceId,
    boardId: ctx.boardId,
    aggregate: { type: 'attachment', id: attachment.id, version: null },
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
        hasPreview: Boolean(previewKey),
        uploadedBy: attachment.uploadedBy,
        createdAt: attachment.createdAt,
        updatedAt: attachment.updatedAt,
      },
    },
  };
}

/** Types that get a WebP preview (spec FR-4.3). */
const PREVIEWABLE = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

function previewKeyOf(attachment: AttachmentRow): string {
  return `boards/${attachment.boardId}/tasks/${attachment.taskId}/attachments/${attachment.id}/preview.webp`;
}

const isPdf = (h: Uint8Array): boolean => hex(h, 0, 5) === '255044462d'; // %PDF-

/** Magic bytes per declared content type, keyed like core-api's ATTACHMENT_CONTENT_TYPES (spec 3.4). */
const SIGNATURES: Record<string, (h: Uint8Array) => boolean> = {
  'image/png': (h) => hex(h, 0, 8) === '89504e470d0a1a0a',
  'image/jpeg': (h) => hex(h, 0, 3) === 'ffd8ff',
  'image/webp': (h) => hex(h, 0, 4) === '52494646' && hex(h, 8, 4) === '57454250', // RIFF....WEBP
  'image/gif': (h) => ['474946383761', '474946383961'].includes(hex(h, 0, 6)), // GIF87a / GIF89a
  'application/pdf': isPdf,
  'image/vnd.adobe.photoshop': (h) => hex(h, 0, 4) === '38425053', // 8BPS
  'application/vnd.adobe.photoshop': (h) => hex(h, 0, 4) === '38425053', // core-api accepts this spelling
  // PostScript (%!); modern .ai files are PDF-compatible, so %PDF- also passes.
  'application/postscript': (h) => hex(h, 0, 2) === '2521' || isPdf(h),
  // Local file header, empty archive (PK\5\6) and spanned marker (PK\7\8).
  'application/zip': (h) => ['504b0304', '504b0506', '504b0708'].includes(hex(h, 0, 4)),
};

function signatureMatches(contentType: string, header: Uint8Array): boolean {
  // Unknown declared type fails closed: core-api only allows the keys above.
  const check = SIGNATURES[contentType];
  return check != null && check(header);
}

function hex(bytes: Uint8Array, offset: number, length: number): string {
  return Buffer.from(bytes.subarray(offset, offset + length)).toString('hex');
}
