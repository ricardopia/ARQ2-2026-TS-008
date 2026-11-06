import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Server } from 'node:http';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { AuthGuard } from '../auth';
import { ProblemFilter } from '../common/problem.filter';
import { WorkspaceMember } from '../workspaces/workspace-member.entity';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { Board } from './board.entity';
import { BoardColumn } from './board-column.entity';
import { BoardMember } from './board-member.entity';
import { BoardsController } from './boards.controller';
import { BoardsService } from './boards.service';

const JWT_SECRET = 'test-secret';
const ALICE = '0a11ce00-0000-4000-8000-000000000001';
const WS = '3f1c2a9e-5b7d-4e8a-9c21-0a6b4d2e8f10';
const BOARD_ID = 'b7e4d1c2-8a3f-4b6e-9d05-1c2e3f4a5b6c';
const CREATED_AT = new Date('2026-10-01T09:00:00.000Z');

const memberOf = (role: 'OWNER' | 'MEMBER') => ({
  workspaceId: WS,
  userId: ALICE,
  role,
});

describe('boards creation', () => {
  let app: INestApplication;
  let server: Server;
  let jwt: JwtService;
  let memberRepo: { findOneBy: jest.Mock };
  let manager: { save: jest.Mock };
  let dataSource: { transaction: jest.Mock; getRepository: jest.Mock };

  beforeEach(async () => {
    jest.clearAllMocks();

    memberRepo = { findOneBy: jest.fn().mockResolvedValue(memberOf('MEMBER')) };
    manager = {
      save: jest.fn((target: unknown, data: Record<string, unknown>) => {
        if (target === Board) {
          return Promise.resolve({
            id: BOARD_ID,
            workspaceId: data.workspaceId,
            name: data.name,
            description: data.description,
            createdBy: data.createdBy,
            createdAt: CREATED_AT,
          });
        }
        if (target === BoardColumn) {
          const columns = Array.isArray(data) ? data : [data];
          return Promise.resolve(
            columns.map((column, index) => ({
              id: `${BOARD_ID}-column-${index}`,
              boardId: column.boardId,
              name: column.name,
              position: column.position,
            })),
          );
        }
        if (target === BoardMember) {
          return Promise.resolve({
            boardId: data.boardId,
            userId: data.userId,
            role: data.role,
          });
        }
        return Promise.resolve(data);
      }),
    };
    dataSource = {
      transaction: jest.fn(
        async (cb: (m: typeof manager) => Promise<unknown>) => cb(manager),
      ),
      getRepository: jest.fn((target: unknown) => {
        if (target === WorkspaceMember) return memberRepo;
        throw new Error(`unexpected repository: ${String(target)}`);
      }),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        JwtModule.register({
          secret: JWT_SECRET,
          signOptions: { expiresIn: '8h' },
        }),
      ],
      controllers: [BoardsController],
      providers: [
        BoardsService,
        WorkspacesService,
        { provide: DataSource, useValue: dataSource },
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

  const auth = async () => {
    const token = await jwt.signAsync({ sub: ALICE, email: 'alice@acme.test' });
    return `Bearer ${token}`;
  };

  const createBoard = (body: unknown, authorization?: string) => {
    const req = request(server).post(`/workspaces/${WS}/boards`);
    if (authorization) req.set('Authorization', authorization);
    return req.send(body as object);
  };

  describe('POST /workspaces/{id}/boards', () => {
    it('creates the board with its three default columns and the creator as ADMIN (201 Board)', async () => {
      const response = await createBoard(
        { name: 'Platform', description: 'Platform team delivery board' },
        await auth(),
      );

      expect(response.status).toBe(201);
      expect(response.body).toEqual({
        id: BOARD_ID,
        workspaceId: WS,
        name: 'Platform',
        description: 'Platform team delivery board',
        myRole: 'ADMIN',
        columns: [
          { id: expect.any(String), name: 'To Do', position: 1 },
          { id: expect.any(String), name: 'In Progress', position: 2 },
          { id: expect.any(String), name: 'Done', position: 3 },
        ],
        createdAt: '2026-10-01T09:00:00.000Z',
      });
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(manager.save).toHaveBeenCalledWith(Board, {
        workspaceId: WS,
        name: 'Platform',
        description: 'Platform team delivery board',
        createdBy: ALICE,
      });
      expect(manager.save).toHaveBeenCalledWith(BoardMember, {
        boardId: BOARD_ID,
        userId: ALICE,
        role: 'ADMIN',
      });
    });

    it('defaults the description to null and trims the name (201)', async () => {
      const response = await createBoard({ name: '  Platform  ' }, await auth());

      expect(response.status).toBe(201);
      expect(response.body.name).toBe('Platform');
      expect(response.body.description).toBeNull();
      expect(manager.save).toHaveBeenCalledWith(Board, {
        workspaceId: WS,
        name: 'Platform',
        description: null,
        createdBy: ALICE,
      });
    });

    it('answers 401 without a token', async () => {
      const response = await createBoard({ name: 'Platform' });

      expect(response.status).toBe(401);
      expect(response.body.code).toBe('UNAUTHENTICATED');
      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('answers 404 for a caller without workspace membership (FR-1.3)', async () => {
      memberRepo.findOneBy.mockResolvedValue(null);
      const authorization = await auth();

      const response = await createBoard(
        { name: 'Platform' },
        authorization,
      );

      expect(response.status).toBe(404);
      expect(response.body.code).toBe('NOT_FOUND');
      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(manager.save).not.toHaveBeenCalled();
    });

    it.each([
      ['missing name', {}],
      ['empty name', { name: '   ' }],
      ['name longer than 100 chars', { name: 'x'.repeat(101) }],
      ['unknown field', { name: 'Platform', owner: 'Alice' }],
      ['description longer than 2000 chars', { name: 'Platform', description: 'x'.repeat(2001) }],
    ])('rejects %s with 400 VALIDATION_ERROR', async (_label, body) => {
      const response = await createBoard(body, await auth());

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_ERROR');
      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(manager.save).not.toHaveBeenCalled();
    });
  });
});
