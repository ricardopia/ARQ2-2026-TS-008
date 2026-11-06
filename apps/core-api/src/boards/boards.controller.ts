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
import { WorkspaceRoleGuard } from '../workspaces/workspace-role.guard';
import { WorkspaceRoles } from '../workspaces/workspace-role.decorator';
import { BoardsService } from './boards.service';
import { CreateBoardDto } from './dto/create-board.dto';

/**
 * Board creation lives under the workspace path (`POST /workspaces/{id}/boards`)
 * because a board belongs to a workspace; creating one requires being a
 * workspace member (any effective role counts).
 */
@Controller('workspaces')
export class BoardsController {
  constructor(private readonly boards: BoardsService) {}

  @Post(':workspaceId/boards')
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('MEMBER', 'OWNER')
  @HttpCode(HttpStatus.CREATED)
  create(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Body() dto: CreateBoardDto,
  ) {
    return this.boards.create(workspaceId, user.sub, dto);
  }
}
