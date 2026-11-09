import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

export const ATTACHMENT_STATUSES = ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'] as const;

export type AttachmentStatus = (typeof ATTACHMENT_STATUSES)[number];

@Entity({ name: 'attachments' })
export class Attachment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'task_id', type: 'uuid' })
  taskId: string;

  @Column({ name: 'board_id', type: 'uuid' })
  boardId: string;

  @Column({ name: 'uploaded_by', type: 'uuid' })
  uploadedBy: string;

  @Column({ name: 'file_name', type: 'varchar', length: 255 })
  fileName: string;

  @Column({ name: 'content_type', type: 'varchar', length: 127 })
  contentType: string;

  @Column({ name: 'size_bytes', type: 'bigint' })
  sizeBytes: number;

  @Column({ name: 'storage_key', type: 'text' })
  storageKey: string;

  @Column({ name: 'preview_key', type: 'text', nullable: true })
  previewKey: string | null;

  @Column({ type: 'enum', enum: ATTACHMENT_STATUSES })
  status: AttachmentStatus;

  @Column({ name: 'failure_reason', type: 'varchar', length: 32, nullable: true })
  failureReason: string | null;

  @Column({ name: 'upload_confirmed_at', type: 'timestamptz', nullable: true })
  uploadConfirmedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @CreateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
