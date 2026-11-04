import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Server } from 'node:http';
import { DataSource, QueryFailedError } from 'typeorm';
import request from 'supertest';
import { AuthGuard } from '../auth';
import { ProblemFilter } from '../common/problem.filter';
import { User } from '../users/user.entity';
import { WorkspaceMember } from './workspace-member.entity';
import { Workspace } from './workspace.entity';
import { WorkspacesController } from './workspaces.controller';
import { WorkspacesService } from './workspaces.service';

const JWT_SECRET = 'test-secret';
const ALICE = '0a11ce00-0000-4000-8000-000000000001';
const CAROL = '0ca10000-0000-4000-8000-000000000003';
const WS = '3f1c2a9e-5b7d-4e8a-9c21-0a6b4d2e8f10';
const WS_OTHER = '9b2d4e6a-1c3f-4a5b-8d7e-2f4a6b8c0e12';
const MALFORMED_WS = 'not-a-uuid';

const carol: User = {
  id: CAROL,
  email: 'carol@acme.test',
  displayName: 'Carol',
  passwordHash: '$argon2id$fake',
  createdAt: new Date('2026-10-02T09:00:00.000Z'),
};

const memberOf = (role: 'OWNER' | 'MEMBER') => ({
  workspaceId: WS,
  userId: ALICE,
  role,
});

describe('workspaces authorization', () => {
  let app: INestApplication;
  let server: Server;
  let jwt: JwtService;
  let memberRepo: { findOneBy: jest.Mock; insert: jest.Mock };
  let userRepo: { findOneBy: jest.Mock };
  let manager: { save: jest.Mock };
  let dataSource: { transaction: jest.Mock; getRepository: jest.Mock };

  beforeEach(async () => {
    jest.clearAllMocks();

    memberRepo = {
      findOneBy: jest.fn().mockResolvedValue(null),
      insert: jest.fn().mockResolvedValue(undefined),
    };
    userRepo = {
      findOneBy: jest.fn().mockResolvedValue(carol),
    };
    manager = {
      save: jest.fn((target: unknown, data: Record<string, unknown>) => {
        if (target === Workspace) {
          return Promise.resolve({
            id: WS,
            name: data.name,
            createdBy: data.createdBy,
            createdAt: new Date('2026-10-01T08:00:00.000Z'),
          });
        }
        if (target === WorkspaceMember) {
          return Promise.resolve({
            workspaceId: data.workspaceId,
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
        if (target === User) return userRepo;
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
      controllers: [WorkspacesController],
      providers: [
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

  const addMember = (body: unknown, authorization?: string) => {
    const req = request(server).post(`/workspaces/${WS}/members`);
    if (authorization) req.set('Authorization', authorization);
    return req.send(body as object);
  };

  describe('POST /workspaces', () => {
    it('creates the workspace and its OWNER membership in one transaction', async () => {
      const response = await request(server)
        .post('/workspaces')
        .set('Authorization', await auth())
        .send({ name: '  Acme  ' });

      expect(response.status).toBe(201);
      expect(response.body).toEqual({
        id: WS,
        name: 'Acme',
        myRole: 'OWNER',
        createdAt: '2026-10-01T08:00:00.000Z',
      });
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(dataSource.transaction.mock.calls[0][0]).toEqual(expect.any(Function));
      expect(manager.save).toHaveBeenCalledWith(Workspace, {
        name: 'Acme',
        createdBy: ALICE,
      });
      expect(manager.save).toHaveBeenCalledWith(WorkspaceMember, {
        workspaceId: WS,
        userId: ALICE,
        role: 'OWNER',
      });
    });

    it('rejects the request without a token (401)', async () => {
      const response = await request(server)
        .post('/workspaces')
        .send({ name: 'Acme' });

      expect(response.status).toBe(401);
      expect(response.body.code).toBe('UNAUTHENTICATED');
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it.each([
      ['missing name', {}],
      ['empty name', { name: '   ' }],
      ['name longer than 100 chars', { name: 'x'.repeat(101) }],
      ['unknown field', { name: 'Acme', owner: 'Alice' }],
    ])('rejects %s with 400 VALIDATION_ERROR', async (_label, body) => {
      const response = await request(server)
        .post('/workspaces')
        .set('Authorization', await auth())
        .send(body);

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_ERROR');
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });
  });

  describe('POST /workspaces/{id}/members', () => {
    it('adds a registered user when the caller is OWNER (201 Member)', async () => {
      memberRepo.findOneBy.mockResolvedValue(memberOf('OWNER'));

      const response = await addMember(
        { email: '  CAROL@ACME.test ', role: 'MEMBER' },
        await auth(),
      );

      expect(response.status).toBe(201);
      expect(response.body).toEqual({
        userId: CAROL,
        email: 'carol@acme.test',
        displayName: 'Carol',
        role: 'MEMBER',
      });
      // The email is normalized before the lookup (users store lowercase).
      expect(userRepo.findOneBy).toHaveBeenCalledWith({
        email: 'carol@acme.test',
      });
      expect(memberRepo.insert).toHaveBeenCalledWith({
        workspaceId: WS,
        userId: CAROL,
        role: 'MEMBER',
      });
    });

    it('re-reads the effective role on every request (FR-1.2)', async () => {
      // Carol is promoted between two requests with the same token.
      memberRepo.findOneBy
        .mockResolvedValueOnce(memberOf('MEMBER'))
        .mockResolvedValueOnce(memberOf('OWNER'));
      const authorization = await auth();

      const first = await addMember(
        { email: 'carol@acme.test', role: 'MEMBER' },
        authorization,
      );
      const second = await addMember(
        { email: 'carol@acme.test', role: 'MEMBER' },
        authorization,
      );

      expect(first.status).toBe(403);
      expect(second.status).toBe(201);
      expect(memberRepo.findOneBy).toHaveBeenCalledTimes(2);
    });

    it('answers 403 FORBIDDEN to a MEMBER (insufficient role, FR-1.2)', async () => {
      memberRepo.findOneBy.mockResolvedValue(memberOf('MEMBER'));

      const response = await addMember(
        { email: 'carol@acme.test', role: 'MEMBER' },
        await auth(),
      );

      expect(response.status).toBe(403);
      expect(response.headers['content-type']).toContain(
        'application/problem+json',
      );
      expect(response.body).toMatchObject({
        status: 403,
        code: 'FORBIDDEN',
        type: '/problems/forbidden',
      });
      expect(userRepo.findOneBy).not.toHaveBeenCalled();
      expect(memberRepo.insert).not.toHaveBeenCalled();
    });

    it('answers 404 with an identical shape to a stranger and to a nonexistent workspace (FR-1.3)', async () => {
      memberRepo.findOneBy.mockResolvedValue(null);
      const authorization = await auth();

      const stranger = await addMember(
        { email: 'carol@acme.test', role: 'MEMBER' },
        authorization,
      );
      const missing = await request(server)
        .post(`/workspaces/${WS_OTHER}/members`)
        .set('Authorization', authorization)
        .send({ email: 'carol@acme.test', role: 'MEMBER' });

      expect(stranger.status).toBe(404);
      expect(missing.status).toBe(404);
      // instance/correlationId only repeat what the client sent; everything
      // about the resource must be byte-identical.
      const shape = (body: Record<string, unknown>) => ({
        type: body.type,
        title: body.title,
        status: body.status,
        code: body.code,
        detail: body.detail,
      });
      expect(shape(stranger.body)).toEqual(shape(missing.body));
      expect(stranger.body.code).toBe('NOT_FOUND');
      expect(memberRepo.insert).not.toHaveBeenCalled();
    });

    it('answers 404 (not 500) for a malformed workspace id', async () => {
      const response = await request(server)
        .post(`/workspaces/${MALFORMED_WS}/members`)
        .set('Authorization', await auth())
        .send({ email: 'carol@acme.test', role: 'MEMBER' });

      expect(response.status).toBe(404);
      expect(response.body.code).toBe('NOT_FOUND');
      expect(memberRepo.findOneBy).not.toHaveBeenCalled();
    });

    it('answers 404 USER_NOT_FOUND for an email with no account', async () => {
      memberRepo.findOneBy.mockResolvedValue(memberOf('OWNER'));
      userRepo.findOneBy.mockResolvedValue(null);

      const response = await addMember(
        { email: 'ghost@acme.test', role: 'MEMBER' },
        await auth(),
      );

      expect(response.status).toBe(404);
      expect(response.body.code).toBe('USER_NOT_FOUND');
      expect(memberRepo.insert).not.toHaveBeenCalled();
    });

    it('answers 409 ALREADY_MEMBER when the user is already in the workspace', async () => {
      memberRepo.findOneBy.mockResolvedValue(memberOf('OWNER'));
      memberRepo.insert.mockRejectedValue(
        new QueryFailedError('insert into workspace_members', [], {
          code: '23505',
        } as never),
      );

      const response = await addMember(
        { email: 'carol@acme.test', role: 'MEMBER' },
        await auth(),
      );

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('ALREADY_MEMBER');
    });

    it('rejects the request without a token (401)', async () => {
      const response = await addMember({
        email: 'carol@acme.test',
        role: 'MEMBER',
      });

      expect(response.status).toBe(401);
      expect(response.body.code).toBe('UNAUTHENTICATED');
      expect(memberRepo.findOneBy).not.toHaveBeenCalled();
    });

    it.each([
      ['missing email', { role: 'MEMBER' }],
      ['missing role', { email: 'carol@acme.test' }],
      ['role outside WorkspaceRole', { email: 'carol@acme.test', role: 'ADMIN' }],
      [
        'unknown field',
        { email: 'carol@acme.test', role: 'MEMBER', note: 'hi' },
      ],
    ])('rejects %s with 400 VALIDATION_ERROR', async (_label, body) => {
      memberRepo.findOneBy.mockResolvedValue(memberOf('OWNER'));

      const response = await addMember(body, await auth());

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_ERROR');
      expect(memberRepo.insert).not.toHaveBeenCalled();
    });
  });
});
