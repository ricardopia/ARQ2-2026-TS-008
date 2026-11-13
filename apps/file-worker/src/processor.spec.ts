import type { AttachmentRow } from './db.js';
import { RETRY_DELAYS_MS, runCleanup, runJob, runJobWithRetry, type ProcessJobDeps } from './processor.js';

const PSD = Buffer.from([0x38, 0x42, 0x50, 0x53, 0, 0, 0, 0]); // 8BPS
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PDF = Buffer.from('%PDF-1.7');
const EXE = Buffer.from([0x4d, 0x5a, 0x90, 0x00]);

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

function makeDeps(overrides: Partial<ProcessJobDeps> = {}) {
  const calls: string[] = [];
  const events: Array<Record<string, unknown>> = [];
  const d: ProcessJobDeps = {
    getAttachment: async () => attachment,
    claimAttachment: async () => true,
    finishAttachment: async (_id, finish, event) => {
      calls.push(`finish:${finish.status}:${finish.failureReason ?? 'none'}`);
      events.push(event);
      expect(event).toMatchObject({
        eventType: 'attachment.processed',
        data: { taskId: attachment.taskId },
      });
      return true;
    },
    cleanupStale: async () => [],
    fetchHead: async () => ({ sizeBytes: attachment.sizeBytes, header: PSD }),
    decodePreview: async () => {
      calls.push('decode');
      return Buffer.from('preview');
    },
    putObject: async (storageKey) => {
      calls.push(`put:${storageKey}`);
    },
    deleteObject: async (storageKey) => {
      calls.push(`delete:${storageKey}`);
    },
    ...overrides,
  };
  return { d, calls, events };
}

describe('runJob', () => {
  it('skips unknown events', async () => {
    const { d } = makeDeps();
    await expect(runJob(d, { ...envelope(), eventType: 'task.updated' })).resolves.toBe('SKIPPED');
  });

  it('skips when the attachment is missing or already finished', async () => {
    const { d } = makeDeps({ getAttachment: async () => null });
    await expect(runJob(d, envelope())).resolves.toBe('SKIPPED');

    for (const status of ['COMPLETED', 'FAILED']) {
      const { d: finished } = makeDeps({ getAttachment: async () => ({ ...attachment, status }) });
      await expect(runJob(finished, envelope())).resolves.toBe('SKIPPED');
    }
  });

  it('skips when the guarded claim finds no row', async () => {
    const { d } = makeDeps({ claimAttachment: async () => false });
    await expect(runJob(d, envelope())).resolves.toBe('SKIPPED');
  });

  it('resumes a row already left in PROCESSING by an interrupted run', async () => {
    const { d, calls } = makeDeps({ getAttachment: async () => ({ ...attachment, status: 'PROCESSING' }) });
    await expect(runJob(d, envelope())).resolves.toBe('COMPLETED');
    expect(calls).toEqual(['finish:COMPLETED:none']);
  });

  it('completes a valid photoshop file without generating a preview', async () => {
    const { d, calls, events } = makeDeps();
    await expect(runJob(d, envelope())).resolves.toBe('COMPLETED');
    expect(calls).toEqual(['finish:COMPLETED:none']);
    expect(events[0]).toMatchObject({ correlationId: 'c-1', data: { attachment: { hasPreview: false } } });
  });

  it('stores a webp preview for previewable images', async () => {
    const pngRow: AttachmentRow = { ...attachment, contentType: 'image/png' };
    const { d, calls, events } = makeDeps({
      getAttachment: async () => pngRow,
      fetchHead: async () => ({ sizeBytes: pngRow.sizeBytes, header: PNG }),
    });
    await expect(runJob(d, envelope())).resolves.toBe('COMPLETED');
    const previewKey = `boards/${pngRow.boardId}/tasks/${pngRow.taskId}/attachments/${pngRow.id}/preview.webp`;
    expect(calls).toEqual(['decode', `put:${previewKey}`, 'finish:COMPLETED:none']);
    expect(events[0]).toMatchObject({ data: { attachment: { hasPreview: true } } });
  });

  it('fails with SIZE_MISMATCH after one attempt and deletes the object', async () => {
    const { d, calls } = makeDeps({
      fetchHead: async () => ({ sizeBytes: attachment.sizeBytes - 1, header: PSD }),
    });
    await expect(runJob(d, envelope())).resolves.toBe('FAILED');
    expect(calls).toEqual(['finish:FAILED:SIZE_MISMATCH', `delete:${attachment.storageKey}`]);
  });

  it('fails a windows executable declared as image/png with CONTENT_TYPE_MISMATCH (spec example)', async () => {
    const { d, calls } = makeDeps({
      getAttachment: async () => ({ ...attachment, contentType: 'image/png' }),
      fetchHead: async () => ({ sizeBytes: attachment.sizeBytes, header: EXE }),
    });
    await expect(runJob(d, envelope())).resolves.toBe('FAILED');
    expect(calls).toEqual(['finish:FAILED:CONTENT_TYPE_MISMATCH', `delete:${attachment.storageKey}`]);
  });

  it('fails when the declared type has no known signature', async () => {
    const { d } = makeDeps({
      getAttachment: async () => ({ ...attachment, contentType: 'application/x-msdownload' }),
      fetchHead: async () => ({ sizeBytes: attachment.sizeBytes, header: EXE }),
    });
    await expect(runJob(d, envelope())).resolves.toBe('FAILED');
  });

  it('does not delete the object when a concurrent job finished the row first', async () => {
    const { d, calls } = makeDeps({
      fetchHead: async () => ({ sizeBytes: attachment.sizeBytes - 1, header: PSD }),
      finishAttachment: async (_id, finish) => {
        calls.push(`finish:${finish.status}`);
        return false;
      },
    });
    await expect(runJob(d, envelope())).resolves.toBe('SKIPPED');
    expect(calls).toEqual(['finish:FAILED']);
  });

  it('propagates storage errors so the retry layer sees them', async () => {
    const { d } = makeDeps({
      fetchHead: async () => {
        throw new Error('storage down');
      },
    });
    await expect(runJob(d, envelope())).rejects.toThrow('storage down');
  });
});

describe('runJobWithRetry', () => {
  function sleepRecorder() {
    const delays: number[] = [];
    return { delays, sleep: async (ms: number) => void delays.push(ms) };
  }

  it('retries with 10 s, 60 s, 300 s, then dead-letters with FAILED / PROCESSING_ERROR', async () => {
    const { d, calls } = makeDeps({
      fetchHead: async () => {
        throw new Error('storage down');
      },
    });
    const { delays, sleep } = sleepRecorder();

    await expect(runJobWithRetry(d, envelope(), sleep)).resolves.toBe('DLQ');
    expect(delays).toEqual(RETRY_DELAYS_MS);
    expect(delays).toEqual([10_000, 60_000, 300_000]);
    expect(calls).toEqual(['finish:FAILED:PROCESSING_ERROR']);
  });

  it('completes as soon as a retry succeeds', async () => {
    let failures = 1;
    const { d } = makeDeps({
      fetchHead: async () => {
        if (failures-- > 0) throw new Error('blip');
        return { sizeBytes: attachment.sizeBytes, header: PSD };
      },
    });
    const { delays, sleep } = sleepRecorder();

    await expect(runJobWithRetry(d, envelope(), sleep)).resolves.toBe('COMPLETED');
    expect(delays).toEqual([10_000]);
  });
});

describe('runCleanup', () => {
  it('fails stale PENDING rows with UPLOAD_NOT_CONFIRMED and deletes their object', async () => {
    const stalePending: AttachmentRow & { workspaceId: string | null } = {
      ...attachment,
      workspaceId: '3f1c2a9e-5b7d-4e8a-9c21-0a6b4d2e8f10',
    };
    const staleProcessing: AttachmentRow & { workspaceId: string | null } = {
      ...attachment,
      id: 'f11e0000-0000-4000-8000-000000000151',
      status: 'PROCESSING',
      storageKey: 'boards/b7e4d1c2/tasks/7a5c0000/attachments/f11e0000-151/original',
      workspaceId: '3f1c2a9e-5b7d-4e8a-9c21-0a6b4d2e8f10',
    };
    const { d, calls } = makeDeps({ cleanupStale: async () => [stalePending, staleProcessing] });

    await expect(runCleanup(d)).resolves.toBe(2);
    expect(calls).toEqual([
      'finish:FAILED:UPLOAD_NOT_CONFIRMED',
      `delete:${stalePending.storageKey}`,
      'finish:FAILED:PROCESSING_ERROR',
    ]);
  });

  it('keeps the object when the stale row was finished concurrently', async () => {
    const { d, calls } = makeDeps({
      cleanupStale: async () => [{ ...attachment, workspaceId: 'w-1' }],
      finishAttachment: async (_id, finish) => {
        calls.push(`finish:${finish.status}`);
        return false;
      },
    });

    await expect(runCleanup(d)).resolves.toBe(0);
    expect(calls).toEqual(['finish:FAILED']);
  });
});
