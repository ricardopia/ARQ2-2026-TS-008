import { Module } from '@nestjs/common';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { BoardsController } from './boards.controller';
import { BoardsService } from './boards.service';
import { BoardSummaryController } from './board-summary.controller';

@Module({
  imports: [WorkspacesModule],
  controllers: [BoardsController, BoardSummaryController],
  providers: [BoardsService],
  exports: [BoardsService],
})
export class BoardsModule {}
