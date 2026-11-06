import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ name: 'board_columns' })
export class BoardColumn {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'board_id', type: 'uuid' })
  boardId: string;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ type: 'integer' })
  position: number;
}
