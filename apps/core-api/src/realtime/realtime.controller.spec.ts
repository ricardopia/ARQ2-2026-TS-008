import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';
import { AuthGuard } from '../auth';
import { ProblemFilter } from '../common/problem.filter';
import { RealtimeController } from './realtime.controller';
import { RealtimeService } from './realtime.service';

const JWT_SECRET = 'test-secret';
const ALICE = '0a11ce00-0000-4000-8000-000000000001';

describe('realtime tickets api', () => {
  let app: INestApplication;
  let server: Server;
  let jwt: JwtService;
  let realtime: { issue: jest.Mock };

  beforeEach(async () => {
    jest.clearAllMocks();
    realtime = { issue: jest.fn() };

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        JwtModule.register({
          secret: JWT_SECRET,
          signOptions: { expiresIn: '8h' },
        }),
      ],
      controllers: [RealtimeController],
      providers: [
        { provide: RealtimeService, useValue: realtime },
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new ProblemFilter());
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

  it('answers 201 with a ticket for the caller (FR-5.2)', async () => {
    realtime.issue.mockResolvedValue({
      ticket: 'wst_8Jf2kQ0mZr6Yb1Xc',
      expiresAt: '2026-10-13T14:00:30.000Z',
      url: 'ws://localhost:8080/ws',
    });

    const response = await request(server)
      .post('/api/v1/realtime/tickets')
      .set('Authorization', await auth());

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      ticket: 'wst_8Jf2kQ0mZr6Yb1Xc',
      expiresAt: '2026-10-13T14:00:30.000Z',
      url: 'ws://localhost:8080/ws',
    });
    expect(realtime.issue).toHaveBeenCalledWith(ALICE);
  });

  it('answers 401 without a token', async () => {
    const response = await request(server).post('/api/v1/realtime/tickets');

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('UNAUTHENTICATED');
    expect(realtime.issue).not.toHaveBeenCalled();
  });
});
