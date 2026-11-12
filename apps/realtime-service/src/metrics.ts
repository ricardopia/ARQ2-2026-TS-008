import type { ServerResponse } from 'node:http';
import { Counter, Gauge, Histogram, collectDefaultMetrics, register } from '@prometheus-io/client';

collectDefaultMetrics();

export const connectionsOpen = new Gauge({
  name: 'realtime_ws_connections',
  help: 'Currently open WebSocket connections',
});

export const connectionsTotal = new Counter({
  name: 'realtime_ws_connections_total',
  help: 'WebSocket connections by outcome (accepted, rejected, error)',
  labelNames: ['outcome'],
});

export const subscriptionsOpen = new Gauge({
  name: 'realtime_board_subscriptions',
  help: 'Active board subscriptions across all sockets',
});

export const subscribeTotal = new Counter({
  name: 'realtime_subscribe_total',
  help: 'subscribe requests by result (subscribed, forbidden, invalid, unavailable)',
  labelNames: ['result'],
});

export const eventsConsumed = new Counter({
  name: 'realtime_events_consumed_total',
  help: 'Domain events received from RabbitMQ by outcome (delivered, duplicate, invalid)',
  labelNames: ['outcome'],
});

export const eventsPushed = new Counter({
  name: 'realtime_events_pushed_total',
  help: 'Event frames pushed to sockets',
});

export const deliveryLatency = new Histogram({
  name: 'realtime_event_delivery_seconds',
  help: 'Commit-to-socket latency (occurredAt to push), NFR-3',
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
});

export const accessCheckDuration = new Histogram({
  name: 'realtime_access_check_duration_seconds',
  help: 'Duration of the board-access check against Core API',
  buckets: [0.005, 0.025, 0.1, 0.25, 1, 5],
});

export const brokerConnected = new Gauge({
  name: 'realtime_broker_connected',
  help: '1 while the RabbitMQ consumer is connected',
});


/** Handles GET /metrics and /health on the shared HTTP server. */
export async function serveMetrics(res: ServerResponse): Promise<void> {
  try {
    res.setHeader('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (err) {
    res.statusCode = 500;
    res.end(String(err));
  }
}

