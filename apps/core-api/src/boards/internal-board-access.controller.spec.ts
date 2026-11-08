import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';
import { ProblemFilter } from '../common/problem.filter';
import { BoardsService } from './boards.service';
import { InternalBoardAccessController } from './internal-board-access.controller';

const INTERNAL_TOKEN = 'shared-internal-secret';
const BOARD_ID = 'b7e4d1c2-8a3f-4b6e-9d05-1c2e3f4a5b6c';
const USER_ID = '0ca10000-0000-4000-8000-000000000003';

describe('InternalBoardAccessController', () => {
  let app: INestApplication;
  let server: Server;
  let getAccess: jest.Mock;

  beforeEach(async () => {
    jest.clearAllMocks();
    getAccess = jest.fn();

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [InternalBoardAccessController],
      providers: [
        { provide: BoardsService, useValue: { getAccess } },
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
  });

  afterEach(async () => {
    await app.close();
  });

  const call = (boardId: string, userId: string, token?: string) => {
    const req = request(server).get(`/internal/boards/${boardId}/access/${userId}`);
    if (token) req.set('X-Internal-Token', token);
    return req;
  };

  it('answers 200 with the effective access for a known board and user', async () => {
    getAccess.mockResolvedValue({ boardId: BOARD_ID, userId: USER_ID, role: 'VIEWER' });

    const response = await call(BOARD_ID, USER_ID, INTERNAL_TOKEN);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      boardId: BOARD_ID,
      userId: USER_ID,
      role: 'VIEWER',
    });
    expect(getAccess).toHaveBeenCalledWith(BOARD_ID, USER_ID);
  });

  it('answers 404 when the user has no effective access (FR-1.3)', async () => {
    getAccess.mockResolvedValue(null);

    const response = await call(BOARD_ID, USER_ID, INTERNAL_TOKEN);

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('NOT_FOUND');
  });

  it('answers 404 without the shared internal token (endpoint not revealed)', async () => {
    const response = await call(BOARD_ID, USER_ID);

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('NOT_FOUND');
    expect(getAccess).not.toHaveBeenCalled();
  });

  it('answers 404 with a wrong internal token', async () => {
    const response = await call(BOARD_ID, USER_ID, 'wrong-secret');

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('NOT_FOUND');
    expect(getAccess).not.toHaveBeenCalled();
  });
});
