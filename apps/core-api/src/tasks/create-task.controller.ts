import { Body, Controller, Headers, HttpCode, HttpStatus, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser, type AccessTokenClaims } from '../auth';
import { ProblemException } from '../common/problem';
import { TasksService } from './tasks.service';
import { CreateTaskDto } from './dto/create-task.dto';

@Controller('boards')
export class CreateTaskController {
  constructor(private readonly tasks: TasksService) {}

  @Post(':boardId/tasks')
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Param('boardId') boardId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Body() dto: CreateTaskDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const task = await this.tasks.create(boardId, user.sub, dto);
    res.setHeader('ETag', '"1"');
    return task;
  }
}
