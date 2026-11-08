import { LoggerService } from '@nestjs/common';

export type JsonLogEntry = {
  timestamp: string;
  level: string;
  context: string;
  message: string;
  correlationId?: string;
};

/**
 * JSON-lines logger (spec section 6, NFR-6): one JSON object per line on
 * stdout, ready for Loki ingestion.
 */
export class JsonLogger implements LoggerService {
  private readonly context: string;
  private correlationId?: string;

  constructor(context: string = 'app') {
    this.context = context;
  }

  setCorrelationId(correlationId?: string): void {
    this.correlationId = correlationId;
  }

  clearCorrelationId(): void {
    this.correlationId = undefined;
  }

  setLogLevels(levels: string[]): any {
    return levels;
  }

  log(message: any, ...optionalParams: any[]): any {
    this.write('log', message, this.contextFrom(optionalParams));
  }

  error(message: any, ...optionalParams: any[]): any {
    const stack = optionalParams[0];
    const text =
      typeof message === 'string'
        ? message
        : (message as { message?: string })?.message ?? String(message);
    this.write('error', { message: text, stack }, this.contextFrom(optionalParams));
  }

  warn(message: any, ...optionalParams: any[]): any {
    this.write('warn', message, this.contextFrom(optionalParams));
  }

  debug(message: any, ...optionalParams: any[]): any {
    this.write('debug', message, this.contextFrom(optionalParams));
  }

  verbose(message: any, ...optionalParams: any[]): any {
    this.write('verbose', message, this.contextFrom(optionalParams));
  }

  fatal(message: any, ...optionalParams: any[]): any {
    this.write('fatal', message, this.contextFrom(optionalParams));
  }

  private contextFrom(optionalParams: any[]): string {
    const last = optionalParams[optionalParams.length - 1];
    return typeof last === 'string' ? last : this.context;
  }

  private write(level: string, message: any, context: string): void {
    const entry: JsonLogEntry = {
      timestamp: new Date().toISOString(),
      level,
      context,
      message: typeof message === 'string' ? message : JSON.stringify(message),
    };
    if (this.correlationId) {
      entry.correlationId = this.correlationId;
    }
    process.stdout.write(`${JSON.stringify(entry)}\n`);
  }
}
