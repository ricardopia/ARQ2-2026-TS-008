import { S3Client } from '@aws-sdk/client-s3';
import type { ConfigService } from '@nestjs/config';
import type { DataSource } from 'typeorm';
import type { BoardsService } from '../boards/boards.service';
import { AttachmentsService } from './attachments.service';

const ALICE = '0a11ce00-0000-4000-8000-000000000001';
const attachment = {
  id: 'f11e0000-0000-4000-8000-000000000150',
  taskId: '7a5c0000-0000-4000-8000-000000000042',
  boardId: 'b7e4d1c2-8a3f-4b6e-9d05-1c2e3f4a5b6c',
  uploadedBy: ALICE,
  storageKey: 'k',
  contentType: 'application/pdf',
  sizeBytes: 10,
  status: 'PENDING',
  uploadConfirmedAt: null,
};

function setup(affected: number) {
  jest.spyOn(S3Client.prototype, 'send').mockResolvedValue({ ContentLength: 10 } as never);
  const query = jest.fn();
  const execute = jest.fn().mockResolvedValue({ affected });
  const qb = { update: () => qb, set: () => qb, where: () => qb, execute };
  const repo = { findOne: jest.fn().mockResolvedValue(attachment) };
  const manager = { createQueryBuilder: () => qb, query, getRepository: () => repo };
  const dataSource = {
    getRepository: () => repo,
    transaction: (fn: (m: typeof manager) => unknown) => fn(manager),
  } as unknown as DataSource;
  const config = { get: () => undefined } as unknown as ConfigService;
  const service = new AttachmentsService(dataSource, {} as BoardsService, config);
  return { service, query };
}

describe('AttachmentsService.confirm', () => {
  afterEach(() => jest.restoreAllMocks());

  it('queues the job when it wins the confirm claim', async () => {
    const { service, query } = setup(1);
    await service.confirm(attachment.id, ALICE, 'c1');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('queues nothing when another confirm already claimed it', async () => {
    const { service, query } = setup(0);
    await service.confirm(attachment.id, ALICE, 'c2');
    expect(query).not.toHaveBeenCalled();
  });
});
