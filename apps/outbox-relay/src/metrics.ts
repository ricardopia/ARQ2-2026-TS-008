import { createServer } from 'node:http';
import { Counter, Gauge, Histogram, collectDefaultMetrics, register } from '@prometheus-io/client';

collectDefaultMetrics();

export const publishedTotal = new Counter({
  name: 'outbox_relay_published_total',
  help: 'Events published to RabbitMQ and confirmed by the broker',
});

export const cycleFailuresTotal = new Counter({
  name: 'outbox_relay_cycle_failures_total',
  help: 'Relay cycles that ended in an error and triggered a backoff',
});

export const pendingRows = new Gauge({
  name: 'outbox_relay_pending_rows',
  help: 'Outbox rows not yet published',
});

export const cycleDuration = new Histogram({
  name: 'outbox_relay_cycle_duration_seconds',
  help: 'Duration of a relay cycle (poll, publish, mark)',
  buckets: [0.01, 0.05, 0.25, 1, 5],
});

export function startMetricsServer(port: number): void {
  createServer(async (req, res) => {
    if (req.url !== '/metrics') {
      res.statusCode = 404;
      res.end();
      return;
    }
    try {
      res.setHeader('Content-Type', register.contentType);
      res.end(await register.metrics());
    } catch (err) {
      res.statusCode = 500;
      res.end(String(err));
    }
  }).listen(port, '0.0.0.0');
}
