import { Injectable } from '@nestjs/common';
import { Counter, Histogram, Registry } from 'prom-client';

/**
 * Prometheus metrics for the Core API (spec section 6, NFR-6): HTTP request
 * counter and latency histogram, labeled by method, route and status.
 */
@Injectable()
export class MetricsService {
  private readonly registry: Registry = new Registry();
  readonly httpRequests: Counter<string>;
  readonly httpRequestDuration: Histogram<string>;

  constructor() {
    this.httpRequests = new Counter({
      name: 'http_requests_total',
      help: 'Total number of HTTP requests handled by the API',
      labelNames: ['method', 'route', 'status'],
    });
    this.httpRequestDuration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request latency in seconds',
      labelNames: ['method', 'route', 'status'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    });
    this.registry.registerMetric(this.httpRequests);
    this.registry.registerMetric(this.httpRequestDuration);
  }

  getMetrics(): Promise<string> {
    return this.registry.metrics();
  }
}
