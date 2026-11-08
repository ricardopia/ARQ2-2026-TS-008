import { Module } from '@nestjs/common';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { BoardsController } from './boards.controller';
import { BoardsService } from './boards.service';
import { BoardSummaryController } from './board-summary.controller';
import { AddBoardMemberController } from './add-board-member.controller';
import { InternalBoardAccessController } from './internal-board-access.controller';

@Module({
  imports: [WorkspacesModule],
  controllers: [BoardsController, BoardSummaryController, AddBoardMemberController, InternalBoardAccessController],
  providers: [BoardsService],
  exports: [BoardsService],
})
export class BoardsModule {}
