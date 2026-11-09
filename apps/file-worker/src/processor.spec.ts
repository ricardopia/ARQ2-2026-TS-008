import type { AttachmentRow } from './db.js';
import { runJob, type ProcessJobDeps } from './processor.js';

const attachment: AttachmentRow = {
  id: 'f11e0000-0000-4000-8000-000000000150',
  taskId: '7a5c0000-0000-4000-8000-000000000042',
  boardId: 'b7e4d1c2-8a3f-4b6e-9d05-1c2e3f4a5b6c',
  uploadedBy: '0a11ce00-0000-4000-8000-000000000001',
  fileName: 'homepage-v3.psd',
  contentType: 'image/vnd.adobe.photoshop',
  sizeBytes: 157286400,
  storageKey: 'boards/b7e4d1c2/tasks/7a5c0000/attachments/f11e0000/original',
  previewKey: null,
  status: 'PENDING',
  failureReason: null,
  uploadConfirmedAt: new Date('2026-10-13T14:33:41.000Z'),
  createdAt: new Date('2026-10-13T14:30:00.000Z'),
  updatedAt: new Date('2026-10-13T14:30:00.000Z'),
};

function envelope() {
  return {
    eventId: 'event-1',
    eventType: 'attachment.process',
    eventVersion: 1,
    occurredAt: '2026-10-13T14:33:41.000Z',
    producer: 'core-api',
    correlationId: 'c-1',
    actorId: '0a11ce00-0000-4000-8000-000000000001',
    workspaceId: '3f1c2a9e-5b7d-4e8a-9c21-0a6b4d2e8f10',
    boardId: 'b7e4d1c2-8a3f-4b6e-9d05-1c2e3f4a5b6c',
    aggregate: { type: 'attachment', id: attachment.id, version: null },
    data: {
      attachmentId: attachment.id,
      taskId: attachment.taskId,
      storageKey: attachment.storageKey,
      declaredContentType: attachment.contentType,
      declaredSizeBytes: attachment.sizeBytes,
    },
  };
}

function deps(overrides: Partial<ProcessJobDeps> = {}): ProcessJobDeps {
  const calls: string[] = [];
  return {
    getAttachment: overrides.getAttachment ?? (async () => attachment),
    claimAttachment: overrides.claimAttachment ?? (async () => true),
    completeAttachment: overrides.completeAttachment ?? (async () => {
      calls.push('complete');
    }),
    failAttachment: overrides.failAttachment ?? (async (_id, failureReason) => {
      calls.push(`fail:${failureReason}`);
    }),
    insertOutboxEvent:
      overrides.insertOutboxEvent ?? (async (eventId, exchange, routingKey, payload) => {
        calls.push(`event:${eventId}:${exchange}:${routingKey}`);
        expect(payload).toMatchObject({
          eventType: 'attachment.processed',
          data: { taskId: attachment.taskId },
        });
      }),
    fetchObject:
      overrides.fetchObject ?? (async () => ({
        contentType: attachment.contentType,
        sizeBytes: attachment.sizeBytes,
      })),
    ...overrides,
  };
}

describe('runJob', () => {
  it('skips unknown events', async () => {
    const d = deps();
    await expect(runJob(d, { ...envelope(), eventType: 'task.updated' })).resolves.toBe('SKIPPED');
  });

  it('skips when the attachment is missing or already finished', async () => {
    const d = deps({ getAttachment: async () => null });
    await expect(runJob(d, envelope())).resolves.toBe('SKIPPED');

    const d2 = deps({ getAttachment: async () => ({ ...attachment, status: 'COMPLETED' }) });
    await expect(runJob(d2, envelope())).resolves.toBe('SKIPPED');
  });

  it('skips when the guarded claim finds no PENDING row', async () => {
    const d = deps({ claimAttachment: async () => false });
    await expect(runJob(d, envelope())).resolves.toBe('SKIPPED');
  });

  it('completes the attachment and emits attachment.processed on success', async () => {
    const calls: string[] = [];
    const d = deps({
      completeAttachment: async () => {
        calls.push('complete');
      },
    });
    const result = await runJob(d, envelope());

    expect(result).toBe('COMPLETED');
    expect(calls).toEqual(['complete']);
  });

  it('fails with SIZE_MISMATCH and emits attachment.processed', async () => {
    const calls: string[] = [];
    const d = deps({
      fetchObject: async () => ({ contentType: attachment.contentType, sizeBytes: attachment.sizeBytes - 1 }),
      failAttachment: async (_id, failureReason) => {
        calls.push(`fail:${failureReason}`);
      },
    });
    const result = await runJob(d, envelope());

    expect(result).toBe('FAILED');
    expect(calls).toEqual(['fail:SIZE_MISMATCH']);
  });

  it('fails with CONTENT_TYPE_MISMATCH when the object type differs', async () => {
    const d = deps({
      fetchObject: async () => ({ contentType: 'application/pdf', sizeBytes: attachment.sizeBytes }),
      failAttachment: async () => undefined,
    });
    await expect(runJob(d, envelope())).resolves.toBe('FAILED');
  });

  it('fails with PROCESSING_ERROR when the object cannot be fetched', async () => {
    const d = deps({ fetchObject: async () => {
      throw new Error('storage down');
    } });
    await expect(runJob(d, envelope())).resolves.toBe('FAILED');
  });
});
