import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import { WorkspaceMember, type WorkspaceRole } from './workspace-member.entity';
import { Workspace } from './workspace.entity';

export type WorkspaceView = {
  id: string;
  name: string;
  myRole: WorkspaceRole;
  createdAt: Date;
};

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
}
