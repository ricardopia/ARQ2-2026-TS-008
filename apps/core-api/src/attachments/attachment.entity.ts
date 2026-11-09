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

  @Column({ type: 'varchar', length: 255 })
  fileName: string;

  @Column({ type: 'varchar', length: 127 })
  contentType: string;

  @Column({ type: 'bigint' })
  sizeBytes: number;

  @Column({ type: 'text' })
  storageKey: string;

  @Column({ type: 'text', nullable: true })
  previewKey: string | null;

  @Column({ type: 'enum', enum: ATTACHMENT_STATUSES })
  status: AttachmentStatus;

  @Column({ type: 'varchar', length: 32, nullable: true })
  failureReason: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  uploadConfirmedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @CreateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
