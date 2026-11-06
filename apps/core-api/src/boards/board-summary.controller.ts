import { Controller, Get, Param } from '@nestjs/common';
import { CurrentUser, type AccessTokenClaims } from '../auth';
import { BoardsService } from './boards.service';

/**
 * Board reads live under /boards (board-scoped); board creation lives under
 * /workspaces because a board is created inside a workspace.
 */
@Controller('boards')
export class BoardSummaryController {
  constructor(private readonly boards: BoardsService) {}

  /** GET /boards/{boardId}/summary: lightweight, cached later on top of this read path. */
  @Get(':boardId/summary')
  getSummary(
    @Param('boardId') boardId: string,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return this.boards.getSummary(boardId, user.sub);
  }
}
