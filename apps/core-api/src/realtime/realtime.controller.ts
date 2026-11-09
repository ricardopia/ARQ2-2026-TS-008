import { Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { CurrentUser, type AccessTokenClaims } from '../auth';
import { RealtimeService, type RealtimeTicket } from './realtime.service';

@Controller('realtime')
export class RealtimeController {
  constructor(private readonly realtime: RealtimeService) {}

  /** POST /realtime/tickets: one-time ticket to open the WebSocket (spec 3.5). */
  @Post('tickets')
  @HttpCode(HttpStatus.CREATED)
  issue(@CurrentUser() user: AccessTokenClaims): Promise<RealtimeTicket> {
    return this.realtime.issue(user.sub);
  }
}
