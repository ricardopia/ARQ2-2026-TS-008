# TaskMaster — API and Contract Specification

> Contract specification for **Case 8: TaskMaster — Enterprise Kanban (Concurrency)**.
> Wave 2 source code is reviewed against this file. Contract changes are made here first, through a pull request that bumps the version and updates [§11 Change history](#11-change-history).

| | |
|---|---|
| **Team** | TS-008 |
| **Case** | Case 8: TaskMaster — Enterprise Kanban (Concurrency) |
| **Status** | Draft |
| **Version** | 0.1.0 |
| **Last updated** | 2026-10-13 |
| **Related documents** | [ADR 001](adrs/001-optimistic-concurrency-control.md) · [ADR 002](adrs/002-presigned-uploads-async-workers.md) · [ADR 003](adrs/003-transactional-outbox-realtime-notifications.md) · [C4 container diagram](assets/c4-container-diagram.png) |

The key words **MUST**, **MUST NOT**, **SHALL**, **SHALL NOT**, **SHOULD** and **MAY** are to be interpreted as described in RFC 2119.

## Contents

1. [Overview](#1-overview)
2. [Domain data schemas](#2-domain-data-schemas)
3. [REST API](#3-rest-api)
4. [Asynchronous events and integration contracts](#4-asynchronous-events-and-integration-contracts)
5. [Requirements and scenarios](#5-requirements-and-scenarios)
6. [Non-functional requirements](#6-non-functional-requirements)
7. [Edge cases and failure handling](#7-edge-cases-and-failure-handling)
8. [Constraints, assumptions and dependencies](#8-constraints-assumptions-and-dependencies)
9. [Open questions](#9-open-questions)
10. [Glossary](#10-glossary)
11. [Change history](#11-change-history)

---

## 1. Overview

### 1.1 Purpose

TaskMaster provides Trello-style Kanban boards for enterprise teams. This document is the single source of truth for the system's contracts: domain data schemas, REST endpoints, the WebSocket protocol, asynchronous events, and the verifiable requirements for the five mandatory features. Behavior not described here is out of scope for this version.

### 1.2 Problem statement

Two production failures motivate this design:

1. **Lost update.** Developer A and Manager B open the same task. A edits the technical description and saves. Two seconds later B moves the task from *To Do* to *In Progress*. B's client sends the full payload it loaded earlier, so A's description is silently overwritten.
2. **Upload memory exhaustion.** A user attaches a 150 MB design file to a card. The Node.js API buffers the whole stream in memory, fills the RAM and disconnects teammates who only wanted to read tasks.

The architecture removes both failures at the root:

- Task writes are partial, intent-based and conditional on the version the client last saw (Optimistic Concurrency Control, [ADR 001](adrs/001-optimistic-concurrency-control.md)).
- File bytes never reach the API: the browser uploads directly to object storage with a pre-signed URL and a worker processes the file asynchronously ([ADR 002](adrs/002-presigned-uploads-async-workers.md)).
- Board changes reach connected users through a transactional outbox, RabbitMQ and WebSockets, without coupling the write to the delivery ([ADR 003](adrs/003-transactional-outbox-realtime-notifications.md)).

### 1.3 Goals and non-goals

**Goals (in scope for this version)**

| # | Goal | Feature |
|---|---|---|
| G1 | Workspaces, workspace roles and per-board permissions are enforced on every request and every real-time subscription. | F1 |
| G2 | The board summary is returned without loading heavy task fields and is served from a cache. | F2 |
| G3 | No silent overwrites: every task write is conditional on the version the client last saw. | F3 |
| G4 | Files up to 250 MiB are uploaded directly to object storage and processed by workers; API memory does not depend on file size. | F4 |
| G5 | Users viewing a board receive web notifications of its modifications within seconds, and no event is lost. | F5 |

**Non-goals (explicitly out of scope)**

- Real-time co-editing of the same field (CRDT/OT), presence indicators or cursors.
- Automatic merge of concurrent changes to disjoint fields (deferred by ADR 001).
- Pessimistic locks or "being edited by" locks.
- Email, mobile push or desktop notifications; notification inbox or history.
- Comments, checklists, mentions, search, activity feed, task revision history or undo.
- Email invitations, SSO/SAML, MFA and password reset.
- Resumable or multipart uploads, files larger than 250 MiB, file versioning, previews for non-image formats, antivirus scanning (see [§9](#9-open-questions)).
- Archiving or deleting boards and workspaces, restoring archived tasks, board templates.
- Optimistic concurrency on boards and columns (they use field-level `PATCH`; see [§9](#9-open-questions)).
- Native mobile apps and offline mode.

### 1.4 Users and main use cases

| Persona | Typical role | Main use cases |
|---|---|---|
| Workspace administrator | Workspace `OWNER` or `ADMIN` | Create a workspace, add members, assign roles, create boards. |
| Manager | Board `ADMIN` or `EDITOR` | Configure columns, manage board members, move cards through the workflow. |
| Developer / designer | Board `EDITOR` | Edit task details, attach design files, follow board changes live. |
| Stakeholder | Board `VIEWER` | Read boards and tasks, download attachments. |

Main flows:

- **UC-1** Set up a workspace and a board, and grant access to the team.
- **UC-2** Open a board (summary) and receive live updates.
- **UC-3** Edit a task while other users edit or move it.
- **UC-4** Move a card between columns.
- **UC-5** Attach a large design file to a card.
- **UC-6** Revoke a user's access.

### 1.5 Services and responsibilities

Current C4 container diagram (Level 2):

![C4 container diagram](assets/c4-container-diagram.png)

Runtime view required by this specification (adds the API Gateway, Redis, `realtime` and `outbox-relay`, which are not yet drawn in the C4 diagram; see [§9](#9-open-questions)):

```mermaid
flowchart LR
    user([Developer / Manager]) --> web[web<br/>React SPA]
    web -->|HTTPS + WSS| gw[gateway]
    web -->|pre-signed POST and GET| s3[(object storage)]
    gw -->|"/api/v1"| api[core-api x2]
    gw -->|"/ws"| rt[realtime]
    api --> pg[(PostgreSQL)]
    api --> redis[(Redis)]
    api -->|sign URLs, HeadObject| s3
    relay[outbox-relay] -->|read pending rows| pg
    relay -->|publish| mq[[RabbitMQ]]
    mq -->|domain events| rt
    mq -->|domain events| api
    mq -->|file jobs| fw[file-worker]
    fw --> pg
    fw -->|stream object, write preview| s3
    rt -->|access check| api
    rt -->|consume tickets| redis
```

| Service (Compose name) | C4 container | Technology | Responsibility |
|---|---|---|---|
| `web` | Web Application | React SPA | Kanban UI. Sends intent-based writes with `If-Match`, resolves `412` conflicts, uploads files directly to object storage, holds the WebSocket connection. |
| `gateway` | *Not yet in the diagram* | Open-source API Gateway | Single entry point: TLS termination, routing, JWT validation, rate limiting, 1 MiB request-body limit, CORS, `X-Correlation-Id` injection, WebSocket proxying. |
| `core-api` | API Application | Node.js | Identity and access, workspaces, boards, columns, tasks with OCC, board summary (cache-aside on Redis), attachment metadata and pre-signed URLs. Writes outbox events and invalidates the summary cache. Stateless; at least 2 replicas. |
| `outbox-relay` | API Application (separate process) | Node.js | Publishes `outbox_events` rows to RabbitMQ with publisher confirms and marks them as published. |
| `realtime` | Notification module of the API Application (ADR 003), deployed separately | Node.js, WebSocket | Authenticates WebSocket connections, authorizes board subscriptions, consumes domain events and pushes them to authorized subscribers. |
| `file-worker` | Background Worker | Node.js | Consumes file-processing jobs, validates files, generates previews, updates attachment status, runs the upload cleanup. |
| `postgres` | Database | PostgreSQL | Source of truth: users, memberships, roles, boards, columns, tasks and their versions, attachment metadata, outbox. |
| `redis` | *Not yet in the diagram* | Redis | Board-summary cache and WebSocket tickets. Never a source of truth. |
| `rabbitmq` | Message Broker | RabbitMQ | Domain-event fan-out and file-processing job queue with retry and dead-letter queues. |
| `object-storage` | Object Storage | AWS S3 (MinIO in Docker Compose) | Original files and previews in a private bucket, accessed only through pre-signed URLs. |

Observability containers (Prometheus, Loki, Grafana; optionally Tempo or Jaeger) are described in [NFR-9](#6-non-functional-requirements).

### 1.6 Feature traceability

| Mandatory feature | Requirements | Endpoints | Events | ADR |
|---|---|---|---|---|
| **F1** Roles, workspaces and board permissions | FR-1.1 – FR-1.5 | [§3.3](#33-identity) – [§3.5](#35-boards) | `board.member.changed`, `workspace.member.changed` | — |
| **F2** Optimized board summary | FR-2.1 – FR-2.5 | `GET /boards/{boardId}/summary`, `GET /columns/{columnId}/tasks` | All board events (cache invalidation) | Pending (see [§9](#9-open-questions)) |
| **F3** Optimistic concurrency control | FR-3.1 – FR-3.6 | [§3.7](#37-tasks) | `task.*` (carry `aggregate.version`) | ADR 001 |
| **F4** Asynchronous heavy uploads | FR-4.1 – FR-4.7 | [§3.8](#38-attachments) | `attachment.process` job, `attachment.processed` | ADR 002 |
| **F5** Web notifications of board changes | FR-5.1 – FR-5.6 | [§3.9](#39-realtime) | All domain events | ADR 003 |

---
