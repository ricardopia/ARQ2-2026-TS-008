# Guía de observabilidad: ver por debajo lo que pasa en cada feature

Cada clic de la app genera peticiones, consultas, mensajes y métricas. Esta guía dice **dónde mirar
y qué verás** en cada herramienta, feature por feature. Todo se probó contra el stack de
`docker compose`.

## 1. Mapa de herramientas

| Herramienta | Dirección | Credenciales | Para qué sirve |
|---|---|---|---|
| **TaskMaster Web** (panel *Evidencias*) | http://localhost:8080 | — | Cada petición HTTP con `If-Match`, `ETag` y `X-Correlation-Id`; eventos del WebSocket |
| **Grafana** | http://localhost:3000 | usuario `admin-taskmaster`, clave `GRAFANA_PASSWORD` del `.env` | Dashboards, y *Explore* para Loki, Jaeger y Prometheus |
| **Jaeger** | http://localhost:16686 | — | Trazas: el recorrido de una petición por servicios y consultas SQL |
| **Prometheus** | http://localhost:9090 | — | Métricas y alertas (`/alerts`) |
| **Loki** (desde Grafana) | Grafana → Explore → *Loki* | — | Logs de todos los contenedores |
| **RabbitMQ** | http://localhost:15672 | usuario `rabbit-taskmaster`, clave `RABBITMQ_PASSWORD` del `.env` | Exchanges, colas, consumidores, mensajes y DLQ |
| **RustFS** (S3) | http://localhost:9001 | `RUSTFS_ACCESS_KEY` / `RUSTFS_SECRET_KEY` del `.env` | Los archivos subidos (bucket `taskmaster-attachments`) |
| **Redis** | terminal (`docker exec`) | — | Caché del resumen y tickets del WebSocket |
| **PostgreSQL** | terminal (`docker exec`) | — | Fuente de verdad: tareas, versiones, outbox, adjuntos |

Comandos de terminal que se usan en la guía (copia y pega):

```bash
# Redis
docker exec taskmaster-redis redis-cli --scan --pattern "board-summary:*"
# PostgreSQL
docker exec taskmaster-postgres psql -U taskmaster -d taskmaster -c "<consulta SQL>"
```

## 2. Receta general: seguir UNA acción por todas las herramientas

El gateway le pone a cada petición un **`X-Correlation-Id`** y ese identificador viaja por el API,
el outbox, RabbitMQ y el realtime. Con él se sigue una acción de punta a punta.

1. **Haz la acción en la app** (por ejemplo, mover una tarjeta).
2. **Abre el panel *Evidencias*** (barra inferior) → pestaña *HTTP*. Despliega la petición
   `PATCH /tasks/…/position` y copia el valor de **`X-Correlation-Id`**.
3. **Loki (los logs de todos los servicios con ese id).** Grafana → *Explore* → datasource **Loki** →

   ```logql
   {app="taskmaster"} |= "PEGA_AQUI_EL_CORRELATION_ID"
   ```

   Verás las líneas del `api-gateway`, `core-api` y `realtime-service` (columna/etiqueta `container`).
4. **Jaeger (la traza completa).** http://localhost:16686 → *Service* **`realtime-service`** →
   en *Tags* escribe `correlation.id=PEGA_AQUI_EL_CORRELATION_ID` → *Find Traces* → abre la traza.
   Esto funciona para acciones que generan un evento (crear, editar o mover una tarjeta).

   La traza de un movimiento exitoso cruza tres servicios y muestra, en orden:

   ```
   core-api          PATCH /api/v1/tasks/:taskId/position
   core-api            pg.query: SELECT … (rol del usuario, la tarea, la columna)
   core-api            pg.query: START
   core-api            pg.query: UPDATE "tasks" SET column_id, position, version…   ← control de versión (F3)
   core-api            pg.query: INSERT … outbox_events                              ← el evento (F5)
   core-api            pg.query: COMMIT
   outbox-relay      publish taskmaster.domain-events                                ← el relay lo publica
   realtime-service  realtime.dispatch_event                                         ← lo reparte a los sockets
   ```

   Para peticiones que no generan evento (leer el resumen, un 403…): *Service* **`core-api`** y elige la
   *Operation* (por ejemplo `GET /api/v1/boards/:boardId/summary`).

## 3. Feature por feature

### F1: Roles y permisos

| Qué haces en la app | Dónde y qué verás |
|---|---|
| Un VIEWER intenta editar (por ejemplo con `curl`, porque la app lo bloquea antes) y alguien sin rol abre el tablero | **Evidencias**: `403` y `404`. |
| Sin token (`curl` a `/api/v1/...`) | **Loki**: `{container="taskmaster-api-gateway"} \|= "status=401"`. Es el **gateway** quien responde: en **Jaeger no aparece ninguna traza** de `core-api`, porque la petición nunca llegó. |
| Un 404 de un usuario sin acceso | **Jaeger** (*core-api*, operación `GET /api/v1/boards/:boardId/summary`): solo hay `SELECT` de membresías, ningún `UPDATE`. **Loki**: `{container="taskmaster-core-api"} \|~ "summary 404"`. |
| Roles dados | **PostgreSQL**: `select user_id, role from board_members;` y `select user_id, role from workspace_members;` |
| Volumen de errores | **Grafana** → dashboard **TaskMaster - Core API** → panel *API error rate*. |

### F2: Resumen optimizado y caché

| Qué haces en la app | Dónde y qué verás |
|---|---|
| Abrir un tablero y pulsar «↻ Recargar» 2 o 3 veces | **Redis**: `redis-cli --scan --pattern "board-summary:*"` muestra la clave. Con `ttl board-summary:<id>` ves la cuenta atrás desde 300. Con `get board-summary:<id>` ves el JSON: **solo tarjetas, sin descripciones**. |
| Lo mismo | **Prometheus** (http://localhost:9090) → `sum by (result) (board_summary_cache_requests_total)`: sube `miss` la primera vez y `hit` en las siguientes. |
| Primera lectura frente a segunda | **Jaeger** (*core-api*, `GET /api/v1/boards/:boardId/summary`): la lectura con `miss` tiene `pg.query: SELECT … tasks`; la que es `hit` **no consulta la tabla de tareas**. |
| Mover una tarjeta y volver a pedir la clave de Redis | La clave **desapareció** (se invalida en cada escritura); la siguiente lectura la recrea. |
| Tiempo | **Grafana** → *TaskMaster - Core API* → *API p95 latency*. La cabecera del tablero en la app también muestra los ms. |

### F3: Control de concurrencia (OCC)

| Qué haces en la app | Dónde y qué verás |
|---|---|
| «⚡ Simular edición concurrente» y luego «Guardar» | **Evidencias**: `PATCH … 412` con `If-Match "N"`. |
| Lo mismo | **Jaeger** (*core-api*, operación `PATCH /api/v1/tasks/:taskId/position` o `PATCH /api/v1/tasks/:taskId`): compara una traza `200` con una `412`. La `200` hace `UPDATE tasks … version` → `INSERT outbox_events` → `COMMIT`. La `412` hace el `UPDATE` (0 filas) y termina en **`ROLLBACK`, sin `INSERT` en el outbox y sin evento**: nada se escribió. |
| Lo mismo | **Loki**: `{container="taskmaster-core-api"} \|= "position 412"` (los rechazos). |
| Contar rechazos | **Prometheus**: `sum by (status) (http_requests_total{route=~".*tasks.*"})` → verás los `412` y `428` acumulados. |
| Ver cómo sube la versión | **PostgreSQL**: `select left(id::text,8) id, title, version, updated_at from tasks order by updated_at desc limit 5;` (cada guardado exitoso suma 1). |
| «Modo prueba: omitir If-Match» y guardar | **Evidencias**: `428 PRECONDITION_REQUIRED`. |

### F4: Archivos pesados fuera de la API

Haz esta prueba con un archivo grande (100 MB o más) y estas dos cosas a la vez:

```bash
docker stats taskmaster-core-api        # deja la terminal abierta mientras subes
```

| Qué haces en la app | Dónde y qué verás |
|---|---|
| Subir un `.zip` grande | **`docker stats`**: la columna `MEM USAGE` de `core-api` **no se mueve**, aunque el archivo pese 150 MB (en las pruebas se mantuvo en ~85 MiB antes, durante y después). |
| Lo mismo | **Evidencias** (HTTP, feature F4): primero `POST /tasks/…/attachments` (JSON pequeño), después la subida **a `localhost:9000`** (el storage, no la API) y por último `POST /attachments/…/confirm`. |
| Lo mismo | **RustFS** (http://localhost:9001) → bucket `taskmaster-attachments` → carpeta `boards/<tablero>/tasks/<tarea>/attachments/<adjunto>/`: el archivo `original` (y `preview.webp` si es una imagen). |
| Después de confirmar | **RabbitMQ** → *Queues* → `file-worker.attachment-process`: 1 consumidor y 0 mensajes (el worker ya lo consumió). `file-worker.attachment-process.dlq` en 0. En *Exchanges* verás `taskmaster.file-jobs`. |
| Lo mismo | **PostgreSQL**: `select file_name, status, failure_reason, size_bytes from attachments order by created_at desc limit 5;` (pasa de `PENDING` a `COMPLETED`). |
| Lo mismo | **Loki**: `{container="taskmaster-file-worker"} \|= "job done"` → `"result":"COMPLETED"`. |
| Métricas | **Grafana** → dashboard **TaskMaster - File Worker**: *Jobs received*, *Jobs per second*, *Dead-letter queue*. |

**Una falla rápida y segura** (sin romper nada): sube un archivo de texto **renombrado a `.png`**. El worker lo
rechaza porque la firma no coincide con el tipo.
- La app muestra `FAILED · CONTENT_TYPE_MISMATCH`.
- **Loki**: `{container="taskmaster-file-worker"} \|= "FAILED"`.
- **Prometheus / Grafana**: `file_worker_jobs_failed_total` sube a 1 (hasta ~15 s después, que es lo que tarda el *scrape*).

> **La cola de mensajes muertos (DLQ)** solo se llena cuando el storage falla de forma persistente (3 reintentos a los
> 10 s, 60 s y 300 s, unos 6 minutos). Es una prueba más larga y delicada, y no está en esta guía. Si la necesitas,
> la alerta `DeadLetterQueueNotEmpty` de Prometheus (http://localhost:9090/alerts) es la que avisa.

### F5: Notificaciones en tiempo real

Abre dos ventanas lado a lado (por ejemplo Marta y Nicolás en el mismo tablero) y mueve una tarjeta en la primera.

| Qué haces en la app | Dónde y qué verás |
|---|---|
| Mover una tarjeta | **Evidencias → «Tiempo real (WS)»** en la otra ventana: el evento `task.moved` con su latencia («aplicado v2 · llegó N ms tras el commit»). |
| Lo mismo | **PostgreSQL** (el outbox, el evento nace *junto* al cambio): `select seq, routing_key, left(event_id::text,8) ev, published_at is not null as publicado, attempts from outbox_events order by seq desc limit 5;` |
| Lo mismo | **Loki** (el relay y el realtime): `{container="taskmaster-outbox-relay"} \|= "published events"` y `{container="taskmaster-realtime-service"} \|= "event dispatched"`. |
| Lo mismo | **Jaeger**: la traza de la receta general (sección 2) con `outbox-relay → realtime-service`. |
| Lo mismo | **RabbitMQ** → *Exchanges* → `taskmaster.domain-events`: ves la cola `realtime.<id>` enlazada. En *Queues* → `realtime.<id>`: 1 consumidor. |
| Métricas | **Grafana** → **TaskMaster - Realtime Service**: *Open WebSocket connections*, *Events by outcome*, *Commit-to-socket p95* (meta: menos de 2 s). Y **TaskMaster - Outbox Relay**: *Pending rows* (0), *Published per second*. |
| Un tercer usuario sin acceso intenta suscribirse | **Loki**: `{container="taskmaster-realtime-service"} \|= "forbidden"`. No recibe ningún evento. |

**La prueba de resiliencia del outbox** (muy buena para la sustentación):

```bash
docker stop taskmaster-rabbitmq         # 1) apaga el broker
# 2) En la app, mueve tarjetas: responde 200 igual (la escritura no depende del broker)
#    PostgreSQL: las filas del outbox quedan con publicado = f
#    Grafana → TaskMaster - Outbox Relay → «Pending rows» sube
docker start taskmaster-rabbitmq        # 3) enciéndelo
#    «Pending rows» vuelve a 0 y los navegadores se resincronizan solos
```

> Con el broker apagado la métrica *Pending rows* sube y, pasados ~2 minutos, se dispara la alerta
> `OutboxBacklog` (Prometheus → http://localhost:9090/alerts). Al volver el broker, el servicio de tiempo
> real pide a los navegadores reconectar y recargar el resumen, así no se pierde nada.
> Después de esta prueba, comprueba en **RabbitMQ → Queues** que `file-worker.attachment-process`
> y `realtime.<id>` tienen 1 consumidor.

## 4. Dashboards de Grafana disponibles

Grafana → *Dashboards*:

| Dashboard | Qué muestra |
|---|---|
| **TaskMaster - Health and alerts** | Estado de los 4 servicios, DLQ, outbox pendiente, latencia de entrega y alertas activas. Es el panel resumen. |
| **TaskMaster - Core API** | Peticiones por ruta, tasa de errores y latencia p95. |
| **TaskMaster - File Worker** | Jobs recibidos, fallidos, DLQ, jobs por segundo, memoria. |
| **TaskMaster - Outbox Relay** | Filas pendientes, publicadas por segundo, ciclos fallidos. |
| **TaskMaster - Realtime Service** | Conexiones WebSocket, suscripciones, eventos, latencia commit→socket. |

Los dashboards se llenan con tráfico: **genera actividad en la app antes de mostrarlos** (arrastra tarjetas,
guarda con conflictos, sube un archivo). Si los paneles salen vacíos, revisa que Prometheus tenga los
7 *targets* en `UP` en http://localhost:9090/targets.

## 5. Si algo no aparece

| Síntoma | Qué revisar |
|---|---|
| Loki no devuelve nada | Ajusta el rango de tiempo de Grafana (arriba a la derecha) a «Last 15 minutes». Comprueba que el contenedor `taskmaster-alloy` esté arriba. |
| Jaeger no ve el servicio | Los 4 servicios (`core-api`, `outbox-relay`, `file-worker`, `realtime-service`) aparecen en *Service* solo después de recibir tráfico. |
| Un panel de Grafana sale vacío | Primero genera tráfico. Luego revisa http://localhost:9090/targets (los 7 en `UP`). |
| Cambiaste/recreaste un servicio y el WebSocket ya no conecta | Reinicia el gateway: `docker restart taskmaster-api-gateway` (Nginx guarda la IP del contenedor al arrancar). |
