import { Module } from '@nestjs/common';
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

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        url: config.getOrThrow<string>('DATABASE_URL'),
        entities: [User, Workspace, WorkspaceMember],
        synchronize: false,
      }),
    }),
    UsersModule,
    AuthModule,
    WorkspacesModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
})
export class AppModule {}
