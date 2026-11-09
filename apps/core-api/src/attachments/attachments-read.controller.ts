import { Controller, Get, Param } from '@nestjs/common';
import { CurrentUser, type AccessTokenClaims } from '../auth';
import { AttachmentsService } from './attachments.service';

@Controller('attachments')
export class AttachmentsReadController {
  constructor(private readonly attachments: AttachmentsService) {}

  /** GET /attachments/{attachmentId}: read the attachment status (FR-4.3). */
  @Get(':attachmentId')
  getStatus(
    @Param('attachmentId') attachmentId: string,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return this.attachments.getStatus(attachmentId, user.sub);
  }

  /** GET /attachments/{attachmentId}/download-url: pre-signed download URL (FR-4.3). */
  @Get(':attachmentId/download-url')
  getDownloadUrl(
    @Param('attachmentId') attachmentId: string,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return this.attachments.getDownloadUrl(attachmentId, user.sub);
  }
}
