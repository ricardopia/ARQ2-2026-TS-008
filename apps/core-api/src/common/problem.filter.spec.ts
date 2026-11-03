import { ArgumentsHost, UnauthorizedException } from '@nestjs/common';
import { ProblemFilter } from './problem.filter';
import { ProblemException } from './problem';

type FakeResponse = {
  status: jest.Mock;
  header: jest.Mock;
  json: jest.Mock;
  statusCode?: number;
  headers?: Record<string, string>;
  body?: unknown;
};

function run(
  exception: unknown,
  headers: Record<string, string> = {},
): { problem: Record<string, unknown>; response: FakeResponse } {
  const response: FakeResponse = {
    status: jest.fn(function (this: FakeResponse, code: number) {
      this.statusCode = code;
      return this;
    }),
    header: jest.fn(function (
      this: FakeResponse,
      name: string,
      value: string,
    ) {
      this.headers = { ...(this.headers ?? {}), [name]: value };
      return this;
    }),
    json: jest.fn(function (this: FakeResponse, body: unknown) {
      this.body = body;
      return this;
    }),
  };

  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({ headers, url: '/api/v1/auth/login' }),
    }),
  } as unknown as ArgumentsHost;

  new ProblemFilter().catch(exception, host);
  return { problem: response.body as Record<string, unknown>, response };
}

describe('ProblemFilter', () => {
  it('maps a ProblemException to its exact code and RFC 9457 shape', () => {
    const { problem, response } = run(
      new ProblemException(
        401,
        'INVALID_CREDENTIALS',
        'Invalid credentials',
        'The email or password is incorrect.',
      ),
    );

    expect(response.statusCode).toBe(401);
    expect(response.headers?.['Content-Type']).toBe('application/problem+json');
    expect(problem).toMatchObject({
      type: '/problems/invalid-credentials',
      title: 'Invalid credentials',
      status: 401,
      code: 'INVALID_CREDENTIALS',
      detail: 'The email or password is incorrect.',
      instance: '/api/v1/auth/login',
    });
    expect(problem.correlationId).toEqual(expect.any(String));
  });

  it('maps a plain 401 to UNAUTHENTICATED, not INTERNAL_ERROR', () => {
    const { problem, response } = run(new UnauthorizedException());

    expect(response.statusCode).toBe(401);
    expect(problem.code).toBe('UNAUTHENTICATED');
    expect(problem.status).toBe(401);
  });

  it('echoes the gateway correlation id when present', () => {
    const { response } = run(new UnauthorizedException(), {
      'x-correlation-id': 'c0ffee00-0000-4000-8000-000000000002',
    });

    expect(response.headers?.['X-Correlation-Id']).toBe(
      'c0ffee00-0000-4000-8000-000000000002',
    );
  });

  it('falls back to 500 INTERNAL_ERROR for unknown errors', () => {
    const { problem, response } = run(new Error('boom'));

    expect(response.statusCode).toBe(500);
    expect(problem.code).toBe('INTERNAL_ERROR');
  });
});
