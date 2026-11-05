import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { UsersModule } from '../users/users.module';
import { ACCESS_TOKEN_TTL_SECONDS, AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { AuthGuard } from './jwt-auth.guard';
import { InternalAuthController } from './internal-auth.controller';

@Module({
  imports: [
    UsersModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: { expiresIn: ACCESS_TOKEN_TTL_SECONDS },
      }),
    }),
  ],
  controllers: [AuthController, InternalAuthController],
  providers: [AuthService, AuthGuard],
  exports: [JwtModule],
})
export class AuthModule {}
