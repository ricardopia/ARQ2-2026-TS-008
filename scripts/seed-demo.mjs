#!/usr/bin/env node
/**
 * Deja listo un escenario de demostración en el stack que está corriendo:
 *   - 4 usuarios: marta (OWNER), nicolas (EDITOR), valeria (VIEWER) y esteban (sin acceso)
 *   - workspace «Acme» y tablero «Platform» con 5 tarjetas repartidas en las columnas
 * Uso:  node scripts/seed-demo.mjs        (Node 22+, con `docker compose up -d` corriendo)
 * Puedes ejecutarlo varias veces: los usuarios se reutilizan y cada corrida crea un tablero nuevo.
 */
const BASE = process.env.BASE_URL || 'http://localhost:8080';
const API = BASE + '/api/v1';
const PASSWORD = 'correct-horse-battery';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function call(method, path, { body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;
  for (let i = 0; i < 8; i++) {
    const r = await fetch(API + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    if (r.status === 429) { await sleep(6500); continue; } // el gateway limita /auth a 10 por minuto
    let data = null; try { data = await r.json(); } catch { /* sin cuerpo */ }
    return { status: r.status, data };
  }
  throw new Error('Límite de peticiones persistente en ' + path);
}
async function must(label, p) {
  const r = await p;
  if (r.status >= 300) throw new Error(`${label} falló (${r.status} ${r.data?.code ?? ''}: ${r.data?.detail ?? ''})`);
  return r.data;
}
async function user(name) {
  const email = `${name.toLowerCase()}@equipo.test`;
  const reg = await call('POST', '/auth/register', { body: { email, password: PASSWORD, displayName: name } });
  if (reg.status !== 201 && reg.status !== 409) throw new Error(`No se pudo registrar a ${name}: ${reg.status} ${reg.data?.detail ?? ''}`);
  const login = await call('POST', '/auth/login', { body: { email, password: PASSWORD } });
  if (login.status !== 200) throw new Error(`No se pudo iniciar sesión como ${name} (¿existe con otra contraseña?)`);
  return { name, email, token: login.data.accessToken, id: login.data.user.id };
}

try {
  const h = await fetch(BASE + '/health').catch(() => null);
  if (!h || !h.ok) throw new Error(`No hay respuesta en ${BASE}. Ejecuta primero: docker compose up -d --build`);
  console.log('Preparando usuarios (tarda unos segundos por el límite de /auth)...');
  const marta = await user('Marta'), nicolas = await user('Nicolas'), valeria = await user('Valeria'), esteban = await user('Esteban');

  const ws = await must('crear workspace', call('POST', '/workspaces', { token: marta.token, body: { name: 'Acme' } }));
  await must('agregar a Nicolás', call('POST', `/workspaces/${ws.id}/members`, { token: marta.token, body: { email: nicolas.email, role: 'MEMBER' } }));
  await must('agregar a Valeria', call('POST', `/workspaces/${ws.id}/members`, { token: marta.token, body: { email: valeria.email, role: 'MEMBER' } }));
  const board = await must('crear tablero', call('POST', `/workspaces/${ws.id}/boards`, { token: marta.token, body: { name: 'Platform', description: 'Tablero de demostración' } }));
  await must('rol de Nicolás', call('POST', `/boards/${board.id}/members`, { token: marta.token, body: { userId: nicolas.id, role: 'EDITOR' } }));
  await must('rol de Valeria', call('POST', `/boards/${board.id}/members`, { token: marta.token, body: { userId: valeria.id, role: 'VIEWER' } }));

  const [todo, doing, done] = board.columns.map(c => c.id);
  const cards = [
    [todo, 'Pantalla de login', 'Implementar el formulario y la validación.'],
    [todo, 'Integrar pagos', ''],
    [doing, 'Documentar la API', 'Describir los endpoints en el spec.'],
    [doing, 'Revisar permisos', ''],
    [done, 'Configurar CI', ''],
  ];
  for (const [columnId, title, description] of cards) {
    await must('crear tarjeta ' + title, call('POST', `/boards/${board.id}/tasks`, { token: marta.token, body: description ? { columnId, title, description } : { columnId, title } }));
  }

  const link = `${BASE}/#board=${board.id}`;
  console.log(`
============================================================
 Listo. Escenario de demostración creado.
============================================================
 Contraseña de todos:  ${PASSWORD}

   Marta    marta@equipo.test     OWNER del workspace / ADMIN del tablero
   Nicolás  nicolas@equipo.test   EDITOR del tablero
   Valeria  valeria@equipo.test   VIEWER del tablero (solo lectura)
   Esteban   esteban@equipo.test    sin acceso (debe recibir 404)

 Enlace directo al tablero (entra tras iniciar sesión):
   ${link}

 Cómo probar en vivo (F5): abre ese enlace en DOS ventanas, una como Marta y
 otra como Nicolás, ponlas lado a lado y arrastra una tarjeta en la de Marta.
============================================================`);
} catch (e) {
  console.error('\nNo se pudo preparar la demo:', e.message);
  process.exit(1);
}
