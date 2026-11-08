import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Server } from 'node:http';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { AuthGuard } from '../auth';
import { ProblemException } from '../common/problem';
import { Task } from '../tasks/task.entity';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { BoardsService } from '../boards/boards.service';
import { TasksController } from '../tasks/tasks.controller';
import { CreateTaskController } from '../tasks/create-task.controller';
import { TasksService } from '../tasks/tasks.service';

const JWT_SECRET = 'test-secret';
const ALICE = '0a11ce00-0000-4000-8000-000000000001';
const BOARD_ID = 'b7e4d1c2-8a3f-4b6e-9d05-1c2e3f4a5b6c';
const TASK_ID = '7a5c0000-0000-4000-8000-000000000042';

const task = {
  id: TASK_ID,
  boardId: BOARD_ID,
  columnId: 'c0000000-0000-4000-8000-00000000000a',
  title: 'Login page',
  description: 'Build the login form.',
  assigneeIds: [ALICE],
  dueDate: '2026-10-30',
  position: 1,
  version: 7,
  attachments: [],
  createdBy: ALICE,
  createdAt: new Date('2026-10-10T09:00:00.000Z'),
  updatedBy: ALICE,
  updatedAt: new Date('2026-10-13T14:02:11.000Z'),
} as unknown as Task;

describe('tasks api', () => {
  let app: INestApplication;
  let server: Server;
  let jwt: JwtService;
  let tasksService: { getTask: jest.Mock; create: jest.Mock; update: jest.Mock; move: jest.Mock };

  beforeEach(async () => {
    jest.clearAllMocks();
    tasksService = {
      getTask: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      move: jest.fn(),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        JwtModule.register({
          secret: JWT_SECRET,
          signOptions: { expiresIn: '8h' },
        }),
      ],
      controllers: [TasksController, CreateTaskController],
      providers: [
        { provide: TasksService, useValue: tasksService },
        { provide: BoardsService, useValue: {} },
        WorkspacesService,
        { provide: DataSource, useValue: {} },
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
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

  describe('task reads and writes', () => {
    it('answers 200 with the task and its ETag', async () => {
      tasksService.getTask.mockResolvedValue(task);

      const response = await request(server)
        .get(`/tasks/${TASK_ID}`)
        .set('Authorization', await auth());

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(TASK_ID);
      expect(response.headers.etag).toBe('"7"');
      expect(tasksService.getTask).toHaveBeenCalledWith(TASK_ID, ALICE);
    });

    it('answers 404 NOT_FOUND when the task is missing', async () => {
      tasksService.getTask.mockRejectedValue(
        new ProblemException(404, 'NOT_FOUND', 'Not found', 'The requested resource does not exist.'),
      );

      const response = await request(server)
        .get(`/tasks/${TASK_ID}`)
        .set('Authorization', await auth());

      expect(response.status).toBe(404);
      expect(response.body.code).toBe('NOT_FOUND');
    });

    it('answers 401 without a token', async () => {
      const response = await request(server).get(`/tasks/${TASK_ID}`);

      expect(response.status).toBe(401);
      expect(response.body.code).toBe('UNAUTHENTICATED');
    });

    it('answers 428 PRECONDITION_REQUIRED when If-Match is missing on update', async () => {
      const response = await request(server)
        .patch(`/tasks/${TASK_ID}`)
        .set('Authorization', await auth())
        .send({ title: 'New title' });

      expect(response.status).toBe(428);
      expect(response.body.code).toBe('PRECONDITION_REQUIRED');
      expect(tasksService.update).not.toHaveBeenCalled();
    });

    it('answers 400 INVALID_IF_MATCH when If-Match is malformed on update', async () => {
      const response = await request(server)
        .patch(`/tasks/${TASK_ID}`)
        .set('Authorization', await auth())
        .set('If-Match', 'W/"7"')
        .send({ title: 'New title' });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('INVALID_IF_MATCH');
      expect(tasksService.update).not.toHaveBeenCalled();
    });

    it('answers 200 with the updated task and new ETag', async () => {
      tasksService.update.mockResolvedValue({ ...task, version: 8 });

      const response = await request(server)
        .patch(`/tasks/${TASK_ID}`)
        .set('Authorization', await auth())
        .set('If-Match', '"7"')
        .send({ title: 'New title' });

      expect(response.status).toBe(200);
      expect(response.body.version).toBe(8);
      expect(response.headers.etag).toBe('"8"');
      expect(tasksService.update).toHaveBeenCalledWith(TASK_ID, ALICE, {
        title: 'New title',
      }, '"7"');
    });

    it('answers 412 VERSION_CONFLICT when the version no longer matches', async () => {
      tasksService.update.mockRejectedValue(
        new ProblemException(412, 'VERSION_CONFLICT', 'Version conflict', 'The task was modified.'),
      );

      const response = await request(server)
        .patch(`/tasks/${TASK_ID}`)
        .set('Authorization', await auth())
        .set('If-Match', '"7"')
        .send({ title: 'New title' });

      expect(response.status).toBe(412);
      expect(response.body.code).toBe('VERSION_CONFLICT');
    });

    it('answers 400 VALIDATION_ERROR when the update body is empty', async () => {
      const response = await request(server)
        .patch(`/tasks/${TASK_ID}`)
        .set('Authorization', await auth())
        .set('If-Match', '"7"')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_ERROR');
      expect(tasksService.update).not.toHaveBeenCalled();
    });

    it('answers 200 with the same version when the move is a no-op', async () => {
      tasksService.move.mockResolvedValue(task);

      const response = await request(server)
        .patch(`/tasks/${TASK_ID}/position`)
        .set('Authorization', await auth())
        .set('If-Match', '"7"')
        .send({ columnId: task.columnId });

      expect(response.status).toBe(200);
      expect(response.body.version).toBe(7);
      expect(response.headers.etag).toBe('"7"');
      expect(tasksService.move).toHaveBeenCalledWith(TASK_ID, ALICE, task.columnId, '"7"');
    });

    it('answers 400 VALIDATION_ERROR when the move body misses columnId', async () => {
      const response = await request(server)
        .patch(`/tasks/${TASK_ID}/position`)
        .set('Authorization', await auth())
        .set('If-Match', '"7"')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_ERROR');
      expect(tasksService.move).not.toHaveBeenCalled();
    });

    it('answers 201 for task creation on a board', async () => {
      tasksService.create.mockResolvedValue(task);

      const response = await request(server)
        .post(`/boards/${BOARD_ID}/tasks`)
        .set('Authorization', await auth())
        .send({ columnId: task.columnId, title: 'Login page' });

      expect(response.status).toBe(201);
      expect(response.body.id).toBe(TASK_ID);
      expect(response.headers.etag).toBe('"1"');
      expect(tasksService.create).toHaveBeenCalledWith(BOARD_ID, ALICE, {
        columnId: task.columnId,
        title: 'Login page',
      });
    });

    it('answers 400 VALIDATION_ERROR when the create body misses the title', async () => {
      const response = await request(server)
        .post(`/boards/${BOARD_ID}/tasks`)
        .set('Authorization', await auth())
        .send({ columnId: task.columnId });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_ERROR');
      expect(tasksService.create).not.toHaveBeenCalled();
    });
  });
});
