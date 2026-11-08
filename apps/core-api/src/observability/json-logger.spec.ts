import { JsonLogger } from './json-logger';

describe('JsonLogger', () => {
  let logger: JsonLogger;
  let writeMock: jest.SpyInstance;

  beforeEach(() => {
    logger = new JsonLogger('auth');
    writeMock = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    writeMock.mockRestore();
  });

  it('writes one JSON line per log entry', () => {
    logger.log('hello world', 'auth');

    expect(writeMock).toHaveBeenCalledTimes(1);
    const line = JSON.parse(writeMock.mock.calls[0][0] as string);
    expect(line).toEqual({
      timestamp: expect.any(String),
      level: 'log',
      context: 'auth',
      message: 'hello world',
    });
  });

  it('carries the correlation id when it is set', () => {
    logger.setCorrelationId('c0ffee00-0000-4000-8000-000000000002');
    logger.warn('careful');

    const line = JSON.parse(writeMock.mock.calls[0][0] as string);
    expect(line.level).toBe('warn');
    expect(line.correlationId).toBe('c0ffee00-0000-4000-8000-000000000002');

    logger.clearCorrelationId();
  });

  it('writes error entries with the stack', () => {
    logger.error({ message: 'boom' }, 'stack-trace', 'auth');

    const line = JSON.parse(writeMock.mock.calls[0][0] as string);
    expect(line.level).toBe('error');
    expect(line.context).toBe('auth');
    expect(line.message).toBe(JSON.stringify({ message: 'boom', stack: 'stack-trace' }));
  });
});
