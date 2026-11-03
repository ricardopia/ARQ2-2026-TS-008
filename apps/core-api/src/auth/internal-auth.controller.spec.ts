import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';
import { ProblemFilter } from '../common/problem.filter';
import { InternalAuthController } from './internal-auth.controller';

const JWT_SECRET = 'test-secret';
const INTERNAL_TOKEN = 'shared-internal-secret';

describe('InternalAuthController', () => {
  let app: INestApplication;
  let server: Server;
  let jwt: JwtService;

  beforeEach(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        JwtModule.register({
          secret: JWT_SECRET,
          signOptions: { expiresIn: '8h' },
        }),
      ],
      controllers: [InternalAuthController],
      providers: [
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: (key: string) =>
              key === 'INTERNAL_TOKEN' ? INTERNAL_TOKEN : undefined,
          },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    // Mirrors main.ts: internal routes stay outside the /api/v1 prefix.
    app.setGlobalPrefix('api/v1', { exclude: ['internal/*path'] });
    app.useGlobalFilters(new ProblemFilter());
    await app.init();
    server = app.getHttpServer();
    jwt = app.get(JwtService);
  });

  afterEach(async () => {
    await app.close();
  });

  const call = (token?: string, bearer?: string) => {
    const req = request(server).get('/internal/auth/introspect');
    if (token) {
      req.set('X-Internal-Token', token);
    }
    if (bearer) {
      req.set('Authorization', `Bearer ${bearer}`);
    }
    return req;
  };

  it('answers 204 for a valid access token presented by the gateway', async () => {
    const accessToken = await jwt.signAsync({
      sub: '0a11ce00-0000-4000-8000-000000000001',
      email: 'alice@acme.test',
    });

    const response = await call(INTERNAL_TOKEN, accessToken);

    expect(response.status).toBe(204);
  });

  it('is registered outside the /api/v1 prefix', async () => {
    const response = await request(server).get(
      '/api/v1/internal/auth/introspect',
    );

    expect(response.status).toBe(404);
  });

  it('answers 404 without the shared internal token (endpoint not revealed)', async () => {
    const accessToken = await jwt.signAsync({ sub: 'u1', email: 'a@b.test' });

    const response = await call(undefined, accessToken);

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('NOT_FOUND');
  });

  it('answers 404 with a wrong internal token', async () => {
    const response = await call('wrong-secret', 'anything');

    expect(response.status).toBe(404);
  });

  it('answers 401 UNAUTHENTICATED when the gateway forwards no Authorization header', async () => {
    const response = await call(INTERNAL_TOKEN);

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('UNAUTHENTICATED');
  });

  it('answers 401 UNAUTHENTICATED for an invalid or expired token', async () => {
    const expired = await jwt.signAsync(
      { sub: 'u1', email: 'a@b.test' },
      { expiresIn: '-1h' },
    );
    const expiredResponse = await call(INTERNAL_TOKEN, expired);
    expect(expiredResponse.status).toBe(401);
    expect(expiredResponse.body.code).toBe('UNAUTHENTICATED');

    const forged = await new JwtService({ secret: 'other' }).signAsync({
      sub: 'u1',
      email: 'a@b.test',
    });
    const forgedResponse = await call(INTERNAL_TOKEN, forged);
    expect(forgedResponse.status).toBe(401);
  });
});
