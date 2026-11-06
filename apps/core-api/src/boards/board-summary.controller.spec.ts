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
import { Task } from '../tasks/task.entity';
import { WorkspaceMember } from '../workspaces/workspace-member.entity';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { Board } from './board.entity';
import { BoardColumn } from './board-column.entity';
import { BoardMember } from './board-member.entity';
import { BoardSummaryController } from './board-summary.controller';
import { BoardsService } from './boards.service';

const JWT_SECRET = 'test-secret';
const ALICE = '0a11ce00-0000-4000-8000-000000000001';
const WS = '3f1c2a9e-5b7d-4e8a-9c21-0a6b4d2e8f10';
const BOARD_ID = 'b7e4d1c2-8a3f-4b6e-9d05-1c2e3f4a5b6c';
const COLUMN_TODO = 'c0000000-0000-4000-8000-00000000000a';
const COLUMN_DONE = 'c0000000-0000-4000-8000-00000000000c';
const CREATED_AT = new Date('2026-10-01T09:00:00.000Z');
const UPDATED_AT = new Date('2026-10-13T14:02:11.000Z');
const TASK_ID = '7a5c0000-0000-4000-8000-000000000042';

describe('GET /boards/{boardId}/summary', () => {
  let app: INestApplication;
  let server: Server;
  let jwt: JwtService;
  let boardRepo: { findOneBy: jest.Mock };
  let columnRepo: { find: jest.Mock };
  let memberRepo: { findOneBy: jest.Mock };
  let taskRepo: { find: jest.Mock };
  let dataSource: { getRepository: jest.Mock; transaction: jest.Mock };

  beforeEach(async () => {
    jest.clearAllMocks();

    boardRepo = { findOneBy: jest.fn() };
    columnRepo = { find: jest.fn() };
    memberRepo = { findOneBy: jest.fn() };
    taskRepo = { find: jest.fn() };
    dataSource = {
      getRepository: jest.fn((target: unknown) => {
        if (target === Board) return boardRepo;
        if (target === BoardColumn) return columnRepo;
        if (target === BoardMember) return memberRepo;
        if (target === Task) return taskRepo;
        if (target === WorkspaceMember) {
          return { findOneBy: memberRepo.findOneBy };
        }
        throw new Error(`unexpected repository: ${String(target)}`);
      }),
      transaction: jest.fn(),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        JwtModule.register({
          secret: JWT_SECRET,
          signOptions: { expiresIn: '8h' },
        }),
      ],
      controllers: [BoardSummaryController],
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

  describe('GET /boards/{boardId}/summary', () => {
    it('returns the board with its columns and task cards for a viewer (200 BoardSummary)', async () => {
      boardRepo.findOneBy.mockResolvedValue({
        id: BOARD_ID,
        workspaceId: WS,
        name: 'Platform',
        description: null,
        createdBy: ALICE,
        createdAt: CREATED_AT,
      });
      memberRepo.findOneBy.mockResolvedValue({
        boardId: BOARD_ID,
        userId: ALICE,
        role: 'VIEWER',
      });
      columnRepo.find.mockResolvedValue([
        { id: COLUMN_TODO, boardId: BOARD_ID, name: 'To Do', position: 1 },
        { id: COLUMN_DONE, boardId: BOARD_ID, name: 'Done', position: 3 },
      ]);
      taskRepo.find.mockResolvedValue([
        {
          id: TASK_ID,
          boardId: BOARD_ID,
          columnId: COLUMN_TODO,
          title: 'Login page',
          description: 'ignored for the summary',
          assigneeIds: [ALICE],
          dueDate: new Date('2026-10-30'),
          position: 1,
          version: 7,
          createdBy: ALICE,
          updatedBy: ALICE,
          createdAt: CREATED_AT,
          updatedAt: UPDATED_AT,
        },
      ]);

      const response = await request(server)
        .get(`/boards/${BOARD_ID}/summary`)
        .set('Authorization', await auth());

      expect(response.status).toBe(200);
      expect(response.body.board).toEqual({
        id: BOARD_ID,
        workspaceId: WS,
        name: 'Platform',
        description: null,
        myRole: 'VIEWER',
        createdAt: '2026-10-01T09:00:00.000Z',
      });
      expect(response.body.columns).toEqual([
        {
          id: COLUMN_TODO,
          name: 'To Do',
          position: 1,
          tasks: [
            {
              id: TASK_ID,
              columnId: COLUMN_TODO,
              title: 'Login page',
              assigneeIds: [ALICE],
              dueDate: '2026-10-30',
              position: 1,
              version: 7,
              updatedAt: '2026-10-13T14:02:11.000Z',
            },
          ],
        },
        {
          id: COLUMN_DONE,
          name: 'Done',
          position: 3,
          tasks: [],
        },
      ]);
      expect(typeof response.body.generatedAt).toBe('string');
      expect(taskRepo.find).toHaveBeenCalledWith({ where: { boardId: BOARD_ID } });
    });

    it('answers 404 for a caller without any effective board role (FR-1.3)', async () => {
      boardRepo.findOneBy.mockResolvedValue({
        id: BOARD_ID,
        workspaceId: WS,
        name: 'Platform',
        description: null,
        createdBy: ALICE,
        createdAt: CREATED_AT,
      });
      memberRepo.findOneBy.mockResolvedValue(null);

      const response = await request(server)
        .get(`/boards/${BOARD_ID}/summary`)
        .set('Authorization', await auth());

      expect(response.status).toBe(404);
      expect(response.body.code).toBe('NOT_FOUND');
      expect(taskRepo.find).not.toHaveBeenCalled();
    });

    it('answers 404 when the board does not exist', async () => {
      boardRepo.findOneBy.mockResolvedValue(null);

      const response = await request(server)
        .get(`/boards/${BOARD_ID}/summary`)
        .set('Authorization', await auth());

      expect(response.status).toBe(404);
      expect(response.body.code).toBe('NOT_FOUND');
      expect(taskRepo.find).not.toHaveBeenCalled();
    });

    it('answers 404 for a malformed board id', async () => {
      const response = await request(server)
        .get('/boards/not-a-uuid/summary')
        .set('Authorization', await auth());

      expect(response.status).toBe(404);
      expect(response.body.code).toBe('NOT_FOUND');
      expect(boardRepo.findOneBy).not.toHaveBeenCalled();
    });

    it('answers 401 without a token', async () => {
      const response = await request(server).get(`/boards/${BOARD_ID}/summary`);

      expect(response.status).toBe(401);
      expect(response.body.code).toBe('UNAUTHENTICATED');
      expect(taskRepo.find).not.toHaveBeenCalled();
    });
  });
});
