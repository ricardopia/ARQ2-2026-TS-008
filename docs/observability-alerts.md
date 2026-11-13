# Alerts and dashboards (NFR-6)

Alert rules live in `infrastructure/prometheus/alerts.yml` and are evaluated by
Prometheus. They are listed at http://localhost:9090/alerts. Dashboards are
provisioned from `infrastructure/grafana/provisioning/dashboards/` into the
*TaskMaster* folder in Grafana (http://localhost:3000).

## Alert rules

| Alert | Fires when | Severity | Spec |
|---|---|---|---|
| `DeadLetterQueueNotEmpty` | Any queue whose name contains `dlq` has messages for 1 min | critical | NFR-6 |
| `OutboxBacklog` | `outbox_relay_pending_rows` does not reach 0 in 2 min | critical | F5 |
| `OutboxRelayFailing` | Relay cycles keep ending in errors for 2 min | warning | F5 |
| `RealtimeBrokerDisconnected` | The Realtime Service lost its RabbitMQ consumer for 1 min | critical | F5 |
| `NotificationLatencyHigh` | Commit-to-socket delivery p95 is above 2 s for 5 min | warning | NFR-3 |
| `FileWorkerFailureRatioHigh` | More than 20% of processed file jobs end in FAILED for 10 min | warning | F4 |
| `ServiceDown` | Core API, relay, worker or realtime cannot be scraped for 1 min | critical | NFR-6 |
| `CoreApiHigh5xxRate` | More than 5% of Core API responses are 5xx for 5 min | warning | NFR-6 |
| `CoreApiLatencyHigh` | Core API p95 latency is above 1 s for 5 min | warning | NFR-1 |

The dead-letter alert matches queue names with `.*dlq.*`; when the File Worker
DLQ is created, its name must contain `dlq` (for example
`file-processing.dlq`).

## Dashboards

| Dashboard | Shows |
|---|---|
| TaskMaster - Health and alerts | `up` of the four services, DLQ size, outbox backlog, realtime p95, firing alerts, Core API errors and latency |
| TaskMaster - Outbox Relay | Pending rows, published per second, failed cycles, cycle duration, memory, firing alerts |
| TaskMaster - File Worker | Jobs received, processed and failed, failure ratio, queue depth, DLQ, memory, firing alerts |
| TaskMaster - Realtime Service | (existing) connections, subscriptions, events, delivery p95 |
| TaskMaster - Core API | (existing) request rate, errors, latency |

## Not included

- Alertmanager. Alerts are visible in Prometheus and in the *Firing alerts*
  tables of the dashboards; routing them to email or chat needs Alertmanager.
- RabbitMQ metrics need the `rabbitmq_prometheus` plugin (port 15692). Check
  http://localhost:9090/targets: the `rabbitmq` and `rabbitmq-queues` jobs must
  be UP.
