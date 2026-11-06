import { HttpStatus, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ProblemException } from '../common/problem';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { Board } from './board.entity';
import { BoardColumn } from './board-column.entity';
import { BoardMember, type BoardRole } from './board-member.entity';
import { CreateBoardDto } from './dto/create-board.dto';
import { Task } from '../tasks/task.entity';

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

export type TaskCard = {
  id: string;
  columnId: string;
  title: string;
  assigneeIds: string[];
  dueDate: string | null;
  position: number;
  version: number;
  updatedAt: Date;
};

export type BoardSummaryBoard = {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  myRole: BoardRole;
  createdAt: Date;
};

export type BoardSummary = {
  board: BoardSummaryBoard;
  columns: {
    id: string;
    name: string;
    position: number;
    tasks: TaskCard[];
  }[];
  generatedAt: Date;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A board is created with three fixed columns (spec section 1.3, non-goal). */
const DEFAULT_COLUMNS = ['To Do', 'In Progress', 'Done'];

@Injectable()
export class BoardsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly workspaces: WorkspacesService,
  ) {}

  /** Creates the board, its three default columns and the creator's ADMIN membership in a single transaction; the caller must be a workspace member (enforced by the WorkspaceRoleGuard before this runs). */
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

  /**
   * The caller's effective board role, or null when they have none (FR-1.3:
   * no role and a nonexistent board answer identically). An explicit board
   * membership wins; a workspace OWNER implicitly administers every board.
   */
  async getBoardRole(boardId: string, userId: string): Promise<BoardRole | null> {
    const board = await this.dataSource
      .getRepository(Board)
      .findOneBy({ id: boardId });
    if (!board) {
      return null;
    }

    const member = await this.dataSource
      .getRepository(BoardMember)
      .findOneBy({ boardId, userId });
    if (member) {
      return member.role;
    }

    const workspaceRole = await this.workspaces.getMemberRole(
      board.workspaceId,
      userId,
    );
    return workspaceRole === 'OWNER' ? 'ADMIN' : null;
  }

  /**
   * Lightweight board summary (FR-2.1): the board plus, per column ordered
   * by position, its tasks as TaskCards. Never includes descriptions or
   * attachments, and the task query does not read them (FR-2.2 cache is a
   * later increment on top of this read path).
   */
  async getSummary(boardId: string, userId: string): Promise<BoardSummary> {
    if (!UUID_RE.test(boardId) || !UUID_RE.test(userId)) {
      throw new ProblemException(
        HttpStatus.NOT_FOUND,
        'NOT_FOUND',
        'Not found',
        'The requested resource does not exist.',
      );
    }

    const board = await this.dataSource
      .getRepository(Board)
      .findOneBy({ id: boardId });
    if (!board) {
      throw new ProblemException(
        HttpStatus.NOT_FOUND,
        'NOT_FOUND',
        'Not found',
        'The requested resource does not exist.',
      );
    }

    const role = await this.getBoardRole(boardId, userId);
    if (!role) {
      throw new ProblemException(
        HttpStatus.NOT_FOUND,
        'NOT_FOUND',
        'Not found',
        'The requested resource does not exist.',
      );
    }

    const columns = await this.dataSource
      .getRepository(BoardColumn)
      .find({ where: { boardId }, order: { position: 'ASC' } });
    const tasks = await this.dataSource.getRepository(Task).find({
      where: { boardId },
    });

    const tasksByColumn = new Map<string, TaskCard[]>();
    for (const task of tasks) {
      const card: TaskCard = {
        id: task.id,
        columnId: task.columnId,
        title: task.title,
        assigneeIds: task.assigneeIds ?? [],
        dueDate: task.dueDate ? task.dueDate.toISOString().slice(0, 10) : null,
        position: Number(task.position),
        version: task.version,
        updatedAt: task.updatedAt,
      };
      const list = tasksByColumn.get(task.columnId) ?? [];
      list.push(card);
      tasksByColumn.set(task.columnId, list);
    }
    for (const list of tasksByColumn.values()) {
      list.sort((a, b) => a.position - b.position);
    }

    return {
      board: {
        id: board.id,
        workspaceId: board.workspaceId,
        name: board.name,
        description: board.description,
        myRole: role,
        createdAt: board.createdAt,
      },
      columns: columns.map((column) => ({
        id: column.id,
        name: column.name,
        position: column.position,
        tasks: tasksByColumn.get(column.id) ?? [],
      })),
      generatedAt: new Date(),
    };
  }
}
