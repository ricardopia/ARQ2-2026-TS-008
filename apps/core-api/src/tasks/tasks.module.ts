import { Module } from '@nestjs/common';
import { BoardsModule } from '../boards/boards.module';
import { TasksController } from './tasks.controller';
import { CreateTaskController } from './create-task.controller';
import { TasksService } from './tasks.service';

@Module({
  imports: [BoardsModule],
  controllers: [TasksController, CreateTaskController],
  providers: [TasksService],
  exports: [TasksService],
})
export class TasksModule {}
