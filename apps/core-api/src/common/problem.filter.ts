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
    const detail = httpDetail(exception);
    const code =
      status === HttpStatus.BAD_REQUEST ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR';
    const title =
      status === HttpStatus.BAD_REQUEST ? 'Validation error' : 'Internal error';
    return {
      type: `/problems/${kebab(code)}`,
      title,
      status,
      code,
      detail,
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
