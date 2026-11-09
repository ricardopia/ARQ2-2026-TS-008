import { Controller, HttpCode, HttpStatus, Param, Post, Headers } from '@nestjs/common';
import { CurrentUser, type AccessTokenClaims } from '../auth';
import { randomUUID } from 'node:crypto';
import { AttachmentsService } from './attachments.service';

@Controller('attachments')
export class ConfirmAttachmentController {
  constructor(private readonly attachments: AttachmentsService) {}

  /** POST /attachments/{attachmentId}/confirm: upload finished, enqueue the process job (ADR 002/003). */
  @Post(':attachmentId/confirm')
  @HttpCode(HttpStatus.ACCEPTED)
  confirm(
    @Param('attachmentId') attachmentId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Headers('x-correlation-id') correlationId: string | undefined,
  ) {
    return this.attachments.confirm(attachmentId, user.sub, correlationId ?? randomUUID());
  }
}
