import { DataSource } from 'typeorm';
import { Redis } from 'ioredis';
import { MetricsService } from '../observability/metrics.service';
import { Task } from '../tasks/task.entity';
import { TasksService } from '../tasks/tasks.service';
import { WorkspaceMember } from '../workspaces/workspace-member.entity';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { Board } from './board.entity';
import { BoardColumn } from './board-column.entity';
import { BoardMember } from './board-member.entity';
import { BoardsService } from './boards.service';

const ALICE = '0a11ce00-0000-4000-8000-000000000001';
const BOB = 'b0b0b0b0-0000-4000-8000-000000000002';
const WS = '3f1c2a9e-5b7d-4e8a-9c21-0a6b4d2e8f10';
const BOARD_ID = 'b7e4d1c2-8a3f-4b6e-9d05-1c2e3f4a5b6c';
const COLUMN_TODO = 'c0000000-0000-4000-8000-00000000000a';
const COLUMN_DONE = 'c0000000-0000-4000-8000-00000000000c';
const TASK_ID = '7a5c0000-0000-4000-8000-000000000042';
const CREATED_AT = new Date('2026-10-01T09:00:00.000Z');
const UPDATED_AT = new Date('2026-10-13T14:02:11.000Z');

describe('board summary cache (FR-2.1, FR-2.2)', () => {
  let boardRepo: { findOneBy: jest.Mock };
  let columnRepo: { find: jest.Mock; findOne: jest.Mock };
  let memberRepo: { findOneBy: jest.Mock };
  let workspaceMemberRepo: { findOneBy: jest.Mock };
  let taskRepo: { find: jest.Mock };
  let dataSource: { getRepository: jest.Mock };
  let redis: { get: jest.Mock; set: jest.Mock; del: jest.Mock };
  let metrics: { summaryCache: { inc: jest.Mock } };
  let service: BoardsService;

  beforeEach(() => {
    jest.clearAllMocks();

    boardRepo = {
      findOneBy: jest.fn().mockResolvedValue({
        id: BOARD_ID,
        workspaceId: WS,
        name: 'Platform',
        description: null,
        createdBy: ALICE,
        createdAt: CREATED_AT,
      }),
    };
    columnRepo = {
      find: jest.fn().mockResolvedValue([
        { id: COLUMN_TODO, boardId: BOARD_ID, name: 'To Do', position: 1 },
      ]),
      findOne: jest.fn(),
    };
    memberRepo = { findOneBy: jest.fn() };
    workspaceMemberRepo = { findOneBy: jest.fn().mockResolvedValue(null) };
    taskRepo = { find: jest.fn().mockResolvedValue([]) };
    dataSource = {
      getRepository: jest.fn((target: unknown) => {
        if (target === Board) return boardRepo;
        if (target === BoardColumn) return columnRepo;
        if (target === BoardMember) return memberRepo;
        if (target === WorkspaceMember) return workspaceMemberRepo;
        if (target === Task) return taskRepo;
        throw new Error(`unexpected repository: ${String(target)}`);
      }),
    };
    redis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
    };
    metrics = { summaryCache: { inc: jest.fn() } };

    service = new BoardsService(
      dataSource as unknown as DataSource,
      new WorkspacesService(dataSource as unknown as DataSource),
      redis as unknown as Redis,
      metrics as unknown as MetricsService,
    );
  });

  const viewerOnBoard = () =>
    memberRepo.findOneBy.mockImplementation(({ userId }: { userId: string }) =>
      Promise.resolve(
        userId === ALICE
          ? { boardId: BOARD_ID, userId: ALICE, role: 'VIEWER' }
          : null,
      ),
    );

  it('misses the cache, builds from PostgreSQL without reading descriptions and stores the key', async () => {
    viewerOnBoard();

    const summary = await service.getSummary(BOARD_ID, ALICE);

    expect(summary.board.myRole).toBe('VIEWER');
    expect(taskRepo.find).toHaveBeenCalledWith({
      where: { boardId: BOARD_ID },
      select: {
        id: true,
        columnId: true,
        title: true,
        assigneeIds: true,
        dueDate: true,
        position: true,
        version: true,
        updatedAt: true,
      },
    });
    expect(redis.set).toHaveBeenCalledWith(
      `board-summary:${BOARD_ID}`,
      expect.not.stringContaining('"myRole"'),
      'EX',
      300,
    );
    expect(metrics.summaryCache.inc).toHaveBeenCalledWith({ result: 'miss' });
  });

  it('serves the second read from Redis and computes myRole per request', async () => {
    viewerOnBoard();
    // Alice's cached summary: no myRole, dates serialized by JSON.
    redis.get.mockResolvedValue(
      JSON.stringify({
        board: {
          id: BOARD_ID,
          workspaceId: WS,
          name: 'Platform',
          description: null,
          createdAt: CREATED_AT.toISOString(),
        },
        columns: [
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
                updatedAt: UPDATED_AT.toISOString(),
              },
            ],
          },
        ],
        generatedAt: '2026-10-13T14:00:00.000Z',
      }),
    );
    // Bob has no board membership; his workspace OWNER role implies ADMIN.
    workspaceMemberRepo.findOneBy.mockImplementation(
      ({ userId }: { userId: string }) =>
        Promise.resolve(userId === BOB ? { workspaceId: WS, userId: BOB, role: 'OWNER' } : null),
    );

    const alice = await service.getSummary(BOARD_ID, ALICE);
    const bob = await service.getSummary(BOARD_ID, BOB);

    expect(taskRepo.find).not.toHaveBeenCalled();
    expect(columnRepo.find).not.toHaveBeenCalled();
    expect(alice.board.myRole).toBe('VIEWER');
    expect(bob.board.myRole).toBe('ADMIN');
    expect(alice.generatedAt).toBeInstanceOf(Date);
    expect(alice.board.createdAt).toBeInstanceOf(Date);
    expect(alice.columns[0].tasks[0].updatedAt).toBeInstanceOf(Date);
    expect(alice.columns[0].tasks[0].title).toBe('Login page');
    expect(metrics.summaryCache.inc).toHaveBeenCalledTimes(2);
    expect(metrics.summaryCache.inc).toHaveBeenCalledWith({ result: 'hit' });
  });

  it('falls back to PostgreSQL when Redis is down', async () => {
    viewerOnBoard();
    redis.get.mockRejectedValue(new Error('ECONNREFUSED'));
    redis.set.mockRejectedValue(new Error('ECONNREFUSED'));

    const summary = await service.getSummary(BOARD_ID, ALICE);

    expect(summary.board.myRole).toBe('VIEWER');
    expect(taskRepo.find).toHaveBeenCalled();
    expect(metrics.summaryCache.inc).toHaveBeenCalledWith({ result: 'error' });
    // A failed invalidation must not fail the write either.
    redis.del.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(service.invalidateSummary(BOARD_ID)).resolves.toBeUndefined();
  });

  it('deletes the key after a committed task write', async () => {
    const task = {
      id: TASK_ID,
      boardId: BOARD_ID,
      columnId: COLUMN_TODO,
      title: 'Login page',
      description: '',
      assigneeIds: [],
      dueDate: null,
      position: 1,
      version: 7,
      createdBy: ALICE,
      updatedBy: ALICE,
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
    } as unknown as Task;
    const movedTask = { ...task, columnId: COLUMN_DONE, version: 8 };
    const taskRepoFull = {
      findOne: jest.fn().mockResolvedValue(task),
      find: jest.fn().mockResolvedValue([]),
    };
    columnRepo.findOne.mockResolvedValue({ id: COLUMN_DONE, boardId: BOARD_ID });
    const manager = {
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      findOne: jest.fn().mockResolvedValue(movedTask),
      query: jest.fn().mockResolvedValue(undefined),
    };
    const txDataSource = {
      ...dataSource,
      transaction: jest.fn((cb: (m: typeof manager) => Promise<unknown>) => cb(manager)),
      getRepository: jest.fn((target: unknown) => {
        if (target === Task) return taskRepoFull;
        if (target === BoardColumn) return columnRepo;
        if (target === Board) return boardRepo;
        throw new Error(`unexpected repository: ${String(target)}`);
      }),
    };
    const boards = {
      getBoardRole: jest.fn().mockResolvedValue('EDITOR'),
      invalidateSummary: jest.fn().mockResolvedValue(undefined),
    };
    const tasksService = new TasksService(
      txDataSource as unknown as DataSource,
      boards as unknown as BoardsService,
    );

    await tasksService.move(TASK_ID, ALICE, COLUMN_DONE, '"7"', 'correlation');

    expect(boards.invalidateSummary).toHaveBeenCalledWith(BOARD_ID);
    // The key is deleted only after the transaction committed.
    expect(txDataSource.transaction.mock.invocationCallOrder[0]).toBeLessThan(
      boards.invalidateSummary.mock.invocationCallOrder[0],
    );
  });
});
