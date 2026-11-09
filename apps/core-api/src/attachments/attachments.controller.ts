import { Body, Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { CurrentUser, type AccessTokenClaims } from '../auth';
import { AttachmentsService } from './attachments.service';
import { CreateAttachmentDto } from './dto/create-attachment.dto';

@Controller('tasks')
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  /** POST /tasks/{taskId}/attachments: authorize a presigned upload (ADR 002). */
  @Post(':taskId/attachments')
  @HttpCode(HttpStatus.CREATED)
  issueUpload(
    @Param('taskId') taskId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Body() dto: CreateAttachmentDto,
  ) {
    return this.attachments.issueUpload(taskId, user.sub, dto);
  }
}
