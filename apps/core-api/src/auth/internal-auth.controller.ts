import {
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { ProblemException } from '../common/problem';
import { bearerToken } from './bearer-token';
import { Public } from './public.decorator';
import { unauthenticated } from './jwt-auth.guard';
import { timingSafeEqual } from 'node:crypto';

/**
 * Internal endpoints called by other containers, never routed by the API
 * Gateway (spec section 3.5 and NFR-5). They authenticate with the shared
 * `X-Internal-Token` secret instead of a user access token.
 *
 * `GET /internal/auth/introspect` is what the gateway's `auth_request`
 * subrequest calls: 204 means "this Bearer token is valid", 401 means it is
 * missing, malformed, invalid or expired.
 */
@Public()
@Controller('internal/auth')
export class InternalAuthController {
  private readonly internalToken: string;

  constructor(
    config: ConfigService,
    private readonly jwt: JwtService,
  ) {
    this.internalToken = config.getOrThrow<string>('INTERNAL_TOKEN');
  }

  @Get('introspect')
  @HttpCode(HttpStatus.NO_CONTENT)
  introspect(
    @Headers('x-internal-token') presentedToken: string | undefined,
    @Headers('authorization') authorization: string | undefined,
  ): void {
    // Do not reveal the endpoint to callers without the shared secret. The
    // compare is constant-time (same length first) to avoid leaking bytes.
    if (
      !presentedToken ||
      !timingSafeEqualStr(presentedToken, this.internalToken)
    ) {
      throw new ProblemException(
        HttpStatus.NOT_FOUND,
        'NOT_FOUND',
        'Not found',
        'The requested resource does not exist.',
      );
    }

    const token = bearerToken(authorization);
    if (!token) {
      throw unauthenticated('A valid access token is required.');
    }

    try {
      this.jwt.verify(token);
    } catch {
      throw unauthenticated('The access token is invalid or expired.');
    }
  }
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
