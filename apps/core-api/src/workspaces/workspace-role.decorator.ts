import { SetMetadata } from '@nestjs/common';
import type { WorkspaceRole } from './workspace-member.entity';

export const WORKSPACE_ROLES_KEY = 'workspaceRoles';

/**
 * Declares the workspace roles a route accepts (spec section 2.2 matrix).
 * The guard re-reads the caller's effective role from PostgreSQL on every
 * request, so a role change applies immediately (spec section 3.1).
 */
export const WorkspaceRoles = (...roles: WorkspaceRole[]) =>
  SetMetadata(WORKSPACE_ROLES_KEY, roles);
