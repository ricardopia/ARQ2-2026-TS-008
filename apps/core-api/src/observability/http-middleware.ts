import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { MetricsService } from './metrics.service';
import { JsonLogger } from './json-logger';

/**
 * Observability middleware (spec section 6, NFR-6): assigns the correlation
 * id, writes one JSON log line per request and records the request counter
 * and latency histogram.
 */
@Injectable()
export class ObservabilityMiddleware implements NestMiddleware {
  constructor(
    private readonly metrics: MetricsService,
    private readonly logger: JsonLogger,
  ) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const header = req.headers['x-correlation-id'];
    const correlationId =
      typeof header === 'string' && header.length > 0 ? header : randomUUID();
    res.setHeader('X-Correlation-Id', correlationId);
    this.logger.setCorrelationId(correlationId);

    const start = process.hrtime.bigint();

    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      const route = req.route?.path ?? req.path;
      const status = res.statusCode;

      this.metrics.httpRequests.inc(
        { method: req.method, route, status: String(status) },
        1,
      );
      this.metrics.httpRequestDuration.observe(
        { method: req.method, route, status: String(status) },
        durationMs / 1000,
      );

      this.logger.log(
        {
          message: `${req.method} ${req.originalUrl} ${status}`,
          method: req.method,
          path: req.path,
          status,
          durationMs,
        },
        'HTTP',
      );
      this.logger.clearCorrelationId();
    });

    next();
  }
}
