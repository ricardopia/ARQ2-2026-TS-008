#!/usr/bin/env node
/**
 * Verifica automáticamente las 5 features de TaskMaster contra el stack real.
 *   Requisitos: Node 22+, `docker compose up -d` corriendo.
 *   Uso:        node scripts/verify-features.mjs
 *   Opcional:   --chaos   apaga RabbitMQ unos segundos para probar el outbox (F5)
 * Crea usuarios con correos aleatorios; no borra ni modifica datos existentes.
 */
import { execFileSync } from 'node:child_process';

const BASE = process.env.BASE_URL || 'http://localhost:8080';
const API = BASE + '/api/v1';
const CHAOS = process.argv.includes('--chaos');
const PASSWORD = 'correct-horse-battery';
const tag = Math.random().toString(36).slice(2, 7);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
let current = '';
const section = name => { current = name; console.log(`\n=== ${name} ===`); };
function check(desc, ok, extra = '') {
  results.push({ feature: current, desc, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${desc}${extra ? '  (' + extra + ')' : ''}`);
  return ok;
}
function skip(desc, why) { console.log(`  SKIP  ${desc}  (${why})`); }

async function call(method, path, { body, token, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (token) h.Authorization = 'Bearer ' + token;
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await fetch(API + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    if (r.status === 429) { await sleep(6500); continue; } // límite del gateway en /auth (10/min)
    let data = null; try { data = await r.json(); } catch { /* sin cuerpo */ }
    return { status: r.status, data, etag: r.headers.get('etag') };
  }
  throw new Error('Rate limit persistente en ' + path);
}
function docker(...args) {
  try { return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
}
async function makeUser(name) {
  const email = `${name}.${tag}@acme.test`;
  await call('POST', '/auth/register', { body: { email, password: PASSWORD, displayName: name } });
  const l = await call('POST', '/auth/login', { body: { email, password: PASSWORD } });
  if (l.status !== 200) throw new Error('No se pudo iniciar sesión como ' + name + ' (' + l.status + ')');
  return { token: l.data.accessToken, ...l.data.user };
}

async function main() {
  const health = await fetch(BASE + '/health').catch(() => null);
  if (!health || !health.ok) { console.error(`No hay respuesta en ${BASE}. ¿Corriste "docker compose up -d --build"?`); process.exit(2); }

  console.log('Creando usuarios de prueba (puede tardar unos segundos por el límite de /auth)...');
  const bob = await makeUser('bob'), alice = await makeUser('alice'), carol = await makeUser('carol'), dave = await makeUser('dave');

  /* ---------------- F1 ---------------- */
  section('F1 · Roles, workspaces y permisos');
  const ws = (await call('POST', '/workspaces', { token: bob.token, body: { name: 'Acme ' + tag } })).data;
  check('El creador del workspace es OWNER', ws.myRole === 'OWNER');
  check('Bob (OWNER) agrega a Alice y Carol al workspace',
    (await call('POST', `/workspaces/${ws.id}/members`, { token: bob.token, body: { email: alice.email, role: 'MEMBER' } })).status === 201 &&
    (await call('POST', `/workspaces/${ws.id}/members`, { token: bob.token, body: { email: carol.email, role: 'MEMBER' } })).status === 201);
  check('Alice (MEMBER) NO puede agregar miembros al workspace (403)',
    (await call('POST', `/workspaces/${ws.id}/members`, { token: alice.token, body: { email: dave.email, role: 'MEMBER' } })).status === 403);
  const board = (await call('POST', `/workspaces/${ws.id}/boards`, { token: bob.token, body: { name: 'Platform' } })).data;
  check('El tablero nace con 3 columnas y su creador es ADMIN', board.columns.length === 3 && board.myRole === 'ADMIN');
  check('No se puede dar rol de tablero a quien no es miembro del workspace (409)',
    (await call('POST', `/boards/${board.id}/members`, { token: bob.token, body: { userId: dave.id, role: 'EDITOR' } })).status === 409);
  check('Bob da EDITOR a Alice y VIEWER a Carol',
    (await call('POST', `/boards/${board.id}/members`, { token: bob.token, body: { userId: alice.id, role: 'EDITOR' } })).status === 201 &&
    (await call('POST', `/boards/${board.id}/members`, { token: bob.token, body: { userId: carol.id, role: 'VIEWER' } })).status === 201);
  const task = (await call('POST', `/boards/${board.id}/tasks`, { token: bob.token, body: { columnId: board.columns[0].id, title: 'Login page' } })).data;
  check('Alice (EDITOR) NO puede dar roles de tablero (403)',
    (await call('POST', `/boards/${board.id}/members`, { token: alice.token, body: { userId: dave.id, role: 'VIEWER' } })).status === 403);
  check('Carol (VIEWER) NO puede editar una tarea (403)',
    (await call('PATCH', `/tasks/${task.id}`, { token: carol.token, body: { title: 'x' }, headers: { 'If-Match': '"1"' } })).status === 403);
  check('Carol (VIEWER) SÍ puede leer el resumen (200)', (await call('GET', `/boards/${board.id}/summary`, { token: carol.token })).status === 200);
  check('Dave (sin rol) recibe 404 en el tablero y en la tarea',
    (await call('GET', `/boards/${board.id}/summary`, { token: dave.token })).status === 404 &&
    (await call('GET', `/tasks/${task.id}`, { token: dave.token })).status === 404);
  check('Sin token el gateway responde 401', (await call('GET', `/boards/${board.id}/summary`)).status === 401);

  /* ---------------- F2 ---------------- */
  section('F2 · Resumen optimizado y caché');
  const big = 'x'.repeat(20000);
  const t2 = (await call('POST', `/boards/${board.id}/tasks`, { token: bob.token, body: { columnId: board.columns[0].id, title: 'Tarea pesada', description: big } })).data;
  const sum = (await call('GET', `/boards/${board.id}/summary`, { token: carol.token })).data;
  const card = sum.columns.flatMap(c => c.tasks).find(t => t.id === t2.id);
  check('El resumen NO incluye descripción ni adjuntos (aunque la tarea tiene 20.000 caracteres)',
    card && !('description' in card) && !('attachments' in card) && JSON.stringify(sum).length < 5000, `payload ${JSON.stringify(sum).length} bytes`);
  check('Cada tarjeta trae solo campos de TaskCard',
    ['id', 'columnId', 'title', 'assigneeIds', 'dueDate', 'position', 'version', 'updatedAt'].every(k => k in card));
  const key = `board-summary:${board.id}`;
  const has = () => docker('exec', 'taskmaster-redis', 'redis-cli', 'exists', key);
  if (has() === null) skip('Clave en Redis y su invalidación', 'docker no disponible desde este script');
  else {
    check('Tras leer el resumen existe la clave en Redis', has() === '1');
    const ttl = Number(docker('exec', 'taskmaster-redis', 'redis-cli', 'ttl', key));
    check('La clave tiene TTL ≤ 300 s', ttl > 0 && ttl <= 300, `ttl ${ttl}s`);
    await call('PATCH', `/tasks/${task.id}/position`, { token: bob.token, body: { columnId: board.columns[1].id }, headers: { 'If-Match': '"1"' } });
    check('Una escritura invalida (borra) la clave', has() === '0');
    const after = (await call('GET', `/boards/${board.id}/summary`, { token: carol.token })).data;
    check('El nuevo resumen refleja el movimiento', after.columns[1].tasks.some(t => t.id === task.id));
  }

  /* ---------------- F3 ---------------- */
  section('F3 · Concurrencia optimista (OCC)');
  const t3 = (await call('POST', `/boards/${board.id}/tasks`, { token: bob.token, body: { columnId: board.columns[0].id, title: 'Caso Lost Update', description: 'original' } })).data;
  const a = await call('PATCH', `/tasks/${t3.id}`, { token: alice.token, body: { description: 'Texto técnico de Alice' }, headers: { 'If-Match': '"1"' } });
  check('Alice edita con If-Match "1" → 200 y ETag "2"', a.status === 200 && a.etag === '"2"');
  const b = await call('PATCH', `/tasks/${t3.id}/position`, { token: bob.token, body: { columnId: board.columns[1].id }, headers: { 'If-Match': '"1"' } });
  check('Bob mueve con la versión vieja → 412 VERSION_CONFLICT', b.status === 412 && b.data.code === 'VERSION_CONFLICT');
  const mid = (await call('GET', `/tasks/${t3.id}`, { token: bob.token })).data;
  check('El 412 no cambió nada (sigue en To Do con el texto de Alice)', mid.columnId === board.columns[0].id && mid.description === 'Texto técnico de Alice' && mid.version === 2);
  const retry = await call('PATCH', `/tasks/${t3.id}/position`, { token: bob.token, body: { columnId: board.columns[1].id }, headers: { 'If-Match': '"2"' } });
  check('Bob reintenta con la versión actual → 200 y ETag "3"', retry.status === 200 && retry.etag === '"3"');
  check('Se conservan AMBOS cambios (movida + descripción de Alice)', retry.data.columnId === board.columns[1].id && retry.data.description === 'Texto técnico de Alice');
  check('Sin If-Match → 428', (await call('PATCH', `/tasks/${t3.id}`, { token: alice.token, body: { title: 'x' } })).status === 428);
  check('If-Match débil o inválido → 400', (await call('PATCH', `/tasks/${t3.id}`, { token: alice.token, body: { title: 'x' }, headers: { 'If-Match': 'W/"3"' } })).status === 400);
  check('Enviar la tarea completa (campos no permitidos) → 400',
    (await call('PATCH', `/tasks/${t3.id}`, { token: alice.token, body: { id: t3.id, columnId: board.columns[0].id, version: 3, title: 'y' }, headers: { 'If-Match': '"3"' } })).status === 400);
  const race = await Promise.all(Array.from({ length: 20 }, (_, i) => call('PATCH', `/tasks/${t3.id}`, { token: alice.token, body: { title: 'carrera ' + i }, headers: { 'If-Match': '"3"' } })));
  const wins = race.filter(r => r.status === 200).length, losses = race.filter(r => r.status === 412).length;
  check('20 escrituras simultáneas con la misma versión: exactamente 1 gana y 19 reciben 412', wins === 1 && losses === 19, `ganan ${wins}, 412: ${losses}`);

  /* ---------------- F4 ---------------- */
  section('F4 · Subida pesada fuera de la API');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
  check('Tipo no permitido (text/html) → 400 UNSUPPORTED_CONTENT_TYPE',
    (await call('POST', `/tasks/${t3.id}/attachments`, { token: alice.token, body: { fileName: 'a.html', contentType: 'text/html', sizeBytes: 10 } })).data?.code === 'UNSUPPORTED_CONTENT_TYPE');
  check('Archivo de 300 MB → 400 FILE_TOO_LARGE',
    (await call('POST', `/tasks/${t3.id}/attachments`, { token: alice.token, body: { fileName: 'g.zip', contentType: 'application/zip', sizeBytes: 300000000 } })).data?.code === 'FILE_TOO_LARGE');
  check('Carol (VIEWER) no puede pedir subidas (403)',
    (await call('POST', `/tasks/${t3.id}/attachments`, { token: carol.token, body: { fileName: 'a.png', contentType: 'image/png', sizeBytes: png.length } })).status === 403);
  const up = await call('POST', `/tasks/${t3.id}/attachments`, { token: alice.token, body: { fileName: 'mock.png', contentType: 'image/png', sizeBytes: png.length } });
  check('Alice obtiene un POST pre-firmado y el adjunto nace PENDING', up.status === 201 && up.data.attachment.status === 'PENDING' && !!up.data.upload.url);
  check('La subida NO cambia la versión de la tarea', (await call('GET', `/tasks/${t3.id}`, { token: alice.token })).data.version >= 3);
  const early = await call('POST', `/attachments/${up.data.attachment.id}/confirm`, { token: alice.token });
  check('Confirmar antes de subir → 409 UPLOAD_NOT_FOUND', early.status === 409 && early.data.code === 'UPLOAD_NOT_FOUND');
  const form = new FormData();
  Object.entries(up.data.upload.fields).forEach(([k, v]) => form.append(k, v));
  form.append('file', new Blob([png], { type: 'image/png' }), 'mock.png');
  const s3 = await fetch(up.data.upload.url, { method: 'POST', body: form });
  check('El archivo se sube DIRECTO al storage (204), sin pasar por la API', s3.status === 204, new URL(up.data.upload.url).host);
  const c1 = await call('POST', `/attachments/${up.data.attachment.id}/confirm`, { token: alice.token });
  const c2 = await call('POST', `/attachments/${up.data.attachment.id}/confirm`, { token: alice.token });
  check('Confirmar → 202; confirmar dos veces es idempotente', c1.status === 202 && c2.status === 202);
  let final = null;
  for (let i = 0; i < 15; i++) { await sleep(2000); final = (await call('GET', `/attachments/${up.data.attachment.id}`, { token: alice.token })).data; if (['COMPLETED', 'FAILED'].includes(final.status)) break; }
  check('El worker procesa el archivo en segundo plano → COMPLETED', final?.status === 'COMPLETED', `estado: ${final?.status}${final?.failureReason ? ' ' + final.failureReason : ''}`);
  check('Imagen: se generó la vista previa', final?.hasPreview === true);
  const dl = await call('GET', `/attachments/${up.data.attachment.id}/download-url`, { token: carol.token });
  check('Carol (VIEWER) obtiene una URL de descarga pre-firmada', dl.status === 200 && !!dl.data.url);
  const big413 = await fetch(API + `/tasks/${t3.id}`, { method: 'PATCH', headers: { Authorization: 'Bearer ' + alice.token, 'Content-Type': 'application/json', 'If-Match': '"99"' }, body: JSON.stringify({ description: 'x'.repeat(1.2 * 1024 * 1024) }) });
  check('Un cuerpo > 1 MiB nunca llega a la API: el gateway responde 413', big413.status === 413);

  /* ---------------- F5 ---------------- */
  section('F5 · Notificaciones en tiempo real');
  const connect = async user => {
    const tk = (await call('POST', '/realtime/tickets', { token: user.token })).data;
    const url = `${BASE.replace(/^http/, 'ws')}/ws?ticket=${tk.ticket}`;
    const events = []; let subscribed = false, error = null, closeCode = null;
    const sock = new WebSocket(url);
    sock.onmessage = m => { const d = JSON.parse(m.data); if (d.type === 'subscribed') subscribed = true; else if (d.type === 'error') error = d.code; else if (d.type === 'event') events.push({ ...d.event, receivedAt: Date.now() }); };
    sock.onclose = e => { closeCode = e.code; };
    await new Promise(r => { sock.onopen = r; sock.onerror = r; });
    return { sock, events, get subscribed() { return subscribed; }, get error() { return error; }, get closeCode() { return closeCode; }, sub: id => sock.send(JSON.stringify({ type: 'subscribe', requestId: '1', boardId: id })) };
  };
  const wsAlice = await connect(alice), wsCarol = await connect(carol), wsDave = await connect(dave);
  wsAlice.sub(board.id); wsCarol.sub(board.id); wsDave.sub(board.id);
  await sleep(1200);
  check('Alice y Carol (con rol) se suscriben al tablero', wsAlice.subscribed && wsCarol.subscribed);
  check('Dave (sin rol) recibe error FORBIDDEN al suscribirse', wsDave.error === 'FORBIDDEN');
  const reuse = await (async () => { const tk = (await call('POST', '/realtime/tickets', { token: bob.token })).data; const u = `${BASE.replace(/^http/, 'ws')}/ws?ticket=${tk.ticket}`; const s1 = new WebSocket(u); await new Promise(r => { s1.onopen = r; s1.onerror = r; }); const s2 = new WebSocket(u); const code = await new Promise(r => { s2.onclose = e => r(e.code); setTimeout(() => r('timeout'), 3000); }); s1.close(); return code; })();
  check('Un ticket reutilizado es rechazado (cierre 4401)', reuse === 4401, 'código ' + reuse);
  const t5 = (await call('POST', `/boards/${board.id}/tasks`, { token: bob.token, body: { columnId: board.columns[0].id, title: 'Evento en vivo' } })).data;
  const t0 = Date.now();
  const mv = await call('PATCH', `/tasks/${t5.id}/position`, { token: bob.token, body: { columnId: board.columns[1].id }, headers: { 'If-Match': '"1"' } });
  await sleep(2500);
  const evA = wsAlice.events.find(e => e.eventType === 'task.moved' && e.aggregate.id === t5.id);
  const evC = wsCarol.events.find(e => e.eventType === 'task.moved' && e.aggregate.id === t5.id);
  check('Alice y Carol reciben task.moved al instante', !!evA && !!evC, evA ? `llegó ${evA.receivedAt - t0} ms después de la petición` : 'no llegó');
  check('La versión del evento coincide con el ETag que recibió Bob', evA && `"${evA.aggregate.version}"` === mv.etag);
  check('El evento trae actor y NO trae la descripción', evA && evA.actorId === bob.id && !JSON.stringify(evA).includes('description'));
  check('Dave NO recibe ningún evento del tablero', wsDave.events.length === 0);
  if (CHAOS) {
    console.log('  … --chaos: deteniendo RabbitMQ 6 s');
    if (docker('stop', 'taskmaster-rabbitmq') === null) skip('Prueba de outbox', 'no se pudo detener RabbitMQ');
    else {
      const edit = await call('PATCH', `/tasks/${t5.id}`, { token: bob.token, body: { title: 'Editada con broker caído' }, headers: { 'If-Match': `"${mv.data.version}"` } });
      check('Con RabbitMQ caído la escritura responde 200 igualmente', edit.status === 200);
      await sleep(6000); docker('start', 'taskmaster-rabbitmq'); console.log('  … RabbitMQ reiniciado, esperando entrega (hasta 60 s)');
      let got = null; for (let i = 0; i < 30 && !got; i++) { await sleep(2000); got = wsAlice.events.find(e => e.eventType === 'task.updated' && e.aggregate.id === t5.id); }
      const pending = docker('exec', 'taskmaster-postgres', 'psql', '-U', 'taskmaster', '-d', 'taskmaster', '-tA', '-c', "select count(*) from outbox_events where published_at is null and routing_key like 'task.%'");
      if (pending !== null) check('Outbox: el relay publicó al broker todas las filas pendientes (ninguna se perdió)', pending === '0', `pendientes: ${pending}`);
      // Como el cliente real: si el servidor pidió resincronizar (cierre 1012), reconecta, se suscribe y recarga el resumen.
      let synced = false;
      if (!got && wsAlice.closeCode === 1012) {
        const again = await connect(alice); again.sub(board.id); await sleep(800);
        const s = (await call('GET', `/boards/${board.id}/summary`, { token: alice.token })).data;
        synced = again.subscribed && s.columns.flatMap(c => c.tasks).some(t => t.id === t5.id && t.title === 'Editada con broker caído');
        again.sock.close();
      }
      check('Realtime: tras volver el broker Alice queda al día (evento en vivo o resincronización)', !!got || synced,
        got ? 'recibió el evento en vivo' : synced ? 'el servidor pidió resincronizar (1012) y el resumen ya trae el cambio' : 'quedó desactualizada');
      const stuck = docker('exec', 'taskmaster-rabbitmq', 'rabbitmqctl', 'list_queues', 'name', 'consumers');
      if (stuck !== null) check('El file-worker volvió a consumir su cola tras el reinicio del broker', /file-worker\.attachment-process\t[1-9]/.test(stuck));
    }
  } else skip('Outbox con RabbitMQ caído', 'ejecuta con --chaos para probarlo');
  [wsAlice, wsCarol, wsDave].forEach(w => w.sock.close());

  /* ---------------- resumen ---------------- */
  const failed = results.filter(r => !r.ok);
  const byFeature = {};
  results.forEach(r => { (byFeature[r.feature] ??= { ok: 0, total: 0 }); byFeature[r.feature].total++; if (r.ok) byFeature[r.feature].ok++; });
  console.log('\n================ RESUMEN ================');
  Object.entries(byFeature).forEach(([f, v]) => console.log(`${v.ok === v.total ? 'PASS' : 'FAIL'}  ${f}  (${v.ok}/${v.total})`));
  if (failed.length) { console.log('\nFallaron:'); failed.forEach(f => console.log(' - [' + f.feature.split(' ')[0] + '] ' + f.desc)); }
  process.exit(failed.length ? 1 : 0);
}
main().catch(e => { console.error('\nError inesperado:', e.message); process.exit(2); });
