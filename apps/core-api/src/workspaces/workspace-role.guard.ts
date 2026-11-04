import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ProblemException } from '../common/problem';
import type { AuthenticatedRequest } from '../auth';
import type { WorkspaceRole } from './workspace-member.entity';
import { WORKSPACE_ROLES_KEY } from './workspace-role.decorator';
import { WorkspacesService } from './workspaces.service';

type WorkspaceRequest = AuthenticatedRequest;

/**
 * Enforces FR-1.2 and FR-1.3 for workspace routes: the effective role is read
 * from PostgreSQL at request time, a caller with no membership gets 404
 * (existence is not revealed) and a member with too low a role gets 403.
 */
@Injectable()
export class WorkspaceRoleGuard implements CanActivate {
  constructor(
    private readonly workspaces: WorkspacesService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<
      WorkspaceRole[] | undefined
    >(WORKSPACE_ROLES_KEY, [context.getHandler(), context.getClass()]);
    if (!required?.length) {
      return true;
    }

    const request = context.switchToHttp().getRequest<WorkspaceRequest>();
    const workspaceId = request.params?.workspaceId;
    const role = await this.workspaces.getMemberRole(
      typeof workspaceId === 'string' ? workspaceId : '',
      request.user?.sub ?? '',
    );

    // No membership and a nonexistent workspace answer identically (FR-1.3).
    if (!role) {
      throw new ProblemException(
        HttpStatus.NOT_FOUND,
        'NOT_FOUND',
        'Not found',
        'The requested resource does not exist.',
      );
    }

    if (!required.includes(role)) {
      throw new ProblemException(
        HttpStatus.FORBIDDEN,
        'FORBIDDEN',
        'Forbidden',
        'You do not have permission to perform this action.',
      );
    }

    return true;
  }
}
