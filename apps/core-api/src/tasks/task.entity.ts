import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity({ name: 'tasks' })
export class Task {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'board_id', type: 'uuid' })
  boardId: string;

  @Column({ name: 'column_id', type: 'uuid' })
  columnId: string;

  @Column({ type: 'varchar', length: 200 })
  title: string;

  @Column({ type: 'text', default: '' })
  description: string;

  @Column({ name: 'assignee_ids', type: 'uuid', array: true })
  assigneeIds: string[];

  @Column({ name: 'due_date', type: 'date' })
  dueDate: Date | null;

  @Column({ type: 'bigint' })
  position: number;

  @Column({ type: 'int' })
  version: number;

  @Column({ name: 'created_by', type: 'uuid' })
  createdBy: string;

  @Column({ name: 'updated_by', type: 'uuid' })
  updatedBy: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
