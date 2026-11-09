import { Module } from '@nestjs/common';
import { BoardsModule } from '../boards/boards.module';
import { AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';
import { AttachmentsReadController } from './attachments-read.controller';
import { ConfirmAttachmentController } from './confirm-attachment.controller';

@Module({
  imports: [BoardsModule],
  controllers: [AttachmentsController, AttachmentsReadController, ConfirmAttachmentController],
  providers: [AttachmentsService],
})
export class AttachmentsModule {}
