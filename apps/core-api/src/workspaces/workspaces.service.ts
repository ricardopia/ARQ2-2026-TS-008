import { HttpStatus, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { isUniqueViolation } from '../common/pg-error';
import { ProblemException } from '../common/problem';
import { User } from '../users/user.entity';
import { AddWorkspaceMemberDto } from './dto/add-workspace-member.dto';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import { WorkspaceMember, type WorkspaceRole } from './workspace-member.entity';
import { Workspace } from './workspace.entity';

export type WorkspaceView = {
  id: string;
  name: string;
  myRole: WorkspaceRole;
  createdAt: Date;
};

export type MemberView = {
  userId: string;
  email: string;
  displayName: string;
  role: WorkspaceRole;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class WorkspacesService {
  constructor(private readonly dataSource: DataSource) {}

  /** Creates the workspace and its OWNER membership in a single transaction. */
  async create(ownerId: string, dto: CreateWorkspaceDto): Promise<WorkspaceView> {
    return this.dataSource.transaction(async (manager) => {
      const workspace = await manager.save(Workspace, {
        name: dto.name,
        createdBy: ownerId,
      });
      await manager.save(WorkspaceMember, {
        workspaceId: workspace.id,
        userId: ownerId,
        role: 'OWNER',
      });

      return {
        id: workspace.id,
        name: workspace.name,
        myRole: 'OWNER',
        createdAt: workspace.createdAt,
      };
    });
  }

  /**
   * The caller's effective workspace role read from PostgreSQL right now
   * (FR-1.2), or null when they have no membership — which is also the answer
   * for a nonexistent workspace, so the two are indistinguishable (FR-1.3).
   */
  async getMemberRole(
    workspaceId: string,
    userId: string,
  ): Promise<WorkspaceRole | null> {
    // A malformed id must look exactly like a missing one, never a 500.
    if (!UUID_RE.test(workspaceId) || !UUID_RE.test(userId)) {
      return null;
    }

    const member = await this.dataSource
      .getRepository(WorkspaceMember)
      .findOneBy({ workspaceId, userId });
    return member?.role ?? null;
  }

  /** Adds a registered user to the workspace. Callers are checked by the guard. */
  async addMember(
    workspaceId: string,
    dto: AddWorkspaceMemberDto,
  ): Promise<MemberView> {
    const user = await this.dataSource
      .getRepository(User)
      .findOneBy({ email: dto.email });
    if (!user) {
      throw new ProblemException(
        HttpStatus.NOT_FOUND,
        'USER_NOT_FOUND',
        'User not found',
        'No user with that email address exists.',
      );
    }

    try {
      // insert() (unlike save()) always INSERTs, so the (workspace_id, user_id)
      // primary key turns a repeat add into 23505 instead of a silent UPDATE.
      await this.dataSource.getRepository(WorkspaceMember).insert({
        workspaceId,
        userId: user.id,
        role: dto.role,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ProblemException(
          HttpStatus.CONFLICT,
          'ALREADY_MEMBER',
          'Already a member',
          'The user is already a member of this workspace.',
        );
      }
      throw error;
    }

    return {
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      role: dto.role,
    };
  }
}
