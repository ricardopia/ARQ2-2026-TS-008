import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AccessTokenClaims } from './auth.service';
import type { AuthenticatedRequest } from './jwt-auth.guard';

/** Injects the verified JWT claims (`sub`, `email`, `iat`, `exp`). */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AccessTokenClaims | undefined =>
    context.switchToHttp().getRequest<AuthenticatedRequest>().user,
);
