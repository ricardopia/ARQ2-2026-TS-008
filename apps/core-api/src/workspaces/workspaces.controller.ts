import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { CurrentUser, type AccessTokenClaims } from '../auth';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';
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
}
