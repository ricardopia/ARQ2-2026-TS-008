import { Column, Entity, PrimaryColumn } from 'typeorm';

export type WorkspaceRole = 'OWNER' | 'MEMBER';

export const WORKSPACE_ROLES: readonly WorkspaceRole[] = ['OWNER', 'MEMBER'];

@Entity({ name: 'workspace_members' })
export class WorkspaceMember {
  @PrimaryColumn({ name: 'workspace_id', type: 'uuid' })
  workspaceId: string;

  @PrimaryColumn({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ type: 'enum', enum: WORKSPACE_ROLES })
  role: WorkspaceRole;
}
