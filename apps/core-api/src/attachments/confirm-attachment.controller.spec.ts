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
import { ConfirmAttachmentController } from './confirm-attachment.controller';

const JWT_SECRET = 'test-secret';
const ALICE = '0a11ce00-0000-4000-8000-000000000001';
const ATTACHMENT_ID = 'f11e0000-0000-4000-8000-000000000150';

describe('attachment confirm api', () => {
  let app: INestApplication;
  let server: Server;
  let jwt: JwtService;
  let attachments: { confirm: jest.Mock };

  beforeEach(async () => {
    jest.clearAllMocks();
    attachments = { confirm: jest.fn() };

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        JwtModule.register({
          secret: JWT_SECRET,
          signOptions: { expiresIn: '8h' },
        }),
      ],
      controllers: [ConfirmAttachmentController],
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

  it('answers 202 with the attachment after confirming the upload', async () => {
    attachments.confirm.mockResolvedValue({ id: ATTACHMENT_ID, status: 'PROCESSING' });

    const response = await request(server)
      .post(`/api/v1/attachments/${ATTACHMENT_ID}/confirm`)
      .set('Authorization', await auth());

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ id: ATTACHMENT_ID, status: 'PROCESSING' });
    expect(attachments.confirm).toHaveBeenCalledWith(ATTACHMENT_ID, ALICE, expect.any(String));
  });

  it('answers 401 without a token', async () => {
    const response = await request(server).post(`/api/v1/attachments/${ATTACHMENT_ID}/confirm`);

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('UNAUTHENTICATED');
    expect(attachments.confirm).not.toHaveBeenCalled();
  });

  it('answers 403 when the caller is not the uploader', async () => {
    attachments.confirm.mockRejectedValue(
      new ProblemException(403, 'FORBIDDEN', 'Forbidden', 'You do not have permission.'),
    );

    const response = await request(server)
      .post(`/api/v1/attachments/${ATTACHMENT_ID}/confirm`)
      .set('Authorization', await auth());

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('FORBIDDEN');
  });

  it('answers 404 when the attachment does not exist', async () => {
    attachments.confirm.mockRejectedValue(
      new ProblemException(404, 'NOT_FOUND', 'Not found', 'The requested resource does not exist.'),
    );

    const response = await request(server)
      .post(`/api/v1/attachments/${ATTACHMENT_ID}/confirm`)
      .set('Authorization', await auth());

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('NOT_FOUND');
  });

  it('answers 409 UPLOAD_NOT_FOUND when the object is missing in storage', async () => {
    attachments.confirm.mockRejectedValue(
      new ProblemException(409, 'UPLOAD_NOT_FOUND', 'Upload not found', 'The uploaded object is missing.'),
    );

    const response = await request(server)
      .post(`/api/v1/attachments/${ATTACHMENT_ID}/confirm`)
      .set('Authorization', await auth());

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('UPLOAD_NOT_FOUND');
  });

  it('answers 409 UPLOAD_SIZE_MISMATCH when the object size differs', async () => {
    attachments.confirm.mockRejectedValue(
      new ProblemException(409, 'UPLOAD_SIZE_MISMATCH', 'Upload size mismatch', 'The uploaded size differs from the declared size.'),
    );

    const response = await request(server)
      .post(`/api/v1/attachments/${ATTACHMENT_ID}/confirm`)
      .set('Authorization', await auth());

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('UPLOAD_SIZE_MISMATCH');
  });
});
