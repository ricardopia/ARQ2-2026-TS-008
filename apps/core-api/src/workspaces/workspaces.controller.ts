import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser, type AccessTokenClaims } from '../auth';
import { AddWorkspaceMemberDto } from './dto/add-workspace-member.dto';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import { WorkspaceRoleGuard } from './workspace-role.guard';
import { WorkspaceRoles } from './workspace-role.decorator';
import { WorkspacesService } from './workspaces.service';

@Controller('workspaces')
export class WorkspacesController {
  constructor(private readonly workspaces: WorkspacesService) {}

  /** POST /workspaces: any authenticated user, the caller becomes OWNER. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentUser() user: AccessTokenClaims,
    @Body() dto: CreateWorkspaceDto,
  ) {
    return this.workspaces.create(user.sub, dto);
  }

  /** POST /workspaces/{id}/members: workspace OWNER only (spec section 2.2). */
  @Post(':workspaceId/members')
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('OWNER')
  @HttpCode(HttpStatus.CREATED)
  addMember(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: AddWorkspaceMemberDto,
  ) {
    return this.workspaces.addMember(workspaceId, dto);
  }
}
