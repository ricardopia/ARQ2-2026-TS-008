import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { ProblemException } from '../common/problem';
import { Board } from '../boards/board.entity';
import { BoardsService } from '../boards/boards.service';
import { Task } from '../tasks/task.entity';
import { Attachment, ATTACHMENT_STATUSES, type AttachmentStatus } from './attachment.entity';
import { ATTACHMENT_CONTENT_TYPES } from './dto/create-attachment.dto';
import { CreateAttachmentDto } from './dto/create-attachment.dto';

const BUCKET = 'taskmaster-attachments';
const MAX_SIZE_BYTES = 262144000; // 250 MiB
const UPLOAD_TTL_SECONDS = 900; // 15 minutes (spec section 3.4)

@Injectable()
export class AttachmentsService {
  private readonly s3: S3Client;

  constructor(
    private readonly dataSource: DataSource,
    private readonly boards: BoardsService,
    private readonly config: ConfigService,
  ) {
    this.s3 = new S3Client({
      region: 'us-east-1',
      endpoint: this.config.get<string>('RUSTFS_ENDPOINT') ?? 'http://rustfs:9000',
      forcePathStyle: true,
      credentials: {
        accessKeyId: this.config.get<string>('RUSTFS_ACCESS_KEY') ?? '',
        secretAccessKey: this.config.get<string>('RUSTFS_SECRET_KEY') ?? '',
      },
    });
  }

  /**
   * Authorizes an upload for a task: board EDITOR or ADMIN creates the
   * attachment as PENDING and returns a pre-signed PUT URL (15 min) valid for
   * the declared content type and size (FR-4.x, ADR 002).
   */
  async issueUpload(
    taskId: string,
    actorId: string,
    dto: CreateAttachmentDto,
  ): Promise<{
    attachment: {
      id: string;
      taskId: string;
      boardId: string;
      fileName: string;
      contentType: string;
      sizeBytes: number;
      status: AttachmentStatus;
      failureReason: string | null;
      hasPreview: boolean;
      uploadedBy: string;
      createdAt: Date;
      updatedAt: Date;
    };
    upload: { method: string; url: string; fields: Record<string, string>; expiresAt: string };
  }> {
    if (dto.sizeBytes > MAX_SIZE_BYTES) {
      throw new ProblemException(
        HttpStatus.BAD_REQUEST,
        'FILE_TOO_LARGE',
        'File too large',
        'The file exceeds the 250 MiB upload limit.',
      );
    }
    const allowedContentType = dto.contentType as (typeof ATTACHMENT_CONTENT_TYPES)[number];
    if (!ATTACHMENT_CONTENT_TYPES.includes(allowedContentType)) {
      throw new ProblemException(
        HttpStatus.BAD_REQUEST,
        'UNSUPPORTED_CONTENT_TYPE',
        'Unsupported content type',
        'The content type is not allowed for uploads.',
      );
    }

    const task = await this.dataSource.getRepository(Task).findOne({
      where: { id: taskId },
    });
    if (!task) {
      throw new ProblemException(
        HttpStatus.NOT_FOUND,
        'NOT_FOUND',
        'Not found',
        'The requested resource does not exist.',
      );
    }
    const board = await this.dataSource.getRepository(Board).findOne({
      where: { id: task.boardId },
    });
    if (!board) {
      throw new ProblemException(
        HttpStatus.NOT_FOUND,
        'NOT_FOUND',
        'Not found',
        'The requested resource does not exist.',
      );
    }
    const role = await this.boards.getBoardRole(task.boardId, actorId);
    if (!role) {
      throw new ProblemException(
        HttpStatus.NOT_FOUND,
        'NOT_FOUND',
        'Not found',
        'The requested resource does not exist.',
      );
    }
    if (role === 'VIEWER') {
      throw new ProblemException(
        HttpStatus.FORBIDDEN,
        'FORBIDDEN',
        'Forbidden',
        'You do not have permission to perform this action.',
      );
    }

    const attachmentId = randomUUID();
    const storageKey = `boards/${task.boardId}/tasks/${taskId}/attachments/${attachmentId}/original`;
    const attachment = await this.dataSource.getRepository(Attachment).save({
      id: attachmentId,
      taskId,
      boardId: task.boardId,
      uploadedBy: actorId,
      fileName: dto.fileName,
      contentType: dto.contentType,
      sizeBytes: dto.sizeBytes,
      storageKey,
      status: 'PENDING',
    });

    const url = await getSignedUrl(
      this.s3,
      new PutObjectCommand({ Bucket: BUCKET, Key: storageKey }),
      { expiresIn: UPLOAD_TTL_SECONDS },
    );

    const expiresAt = new Date(Date.now() + UPLOAD_TTL_SECONDS * 1000).toISOString();

    return {
      attachment: {
        id: attachment.id,
        taskId: attachment.taskId,
        boardId: attachment.boardId,
        fileName: attachment.fileName,
        contentType: attachment.contentType,
        sizeBytes: Number(attachment.sizeBytes),
        status: attachment.status,
        failureReason: attachment.failureReason,
        hasPreview: false,
        uploadedBy: attachment.uploadedBy,
        createdAt: attachment.createdAt,
        updatedAt: attachment.updatedAt,
      },
      upload: {
        method: 'PUT',
        url,
        fields: { key: storageKey, 'Content-Type': dto.contentType },
        expiresAt,
      },
    };
  }
}
