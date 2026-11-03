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
import { WorkspaceMember } from './workspace-member.entity';
import { Workspace } from './workspace.entity';
import { WorkspacesController } from './workspaces.controller';
import { WorkspacesService } from './workspaces.service';

const JWT_SECRET = 'test-secret';
const ALICE = '0a11ce00-0000-4000-8000-000000000001';

describe('POST /workspaces', () => {
  let app: INestApplication;
  let server: Server;
  let jwt: JwtService;
  let manager: { save: jest.Mock };
  let dataSource: { transaction: jest.Mock };

  beforeEach(async () => {
    jest.clearAllMocks();
    manager = {
      save: jest.fn((target: unknown, data: Record<string, unknown>) => {
        if (target === Workspace) {
          return Promise.resolve({
            id: '3f1c2a9e-5b7d-4e8a-9c21-0a6b4d2e8f10',
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

  it('creates the workspace and its OWNER membership in one transaction', async () => {
    const response = await request(server)
      .post('/workspaces')
      .set('Authorization', await auth())
      .send({ name: '  Acme  ' });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      id: '3f1c2a9e-5b7d-4e8a-9c21-0a6b4d2e8f10',
      name: 'Acme',
      myRole: 'OWNER',
      createdAt: '2026-10-01T08:00:00.000Z',
    });
    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(manager.save).toHaveBeenCalledWith(Workspace, {
      name: 'Acme',
      createdBy: ALICE,
    });
    expect(manager.save).toHaveBeenCalledWith(WorkspaceMember, {
      workspaceId: '3f1c2a9e-5b7d-4e8a-9c21-0a6b4d2e8f10',
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
