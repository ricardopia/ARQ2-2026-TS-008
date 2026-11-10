import { HttpStatus, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { ProblemException } from '../common/problem';
import { Board } from '../boards/board.entity';
import { BoardColumn } from '../boards/board-column.entity';
import { BoardsService } from '../boards/boards.service';
import { Task } from './task.entity';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { MoveTaskDto } from './dto/move-task.dto';

export type TaskDetail = {
  id: string;
  boardId: string;
  columnId: string;
  title: string;
  description: string;
  assigneeIds: string[];
  dueDate: string | null;
  position: number;
  version: number;
  attachments: unknown[];
  createdBy: string;
  createdAt: Date;
  updatedBy: string;
  updatedAt: Date;
};

@Injectable()
export class TasksService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly boards: BoardsService,
  ) {}

  /** Task reads: any effective board role (VIEWER or above). */
  async getTask(taskId: string, actorId: string) {
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
    const role = await this.boards.getBoardRole(task.boardId, actorId);
    if (!role) {
      throw new ProblemException(
        HttpStatus.NOT_FOUND,
        'NOT_FOUND',
        'Not found',
        'The requested resource does not exist.',
      );
    }
    return this.toDetail(task);
  }

  /** Task creation: board EDITOR or ADMIN (FR-1.2). */
  async create(
    boardId: string,
    actorId: string,
    dto: CreateTaskDto,
    correlationId: string,
  ) {
    const board = await this.dataSource.getRepository(Board).findOne({
      where: { id: boardId },
    });
    if (!board) {
      throw new ProblemException(
        HttpStatus.NOT_FOUND,
        'NOT_FOUND',
        'Not found',
        'The requested resource does not exist.',
      );
    }
    const role = await this.boards.getBoardRole(boardId, actorId);
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

    const column = await this.dataSource
      .getRepository(BoardColumn)
      .findOne({ where: { id: dto.columnId } });
    if (!column || column.boardId !== boardId) {
      throw new ProblemException(
        HttpStatus.NOT_FOUND,
        'NOT_FOUND',
        'Not found',
        'The requested resource does not exist.',
      );
    }

    if (dto.assigneeIds && dto.assigneeIds.length > 10) {
      throw new ProblemException(
        HttpStatus.BAD_REQUEST,
        'VALIDATION_ERROR',
        'Validation error',
        'A task can have at most 10 assignees.',
      );
    }

    for (const assigneeId of dto.assigneeIds ?? []) {
      const assigneeRole = await this.boards.getBoardRole(boardId, assigneeId);
      if (!assigneeRole) {
        throw new ProblemException(
          HttpStatus.BAD_REQUEST,
          'INVALID_ASSIGNEE',
          'Invalid assignee',
          'The assignee has no effective role on this board.',
        );
      }
    }

    const columnTasks = await this.dataSource.getRepository(Task).find({
      where: { boardId, columnId: dto.columnId },
    });
    const position =
      columnTasks.reduce((max, task) => Math.max(max, Number(task.position)), 0) + 1;

    const task = await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(Task);
      const taskToCreate = repo.create({
        boardId,
        columnId: dto.columnId,
        title: dto.title,
        description: dto.description ?? '',
        assigneeIds: dto.assigneeIds ?? [],
        dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
        position,
        version: 1,
        createdBy: actorId,
        updatedBy: actorId,
      });
      const saved = await repo.save(taskToCreate);
      // Outbox in the same transaction as the change (FR-5.1, ADR 003).
      await this.emitTaskEvent(manager, {
        eventType: 'task.created',
        task: saved,
        board,
        actorId,
        correlationId,
        data: { task: this.taskCard(saved) },
      });
      return saved;
    });

    await this.boards.invalidateSummary(boardId);
    return this.toDetail(task);
  }

  /** Task update: conditional on the version the client last saw (ADR 001). */
  async update(
    taskId: string,
    actorId: string,
    dto: UpdateTaskDto,
    ifMatch: string,
    correlationId: string,
  ) {
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

    const expectedVersion = Number(ifMatch.replace(/"/g, ''));
    const sameAssignees =
      task.assigneeIds?.length === (dto.assigneeIds?.length ?? 0) &&
      (dto.assigneeIds ?? []).every(
        (id, index) => task.assigneeIds?.[index] === id,
      );
    const sameDueDate =
      (task.dueDate ? task.dueDate.toISOString().slice(0, 10) : null) ===
      (dto.dueDate ?? null);
    const hasChanges =
      (dto.title !== undefined && dto.title !== task.title) ||
      (dto.description !== undefined && dto.description !== task.description) ||
      (dto.assigneeIds !== undefined && !sameAssignees) ||
      (dto.dueDate !== undefined && !sameDueDate);

    if (!hasChanges) {
      return this.toDetail(task);
    }

    const changes: Partial<Task> = {};
    if (dto.title !== undefined && dto.title !== task.title) {
      changes.title = dto.title;
    }
    if (dto.description !== undefined && dto.description !== task.description) {
      changes.description = dto.description;
    }
    if (dto.assigneeIds !== undefined && !sameAssignees) {
      changes.assigneeIds = dto.assigneeIds;
    }
    if (dto.dueDate !== undefined && !sameDueDate) {
      changes.dueDate = dto.dueDate ? new Date(dto.dueDate) : null;
    }

    const board = await this.dataSource
      .getRepository(Board)
      .findOneBy({ id: task.boardId });
    if (!board) {
      throw new ProblemException(
        HttpStatus.NOT_FOUND,
        'NOT_FOUND',
        'Not found',
        'The requested resource does not exist.',
      );
    }

    const updated = await this.dataSource.transaction(async (manager) => {
      const result = await manager.update(
        Task,
        { id: taskId, version: expectedVersion },
        { ...changes, version: expectedVersion + 1, updatedBy: actorId },
      );
      if (result.affected === 0) {
        throw new ProblemException(
          HttpStatus.PRECONDITION_FAILED,
          'VERSION_CONFLICT',
          'Version conflict',
          'The task was modified by another user. Review the current state and retry.',
        );
      }
      const updatedTask = await manager.findOne(Task, { where: { id: taskId } });
      if (!updatedTask) {
        throw new ProblemException(
          HttpStatus.NOT_FOUND,
          'NOT_FOUND',
          'Not found',
          'The requested resource does not exist.',
        );
      }
      await this.emitTaskEvent(manager, {
        eventType: 'task.updated',
        task: updatedTask,
        board,
        actorId,
        correlationId,
        data: {
          changedFields: Object.keys(changes),
          task: this.taskCard(updatedTask),
        },
      });
      return updatedTask;
    });

    if (!updated) {
      throw new ProblemException(
        HttpStatus.PRECONDITION_FAILED,
        'VERSION_CONFLICT',
        'Version conflict',
        'The task was modified by another user. Review the current state and retry.',
      );
    }
    await this.boards.invalidateSummary(task.boardId);
    return this.toDetail(updated);
  }

  /** Task move: conditional on the version the client last saw (ADR 001). */
  async move(
    taskId: string,
    actorId: string,
    columnId: string,
    ifMatch: string,
    correlationId: string,
  ) {
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

    const expectedVersion = Number(ifMatch.replace(/"/g, ''));
    if (task.columnId === columnId) {
      return this.toDetail(task);
    }

    const column = await this.dataSource
      .getRepository(BoardColumn)
      .findOne({ where: { id: columnId } });
    if (!column || column.boardId !== task.boardId) {
      throw new ProblemException(
        HttpStatus.NOT_FOUND,
        'NOT_FOUND',
        'Not found',
        'The requested resource does not exist.',
      );
    }

    const columnTasks = await this.dataSource.getRepository(Task).find({
      where: { boardId: task.boardId, columnId },
    });
    const position =
      columnTasks.reduce((max, candidate) => Math.max(max, Number(candidate.position)), 0) + 1;

    const board = await this.dataSource
      .getRepository(Board)
      .findOneBy({ id: task.boardId });
    if (!board) {
      throw new ProblemException(
        HttpStatus.NOT_FOUND,
        'NOT_FOUND',
        'Not found',
        'The requested resource does not exist.',
      );
    }

    const updated = await this.dataSource.transaction(async (manager) => {
      const result = await manager.update(
        Task,
        { id: taskId, version: expectedVersion },
        { columnId, position, version: expectedVersion + 1, updatedBy: actorId },
      );
      if (result.affected === 0) {
        throw new ProblemException(
          HttpStatus.PRECONDITION_FAILED,
          'VERSION_CONFLICT',
          'Version conflict',
          'The task was modified by another user. Review the current state and retry.',
        );
      }
      const movedTask = await manager.findOne(Task, { where: { id: taskId } });
      if (!movedTask) {
        throw new ProblemException(
          HttpStatus.NOT_FOUND,
          'NOT_FOUND',
          'Not found',
          'The requested resource does not exist.',
        );
      }
      await this.emitTaskEvent(manager, {
        eventType: 'task.moved',
        task: movedTask,
        board,
        actorId,
        correlationId,
        data: { fromColumnId: task.columnId, toColumnId: columnId, task: this.taskCard(movedTask) },
      });
      return movedTask;
    });

    if (!updated) {
      throw new ProblemException(
        HttpStatus.PRECONDITION_FAILED,
        'VERSION_CONFLICT',
        'Version conflict',
        'The task was modified by another user. Review the current state and retry.',
      );
    }
    await this.boards.invalidateSummary(task.boardId);
    return this.toDetail(updated);
  }

  private async emitTaskEvent(
    manager: EntityManager,
    event: {
      eventType: 'task.created' | 'task.updated' | 'task.moved';
      task: Task;
      board: Board;
      actorId: string;
      correlationId: string;
      data: Record<string, unknown>;
    },
  ): Promise<void> {
    const eventId = randomUUID();
    const payload = {
      eventId,
      eventType: event.eventType,
      eventVersion: 1,
      occurredAt: new Date().toISOString(),
      producer: 'core-api',
      correlationId: event.correlationId,
      actorId: event.actorId,
      workspaceId: event.board.workspaceId,
      boardId: event.task.boardId,
      aggregate: { type: 'task', id: event.task.id, version: event.task.version },
      data: event.data,
    };
    // Written in the same transaction as the task change (FR-5.1, ADR 003).
    await manager.query(
      `INSERT INTO outbox_events (event_id, exchange, routing_key, payload)
       VALUES ($1, $2, $3, $4)`,
      [eventId, 'taskmaster.domain-events', event.eventType, JSON.stringify(payload)],
    );
  }

  private taskCard(task: Task) {
    return {
      id: task.id,
      columnId: task.columnId,
      title: task.title,
      assigneeIds: task.assigneeIds ?? [],
      dueDate: task.dueDate ? task.dueDate.toISOString().slice(0, 10) : null,
      position: Number(task.position),
      version: task.version,
      updatedAt: task.updatedAt,
    };
  }

  private toDetail(task: Task) {
    return {
      id: task.id,
      boardId: task.boardId,
      columnId: task.columnId,
      title: task.title,
      description: task.description,
      assigneeIds: task.assigneeIds ?? [],
      dueDate: task.dueDate ? task.dueDate.toISOString().slice(0, 10) : null,
      position: Number(task.position),
      version: task.version,
      attachments: [],
      createdBy: task.createdBy,
      createdAt: task.createdAt,
      updatedBy: task.updatedBy,
      updatedAt: task.updatedAt,
    };
  }
}
