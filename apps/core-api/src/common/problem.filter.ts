import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { ProblemBody, ProblemException } from './problem';

/** Fallback code per HTTP status for plain `HttpException`s. */
const STATUS_PROBLEMS: Record<number, { code: string; title: string }> = {
  400: { code: 'VALIDATION_ERROR', title: 'Validation error' },
  401: { code: 'UNAUTHENTICATED', title: 'Unauthenticated' },
  403: { code: 'FORBIDDEN', title: 'Forbidden' },
  404: { code: 'NOT_FOUND', title: 'Not found' },
  409: { code: 'CONFLICT', title: 'Conflict' },
  410: { code: 'GONE', title: 'Gone' },
  412: { code: 'VERSION_CONFLICT', title: 'Version conflict' },
  413: { code: 'PAYLOAD_TOO_LARGE', title: 'Payload too large' },
  428: { code: 'PRECONDITION_REQUIRED', title: 'Precondition required' },
  429: { code: 'RATE_LIMITED', title: 'Rate limited' },
  503: { code: 'SERVICE_UNAVAILABLE', title: 'Service unavailable' },
  504: { code: 'GATEWAY_TIMEOUT', title: 'Gateway timeout' },
};

@Catch()
export class ProblemFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const correlationId =
      headerValue(request.headers['x-correlation-id']) ?? randomUUID();

    const problem = toProblem(exception, request.url, correlationId);
    response
      .status(problem.status)
      .header('Content-Type', 'application/problem+json')
      .header('X-Correlation-Id', correlationId)
      .json(problem);
  }
}

function toProblem(
  exception: unknown,
  instance: string,
  correlationId: string,
): ProblemBody {
  if (exception instanceof ProblemException) {
    return {
      type: `/problems/${kebab(exception.code)}`,
      title: exception.title,
      status: exception.getStatus(),
      code: exception.code,
      detail: exception.detail,
      instance,
      correlationId,
    };
  }

  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const fallback = STATUS_PROBLEMS[status] ?? {
      code: 'INTERNAL_ERROR',
      title: 'Internal error',
    };
    return {
      type: `/problems/${kebab(fallback.code)}`,
      title: fallback.title,
      status,
      code: fallback.code,
      detail: httpDetail(exception),
      instance,
      correlationId,
    };
  }

  return {
    type: '/problems/internal-error',
    title: 'Internal error',
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    code: 'INTERNAL_ERROR',
    detail: 'An unexpected error occurred.',
    instance,
    correlationId,
  };
}

function httpDetail(exception: HttpException): string {
  const payload = exception.getResponse();
  if (typeof payload === 'string') {
    return payload;
  }
  if (typeof payload === 'object' && payload !== null && 'message' in payload) {
    const message = (payload as { message: string | string[] }).message;
    return Array.isArray(message) ? message.join('; ') : message;
  }
  return exception.message;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function kebab(code: string): string {
  return code.toLowerCase().replaceAll('_', '-');
}
