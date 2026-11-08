import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';
import { AuthGuard } from '../auth';
import { ProblemException } from '../common/problem';
import { BoardsService } from './boards.service';
import { AddBoardMemberController } from './add-board-member.controller';

const JWT_SECRET = 'test-secret';
const ALICE = '0a11ce00-0000-4000-8000-000000000001';
const BOARD_ID = 'b7e4d1c2-8a3f-4b6e-9d05-1c2e3f4a5b6c';
const USER_ID = '0ca10000-0000-4000-8000-000000000003';

const memberView = {
  userId: USER_ID,
  email: 'carol@acme.test',
  displayName: 'Carol',
  role: 'VIEWER',
} as const;

describe('board member management api', () => {
  let app: INestApplication;
  let server: Server;
  let jwt: JwtService;
  let boardsService: { addBoardMember: jest.Mock };

  beforeEach(async () => {
    jest.clearAllMocks();
    boardsService = { addBoardMember: jest.fn() };

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        JwtModule.register({
          secret: JWT_SECRET,
          signOptions: { expiresIn: '8h' },
        }),
      ],
      controllers: [AddBoardMemberController],
      providers: [
        { provide: BoardsService, useValue: boardsService },
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

  const addMember = (body: unknown, authorization?: string) => {
    const req = request(server).post(`/boards/${BOARD_ID}/members`);
    if (authorization) req.set('Authorization', authorization);
    return req.send(body as object);
  };

  it('answers 201 with the granted board role when the caller is ADMIN', async () => {
    boardsService.addBoardMember.mockResolvedValue(memberView);

    const response = await addMember(
      { userId: USER_ID, role: 'VIEWER' },
      await auth(),
    );

    expect(response.status).toBe(201);
    expect(response.body).toEqual(memberView);
    expect(boardsService.addBoardMember).toHaveBeenCalledWith(BOARD_ID, ALICE, {
      userId: USER_ID,
      role: 'VIEWER',
    });
  });

  it('answers 403 FORBIDDEN when the caller is not a board ADMIN', async () => {
    boardsService.addBoardMember.mockRejectedValue(
      new ProblemException(403, 'FORBIDDEN', 'Forbidden', 'You do not have permission.'),
    );

    const response = await addMember(
      { userId: USER_ID, role: 'VIEWER' },
      await auth(),
    );

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
      type: '/problems/forbidden',
    });
    expect(boardsService.addBoardMember).toHaveBeenCalled();
  });

  it('answers 404 NOT_FOUND when the board does not exist', async () => {
    boardsService.addBoardMember.mockRejectedValue(
      new ProblemException(404, 'NOT_FOUND', 'Not found', 'The requested resource does not exist.'),
    );

    const response = await addMember(
      { userId: USER_ID, role: 'VIEWER' },
      await auth(),
    );

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('NOT_FOUND');
  });

  it('answers 409 NOT_WORKSPACE_MEMBER when the user is not a workspace member', async () => {
    boardsService.addBoardMember.mockRejectedValue(
      new ProblemException(409, 'NOT_WORKSPACE_MEMBER', 'Not a workspace member', 'The user must be a workspace member first.'),
    );

    const response = await addMember(
      { userId: USER_ID, role: 'VIEWER' },
      await auth(),
    );

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('NOT_WORKSPACE_MEMBER');
  });

  it('answers 409 ALREADY_MEMBER when the board role grant already exists', async () => {
    boardsService.addBoardMember.mockRejectedValue(
      new ProblemException(409, 'ALREADY_MEMBER', 'Already a member', 'The user already has a role on this board.'),
    );

    const response = await addMember(
      { userId: USER_ID, role: 'VIEWER' },
      await auth(),
    );

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('ALREADY_MEMBER');
  });

  it('answers 401 without a token', async () => {
    const response = await addMember({ userId: USER_ID, role: 'VIEWER' });

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('UNAUTHENTICATED');
    expect(boardsService.addBoardMember).not.toHaveBeenCalled();
  });

  it.each([
    ['missing userId', { role: 'VIEWER' }],
    ['invalid userId', { userId: 'not-a-uuid', role: 'VIEWER' }],
    ['missing role', { userId: USER_ID }],
    ['role outside BoardRole', { userId: USER_ID, role: 'SUPERUSER' }],
    ['unknown field', { userId: USER_ID, role: 'VIEWER', note: 'hi' }],
  ])('rejects %s with 400 VALIDATION_ERROR', async (_label, body) => {
    const response = await addMember(body, await auth());

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(boardsService.addBoardMember).not.toHaveBeenCalled();
  });
});
