import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from './auth/auth.module';
import { AuthGuard } from './auth/jwt-auth.guard';
import { User } from './users/user.entity';
import { UsersModule } from './users/users.module';
import { WorkspaceMember } from './workspaces/workspace-member.entity';
import { Workspace } from './workspaces/workspace.entity';
import { WorkspacesModule } from './workspaces/workspaces.module';
import { Board } from './boards/board.entity';
import { BoardMember } from './boards/board-member.entity';
import { BoardColumn } from './boards/board-column.entity';
import { Task } from './tasks/task.entity';
import { Attachment } from './attachments/attachment.entity';
import { BoardsModule } from './boards/boards.module';
import { TasksModule } from './tasks/tasks.module';
import { RealtimeModule } from './realtime/realtime.module';
import { AttachmentsModule } from './attachments/attachments.module';
import { MetricsController } from './observability/metrics.controller';
import { MetricsService } from './observability/metrics.service';
import { ObservabilityMiddleware } from './observability/http-middleware';
import { JsonLogger } from './observability/json-logger';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        url: config.getOrThrow<string>('DATABASE_URL'),
        entities: [User, Workspace, WorkspaceMember, Board, BoardMember, BoardColumn, Task, Attachment],
        synchronize: false,
      }),
    }),
    UsersModule,
    AuthModule,
    WorkspacesModule,
    BoardsModule,
    TasksModule,
    RealtimeModule,
    AttachmentsModule,
  ],
  controllers: [MetricsController],
  providers: [
    MetricsService,
    { provide: JsonLogger, useFactory: () => new JsonLogger() },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(ObservabilityMiddleware).forRoutes('*');
  }
}
