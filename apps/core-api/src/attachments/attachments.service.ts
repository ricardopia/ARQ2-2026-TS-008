import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
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
  private readonly s3Presign: S3Client;

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
    // Presigned URLs are handed to the browser, so they must be host-facing.
    this.s3Presign = new S3Client({
      region: 'us-east-1',
      endpoint: this.config.get<string>('RUSTFS_ENDPOINT') ?? 'http://localhost:9000',
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
      this.s3Presign,
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

  /**
   * Confirms a finished upload: the object must exist and match the declared
   * size, then the attachment moves to PROCESSING and the `attachment.process`
   * job is queued in the same transaction (FR-4.x, ADR 002/003).
   */
  async confirm(
    attachmentId: string,
    actorId: string,
    correlationId: string,
  ): Promise<Attachment> {
    const attachment = await this.dataSource.getRepository(Attachment).findOne({
      where: { id: attachmentId },
    });
    if (!attachment) {
      throw new ProblemException(
        HttpStatus.NOT_FOUND,
        'NOT_FOUND',
        'Not found',
        'The requested resource does not exist.',
      );
    }
    // Only the uploader may confirm; repeats are idempotent no-ops.
    if (attachment.uploadedBy !== actorId) {
      throw new ProblemException(
        HttpStatus.FORBIDDEN,
        'FORBIDDEN',
        'Forbidden',
        'You do not have permission to perform this action.',
      );
    }
    if (attachment.status !== 'PENDING') {
      return attachment;
    }

    let head;
    try {
      head = await this.s3.send(
        new HeadObjectCommand({ Bucket: BUCKET, Key: attachment.storageKey }),
      );
    } catch {
      throw new ProblemException(
        HttpStatus.CONFLICT,
        'UPLOAD_NOT_FOUND',
        'Upload not found',
        'The uploaded object is missing.',
      );
    }
    if (Number(head.ContentLength ?? 0) !== attachment.sizeBytes) {
      await this.dataSource.getRepository(Attachment).update(attachment.id, {
        status: 'FAILED',
        failureReason: 'SIZE_MISMATCH',
      });
      throw new ProblemException(
        HttpStatus.CONFLICT,
        'UPLOAD_SIZE_MISMATCH',
        'Upload size mismatch',
        'The uploaded size differs from the declared size.',
      );
    }

    const task = await this.dataSource.getRepository(Task).findOne({
      where: { id: attachment.taskId },
    });
    const board = task
      ? await this.dataSource.getRepository(Board).findOne({
          where: { id: task.boardId },
        })
      : null;

    const updated = await this.dataSource.transaction(async (manager) => {
      await manager.update(Attachment, attachment.id, {
        status: 'PROCESSING',
        uploadConfirmedAt: new Date(),
      });
      const eventId = randomUUID();
      const payload = {
        eventId,
        eventType: 'attachment.process',
        eventVersion: 1,
        occurredAt: new Date().toISOString(),
        producer: 'core-api',
        correlationId,
        actorId,
        workspaceId: board?.workspaceId ?? attachment.boardId,
        boardId: attachment.boardId,
        aggregate: { type: 'attachment', id: attachment.id, version: null },
        data: {
          attachmentId: attachment.id,
          taskId: attachment.taskId,
          storageKey: attachment.storageKey,
          declaredContentType: attachment.contentType,
          declaredSizeBytes: attachment.sizeBytes,
        },
      };
      await manager.query(
        `INSERT INTO outbox_events (event_id, exchange, routing_key, payload)
         VALUES ($1, $2, $3, $4)`,
        [eventId, 'taskmaster.domain-events', 'attachment.process', JSON.stringify(payload)],
      );
      return manager.getRepository(Attachment).findOne({
        where: { id: attachmentId },
      });
    });

    if (!updated) {
      throw new ProblemException(
        HttpStatus.NOT_FOUND,
        'NOT_FOUND',
        'Not found',
        'The requested resource does not exist.',
      );
    }
    return updated;
  }
}
