'use strict';
/* TaskMaster web client. Vanilla JS, no build. Served by the API Gateway (same origin as /api/v1 and /ws). */
const API = '/api/v1';

/* ---------- tiny helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, v);
  }
  for (const c of kids.flat()) { if (c == null || c === false) continue; e.append(c.nodeType ? c : document.createTextNode(String(c))); }
  return e;
}
const store = {
  get(k, d) { try { const v = localStorage.getItem('tm.' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('tm.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  del(k) { try { localStorage.removeItem('tm.' + k); } catch { /* ignore */ } }
};
const short = id => (id || '').slice(0, 8);
const fmtSize = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B';
const etagVersion = s => Number(String(s || '').replace(/"/g, ''));

/* The session lives per TAB (sessionStorage) so two tabs can be two different users. */
const sess = {
  get(k) { try { const v = sessionStorage.getItem('tm.' + k); return v ? JSON.parse(v) : null; } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem('tm.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
  del(k) { try { sessionStorage.removeItem('tm.' + k); } catch { /* ignore */ } }
};
const state = {
  token: sess.get('token'), user: sess.get('user'),
  workspaces: [], boards: [], board: null, summary: null, summaryMs: null,
  ws: null, wsStatus: 'off', seenEvents: new Set(), skipIfMatch: false, openTask: null
};

/* known users (id -> {email, displayName}); there is no "list members" endpoint */
function knownUsers() { return store.get('users', {}); }
function rememberUser(u) { if (!u || !u.id && !u.userId) return; const id = u.id || u.userId; const m = knownUsers(); m[id] = { email: u.email, displayName: u.displayName }; store.set('users', m); }
function userLabel(id) { const u = knownUsers()[id]; return u ? u.displayName : short(id); }
function initials(id) { const u = knownUsers()[id]; return (u ? u.displayName : id).slice(0, 2).toUpperCase(); }

/* ---------- toasts ---------- */
function toast(title, msg, kind = '', ms = 5000) {
  const t = h('div', { class: 'toast ' + kind }, h('b', null, title), msg ? h('span', { class: 'muted' }, msg) : null);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), ms);
}

/* ---------- evidence drawer (what the system did, per feature) ---------- */
const evidence = { open: false, tab: 'http', http: [], events: [] };
function featureOf(method, path) {
  if (path.startsWith('/realtime')) return 'F5';
  if (/\/attachments|^\/attachments/.test(path)) return 'F4';
  if (path.includes('/summary')) return 'F2';
  if (path.startsWith('/tasks') || /\/tasks$/.test(path)) return 'F3';
  return 'F1';
}
function logHttp(e) { evidence.http.unshift(e); if (evidence.http.length > 150) evidence.http.pop(); renderEvidence(); }
function logEvent(e) { evidence.events.unshift(e); if (evidence.events.length > 150) evidence.events.pop(); renderEvidence(); }
function renderEvidence() {
  const root = $('#evidence-root'); root.innerHTML = '';
  const shell = $('.shell'); if (shell) shell.classList.toggle('ev-open', evidence.open);
  const bar = h('div', { class: 'ev-bar' },
    h('b', null, 'Evidencias'),
    h('button', { onclick: () => { evidence.open = !evidence.open; renderEvidence(); } }, evidence.open ? 'Ocultar ▾' : `Mostrar ▴ (${evidence.http.length} peticiones · ${evidence.events.length} eventos)`)
  );
  if (evidence.open) {
    bar.append(
      h('button', { class: evidence.tab === 'http' ? 'on' : '', onclick: () => { evidence.tab = 'http'; renderEvidence(); } }, 'HTTP'),
      h('button', { class: evidence.tab === 'ws' ? 'on' : '', onclick: () => { evidence.tab = 'ws'; renderEvidence(); } }, 'Tiempo real (WS)'),
      h('span', { class: 'sp' }),
      h('label', { title: 'Demuestra el 428: el servidor exige If-Match en PATCH /tasks' },
        h('input', { type: 'checkbox', ...(state.skipIfMatch ? { checked: true } : {}), onchange: ev => { state.skipIfMatch = ev.target.checked; } }),
        'Modo prueba: omitir If-Match'),
      h('button', { onclick: () => { evidence.http = []; evidence.events = []; renderEvidence(); } }, 'Limpiar')
    );
  }
  const wrap = h('div', { class: 'ev' }, bar);
  if (evidence.open) {
    const body = h('div', { class: 'ev-body' });
    if (evidence.tab === 'http') {
      if (!evidence.http.length) body.append(h('div', { class: 'muted' }, 'Aún no hay peticiones.'));
      evidence.http.forEach(e => body.append(h('details', { class: 'ev-row' },
        h('summary', null,
          h('span', { class: 'ft' }, e.feature), h('span', null, e.time), h('b', null, e.method), h('span', null, e.path),
          h('span', { class: 'st' + String(e.status)[0] }, e.status || 'ERR'), h('span', { class: 'muted' }, e.ms + ' ms'),
          e.ifMatch ? h('span', { class: 'hd' }, 'If-Match ' + e.ifMatch) : null,
          e.etag ? h('span', { class: 'hd' }, 'ETag ' + e.etag) : null),
        h('pre', null, `X-Correlation-Id: ${e.cid || '-'}\n` + (e.reqBody ? `→ ${e.reqBody}\n` : '') + `← ${e.resBody || ''}`))));
    } else {
      if (!evidence.events.length) body.append(h('div', { class: 'muted' }, 'Abre un tablero para recibir eventos en vivo.'));
      evidence.events.forEach(e => body.append(h('details', { class: 'ev-row' },
        h('summary', null, h('span', { class: 'ft' }, 'F5'), h('span', null, e.time), h('b', null, e.type), h('span', { class: e.note.startsWith('ignorado') ? 'st5' : 'st2' }, e.note)),
        h('pre', null, e.raw))));
    }
    wrap.append(body);
  }
  root.append(wrap);
}

/* ---------- API client ---------- */
class ApiError extends Error {
  constructor(status, problem, res) { super(problem && (problem.detail || problem.title) || 'Error'); this.status = status; this.problem = problem || {}; this.code = (problem && problem.code) || ''; this.res = res; }
}
async function api(method, path, { body, headers = {}, noAuth = false } = {}) {
  const hdr = { ...headers };
  if (body !== undefined) hdr['Content-Type'] = 'application/json';
  if (state.token && !noAuth) hdr.Authorization = 'Bearer ' + state.token;
  const t0 = performance.now();
  let res;
  try { res = await fetch(API + path, { method, headers: hdr, body: body !== undefined ? JSON.stringify(body) : undefined }); }
  catch { logHttp({ feature: featureOf(method, path), time: new Date().toLocaleTimeString(), method, path, status: 0, ms: 0, resBody: 'sin conexión' }); throw new ApiError(0, { code: 'NETWORK', detail: 'No hay conexión con el servidor.' }); }
  const ms = Math.round(performance.now() - t0);
  let data = null;
  if (res.status !== 204) { try { data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text(); } catch { /* empty */ } }
  const clip = v => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s && s.length > 1500 ? s.slice(0, 1500) + '…' : s; };
  logHttp({ feature: featureOf(method, path), time: new Date().toLocaleTimeString(), method, path, status: res.status, ms,
    ifMatch: hdr['If-Match'], etag: res.headers.get('ETag'), cid: res.headers.get('X-Correlation-Id'),
    reqBody: body !== undefined ? clip(body) : '', resBody: clip(data) });
  if (!res.ok) {
    if (res.status === 401 && state.token && !noAuth) { logout(); toast('Sesión expirada', 'Inicia sesión de nuevo.', 'warn'); }
    throw new ApiError(res.status, typeof data === 'object' ? data : {}, res);
  }
  return { status: res.status, data, etag: res.headers.get('ETag'), ms };
}
const ifMatch = v => state.skipIfMatch ? {} : { 'If-Match': `"${v}"` };
const errMsg = e => e.code === 'NETWORK' ? e.message : `${e.status} ${e.code || ''}: ${e.message}`.trim();

/* ---------- session ---------- */
function setSession(token, user) { state.token = token; state.user = user; sess.set('token', token); sess.set('user', user); rememberUser(user); loadLocal(); }
function logout() { closeBoard(); state.token = null; state.user = null; sess.del('token'); sess.del('user'); renderApp(); }
const ukey = k => `u.${state.user.id}.${k}`;
function loadLocal() { state.workspaces = store.get(ukey('ws'), []); state.boards = store.get(ukey('boards'), []); }
function saveLocal() { store.set(ukey('ws'), state.workspaces); store.set(ukey('boards'), state.boards); }

/* ---------- modal ---------- */
function openModal(node, { wide = false, onClose } = {}) {
  const bd = h('div', { class: 'backdrop' });
  const m = h('div', { class: 'modal' + (wide ? ' wide' : '') }, node);
  bd.append(m);
  const close = () => { bd.remove(); if (onClose) onClose(); };
  bd.addEventListener('mousedown', e => { if (e.target === bd) close(); });
  $('#modal-root').append(bd);
  return { close, el: m };
}

function formModal(title, fields, submitLabel, onSubmit, extra) {
  const err = h('div', { class: 'err' });
  const inputs = {};
  const form = h('form', { onsubmit: async ev => {
    ev.preventDefault(); err.textContent = '';
    const vals = Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.value.trim()]));
    try { await onSubmit(vals); mod.close(); } catch (e) { err.textContent = e.message || String(e); }
  } }, h('h3', null, title));
  if (extra) form.append(extra);
  fields.forEach(f => {
    const i = f.options
      ? h('select', null, f.options.map(o => h('option', { value: o.value ?? o }, o.label ?? o)))
      : h('input', { type: f.type || 'text', placeholder: f.placeholder || '', required: f.required !== false, ...(f.maxlength ? { maxlength: f.maxlength } : {}) });
    inputs[f.name] = i; form.append(h('label', null, f.label), i);
  });
  form.append(err, h('div', { class: 'actions' }, h('button', { type: 'button', onclick: () => mod.close() }, 'Cancelar'), h('button', { class: 'primary', type: 'submit' }, submitLabel)));
  const mod = openModal(form);
  const first = form.querySelector('input,select'); if (first) first.focus();
  return mod;
}

/* =====================================================================
   AUTH SCREEN  (F1: register / login)
   ===================================================================== */
function renderAuth() {
  const app = $('#app'); app.innerHTML = '';
  let mode = 'login';
  const err = h('div', { class: 'err' });
  const email = h('input', { type: 'email', required: true, placeholder: 'nicolas@equipo.test', autocomplete: 'username' });
  const pass = h('input', { type: 'password', required: true, minlength: 12, maxlength: 128, placeholder: 'Mínimo 12 caracteres', autocomplete: 'current-password' });
  const name = h('input', { type: 'text', maxlength: 100, placeholder: 'Nicolás' });
  const nameRow = h('div', { style: 'display:none' }, h('label', null, 'Nombre visible'), name);
  const submit = h('button', { class: 'primary', type: 'submit', style: 'width:100%;margin-top:16px' }, 'Entrar');
  const tabL = h('button', { type: 'button', class: 'on', onclick: () => set('login') }, 'Iniciar sesión');
  const tabR = h('button', { type: 'button', onclick: () => set('register') }, 'Crear cuenta');
  function set(m) { mode = m; tabL.classList.toggle('on', m === 'login'); tabR.classList.toggle('on', m === 'register'); nameRow.style.display = m === 'register' ? '' : 'none'; submit.textContent = m === 'register' ? 'Crear cuenta' : 'Entrar'; err.textContent = ''; }
  const form = h('form', { onsubmit: async ev => {
    ev.preventDefault(); err.textContent = ''; submit.disabled = true;
    try {
      if (mode === 'register') await api('POST', '/auth/register', { noAuth: true, body: { email: email.value.trim(), password: pass.value, displayName: name.value.trim() || email.value.split('@')[0] } });
      const r = await api('POST', '/auth/login', { noAuth: true, body: { email: email.value.trim(), password: pass.value } });
      setSession(r.data.accessToken, r.data.user); renderApp(); openDeepLink();
    } catch (e) { err.textContent = e.code === 'RATE_LIMITED' ? 'Demasiados intentos (límite del gateway: 10/min). Espera un momento.' : errMsg(e); }
    submit.disabled = false;
  } }, h('div', { class: 'tabs' }, tabL, tabR), h('label', null, 'Correo'), email, nameRow, h('label', null, 'Contraseña'), pass, err, submit);
  app.append(h('div', { class: 'auth' }, h('div', { class: 'auth-card' },
    h('h1', null, 'TaskMaster'), h('div', { class: 'muted' }, 'Kanban empresarial con control de concurrencia'), form,
    h('div', { class: 'hint' }, '¿Corriste el seed (node scripts/seed-demo.mjs)? Entra con marta@equipo.test, nicolas@equipo.test, valeria@equipo.test o esteban@equipo.test y la contraseña ', h('code', null, 'correct-horse-battery'), '. ',
      h('button', { class: 'ghost small', type: 'button', onclick: openGuide }, 'Ver guía de pruebas')))));
}

/* =====================================================================
   APP SHELL
   ===================================================================== */
function renderApp() {
  if (!state.token || !state.user) { renderAuth(); renderEvidence(); return; }
  const app = $('#app'); app.innerHTML = '';
  const side = h('aside', { class: 'side' },
    h('div', { class: 'brand' }, h('i'), 'TaskMaster'),
    h('div', { class: 'userbox' }, h('b', null, state.user.displayName), h('span', { class: 'muted' }, state.user.email),
      h('div', { class: 'small muted', style: 'margin-top:4px' }, 'ID: ', h('code', null, short(state.user.id)), ' ',
        h('button', { class: 'ghost small', title: 'Copiar tu ID de usuario', onclick: () => navigator.clipboard && navigator.clipboard.writeText(state.user.id).then(() => toast('ID copiado', '', 'ok', 1800)) }, 'copiar')),
      h('button', { class: 'ghost small', onclick: logout }, 'Cerrar sesión')));
  state.workspaces.forEach(w => {
    const bs = state.boards.filter(b => b.workspaceId === w.id);
    side.append(h('div', { class: 'ws' },
      h('div', { class: 'ws-h' }, h('span', { class: 'n' }, w.name), w.myRole ? h('span', { class: 'chip ' + (w.myRole === 'OWNER' ? 'ok' : 'gray') }, w.myRole) : null),
      bs.map(b => h('button', { class: 'bl' + (state.board && state.board.id === b.id ? ' on' : ''), onclick: () => openBoard(b.id) }, '▦ ' + b.name)),
      h('div', { class: 'row' },
        h('button', { class: 'small', onclick: () => newBoardModal(w) }, '+ Tablero'),
        w.myRole === 'OWNER' ? h('button', { class: 'small', title: 'Solo el OWNER del workspace puede agregar miembros', onclick: () => addWsMemberModal(w) }, '+ Miembro') : null,
        h('button', { class: 'small ghost', title: 'Copiar ID del workspace', onclick: () => navigator.clipboard && navigator.clipboard.writeText(w.id).then(() => toast('ID copiado', short(w.id), 'ok', 1800)) }, 'ID')
      )));
  });
  side.append(h('div', { class: 'row', style: 'margin-top:20px' },
    h('button', { class: 'primary', onclick: newWorkspaceModal }, '+ Workspace'),
    h('button', { onclick: openByIdModal }, 'Abrir tablero por ID'),
    h('button', { class: 'ghost', onclick: openGuide }, '📘 Guía de pruebas')));
  const main = h('main', { class: 'main', id: 'main' });
  app.append(h('div', { class: 'shell' + (evidence.open ? ' ev-open' : '') }, side, main));
  renderBoard(); renderEvidence();
}

function newWorkspaceModal() {
  formModal('Nuevo workspace', [{ name: 'name', label: 'Nombre', maxlength: 100, placeholder: 'Acme' }], 'Crear', async v => {
    const r = await api('POST', '/workspaces', { body: { name: v.name } });
    state.workspaces.push({ id: r.data.id, name: r.data.name, myRole: r.data.myRole }); saveLocal(); renderApp();
    toast('Workspace creado', 'Eres OWNER: puedes agregar miembros y administras todos sus tableros.', 'ok');
  });
}
function newBoardModal(ws) {
  formModal(`Nuevo tablero en ${ws.name}`, [{ name: 'name', label: 'Nombre', maxlength: 100 }, { name: 'description', label: 'Descripción (opcional)', required: false, maxlength: 2000 }], 'Crear', async v => {
    const r = await api('POST', `/workspaces/${ws.id}/boards`, { body: v.description ? { name: v.name, description: v.description } : { name: v.name } });
    state.boards.push({ id: r.data.id, workspaceId: ws.id, name: r.data.name }); saveLocal(); renderApp(); openBoard(r.data.id);
  });
}
function addWsMemberModal(ws) {
  formModal(`Agregar miembro a ${ws.name}`, [
    { name: 'email', label: 'Correo (debe estar registrado)', type: 'email', placeholder: 'valeria@equipo.test' },
    { name: 'role', label: 'Rol en el workspace', options: ['MEMBER', 'OWNER'] }], 'Agregar', async v => {
    const r = await api('POST', `/workspaces/${ws.id}/members`, { body: { email: v.email, role: v.role } });
    rememberUser(r.data); toast('Miembro agregado', `${r.data.displayName} (${r.data.role}) · ID ${short(r.data.userId)}. Ahora puedes darle un rol en un tablero.`, 'ok', 7000);
  });
}
function openByIdModal() {
  formModal('Abrir tablero por ID', [{ name: 'id', label: 'ID del tablero (UUID)', placeholder: 'b7e4d1c2-…' }], 'Abrir', async v => {
    await openBoard(v.id.trim(), true);
  });
}

/* =====================================================================
   BOARD (F2 summary, F5 realtime, F3 drag&drop)
   ===================================================================== */
async function openBoard(id, strict = false) {
  closeBoard();
  const t0 = performance.now();
  try {
    const r = await api('GET', `/boards/${id}/summary`);
    state.summary = r.data; state.board = r.data.board; state.summaryMs = Math.round(performance.now() - t0);
    state.seenEvents = new Set();
    if (!state.boards.find(b => b.id === id)) {
      if (!state.workspaces.find(w => w.id === state.board.workspaceId)) state.workspaces.push({ id: state.board.workspaceId, name: 'Compartido (' + short(state.board.workspaceId) + ')', myRole: null }); // rol de workspace desconocido: no se muestra
      state.boards.push({ id, workspaceId: state.board.workspaceId, name: state.board.name }); saveLocal();
    }
    renderApp(); connectWs();
  } catch (e) {
    toast('No se pudo abrir el tablero', e.status === 404 ? '404: no existe o no tienes rol en él (la API no revela cuál).' : errMsg(e), 'bad');
    if (strict) throw e; else renderApp();
  }
}
function closeBoard() { disconnectWs(); state.board = null; state.summary = null; state.openTask = null; }
async function refreshSummary(quiet) {
  if (!state.board) return;
  const t0 = performance.now();
  try {
    const r = await api('GET', `/boards/${state.board.id}/summary`);
    state.summary = r.data; state.board = r.data.board; state.summaryMs = Math.round(performance.now() - t0); renderBoard();
    if (!quiet) toast('Resumen recargado', `${state.summaryMs} ms`, 'ok', 1800);
  } catch (e) { toast('No se pudo recargar', errMsg(e), 'bad'); }
}
const canEdit = () => state.board && state.board.myRole !== 'VIEWER';
const isAdmin = () => state.board && state.board.myRole === 'ADMIN';
const allCards = () => state.summary.columns.flatMap(c => c.tasks);
const toCard = t => ({ id: t.id, columnId: t.columnId, title: t.title, assigneeIds: t.assigneeIds || [], dueDate: t.dueDate || null, position: t.position, version: t.version, updatedAt: t.updatedAt });
function applyCard(card, flashIt) {
  if (!state.summary) return false;
  const existing = allCards().find(c => c.id === card.id);
  if (existing && card.version <= existing.version) return false; // FR-5.4: ignore stale / duplicate
  state.summary.columns.forEach(c => { c.tasks = c.tasks.filter(t => t.id !== card.id); });
  const col = state.summary.columns.find(c => c.id === card.columnId);
  if (col) { col.tasks.push(card); col.tasks.sort((a, b) => a.position - b.position); }
  renderBoard(flashIt ? card.id : null);
  return true;
}

function renderBoard(flashId) {
  const main = $('#main'); if (!main) return;
  main.innerHTML = '';
  if (!state.board) {
    main.append(h('div', { class: 'empty' }, h('div', null, h('h2', null, 'Bienvenido a TaskMaster'),
      h('p', null, 'Crea un workspace y un tablero, o abre uno por ID.'),
      h('p', { class: 'small' }, 'Tip: abre el panel «Evidencias» (abajo) para ver cada petición HTTP, los ETag / If-Match y los eventos en vivo.'))));
    return;
  }
  const b = state.board;
  const live = h('span', { class: 'live ' + (state.wsStatus === 'on' ? 'on' : state.wsStatus === 'off' ? 'off' : ''), id: 'live' }, h('i'), state.wsStatus === 'on' ? 'En vivo' : state.wsStatus === 'off' ? 'Sin conexión en vivo' : 'Conectando…');
  main.append(h('div', { class: 'bh' },
    h('h2', null, b.name), h('span', { class: 'chip ' + (b.myRole === 'ADMIN' ? 'ok' : b.myRole === 'EDITOR' ? '' : 'gray'), title: 'Tu rol efectivo en este tablero' }, b.myRole), live,
    h('span', { class: 'small muted', title: 'Resumen liviano: solo TaskCards, servido desde Redis cuando está en caché' }, `Resumen: ${state.summaryMs} ms · ${new Date(state.summary.generatedAt).toLocaleTimeString()}`),
    h('span', { class: 'sp' }),
    h('button', { class: 'small', title: 'Copia un enlace que abre este tablero directamente', onclick: () => navigator.clipboard && navigator.clipboard.writeText(`${location.origin}/#board=${b.id}`).then(() => toast('Enlace copiado', 'Pégalo en otra ventana: tras iniciar sesión abre este tablero.', 'ok', 4000)) }, 'Copiar enlace'),
    h('button', { class: 'small', onclick: () => refreshSummary(false) }, '↻ Recargar'),
    isAdmin() ? h('button', { class: 'small', onclick: addBoardMemberModal }, '+ Miembro del tablero') : null));
  const cols = h('div', { class: 'cols' });
  state.summary.columns.forEach(col => {
    const colEl = h('div', { class: 'col', 'data-col': col.id,
      ondragover: ev => { if (canEdit()) { ev.preventDefault(); colEl.classList.add('over'); } },
      ondragleave: () => colEl.classList.remove('over'),
      ondrop: ev => { ev.preventDefault(); colEl.classList.remove('over'); const id = ev.dataTransfer.getData('text/plain'); const card = allCards().find(c => c.id === id); if (card && card.columnId !== col.id) moveTask(card.id, col.id, card.version); } },
      h('div', { class: 'col-h' }, h('span', null, col.name), h('span', { class: 'muted' }, col.tasks.length)));
    col.tasks.forEach(t => {
      const el = h('div', { class: 'card' + (t.id === flashId ? ' flash' : ''), draggable: canEdit() ? 'true' : null, onclick: () => openTaskModal(t.id),
        ondragstart: ev => { ev.dataTransfer.setData('text/plain', t.id); el.classList.add('dragging'); }, ondragend: () => el.classList.remove('dragging') },
        h('div', { class: 't' }, t.title),
        h('div', { class: 'meta' }, h('span', { class: 'chip gray', title: 'Versión (ETag) que se enviará en If-Match' }, 'v' + t.version),
          t.dueDate ? h('span', { class: 'chip warn' }, '📅 ' + t.dueDate) : null,
          t.assigneeIds.map(a => h('span', { class: 'avatar', title: userLabel(a) }, initials(a)))));
      colEl.append(el);
    });
    if (canEdit()) colEl.append(h('button', { class: 'addcard', onclick: () => addCardInline(col, colEl) }, '+ Añadir tarjeta'));
    cols.append(colEl);
  });
  main.append(cols);
}
function addCardInline(col, colEl) {
  const btn = colEl.querySelector('.addcard');
  const input = h('input', { placeholder: 'Título y Enter', maxlength: 200 });
  btn.replaceWith(input); input.focus();
  const done = () => { renderBoard(); };
  input.addEventListener('keydown', async ev => {
    if (ev.key === 'Escape') return done();
    if (ev.key !== 'Enter' || !input.value.trim()) return;
    input.disabled = true;
    try { const r = await api('POST', `/boards/${state.board.id}/tasks`, { body: { columnId: col.id, title: input.value.trim() } }); applyCard(toCard(r.data), true); }
    catch (e) { toast('No se pudo crear la tarjeta', errMsg(e), 'bad'); done(); }
  });
  input.addEventListener('blur', () => setTimeout(done, 150));
}
function addBoardMemberModal() {
  const known = Object.entries(knownUsers()).filter(([id]) => id !== state.user.id);
  const sel = known.length ? h('div', null, h('label', null, 'Usuarios conocidos'), h('select', { id: 'bm-known', onchange: ev => { $('#bm-id').value = ev.target.value; } },
    h('option', { value: '' }, '— elegir —'), known.map(([id, u]) => h('option', { value: id }, `${u.displayName} (${u.email})`)))) : null;
  const mod = formModal('Dar rol en el tablero', [
    { name: 'userId', label: 'ID de usuario (debe ser miembro del workspace)', placeholder: 'UUID' },
    { name: 'role', label: 'Rol', options: ['EDITOR', 'VIEWER', 'ADMIN'] }], 'Asignar', async v => {
    const r = await api('POST', `/boards/${state.board.id}/members`, { body: { userId: v.userId, role: v.role } });
    toast('Rol asignado', `${r.data.displayName} → ${r.data.role}`, 'ok');
  }, sel);
  const idInput = mod.el.querySelector('input'); if (idInput) idInput.id = 'bm-id';
}

/* ---------- move (intent-based, conditional) ---------- */
async function moveTask(taskId, toColumnId, version, onDone) {
  const colName = id => (state.summary.columns.find(c => c.id === id) || {}).name || id;
  const send = v => api('PATCH', `/tasks/${taskId}/position`, { body: { columnId: toColumnId }, headers: ifMatch(v) });
  try {
    const r = await send(version);
    applyCard(toCard(r.data), true); toast('Tarjeta movida', `→ ${colName(toColumnId)} (v${r.data.version})`, 'ok', 2500);
    if (onDone) onDone(r.data); return r.data;
  } catch (e) {
    if (e.status === 412) {
      try {
        const cur = await api('GET', `/tasks/${taskId}`);
        toast('Conflicto de versión (412)', `Otra persona modificó la tarjeta (tenías v${version}, ahora v${cur.data.version}). Reintento el movimiento sobre la versión actual: no se pierde ningún cambio.`, 'warn', 8000);
        const r2 = await send(cur.data.version);
        applyCard(toCard(r2.data), true); if (onDone) onDone(r2.data); return r2.data;
      } catch (e2) { toast('No se pudo mover', errMsg(e2), 'bad'); }
    } else if (e.status === 428) toast('428 Precondition Required', 'El servidor exige If-Match en las escrituras de tareas.', 'warn', 7000);
    else toast('No se pudo mover', e.status === 403 ? '403: tu rol (VIEWER) no permite editar.' : errMsg(e), 'bad');
    renderBoard();
  }
}

/* =====================================================================
   TASK MODAL (F3 optimistic concurrency, F4 uploads)
   ===================================================================== */
const ALLOWED_TYPES = { psd: 'application/vnd.adobe.photoshop', ai: 'application/postscript', eps: 'application/postscript', zip: 'application/zip', pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
function contentTypeOf(file) {
  // Browsers disagree on MIME types (Windows reports .zip as application/x-zip-compressed, .psd as image/vnd...).
  // For known extensions send the type the API accepts; the File Worker verifies the real file signature anyway.
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  return ALLOWED_TYPES[ext] || file.type || 'application/octet-stream';
}

async function openTaskModal(taskId) {
  let task, version, base;
  try { const r = await api('GET', `/tasks/${taskId}`); task = r.data; version = etagVersion(r.etag) || task.version; }
  catch (e) { toast('No se pudo abrir la tarjeta', errMsg(e), 'bad'); return; }
  const editable = canEdit();
  base = { title: task.title, description: task.description, dueDate: task.dueDate || '', assigneeIds: [...task.assigneeIds] };

  const verChip = h('span', { class: 'chip', title: 'ETag actual en tu pantalla' }, 'ETag v' + version);
  const banner = h('div');
  const title = h('input', { value: task.title, maxlength: 200, ...(editable ? {} : { readonly: true }) });
  const desc = h('textarea', { maxlength: 20000, ...(editable ? {} : { readonly: true }) }, task.description);
  const due = h('input', { type: 'date', value: task.dueDate || '', ...(editable ? {} : { disabled: true }) });
  const users = Object.entries(knownUsers());
  const assigneeBox = h('div', { class: 'checks' }, users.map(([id, u]) => h('label', null,
    h('input', { type: 'checkbox', value: id, ...(task.assigneeIds.includes(id) ? { checked: true } : {}), ...(editable ? {} : { disabled: true }) }), u.displayName)));
  const colSel = h('select', { ...(editable ? {} : { disabled: true }) }, state.summary.columns.map(c => h('option', { value: c.id, ...(c.id === task.columnId ? { selected: true } : {}) }, c.name)));
  const status = h('div', { class: 'err' });

  const mod = openModal(null, { wide: true, onClose: () => { state.openTask = null; } });
  state.openTask = { id: taskId, version: () => version, banner: v => { banner.innerHTML = ''; banner.append(h('div', { class: 'banner' }, `Esta tarjeta tiene una versión más nueva en el servidor (v${v}).`, h('button', { class: 'small', onclick: reload }, 'Cargar última versión'))); } };

  function setFromServer(t, etag) {
    task = t; version = etag || t.version; verChip.textContent = 'ETag v' + version;
    title.value = t.title; desc.value = t.description; due.value = t.dueDate || ''; colSel.value = t.columnId;
    assigneeBox.querySelectorAll('input').forEach(i => { i.checked = t.assigneeIds.includes(i.value); });
    base = { title: t.title, description: t.description, dueDate: t.dueDate || '', assigneeIds: [...t.assigneeIds] };
    banner.innerHTML = '';
  }
  async function reload() { const r = await api('GET', `/tasks/${taskId}`); setFromServer(r.data, etagVersion(r.etag)); }
  const currentAssignees = () => [...assigneeBox.querySelectorAll('input:checked')].map(i => i.value);
  const sameList = (a, b) => a.length === b.length && a.every(x => b.includes(x));
  function collectChanges() {
    const c = {};
    if (title.value !== base.title) c.title = title.value;
    if (desc.value !== base.description) c.description = desc.value;
    if (due.value !== base.dueDate) c.dueDate = due.value || null;
    if (!sameList(currentAssignees(), base.assigneeIds)) c.assigneeIds = currentAssignees();
    return c;
  }
  const baseVal = f => f === 'dueDate' ? base.dueDate || null : base[f];
  const serverVal = (t, f) => f === 'dueDate' ? t.dueDate || null : t[f];

  async function save() {
    status.textContent = '';
    const changes = collectChanges();
    if (!Object.keys(changes).length) { status.textContent = 'No hay cambios que guardar.'; return; }
    try {
      const r = await api('PATCH', `/tasks/${taskId}`, { body: changes, headers: ifMatch(version) });
      setFromServer(r.data, etagVersion(r.etag)); applyCard(toCard(r.data), true);
      toast('Guardado', `Nueva versión v${version} (solo se enviaron: ${Object.keys(changes).join(', ')})`, 'ok', 3500);
    } catch (e) {
      if (e.status === 412) return resolveConflict(changes);
      if (e.status === 428) { status.textContent = '428 PRECONDITION_REQUIRED: el servidor rechazó la escritura porque no llevaba If-Match.'; return; }
      status.textContent = e.status === 403 ? '403: tu rol no permite editar.' : errMsg(e);
    }
  }
  async function resolveConflict(changes) {
    const cur = await api('GET', `/tasks/${taskId}`); const curV = etagVersion(cur.etag) || cur.data.version;
    const choices = {}; const form = h('div');
    form.append(h('h3', null, 'Conflicto de versión (412)'),
      h('p', { class: 'muted' }, `Tenías la v${version} y el servidor ya está en la v${curV}: alguien guardó antes que tú. Nada se sobrescribió. Decide qué conservar:`));
    Object.keys(changes).forEach(f => {
      const theirsChanged = JSON.stringify(serverVal(cur.data, f)) !== JSON.stringify(baseVal(f));
      if (!theirsChanged) { choices[f] = 'mine'; form.append(h('div', { class: 'diff' }, h('b', null, f), h('span', { class: 'chip ok', style: 'margin-left:8px' }, 'sin choque: se aplica tu cambio'))); return; }
      choices[f] = 'theirs';
      const show = v => h('pre', null, typeof v === 'string' || v == null ? (v ?? '(vacío)') : JSON.stringify(v));
      form.append(h('div', { class: 'diff' }, h('b', null, f), h('span', { class: 'chip bad', style: 'margin-left:8px' }, 'ambos lo cambiaron'),
        h('div', { class: 'small muted' }, 'Versión del servidor:'), show(serverVal(cur.data, f)), h('div', { class: 'small muted' }, 'Tu versión:'), show(changes[f]),
        h('label', { class: 'r' }, h('input', { type: 'radio', name: 'c-' + f, checked: true, onchange: () => { choices[f] = 'theirs'; } }), 'Conservar la del servidor'),
        h('label', { class: 'r' }, h('input', { type: 'radio', name: 'c-' + f, onchange: () => { choices[f] = 'mine'; } }), 'Usar la mía (sobrescribe la del servidor, a sabiendas)')));
    });
    const cm = openModal(form, { wide: true });
    form.append(h('div', { class: 'actions' },
      h('button', { onclick: () => { cm.close(); setFromServer(cur.data, curV); } }, 'Descartar lo mío y cargar el servidor'),
      h('button', { class: 'primary', onclick: async () => {
        const mine = Object.fromEntries(Object.entries(changes).filter(([f]) => choices[f] === 'mine'));
        cm.close();
        if (!Object.keys(mine).length) { setFromServer(cur.data, curV); return; }
        try {
          const r = await api('PATCH', `/tasks/${taskId}`, { body: mine, headers: ifMatch(curV) });
          setFromServer(r.data, etagVersion(r.etag)); applyCard(toCard(r.data), true); toast('Resuelto', `Reaplicado sobre v${curV} → v${version}`, 'ok');
        } catch (e) { if (e.status === 412) { toast('Otro conflicto', 'Alguien volvió a guardar. Reintenta.', 'warn'); resolveConflict(changes); } else status.textContent = errMsg(e); }
      } }, 'Aplicar selección')));
  }
  async function simulateOther() {
    try {
      const cur = await api('GET', `/tasks/${taskId}`);
      const stamp = new Date().toLocaleTimeString();
      await api('PATCH', `/tasks/${taskId}`, { body: { description: (cur.data.description ? cur.data.description + '\n' : '') + `[Edición concurrente de otro usuario ${stamp}]` }, headers: ifMatch(cur.data.version) });
      toast('Edición concurrente simulada', 'El servidor avanzó de versión. Ahora pulsa «Guardar» con tu copia vieja para ver el 412.', 'warn', 7000);
    } catch (e) { status.textContent = errMsg(e); }
  }
  async function move() {
    const to = colSel.value; if (to === task.columnId) { status.textContent = 'La tarjeta ya está en esa columna.'; return; }
    const d = await moveTask(taskId, to, version, nd => { task = { ...task, columnId: nd.columnId }; version = nd.version; verChip.textContent = 'ETag v' + version; });
    if (!d) colSel.value = task.columnId;
  }

  /* attachments */
  const attList = h('div');
  const attIds = store.get('att.' + taskId, []);
  const attRows = {};
  function attRow(a) {
    let r = attRows[a.id];
    if (!r) { r = { el: h('div', { class: 'att' }), }; attRows[a.id] = r; attList.prepend(r.el); }
    r.a = a; r.el.innerHTML = '';
    const pill = h('span', { class: 'chip ' + ({ COMPLETED: 'ok', FAILED: 'bad', PROCESSING: 'warn', PENDING: 'gray' }[a.status] || 'gray') }, a.status + (a.failureReason ? ' · ' + a.failureReason : ''));
    r.el.append(h('div', null, h('b', null, a.fileName), h('span', { class: 'muted small' }, ' ' + fmtSize(a.sizeBytes))), pill);
    r.bar = h('i'); r.el.append(h('div', { class: 'prog' }, r.bar)); r.bar.style.width = (r.pct ?? (a.status === 'PENDING' ? 0 : 100)) + '%';
    r.steps = h('div', { class: 'steps' }, r.stepText || ''); r.el.append(r.steps);
    if (a.status === 'COMPLETED') r.el.append(h('div', null, h('button', { class: 'small', onclick: () => download(a) }, '⬇ Descargar (URL pre-firmada, 5 min)')));
    return r;
  }
  async function download(a) {
    try { const r = await api('GET', `/attachments/${a.id}/download-url`); window.open(r.data.url, '_blank', 'noopener'); }
    catch (e) { toast('No se pudo obtener la URL', errMsg(e), 'bad'); }
  }
  async function refreshAtt(id) { try { const r = await api('GET', `/attachments/${id}`); attRow(r.data); return r.data; } catch { return null; } }
  attIds.forEach(id => refreshAtt(id));
  state.openTask.attachmentUpdated = a => { if (attRows[a.id] || attIds.includes(a.id)) attRow({ ...(attRows[a.id] ? attRows[a.id].a : {}), ...a }); };

  async function upload(file) {
    status.textContent = '';
    const ct = contentTypeOf(file);
    let auth;
    const row = attRow({ id: 'tmp-' + Date.now(), fileName: file.name, sizeBytes: file.size, status: 'PENDING' });
    const step = (t, pct) => { row.stepText = t; row.steps.textContent = t; if (pct != null) { row.pct = pct; row.bar.style.width = pct + '%'; } };
    try {
      step('1/4 Pidiendo URL pre-firmada a la API (solo metadatos, sin bytes)…', 0);
      const r = await api('POST', `/tasks/${taskId}/attachments`, { body: { fileName: file.name, contentType: ct, sizeBytes: file.size } });
      auth = r.data; delete attRows[row.a.id]; row.el.remove();
      const a = attRow(auth.attachment); const rr = attRows[a.a.id];
      attIds.unshift(a.a.id); store.set('att.' + taskId, attIds);
      const stepR = (t, pct) => { rr.stepText = t; rr.steps.textContent = t; if (pct != null) { rr.pct = pct; rr.bar.style.width = pct + '%'; } };
      stepR(`2/4 Subiendo directo a ${new URL(auth.upload.url).host} (la API no ve el archivo)…`, 0);
      const form = new FormData();
      Object.entries(auth.upload.fields).forEach(([k, v]) => form.append(k, v));
      form.append('file', file);
      let sent = 0;
      let result = await new Promise(resolve => {
        const x = new XMLHttpRequest(); x.open('POST', auth.upload.url);
        x.upload.onprogress = ev => { sent = ev.loaded; if (ev.lengthComputable) stepR(`2/4 Subiendo directo al storage… ${Math.round(ev.loaded / ev.total * 100)}%`, ev.loaded / ev.total * 100); };
        x.onload = () => resolve({ ok: x.status >= 200 && x.status < 300, status: x.status });
        x.onerror = () => resolve({ ok: false, status: 0 });
        x.send(form);
      });
      let mode = 'xhr';
      if (!result.ok && result.status === 0 && sent === 0) {
        // Listening to upload progress forces a CORS preflight, which a bucket without CORS rejects before any
        // byte is sent. A plain POST is a "simple" request (no preflight), so retry it that way (no progress bar).
        mode = 'simple';
        stepR('2/4 Subiendo directo al storage (sin barra de progreso: el bucket no tiene CORS)…', 50);
        try { await fetch(auth.upload.url, { method: 'POST', body: form, mode: 'no-cors' }); result = { ok: true, status: 0 }; }
        catch { result = { ok: false, status: 0 }; }
      }
      logHttp({ feature: 'F4', time: new Date().toLocaleTimeString(), method: 'POST', path: auth.upload.url.replace(/^https?:\/\//, '') + ' (direct)', status: result.status, ms: 0, reqBody: `multipart (${mode === 'xhr' ? 'con progreso' : 'petición simple, sin preflight'}): ${Object.keys(auth.upload.fields).length} campos + file (${fmtSize(file.size)})`, resBody: result.status === 0 ? 'respuesta ilegible por CORS del bucket (normal); la subida se verifica con /confirm' : '' });
      if (!result.ok && result.status !== 0) throw new ApiError(result.status, { code: 'STORAGE_REJECTED', detail: `El storage rechazó la subida (${result.status}): política vencida, tipo o tamaño distinto.` });
      stepR('3/4 Confirmando con la API (HEAD al objeto + job en el outbox)…', 100);
      const c = await api('POST', `/attachments/${auth.attachment.id}/confirm`, {});
      attRow(c.data); const r3 = attRows[c.data.id]; r3.pct = 100; r3.bar.style.width = '100%';
      r3.stepText = '4/4 Procesando en segundo plano (File Worker)… la API ya está libre.'; r3.steps.textContent = r3.stepText;
      pollAtt(auth.attachment.id);
    } catch (e) { step('Falló: ' + e.message, 0); status.textContent = errMsg(e); }
  }
  async function pollAtt(id) {
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 2000));
      if (!attRows[id]) return;
      const a = await refreshAtt(id); if (!a) return;
      if (a.status === 'COMPLETED' || a.status === 'FAILED') { const r = attRows[id]; r.stepText = a.status === 'COMPLETED' ? 'Listo.' : 'El procesamiento falló.'; r.steps.textContent = r.stepText; return; }
    }
  }
  const fileInput = h('input', { type: 'file', style: 'display:none', onchange: ev => { const f = ev.target.files[0]; ev.target.value = ''; if (f) upload(f); } });

  const body = h('div', null,
    h('div', { class: 'head' }, h('h3', null, 'Tarjeta'), verChip, h('span', { class: 'chip gray' }, 'rol: ' + state.board.myRole), h('span', { class: 'sp' }), h('button', { class: 'ghost', onclick: () => mod.close() }, '✕')),
    banner,
    h('label', null, 'Título'), title,
    h('label', null, 'Descripción'), desc,
    h('div', { class: 'grid2' }, h('div', null, h('label', null, 'Fecha límite'), due), h('div', null, h('label', null, 'Columna'), h('div', { style: 'display:flex;gap:6px' }, colSel, h('button', { disabled: !editable, onclick: move }, 'Mover')))),
    users.length ? [h('label', null, 'Asignados (usuarios conocidos)'), assigneeBox] : null,
    status,
    h('div', { class: 'actions' },
      editable ? h('button', { class: 'small', title: 'Hace una edición como "otra persona" para que tu próximo guardado reciba 412', onclick: simulateOther }, '⚡ Simular edición concurrente') : null,
      h('button', { class: 'primary', disabled: !editable, onclick: save }, 'Guardar')),
    h('div', { class: 'box' }, h('h4', null, 'Adjuntos · subida directa al storage'),
      editable ? h('div', null, h('button', { onclick: () => fileInput.click() }, '+ Adjuntar archivo'), h('span', { class: 'small muted', style: 'margin-left:8px' }, 'Hasta 250 MiB · png, jpg, webp, gif, pdf, psd, ai/eps, zip'), fileInput) : h('div', { class: 'muted small' }, 'Tu rol no permite subir archivos.'),
      attList, !attIds.length ? h('div', { class: 'small muted', style: 'margin-top:8px' }, 'Los adjuntos que subas desde este navegador aparecerán aquí (la API no lista adjuntos por tarea).') : null));
  mod.el.append(body);
}

/* =====================================================================
   REALTIME (F5): one-time ticket -> WebSocket -> subscribe -> events
   ===================================================================== */
let wsTimer = null, wsBackoff = 1000, wsSeq = 0;
function setWsStatus(s) { state.wsStatus = s; const l = $('#live'); if (l) { l.className = 'live ' + (s === 'on' ? 'on' : s === 'off' ? 'off' : ''); l.lastChild.textContent = s === 'on' ? 'En vivo' : s === 'off' ? 'Sin conexión en vivo' : 'Conectando…'; } }
async function connectWs(isReconnect) {
  if (!state.board) return;
  const boardId = state.board.id; setWsStatus('connecting');
  try {
    const t = await api('POST', '/realtime/tickets', {});
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?ticket=${encodeURIComponent(t.data.ticket)}`;
    const ws = new WebSocket(url); state.ws = ws;
    ws.onopen = () => { wsBackoff = 1000; ws.send(JSON.stringify({ type: 'subscribe', requestId: String(++wsSeq), boardId })); if (isReconnect) refreshSummary(true); };
    ws.onmessage = m => handleWsMessage(m.data, boardId);
    ws.onclose = ev => {
      if (state.ws !== ws) return; state.ws = null; setWsStatus('off');
      logEvent({ time: new Date().toLocaleTimeString(), type: 'socket cerrado', note: 'código ' + ev.code, raw: '' });
      if (state.board && state.board.id === boardId) { wsTimer = setTimeout(() => connectWs(true), wsBackoff); wsBackoff = Math.min(wsBackoff * 2, 30000); }
    };
  } catch (e) {
    setWsStatus('off');
    if (state.board && state.board.id === boardId) { wsTimer = setTimeout(() => connectWs(true), wsBackoff); wsBackoff = Math.min(wsBackoff * 2, 30000); }
  }
}
function disconnectWs() { clearTimeout(wsTimer); if (state.ws) { const w = state.ws; state.ws = null; w.close(); } state.wsStatus = 'off'; }

function handleWsMessage(raw, boardId) {
  let msg; try { msg = JSON.parse(raw); } catch { return; }
  const time = new Date().toLocaleTimeString();
  if (msg.type === 'subscribed') { setWsStatus('on'); logEvent({ time, type: 'subscribed', note: 'suscrito a ' + short(msg.boardId), raw }); return; }
  if (msg.type === 'error') { setWsStatus('off'); logEvent({ time, type: 'error', note: msg.code, raw }); toast('Tiempo real', `${msg.code}: ${msg.message || ''}`, 'bad'); return; }
  if (msg.type !== 'event' || !state.board || msg.boardId !== boardId) return;
  const ev = msg.event;
  if (state.seenEvents.has(ev.eventId)) { logEvent({ time, type: ev.eventType, note: 'ignorado: eventId duplicado', raw }); return; }
  state.seenEvents.add(ev.eventId);
  const mine = ev.actorId === state.user.id; const who = mine ? 'Tú' : (knownUsers()[ev.actorId] ? knownUsers()[ev.actorId].displayName : 'Otro usuario');
  const lat = Math.max(0, Date.now() - new Date(ev.occurredAt).getTime());
  if (ev.eventType.startsWith('task.')) {
    const card = ev.data.task; const title = card.title;
    const applied = applyCard(toCard(card), !mine);
    logEvent({ time, type: ev.eventType, note: applied ? `aplicado v${ev.aggregate.version} · llegó ${lat} ms tras el commit` : `ignorado: v${ev.aggregate.version} ya vista`, raw });
    if (applied && !mine) {
      const col = state.summary.columns.find(c => c.id === card.columnId);
      const txt = ev.eventType === 'task.created' ? `${who} creó «${title}»` : ev.eventType === 'task.moved' ? `${who} movió «${title}» a ${col ? col.name : '…'}` : `${who} editó «${title}» (${(ev.data.changedFields || []).join(', ')})`;
      toast('🔔 Tablero modificado', `${txt} · ${lat} ms`, 'rt', 7000);
    }
    if (state.openTask && state.openTask.id === card.id && card.version > state.openTask.version() && !mine) state.openTask.banner(card.version);
  } else if (ev.eventType === 'attachment.processed') {
    logEvent({ time, type: ev.eventType, note: ev.data.attachment ? ev.data.attachment.status : '', raw });
    if (ev.data.attachment) { if (state.openTask && state.openTask.attachmentUpdated) state.openTask.attachmentUpdated(ev.data.attachment); toast('Adjunto procesado', `${ev.data.attachment.fileName}: ${ev.data.attachment.status}`, ev.data.attachment.status === 'COMPLETED' ? 'ok' : 'bad'); }
  } else logEvent({ time, type: ev.eventType, note: 'recibido', raw });
}

/* ---------- deep link: http://localhost:8080/#board=<boardId> ---------- */
function openDeepLink() {
  const m = /#board=([0-9a-f-]{36})/i.exec(location.hash);
  if (m && state.token && !state.board) openBoard(m[1]);
}

/* ---------- guided test checklist ---------- */
function openGuide() {
  const item = (tag, title, steps) => [h('h4', null, h('span', { class: 'tag' }, tag), title), h('ol', null, steps.map(x => h('li', null, x)))];
  const body = h('div', { class: 'guide' },
    h('div', { class: 'head' }, h('h3', null, 'Guía de pruebas'), h('span', { class: 'sp' }), h('button', { class: 'ghost', onclick: () => mod.close() }, '✕')),
    h('p', { class: 'muted' }, 'Abre dos ventanas en la misma dirección: una como Marta (OWNER) y otra como Nicolás (EDITOR). Cada pestaña tiene su propia sesión. Abre «Evidencias» (barra inferior) para ver cada petición y evento.'),
    item('F1', 'Roles y permisos', ['Con Nicolás, comprueba que NO aparece «+ Miembro del tablero» (solo ADMIN).', 'Con Valeria (VIEWER): las tarjetas no se arrastran y «Guardar» está deshabilitado.', 'Con Esteban abre el tablero por ID: aviso 404 (no revela que existe).']),
    item('F2', 'Resumen liviano', ['Pulsa «↻ Recargar» y mira en Evidencias el GET /summary: solo tarjetas, sin descripciones.', 'La cabecera muestra el tiempo de carga; la segunda lectura sale de Redis.']),
    item('F3', 'Control de concurrencia', ['Abre una tarjeta, escribe una descripción y pulsa «⚡ Simular edición concurrente».', 'Pulsa «Guardar»: aparece el 412 y el diálogo para decidir qué conservar.', 'Marca «Modo prueba: omitir If-Match» en Evidencias y guarda: 428.']),
    item('F4', 'Archivos pesados', ['En una tarjeta pulsa «Adjuntar archivo» y elige un .zip o .pdf grande.', 'En Evidencias, la subida va a localhost:9000 (storage), no a la API.', 'El estado pasa de PENDING a COMPLETED (lo procesa el File Worker).']),
    item('F5', 'Notificaciones en vivo', ['Con las dos ventanas lado a lado, arrastra una tarjeta en la de Marta.', 'La de Nicolás la mueve sola y muestra «🔔 Tablero modificado · N ms».', 'En Evidencias → «Tiempo real (WS)» queda el evento completo.']),
    h('div', { class: 'hint' }, 'Atajo: abre http://localhost:8080/#board=ID_DEL_TABLERO y entrarás directo al tablero tras iniciar sesión.'));
  const mod = openModal(body, { wide: true });
}

/* ---------- boot ---------- */
if (state.token && state.user) loadLocal();
renderApp();
openDeepLink();
