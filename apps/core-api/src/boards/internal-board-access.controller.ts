import { Controller, Get, Headers, HttpStatus, Param } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ProblemException } from '../common/problem';
import { BoardsService } from './boards.service';
import { Public } from '../auth/public.decorator';
import { timingSafeEqualStr } from '../auth/internal-auth.controller';

/**
 * Internal endpoints called by other containers (gateway, realtime service),
 * never routed by the API Gateway (spec section 3.5). They authenticate with
 * the shared `X-Internal-Token` secret instead of a user access token.
 *
 * `GET /internal/boards/{boardId}/access/{userId}` answers whether an internal
 * caller (the Realtime Service) may access a board for that user.
 */
@Public()
@Controller('internal/boards')
export class InternalBoardAccessController {
  private readonly internalToken: string;

  constructor(
    private readonly boards: BoardsService,
    private readonly config: ConfigService,
  ) {
    this.internalToken = config.getOrThrow<string>('INTERNAL_TOKEN');
  }

  @Get(':boardId/access/:userId')
  async access(
    @Headers('x-internal-token') presentedToken: string | undefined,
    @Param('boardId') boardId: string,
    @Param('userId') userId: string,
  ) {
    // Do not reveal the endpoint to callers without the shared secret; the
    // compare is constant-time (same length first) to avoid leaking bytes.
    if (!presentedToken || !timingSafeEqualStr(presentedToken, this.internalToken)) {
      throw new ProblemException(
        HttpStatus.NOT_FOUND,
        'NOT_FOUND',
        'Not found',
        'The requested resource does not exist.',
      );
    }

    const access = await this.boards.getAccess(boardId, userId);
    if (!access) {
      throw new ProblemException(
        HttpStatus.NOT_FOUND,
        'NOT_FOUND',
        'Not found',
        'The requested resource does not exist.',
      );
    }
    return access;
  }
}
