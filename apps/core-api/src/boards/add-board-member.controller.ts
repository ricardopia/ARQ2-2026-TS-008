import { Body, Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { CurrentUser, type AccessTokenClaims } from '../auth';
import { BoardsService } from './boards.service';
import { AddBoardMemberDto } from './dto/add-board-member.dto';

/**
 * Board-scoped admin action (spec section 2.2): a board ADMIN grants a board
 * role to a workspace member. Auth + the ADMIN check live in the service.
 */
@Controller('boards')
export class AddBoardMemberController {
  constructor(private readonly boards: BoardsService) {}

  @Post(':boardId/members')
  @HttpCode(HttpStatus.CREATED)
  addMember(
    @Param('boardId') boardId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Body() dto: AddBoardMemberDto,
  ) {
    return this.boards.addBoardMember(boardId, user.sub, dto);
  }
}
