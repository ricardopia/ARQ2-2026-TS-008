import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Board } from './board.entity';
import { BoardColumn } from './board-column.entity';
import { BoardMember, type BoardRole } from './board-member.entity';
import { CreateBoardDto } from './dto/create-board.dto';

export type BoardColumnView = {
  id: string;
  name: string;
  position: number;
};

export type BoardView = {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  myRole: BoardRole;
  columns: BoardColumnView[];
  createdAt: Date;
};

/** A board is created with three fixed columns (spec section 1.3, non-goal). */
const DEFAULT_COLUMNS = ['To Do', 'In Progress', 'Done'];

@Injectable()
export class BoardsService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Creates the board, its three default columns and the creator's ADMIN
   * membership in a single transaction; the caller must be a workspace member
   * (enforced by the WorkspaceRoleGuard before this runs).
   */
  async create(
    workspaceId: string,
    callerId: string,
    dto: CreateBoardDto,
  ): Promise<BoardView> {
    return this.dataSource.transaction(async (manager) => {
      const board = await manager.save(Board, {
        workspaceId,
        name: dto.name,
        description: dto.description ?? null,
        createdBy: callerId,
      });

      const columns = DEFAULT_COLUMNS.map((name, index) => ({
        boardId: board.id,
        name,
        position: index + 1,
      }));
      const savedColumns = await manager.save(BoardColumn, columns);

      await manager.save(BoardMember, {
        boardId: board.id,
        userId: callerId,
        role: 'ADMIN',
      });

      return {
        id: board.id,
        workspaceId: board.workspaceId,
        name: board.name,
        description: board.description,
        myRole: 'ADMIN',
        columns: savedColumns.map((column) => ({
          id: column.id,
          name: column.name,
          position: column.position,
        })),
        createdAt: board.createdAt,
      };
    });
  }
}
