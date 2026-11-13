import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';
import { AuthGuard } from '../auth';
import { ProblemException } from '../common/problem';
import { AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';

const JWT_SECRET = 'test-secret';
const ALICE = '0a11ce00-0000-4000-8000-000000000001';
const TASK_ID = '7a5c0000-0000-4000-8000-000000000042';

const uploadResponse = {
  attachment: {
    id: 'f11e0000-0000-4000-8000-000000000150',
    taskId: TASK_ID,
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
  },
  upload: {
    method: 'POST',
    url: 'https://taskmaster-attachments.s3.amazonaws.com/boards/b7e4d1c2/attachments/f11e0000/original',
    fields: { key: 'boards/b7e4d1c2/attachments/f11e0000/original', 'Content-Type': 'image/vnd.adobe.photoshop' },
    expiresAt: '2026-10-13T14:45:00.000Z',
  },
} as const;

describe('attachments api', () => {
  let app: INestApplication;
  let server: Server;
  let jwt: JwtService;
  let attachments: { issueUpload: jest.Mock };

  beforeEach(async () => {
    jest.clearAllMocks();
    attachments = { issueUpload: jest.fn() };

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        JwtModule.register({
          secret: JWT_SECRET,
          signOptions: { expiresIn: '8h' },
        }),
      ],
      controllers: [AttachmentsController],
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

  it('answers 201 with the upload authorization for the task', async () => {
    attachments.issueUpload.mockResolvedValue(uploadResponse);

    const response = await request(server)
      .post(`/api/v1/tasks/${TASK_ID}/attachments`)
      .set('Authorization', await auth())
      .send({
        fileName: 'homepage-v3.psd',
        contentType: 'image/vnd.adobe.photoshop',
        sizeBytes: 157286400,
      });

    expect(response.status).toBe(201);
    expect(response.body).toEqual(uploadResponse);
    expect(attachments.issueUpload).toHaveBeenCalledWith(TASK_ID, ALICE, {
      fileName: 'homepage-v3.psd',
      contentType: 'image/vnd.adobe.photoshop',
      sizeBytes: 157286400,
    });
  });

  it('answers 400 FILE_TOO_LARGE when the size exceeds the 250 MiB limit', async () => {
    attachments.issueUpload.mockRejectedValue(
      new ProblemException(400, 'FILE_TOO_LARGE', 'File too large', 'The file exceeds the 250 MiB upload limit.'),
    );

    const response = await request(server)
      .post(`/api/v1/tasks/${TASK_ID}/attachments`)
      .set('Authorization', await auth())
      .send({
        fileName: 'big.png',
        contentType: 'image/png',
        sizeBytes: 262144001,
      });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('FILE_TOO_LARGE');
  });

  it('answers 400 UNSUPPORTED_CONTENT_TYPE for a disallowed content type', async () => {
    attachments.issueUpload.mockRejectedValue(
      new ProblemException(400, 'UNSUPPORTED_CONTENT_TYPE', 'Unsupported content type', 'The content type is not allowed for uploads.'),
    );

    const response = await request(server)
      .post(`/api/v1/tasks/${TASK_ID}/attachments`)
      .set('Authorization', await auth())
      .send({
        fileName: 'evil.svg',
        contentType: 'image/svg+xml',
        sizeBytes: 1024,
      });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('UNSUPPORTED_CONTENT_TYPE');
  });

  it('answers 401 without a token', async () => {
    const response = await request(server)
      .post(`/api/v1/tasks/${TASK_ID}/attachments`)
      .send({
        fileName: 'homepage-v3.psd',
        contentType: 'image/vnd.adobe.photoshop',
        sizeBytes: 157286400,
      });

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('UNAUTHENTICATED');
    expect(attachments.issueUpload).not.toHaveBeenCalled();
  });

  it.each([
    ['missing fileName', { contentType: 'image/png', sizeBytes: 10 }],
    ['missing contentType', { fileName: 'a.png', sizeBytes: 10 }],
    ['missing sizeBytes', { fileName: 'a.png', contentType: 'image/png' }],
    ['sizeBytes not a number', { fileName: 'a.png', contentType: 'image/png', sizeBytes: '10' }],
    ['unknown field', { fileName: 'a.png', contentType: 'image/png', sizeBytes: 10, evil: true }],
  ])('rejects %s with 400 VALIDATION_ERROR', async (_label, body) => {
    const response = await request(server)
      .post(`/api/v1/tasks/${TASK_ID}/attachments`)
      .set('Authorization', await auth())
      .send(body);

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(attachments.issueUpload).not.toHaveBeenCalled();
  });
});
