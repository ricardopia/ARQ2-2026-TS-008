import { shutdownTracing } from './tracing.js';

import { SpanStatusCode, trace } from '@opentelemetry/api';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { createAccessChecker } from './access.js';
import { dispatchEvent, SeenEvents } from './events.js';
import { Hub, type HubClient } from './hub.js';
import { log } from './log.js';
import {
  connectionsOpen,
  connectionsTotal,
  deliveryLatency,
  eventsConsumed,
  eventsPushed,
  serveMetrics,
  subscribeTotal,
  subscriptionsOpen,
} from './metrics.js';
import { startConsumer } from './rabbit.js';
import { handleClientMessage } from './session.js';
import { createTicketStore } from './tickets.js';

const CLOSE_UNAUTHENTICATED = 4401;
const CLOSE_INTERNAL = 1011;

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    log({ level: 'fatal', msg: `${name} is required` });
    process.exit(1);
  }
  return value;
}

const config = {
  port: Number(process.env.PORT ?? 8083),
  redisUrl: required('REDIS_URL'),
  rabbitUrl: required('RABBITMQ_URL'),
  coreApiUrl: process.env.CORE_API_URL ?? 'http://core-api:8080',
  internalToken: required('INTERNAL_TOKEN'),
  instanceId: process.env.INSTANCE_ID ?? randomUUID(),
  heartbeatMs: Number(process.env.HEARTBEAT_INTERVAL_MS ?? 30_000),
};

const tracer = trace.getTracer('realtime-service');
const hub = new Hub();
const seen = new SeenEvents();
const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 1 });
redis.on('error', (err) => log({ level: 'error', msg: 'redis error', error: err.message }));
const consumeTicket = createTicketStore(redis);
const checkAccess = createAccessChecker(config.coreApiUrl, config.internalToken);

const server = createServer((req, res) => {
  const path = (req.url ?? '').split('?')[0];
  if (path === '/metrics') {
    void serveMetrics(res);
  } else if (path === '/health') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'healthy' }));
  } else {
    res.statusCode = 404;
    res.end();
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '', 'http://localhost');
  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }
  const correlationId = String(req.headers['x-correlation-id'] ?? randomUUID());

  // The ticket is consumed before the upgrade completes; a bad one still gets a
  // WebSocket handshake so the client can read close code 4401 (spec 3.5).
  consumeTicket(url.searchParams.get('ticket') ?? '')
    .then((userId) => ({ userId, failed: false }))
    .catch((err: Error) => {
      log({ level: 'error', msg: 'ticket lookup failed', correlationId, error: err.message });
      return { userId: null, failed: true };
    })
    .then(({ userId, failed }) => {
      wss.handleUpgrade(req, socket, head, (ws) => {
        if (!userId) {
          connectionsTotal.inc({ outcome: failed ? 'error' : 'rejected' });
          log({ msg: 'connection rejected', correlationId, reason: failed ? 'ticket store unavailable' : 'invalid ticket' });
          ws.close(failed ? CLOSE_INTERNAL : CLOSE_UNAUTHENTICATED);
          return;
        }
        onConnection(ws, userId, correlationId);
      });
    });
});

function onConnection(ws: WebSocket, userId: string, correlationId: string): void {
  const client: HubClient = {
    id: randomUUID(),
    userId,
    send: (frame) => ws.send(frame),
  };
  let alive = true;
  connectionsTotal.inc({ outcome: 'accepted' });
  connectionsOpen.inc();
  log({ msg: 'connection opened', correlationId, connectionId: client.id, userId });

  ws.on('pong', () => {
    alive = true;
  });
  const heartbeat = setInterval(() => {
    if (!alive) {
      ws.terminate();
      return;
    }
    alive = false;
    ws.ping();
  }, config.heartbeatMs);

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      ws.close(1008);
      return;
    }
    void handleClientMessage(client, data.toString(), {
      hub,
      checkAccess,
      onSubscribe: (result) => {
        subscribeTotal.inc({ result });
        log({ msg: 'subscribe', correlationId, connectionId: client.id, userId, result });
        if (result === 'subscribed') subscriptionsOpen.inc();
      },
    })
      .then((closeCode) => {
        if (closeCode !== undefined) ws.close(closeCode);
      })
      .catch((err: Error) => {
        log({ level: 'error', msg: 'message handler failed', correlationId, error: err.message });
        ws.close(CLOSE_INTERNAL);
      });
  });

  ws.on('close', () => {
    clearInterval(heartbeat);
    connectionsOpen.dec();
    subscriptionsOpen.dec(hub.remove(client));
    log({ msg: 'connection closed', correlationId, connectionId: client.id, userId });
  });
  ws.on('error', (err) => log({ level: 'error', msg: 'socket error', correlationId, error: err.message }));
}

const consumer = startConsumer(config.rabbitUrl, config.instanceId, (msg) => {
  const headerCorrelation = msg.properties.headers?.['x-correlation-id'];
  const span = tracer.startSpan('realtime.dispatch_event', {
    attributes: { 'messaging.message.id': msg.properties.messageId },
  });
  try {
    const result = dispatchEvent(msg.content, hub, seen);
    eventsConsumed.inc({ outcome: result.outcome });
    const correlationId = result.event?.correlationId ?? headerCorrelation;
    span.setAttribute('correlation.id', String(correlationId ?? ''));
    span.setAttribute('event.outcome', result.outcome);
    if (result.event) {
      span.setAttribute('event.type', result.event.eventType);
      span.setAttribute('board.id', result.event.boardId);
    }
    if (result.outcome === 'delivered') {
      eventsPushed.inc(result.recipients);
      if (result.recipients > 0) {
        deliveryLatency.observe(Math.max(0, Date.now() - Date.parse(result.event!.occurredAt)) / 1000);
      }
    }
    log({
      msg: 'event dispatched',
      correlationId,
      eventId: result.event?.eventId,
      eventType: result.event?.eventType,
      boardId: result.event?.boardId,
      outcome: result.outcome,
      recipients: result.recipients,
    });
  } catch (err) {
    span.setStatus({ code: SpanStatusCode.ERROR });
    log({ level: 'error', msg: 'event dispatch failed', error: err instanceof Error ? err.message : String(err) });
  } finally {
    span.end();
  }
});

server.listen(config.port, '0.0.0.0', () => log({ msg: 'realtime service listening', port: config.port, instanceId: config.instanceId }));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    for (const ws of wss.clients) ws.close(1001);
    server.close();
    void consumer
      .close()
      .then(() => redis.quit())
      .catch(() => undefined)
      .finally(() => shutdownTracing().finally(() => process.exit(0)));
  });
}
