import { createServer } from 'node:http';
import { Counter, collectDefaultMetrics, register } from '@prometheus-io/client';

collectDefaultMetrics();

export const jobsReceived = new Counter({
  name: 'file_worker_jobs_received_total',
  help: 'File-processing jobs received from the queue',
});

export const jobsProcessed = new Counter({
  name: 'file_worker_jobs_processed_total',
  help: 'File-processing jobs that reached COMPLETED or FAILED',
});

export const jobsFailed = new Counter({
  name: 'file_worker_jobs_failed_total',
  help: 'File-processing jobs that failed after retries were exhausted or failed permanently',
});

export const jobsDlq = new Counter({
  name: 'file_worker_jobs_dlq_total',
  help: 'File-processing jobs moved to the dead-letter queue after every retry',
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
