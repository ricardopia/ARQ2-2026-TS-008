import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { ObservabilityModule } from '../observability/observability.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { BoardsController } from './boards.controller';
import { BoardsService, REDIS_CLIENT } from './boards.service';
import { BoardSummaryController } from './board-summary.controller';
import { AddBoardMemberController } from './add-board-member.controller';
import { InternalBoardAccessController } from './internal-board-access.controller';

@Module({
  imports: [WorkspacesModule, ObservabilityModule],
  controllers: [BoardsController, BoardSummaryController, AddBoardMemberController, InternalBoardAccessController],
  providers: [
    BoardsService,
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const redis = new Redis(
          config.get<string>('REDIS_URL') ?? 'redis://localhost:6379',
          {
            // Fail fast so a down Redis falls back to PostgreSQL (FR-2.2 edge case)
            // instead of queueing commands for seconds.
            maxRetriesPerRequest: 1,
            enableOfflineQueue: false,
            connectTimeout: 2000,
            retryStrategy: (times) => Math.min(times * 200, 2000),
          },
        );
        // Without a listener a connection error can take the whole process down.
        redis.on('error', () => undefined);
        return redis;
      },
    },
  ],
  exports: [BoardsService],
})
export class BoardsModule {}
