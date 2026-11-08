import { HttpStatus, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { isUniqueViolation } from '../common/pg-error';
import { ProblemException } from '../common/problem';
import { User } from '../users/user.entity';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { Board } from './board.entity';
import { BoardColumn } from './board-column.entity';
import { BoardMember, type BoardRole } from './board-member.entity';
import { CreateBoardDto } from './dto/create-board.dto';
import { AddBoardMemberDto } from './dto/add-board-member.dto';
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

export type BoardMemberView = {
  userId: string;
  email: string;
  displayName: string;
  role: BoardRole;
};

export type BoardAccess = {
  boardId: string;
  userId: string;
  role: BoardRole;
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

  /**
   * Grants a workspace member a board role (FR-1.4): the caller must be a
   * board ADMIN. The user must already be a workspace member of the board's
   * workspace; repeat grants hit the (board_id, user_id) primary key.
   */
  async addBoardMember(
    boardId: string,
    actorId: string,
    dto: AddBoardMemberDto,
  ): Promise<BoardMemberView> {
    // A malformed id must look exactly like a missing one, never a 500.
    if (!UUID_RE.test(boardId)) {
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

    const role = await this.getBoardRole(boardId, actorId);
    if (!role) {
      throw new ProblemException(
        HttpStatus.NOT_FOUND,
        'NOT_FOUND',
        'Not found',
        'The requested resource does not exist.',
      );
    }
    if (role !== 'ADMIN') {
      throw new ProblemException(
        HttpStatus.FORBIDDEN,
        'FORBIDDEN',
        'Forbidden',
        'You do not have permission to perform this action.',
      );
    }

    const user = await this.dataSource
      .getRepository(User)
      .findOneBy({ id: dto.userId });
    if (!user) {
      throw new ProblemException(
        HttpStatus.NOT_FOUND,
        'USER_NOT_FOUND',
        'User not found',
        'No user with that id exists.',
      );
    }

    const workspaceRole = await this.workspaces.getMemberRole(
      board.workspaceId,
      user.id,
    );
    if (!workspaceRole) {
      throw new ProblemException(
        HttpStatus.CONFLICT,
        'NOT_WORKSPACE_MEMBER',
        'Not a workspace member',
        'The user must be a member of the workspace before a board role can be granted.',
      );
    }

    try {
      // insert() (unlike save()) always INSERTs, so the (board_id, user_id)
      // primary key turns a repeat grant into 23505 instead of a silent UPDATE.
      await this.dataSource.getRepository(BoardMember).insert({
        boardId: board.id,
        userId: user.id,
        role: dto.role,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ProblemException(
          HttpStatus.CONFLICT,
          'ALREADY_MEMBER',
          'Already a member',
          'The user already has a role on this board.',
        );
      }
      throw error;
    }

    return {
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      role: dto.role,
    };
  }

  /**
   * Effective access for an internal caller (realtime subscriptions): the
   * effective board role, or null when the user has none (spec section 3.5).
   */
  async getAccess(boardId: string, userId: string): Promise<BoardAccess | null> {
    const role = await this.getBoardRole(boardId, userId);
    if (!role) {
      return null;
    }
    return { boardId, userId, role };
  }
}
