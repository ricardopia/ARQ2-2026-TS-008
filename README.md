# ARQ2-2026-TS-008: TaskMaster - Enterprise Kanban (Concurrency)

Software Architecture II Project.

## Tech Spec

The Tech Spec lives in Google Docs: [TS-008](https://docs.google.com/document/d/1x4D07ZjyBjJd6-q3bA780azbjiEzw3IoVFvbBrKYE9M/edit?tab=t.0#heading=h.ygtqk5qb2y2w)

## Team

- Ricardo Andres Amaya
- Samuel Arango Montoya
- Tomas Correa Zea
- Johann Restrepo Hernandez
- Kevin Restrepo Hernandez

## Case Summary

TaskMaster is a Trello-style Kanban platform for enterprise teams. This project
addresses two problems: silent "Lost Update" overwrites when several users edit the
same task, and API memory exhaustion caused by large file uploads (~150 MB).

## Repository Structure

    docs/
    ├── spec.md      API and event contract specification (OpenSpec)
    ├── adrs/        Architecture Decision Records
    └── assets/      C4 diagrams

## Documentation

- [Contract specification (spec.md)](docs/spec.md)
- [ADR 001: Optimistic Concurrency Control with Task Versioning](docs/adrs/001-optimistic-concurrency-control.md)
- [ADR 002: Direct-to-Storage Uploads with Pre-signed URLs and Asynchronous Workers](docs/adrs/002-presigned-uploads-async-workers.md)
- [ADR 003: Transactional Outbox with RabbitMQ and WebSockets for Real-Time Notifications](docs/adrs/003-transactional-outbox-realtime-notifications.md)
- [C4 Container Diagram](docs/assets/C4-TaskManager.png)
