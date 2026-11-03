import { Controller, Get, ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';
import { ProblemFilter } from '../common/problem.filter';
import { AuthController } from './auth.controller';
import { AuthService, type AccessTokenClaims } from './auth.service';
import { CurrentUser } from './current-user.decorator';
import { AuthGuard } from './jwt-auth.guard';

const JWT_SECRET = 'test-secret';

/** A minimal protected route used to observe the guard's behaviour. */
@Controller('probe')
class ProbeController {
  @Get()
  probe(@CurrentUser() user: AccessTokenClaims) {
    return { userId: user.sub };
  }
}

describe('AuthGuard over HTTP', () => {
  let app: INestApplication;
  let server: Server;
  let jwt: JwtService;

  const authService = {
    login: jest.fn().mockResolvedValue({ accessToken: 'token' }),
    register: jest.fn().mockResolvedValue({ id: 'u1' }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        JwtModule.register({
          secret: JWT_SECRET,
          signOptions: { expiresIn: '8h' },
        }),
      ],
      controllers: [AuthController, ProbeController],
      providers: [
        { provide: AuthService, useValue: authService },
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
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

  it('lets POST /auth/login through without a token (public route)', async () => {
    const response = await request(server)
      .post('/auth/login')
      .send({ email: 'alice@acme.test', password: 'correct-horse-battery' });

    expect(response.status).toBe(200);
    expect(authService.login).toHaveBeenCalled();
  });

  it('lets POST /auth/register through without a token (public route)', async () => {
    const response = await request(server)
      .post('/auth/register')
      .send({
        email: 'alice@acme.test',
        password: 'correct-horse-battery',
        displayName: 'Alice',
      });

    expect(response.status).toBe(201);
    expect(authService.register).toHaveBeenCalled();
  });

  it('rejects a protected request without a token with 401 UNAUTHENTICATED', async () => {
    const response = await request(server).get('/probe');

    expect(response.status).toBe(401);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(response.body).toMatchObject({
      status: 401,
      code: 'UNAUTHENTICATED',
      type: '/problems/unauthenticated',
    });
    expect(response.body.correlationId).toEqual(expect.any(String));
  });

  it('rejects a non-bearer Authorization header with 401', async () => {
    const response = await request(server)
      .get('/probe')
      .set('Authorization', 'Basic dXNlcjpwYXNz');

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a token signed with another secret with 401', async () => {
    const forged = await new JwtService({ secret: 'other-secret' }).signAsync({
      sub: '0a11ce00-0000-4000-8000-000000000001',
      email: 'alice@acme.test',
    });

    const response = await request(server)
      .get('/probe')
      .set('Authorization', `Bearer ${forged}`);

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('UNAUTHENTICATED');
  });

  it('rejects an expired token with 401', async () => {
    const expired = await jwt.signAsync(
      { sub: '0a11ce00-0000-4000-8000-000000000001', email: 'a@b.test' },
      { expiresIn: '-1h' },
    );

    const response = await request(server)
      .get('/probe')
      .set('Authorization', `Bearer ${expired}`);

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('UNAUTHENTICATED');
  });

  it('accepts a valid token and exposes the claims to the handler', async () => {
    const token = await jwt.signAsync({
      sub: '0a11ce00-0000-4000-8000-000000000001',
      email: 'alice@acme.test',
    });

    const response = await request(server)
      .get('/probe')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      userId: '0a11ce00-0000-4000-8000-000000000001',
    });
  });
});
