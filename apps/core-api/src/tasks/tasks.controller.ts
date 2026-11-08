import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, Patch, Res } from '@nestjs/common';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import { CurrentUser, type AccessTokenClaims } from '../auth';
import { ProblemException } from '../common/problem';
import { TasksService } from './tasks.service';
import { UpdateTaskDto } from './dto/update-task.dto';
import { MoveTaskDto } from './dto/move-task.dto';

@Controller('tasks')
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Get(':taskId')
  async get(
    @Param('taskId') taskId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Res({ passthrough: true }) res: Response,
  ) {
    const task = await this.tasks.getTask(taskId, user.sub);
    res.setHeader('ETag', `"${task.version}"`);
    return task;
  }

  @Patch(':taskId')
  async update(
    @Param('taskId') taskId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Headers('if-match') ifMatch: string,
    @Body() dto: UpdateTaskDto,
    @Res({ passthrough: true }) res: Response,
    @Headers('x-correlation-id') correlationId: string | undefined,
  ) {
    if (!ifMatch) {
      throw new ProblemException(
        HttpStatus.PRECONDITION_REQUIRED,
        'PRECONDITION_REQUIRED',
        'Precondition required',
        'If-Match is required.',
      );
    }
    if (!/^"\d+"$/.test(ifMatch)) {
      throw new ProblemException(
        HttpStatus.BAD_REQUEST,
        'INVALID_IF_MATCH',
        'Invalid If-Match',
        'If-Match must be a single strong ETag such as "7".',
      );
    }
    const hasFields =
      dto.title !== undefined ||
      dto.description !== undefined ||
      dto.assigneeIds !== undefined ||
      dto.dueDate !== undefined;
    if (!hasFields) {
      throw new ProblemException(
        HttpStatus.BAD_REQUEST,
        'VALIDATION_ERROR',
        'Validation error',
        'At least one task field must be provided.',
      );
    }
    const task = await this.tasks.update(
      taskId,
      user.sub,
      dto,
      ifMatch,
      correlationId ?? randomUUID(),
    );
    res.setHeader('ETag', `"${task.version}"`);
    return task;
  }

  @Patch(':taskId/position')
  async move(
    @Param('taskId') taskId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Headers('if-match') ifMatch: string,
    @Body() dto: MoveTaskDto,
    @Res({ passthrough: true }) res: Response,
    @Headers('x-correlation-id') correlationId: string | undefined,
  ) {
    if (!ifMatch) {
      throw new ProblemException(
        HttpStatus.PRECONDITION_REQUIRED,
        'PRECONDITION_REQUIRED',
        'Precondition required',
        'If-Match is required.',
      );
    }
    if (!/^"\d+"$/.test(ifMatch)) {
      throw new ProblemException(
        HttpStatus.BAD_REQUEST,
        'INVALID_IF_MATCH',
        'Invalid If-Match',
        'If-Match must be a single strong ETag such as "7".',
      );
    }
    const task = await this.tasks.move(taskId, user.sub, dto.columnId, ifMatch, correlationId ?? randomUUID());
    res.setHeader('ETag', `"${task.version}"`);
    return task;
  }
}
