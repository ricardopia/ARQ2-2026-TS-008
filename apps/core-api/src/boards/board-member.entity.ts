import { Column, Entity, PrimaryColumn } from 'typeorm';

export type BoardRole = 'ADMIN' | 'EDITOR' | 'VIEWER';

export const BOARD_ROLES: readonly BoardRole[] = ['ADMIN', 'EDITOR', 'VIEWER'];

@Entity({ name: 'board_members' })
export class BoardMember {
  @PrimaryColumn({ name: 'board_id', type: 'uuid' })
  boardId: string;

  @PrimaryColumn({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ type: 'enum', enum: BOARD_ROLES })
  role: BoardRole;
}
