import { MetricsService } from './metrics.service';

describe('MetricsService', () => {
  it('exposes prometheus metrics for http requests', async () => {
    const service = new MetricsService();

    service.httpRequests.inc(
      { method: 'GET', route: '/boards/:boardId/summary', status: '200' },
      1,
    );
    service.httpRequestDuration.observe(
      { method: 'GET', route: '/boards/:boardId/summary', status: '200' },
      0.05,
    );

    const metrics = await service.getMetrics();
    expect(metrics).toContain('http_requests_total');
    expect(metrics).toContain('http_request_duration_seconds');
  });
});
