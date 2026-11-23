# TaskMaster Web

Cliente web de TaskMaster. Es JavaScript simple (sin build ni dependencias) y lo sirve el
API Gateway en el mismo origen que `/api/v1` y `/ws`, por eso no necesita CORS.

## Empezar

Todo corre **en tu propia máquina**: cada integrante levanta su stack y crea sus propios
usuarios de prueba. No hay usuarios ni datos compartidos.

```bash
docker compose up -d --build        # levanta todo el stack
```

Luego abre **http://localhost:8080**.

### 1. Crea tus usuarios

Necesitas varios usuarios para ver los roles y las notificaciones en vivo. Abre **una pestaña
nueva por usuario** en http://localhost:8080, pulsa **«Crear cuenta»** y regístralos con cualquier
correo y una contraseña de **12 caracteres o más**. Por ejemplo:

| Usuario de ejemplo | Para qué lo vas a usar |
|---|---|
| Marta | El que crea el workspace y el tablero (OWNER / ADMIN) |
| Nicolás | Editor: edita y mueve tarjetas |
| Valeria | Viewer: solo lectura |
| Esteban | Sin acceso: debe recibir 404 |

**Cada pestaña tiene su propia sesión**, así que puedes tener a todos conectados a la vez.
Abre cada una con «pestaña nueva» (no «Duplicar pestaña», que copia la sesión).

### 2. Asigna los roles tú mismo

1. **En la pestaña de Marta:** «+ Workspace» y pon un nombre. Marta queda como **OWNER**.
2. En ese workspace pulsa «+ Tablero». Se abre con 3 columnas y Marta queda como **ADMIN**. Crea algunas tarjetas.
3. **Agrega a los demás al workspace:** pulsa «+ Miembro» (solo lo ve el OWNER), escribe el **correo** de Nicolás y elige `MEMBER`. Repite con Valeria. *No agregues a Esteban.*
4. **Dales rol en el tablero:** en la pestaña de cada usuario (Nicolás, Valeria) pulsa **«copiar»** junto a su ID, en la barra lateral. Luego, en la pestaña de Marta, dentro del tablero pulsa «+ Miembro del tablero», pega ese ID y elige el rol:
   - Nicolás → `EDITOR`
   - Valeria → `VIEWER`
5. **Que cada uno abra el tablero:** en la pestaña de Marta pulsa «Copiar enlace» y pega ese enlace en la barra de direcciones de las demás pestañas; al iniciar sesión entran directo. (También sirve «Abrir tablero por ID».)

| Rol | Qué puede hacer |
|---|---|
| Workspace `OWNER` | Todo en el workspace; es ADMIN implícito de todos sus tableros |
| Tablero `ADMIN` | Leer, editar y dar roles en el tablero |
| Tablero `EDITOR` | Leer, crear, editar y mover tarjetas, subir archivos |
| Tablero `VIEWER` | Solo leer |
| Sin rol | 404: ni siquiera se revela que el tablero existe |

> **Atajo opcional:** si no quieres hacer todo a mano, `node scripts/seed-demo.mjs` (Node 22+) crea
> los usuarios `marta@equipo.test`, `nicolas@equipo.test`, `valeria@equipo.test` y `esteban@equipo.test` (contraseña
> `correct-horse-battery`) con un tablero y tarjetas ya armados, y te imprime el enlace.

## Qué probar en cada feature

La app trae una **«📘 Guía de pruebas»** (barra lateral) con los pasos. Resumen:

| Feature | Dónde verlo en la app |
|---|---|
| **F1** Roles y permisos | Valeria no puede arrastrar ni guardar; Nicolás no ve «+ Miembro del tablero»; Esteban recibe 404. |
| **F2** Resumen liviano | «↻ Recargar» + pestaña HTTP de *Evidencias*: `GET /summary` trae solo tarjetas. |
| **F3** Concurrencia (OCC) | En una tarjeta: «⚡ Simular edición concurrente» y luego «Guardar» → 412 y diálogo de resolución. «Modo prueba: omitir If-Match» → 428. |
| **F4** Archivos pesados | «Adjuntar archivo» (zip, pdf, imágenes…). En *Evidencias* la subida va al storage (`localhost:9000`), no a la API. |
| **F5** Notificaciones | Dos ventanas lado a lado: arrastra una tarjeta en una y la otra se mueve sola con «🔔 Tablero modificado · N ms». |

> **¿Quieres ver lo que pasa por debajo?** La guía [OBSERVABILIDAD.md](OBSERVABILIDAD.md) explica, paso a paso y
> por feature, dónde evidenciar cada interacción en Grafana, Jaeger, Loki, Prometheus, Redis, RabbitMQ, RustFS y
> PostgreSQL (incluida la receta para seguir una sola acción por todas las herramientas con su `X-Correlation-Id`).

El panel **Evidencias** (barra inferior) muestra cada petición con su `If-Match`, `ETag` y
`X-Correlation-Id`, etiquetada por feature, más los eventos del WebSocket.

## Verificación automática (sin usar la interfaz)

```bash
node scripts/verify-features.mjs            # comprueba los 5 features contra la API
node scripts/verify-features.mjs --chaos    # además apaga RabbitMQ unos segundos
```

## Estructura

```
apps/web/public/
├── index.html   # página base
├── styles.css   # estilos (claro/oscuro)
└── app.js       # toda la lógica: autenticación, tablero, tarjetas, WebSocket, evidencias
```

Como la carpeta se monta como volumen de solo lectura en el contenedor `web`, **basta con
refrescar el navegador** (Ctrl+F5) después de editar un archivo; no hace falta reconstruir.

## Cosas que conviene saber

- **No hay endpoints de listado.** La API no lista workspaces, tableros ni adjuntos, así que la app
  recuerda en `localStorage` lo que creas y se entra a tableros ajenos por enlace (`/#board=<id>`) o con
  «Abrir tablero por ID».
- **El 412 no trae la tarea actual.** El cliente la vuelve a pedir con `GET /tasks/{id}`.
- **Subida directa y CORS.** El bucket no tiene CORS configurado. Si el navegador bloquea la petición
  previa (preflight), la app reintenta la subida como petición simple y la valida con `/confirm`; en ese caso
  se pierde la barra de progreso. En *Evidencias* se ve el modo usado.
- **Tipos de archivo.** Para extensiones conocidas (`.zip`, `.psd`, `.pdf`, …) la app envía el tipo que acepta la
  API, porque los navegadores no coinciden (en Windows un `.zip` llega como `application/x-zip-compressed`).
- **Límite del gateway:** 10 inicios de sesión o registros por minuto desde la misma IP (`429`).
- **Si recreas un servicio** (por ejemplo `docker compose up -d --build realtime-service`), reinicia también
  `taskmaster-api-gateway`: Nginx guarda la IP del contenedor al arrancar.
- **Contraseña olvidada:** no hay recuperación. Crea otra cuenta o resetea el hash en la base
  (ver `docs/auth.md` para cómo se guarda: argon2id).
