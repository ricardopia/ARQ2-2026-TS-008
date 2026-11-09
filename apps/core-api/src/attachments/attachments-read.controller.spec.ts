import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';
import { AuthGuard } from '../auth';
import { ProblemException } from '../common/problem';
import { AttachmentsService } from './attachments.service';
import { AttachmentsReadController } from './attachments-read.controller';

const JWT_SECRET = 'test-secret';
const ALICE = '0a11ce00-0000-4000-8000-000000000001';
const ATTACHMENT_ID = 'f11e0000-0000-4000-8000-000000000150';

const statusResponse = {
  id: ATTACHMENT_ID,
  taskId: '7a5c0000-0000-4000-8000-000000000042',
  boardId: 'b7e4d1c2-8a3f-4b6e-9d05-1c2e3f4a5b6c',
  fileName: 'homepage-v3.psd',
  contentType: 'image/vnd.adobe.photoshop',
  sizeBytes: 157286400,
  status: 'PENDING',
  failureReason: null,
  hasPreview: false,
  uploadedBy: ALICE,
  createdAt: '2026-10-13T14:30:00.000Z',
  updatedAt: '2026-10-13T14:30:00.000Z',
} as const;

const downloadUrlResponse = {
  url: 'https://taskmaster-attachments.s3.amazonaws.com/boards/b7e4d1c2/original?X-Amz-Expires=300',
  previewUrl: null,
  expiresAt: '2026-10-13T15:05:00.000Z',
} as const;

describe('attachments read api', () => {
  let app: INestApplication;
  let server: Server;
  let jwt: JwtService;
  let attachments: { getStatus: jest.Mock; getDownloadUrl: jest.Mock };

  beforeEach(async () => {
    jest.clearAllMocks();
    attachments = { getStatus: jest.fn(), getDownloadUrl: jest.fn() };

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        JwtModule.register({
          secret: JWT_SECRET,
          signOptions: { expiresIn: '8h' },
        }),
      ],
      controllers: [AttachmentsReadController],
      providers: [
        { provide: AttachmentsService, useValue: attachments },
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new (require('../common/problem.filter').ProblemFilter)());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    server = app.getHttpServer();
    jwt = app.get(JwtService);
  });

  afterEach(async () => {
    await app.close();
  });

  const auth = async () => {
    const token = await jwt.signAsync({ sub: ALICE, email: 'alice@acme.test' });
    return `Bearer ${token}`;
  };

  it('answers 200 with the attachment status', async () => {
    attachments.getStatus.mockResolvedValue(statusResponse);

    const response = await request(server)
      .get(`/api/v1/attachments/${ATTACHMENT_ID}`)
      .set('Authorization', await auth());

    expect(response.status).toBe(200);
    expect(response.body).toEqual(statusResponse);
    expect(attachments.getStatus).toHaveBeenCalledWith(ATTACHMENT_ID, ALICE);
  });

  it('answers 401 without a token', async () => {
    const response = await request(server).get(`/api/v1/attachments/${ATTACHMENT_ID}`);

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('UNAUTHENTICATED');
    expect(attachments.getStatus).not.toHaveBeenCalled();
  });

  it('answers 404 when the attachment does not exist', async () => {
    attachments.getStatus.mockRejectedValue(
      new ProblemException(404, 'NOT_FOUND', 'Not found', 'The requested resource does not exist.'),
    );

    const response = await request(server)
      .get(`/api/v1/attachments/${ATTACHMENT_ID}`)
      .set('Authorization', await auth());

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('NOT_FOUND');
  });

  it('answers 200 with a pre-signed download URL for a completed attachment', async () => {
    attachments.getDownloadUrl.mockResolvedValue(downloadUrlResponse);

    const response = await request(server)
      .get(`/api/v1/attachments/${ATTACHMENT_ID}/download-url`)
      .set('Authorization', await auth());

    expect(response.status).toBe(200);
    expect(response.body).toEqual(downloadUrlResponse);
    expect(attachments.getDownloadUrl).toHaveBeenCalledWith(ATTACHMENT_ID, ALICE);
  });

  it('answers 409 ATTACHMENT_NOT_READY when the attachment is not COMPLETED', async () => {
    attachments.getDownloadUrl.mockRejectedValue(
      new ProblemException(409, 'ATTACHMENT_NOT_READY', 'Attachment not ready', 'The file has not been processed yet.'),
    );

    const response = await request(server)
      .get(`/api/v1/attachments/${ATTACHMENT_ID}/download-url`)
      .set('Authorization', await auth());

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('ATTACHMENT_NOT_READY');
  });

  it('answers 404 when the attachment does not exist for the download-url', async () => {
    attachments.getDownloadUrl.mockRejectedValue(
      new ProblemException(404, 'NOT_FOUND', 'Not found', 'The requested resource does not exist.'),
    );

    const response = await request(server)
      .get(`/api/v1/attachments/${ATTACHMENT_ID}/download-url`)
      .set('Authorization', await auth());

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('NOT_FOUND');
  });
});
