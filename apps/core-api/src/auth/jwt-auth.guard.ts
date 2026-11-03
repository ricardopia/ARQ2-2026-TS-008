import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { ProblemException } from '../common/problem';
import type { AccessTokenClaims } from './auth.service';
import { bearerToken } from './bearer-token';
import { IS_PUBLIC_KEY } from './public.decorator';

export type AuthenticatedRequest = Request & {
  user?: AccessTokenClaims;
};

/**
 * Global guard implementing FR-1.1 inside Core API: every endpoint requires a
 * valid, unexpired bearer token except the ones marked with `@Public()`.
 * Roles are deliberately absent from the token (spec section 3.1).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = bearerToken(request.headers.authorization);

    if (!token) {
      throw new ProblemException(
        HttpStatus.UNAUTHORIZED,
        'UNAUTHENTICATED',
        'Unauthenticated',
        'A valid access token is required.',
      );
    }

    try {
      request.user = await this.jwt.verifyAsync<AccessTokenClaims>(token);
      return true;
    } catch {
      throw new ProblemException(
        HttpStatus.UNAUTHORIZED,
        'UNAUTHENTICATED',
        'Unauthenticated',
        'The access token is invalid or expired.',
      );
    }
  }
}
