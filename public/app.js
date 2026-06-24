/* ═══════════════════════════════════════════
   STATE
═══════════════════════════════════════════ */
let sb = null;                   // Supabase JS client
let currentUser = null;          // UUID de auth.users
let currentProfile = null;       // { full_name, initials, role }
let roleReal = null;             // rol REAL del usuario (el toggle "Ver como" muta currentProfile.role solo en memoria)
let USERS = {};                  // map UUID → { name, initials, role }
let state = { simple: [], progress: [], assigned: [], invites: [] };
let tkView = 'kanban';
let tkScope = 'personal';
let tkType = 'simple';
let tkId = Date.now();
let saveTimer = null;

/* ═══════════════════════════════════════════
   AUTH — Supabase
═══════════════════════════════════════════ */
async function initSupabase() {
  const r = await fetch('/api/config');
  if (!r.ok) throw new Error('No se pudo cargar configuración');
  const cfg = await r.json();
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
    throw new Error('Configuración de Supabase incompleta');
  }
  sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
}

async function loadProfile(userId) {
  const { data, error } = await sb
    .from('profiles')
    .select('id, full_name, initials, role')
    .eq('id', userId)
    .single();
  if (error) throw error;
  return data;
}

async function loadAllProfiles() {
  const { data, error } = await sb
    .from('profiles')
    .select('id, full_name, initials, role');
  if (error) throw error;
  USERS = {};
  data.forEach(p => {
    USERS[p.id] = {
      name: p.full_name,
      initials: p.initials || (p.full_name || '?').slice(0,2).toUpperCase(),
      role: p.role,
    };
  });
}

async function enterApp(user) {
  currentUser = user.id;
  mfaMarkActive(user.id);   // renueva la confianza de 2FA y arranca el rastreo de inactividad
  mfaHookActivity();
  currentProfile = await loadProfile(user.id);
  roleReal = currentProfile.role;   // rol real (para el toggle "Ver como" — solo admin lo ve)
  await loadAllProfiles();
  document.getElementById('headerAv').textContent = currentProfile.initials || '—';
  document.getElementById('headerUser').textContent = currentProfile.full_name;
  document.getElementById('loginWrap').style.display = 'none';
  document.getElementById('app').style.display = 'block';

  // pills de multi-asignación — todos menos uno mismo
  const wrap = document.getElementById('aAssignees');
  wrap.innerHTML = Object.entries(USERS)
    .filter(([k]) => k !== currentUser)
    .map(([k,v]) => `
      <button type="button" class="multi-pill" data-uid="${k}" onclick="toggleAssignee(this)">
        <span class="multi-pill-av">${v.initials}</span>
        <span class="multi-pill-name">${v.name}</span>
      </button>`).join('');

  await loadReminderPrefs();
  applyThemeToggleState();

  // Saludo (en selector y en home)
  const firstName = (currentProfile.full_name || '').split(' ')[0] || 'tú';
  const greet = greetingForTime();
  document.getElementById('homeUserName').textContent = firstName;
  document.getElementById('homeGreet').textContent = greet;
  document.getElementById('selUserName').textContent = firstName;
  document.getElementById('selGreet').textContent = greet;

  // Restaura la vista desde el hash de la URL (o selector si no hay/ inválido)
  currentOrg = null;
  applyOrgTheme();
  renderNavList();
  applyRoute();

  loadData();
}

function greetingForTime() {
  const h = new Date().getHours();
  if (h < 6)  return 'Buenas noches';
  if (h < 12) return 'Buenos días';
  if (h < 19) return 'Buenas tardes';
  return 'Buenas noches';
}

// Mostrar/ocultar la contraseña del login (ojo abierto/cerrado)
function toggleLoginPass() {
  const inp = document.getElementById('loginPass');
  const btn = document.getElementById('loginEye');
  if (!inp) return;
  const show = inp.type === 'password';
  inp.type = show ? 'text' : 'password';
  const ic = btn?.querySelector('i');
  if (ic) ic.className = show ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye';
  if (btn) { btn.title = show ? 'Ocultar contraseña' : 'Mostrar contraseña'; btn.setAttribute('aria-label', btn.title); }
  inp.focus();
}

async function doLogin() {
  const email = document.getElementById('loginUser').value.trim();
  const pass = document.getElementById('loginPass').value;
  const err = document.getElementById('loginErr');
  if (!email || !pass) { err.style.display = 'block'; return; }
  if (!sb) {
    err.innerHTML = '<i class="fa-solid fa-circle-exclamation"></i> No se pudo cargar la configuración del servidor. Recarga la página.';
    err.classList.add('show'); err.style.display = 'block';
    console.error('[login] sb no inicializado (config no cargó)');
    return;
  }
  let data, error;
  try {
    ({ data, error } = await sb.auth.signInWithPassword({ email, password: pass }));
  } catch (e) {
    error = e;
  }
  if (error || !data?.user) {
    const m = (error && (error.message || String(error))) || '';
    let txt = 'Credenciales inválidas';
    if (/invalid login credentials/i.test(m)) txt = 'Correo o contraseña incorrectos';
    else if (/email not confirmed/i.test(m)) txt = 'Falta confirmar el correo de esta cuenta';
    else if (/failed to fetch|networkerror|load failed/i.test(m)) txt = 'No se pudo conectar con el servidor (revisa tu conexión)';
    else if (m) txt = m;
    err.innerHTML = `<i class="fa-solid fa-circle-exclamation"></i> ${txt}`;
    err.classList.add('show'); err.style.display = 'block';
    console.error('[login]', error);
    return;
  }
  // 2FA: pide el código solo si la confianza por inactividad expiró
  if (await mfaGateNeeded(data.user.id)) {
    const ok = await mfaPromptLogin();
    if (!ok) { await sb.auth.signOut(); return; }   // canceló → no entra
  }
  err.classList.remove('show');
  document.getElementById('loginPass').value = '';
  await enterApp(data.user);
}

async function doLogout() {
  if (sb) await sb.auth.signOut();
  currentUser = null;
  currentProfile = null;
  USERS = {};
  dbLoaded = false;
  dbInvestors = [];
  dbCompanies = [];
  dbSeries = [];
  Object.keys(dbInvestorCompanies).forEach(k => delete dbInvestorCompanies[k]);
  Object.keys(dbInvestorSeries).forEach(k => delete dbInvestorSeries[k]);
  closeNav();
  document.getElementById('settingsPop')?.classList.remove('show');
  document.getElementById('headerUserBtn')?.classList.remove('open');
  document.getElementById('loginWrap').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
  document.getElementById('loginPass').value = '';
  // reset al selector para siguiente login
  currentOrg = null;
  applyOrgTheme();
  switchView('selector');
}

async function getAccessToken() {
  const { data } = await sb.auth.getSession();
  return data?.session?.access_token || null;
}

async function authedFetch(url, opts = {}) {
  let token = await getAccessToken();
  const headers = { ...(opts.headers || {}) };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  let r = await fetch(url, { ...opts, headers });

  // Si 401, intenta refrescar la sesión una vez y reintenta
  if (r.status === 401) {
    try {
      const { data: refreshed } = await sb.auth.refreshSession();
      const newToken = refreshed?.session?.access_token;
      if (newToken && newToken !== token) {
        headers['Authorization'] = 'Bearer ' + newToken;
        r = await fetch(url, { ...opts, headers });
      }
    } catch (e) {
      console.warn('Token refresh falló:', e.message);
    }
  }
  return r;
}

/* ═══════════════════════════════════════════
   2FA / MFA (TOTP) — verificación en dos pasos
═══════════════════════════════════════════ */
let mfaLoginResolve = null;     // resolver de la promesa del reto de login
let mfaEnrollData = null;       // { factorId } durante el enrolamiento

// Ventana de "confianza": tras verificar, no se vuelve a pedir el código
// mientras haya actividad; se exige de nuevo tras este tiempo de INACTIVIDAD.
const MFA_TRUST_MS = 2 * 60 * 60 * 1000;   // 2 horas
function mfaMarkActive(uid) {
  try { localStorage.setItem('cretum_mfa_active', JSON.stringify({ uid, ts: Date.now() })); } catch (_) {}
}
function mfaTrusted(uid) {
  try {
    const o = JSON.parse(localStorage.getItem('cretum_mfa_active') || 'null');
    return !!o && o.uid === uid && (Date.now() - o.ts) < MFA_TRUST_MS;
  } catch (_) { return false; }
}
// Actualiza el "último activo" con la interacción del usuario (throttle 30s)
let mfaActivityHooked = false;
function mfaHookActivity() {
  if (mfaActivityHooked) return;
  mfaActivityHooked = true;
  let last = 0;
  const bump = () => {
    if (!currentUser) return;
    const now = Date.now();
    if (now - last > 30000) { last = now; mfaMarkActive(currentUser); }
  };
  ['click', 'keydown', 'mousemove', 'scroll', 'touchstart', 'visibilitychange']
    .forEach(ev => window.addEventListener(ev, bump, { passive: true }));
}

// ¿Hay que pedir el código? Solo si la cuenta tiene 2FA activo y se acabó la confianza.
async function mfaGateNeeded(userId) {
  let hasFactor = false;
  try {
    const { data } = await sb.auth.mfa.listFactors();
    hasFactor = !!(data?.totp || []).find(f => f.status === 'verified');
  } catch (e) { console.warn('[mfa] listFactors', e?.message); }
  if (!hasFactor) return false;          // sin 2FA → nunca pide
  if (mfaTrusted(userId)) return false;  // sesión activa reciente → confía, no pide
  return true;                            // 2FA activo + expiró la confianza → pide código
}

// ── Reto en el login: pide el código de 6 dígitos ──
function mfaPromptLogin() {
  return new Promise((resolve) => {
    mfaLoginResolve = resolve;
    document.getElementById('mfaLoginCode').value = '';
    const msg = document.getElementById('mfaLoginMsg'); msg.textContent = ''; msg.className = 'camp-modal-msg';
    document.getElementById('mfaLoginModal').classList.add('show');
    setTimeout(() => document.getElementById('mfaLoginCode').focus(), 60);
  });
}
async function mfaLoginVerify() {
  const code = (document.getElementById('mfaLoginCode').value || '').trim();
  const msg = document.getElementById('mfaLoginMsg');
  const btn = document.getElementById('mfaLoginBtn');
  if (!/^\d{6}$/.test(code)) { msg.textContent = 'Ingresa los 6 dígitos.'; msg.className = 'camp-modal-msg err'; return; }
  btn.disabled = true;
  try {
    const { data: f } = await sb.auth.mfa.listFactors();
    const totp = (f?.totp || [])[0];
    if (!totp) throw new Error('No hay factor configurado');
    const { data: ch, error: e1 } = await sb.auth.mfa.challenge({ factorId: totp.id });
    if (e1) throw e1;
    const { error: e2 } = await sb.auth.mfa.verify({ factorId: totp.id, challengeId: ch.id, code });
    if (e2) throw e2;
    document.getElementById('mfaLoginModal').classList.remove('show');
    btn.disabled = false;
    if (mfaLoginResolve) { mfaLoginResolve(true); mfaLoginResolve = null; }
  } catch (err) {
    btn.disabled = false;
    msg.textContent = /invalid|incorrect|expired/i.test(err.message || '') ? 'Código incorrecto o expirado, intenta de nuevo.' : ('Error: ' + err.message);
    msg.className = 'camp-modal-msg err';
  }
}
function mfaLoginCancel() {
  document.getElementById('mfaLoginModal').classList.remove('show');
  if (mfaLoginResolve) { mfaLoginResolve(false); mfaLoginResolve = null; }
}

// ── Gestión desde el perfil: enrolar / desactivar ──
function mfaRender(html) { document.getElementById('mfaBody').innerHTML = html; }
async function mfaOpen() {
  document.getElementById('settingsPop')?.classList.remove('show');
  document.getElementById('headerUserBtn')?.classList.remove('open');
  document.getElementById('mfaModal').classList.add('show');
  mfaRender('<div class="mfa-loading">Cargando…</div>');
  await mfaRefresh();
}
function mfaClose() { document.getElementById('mfaModal').classList.remove('show'); mfaEnrollData = null; }

async function mfaRefresh() {
  try {
    const { data, error } = await sb.auth.mfa.listFactors();
    if (error) throw error;
    const verified = (data?.totp || []).find(f => f.status === 'verified');
    if (verified) {
      mfaRender(`
        <div class="mfa-status on"><i class="fa-solid fa-circle-check"></i> 2FA activo</div>
        <p class="mfa-p">Tu cuenta pide un código de tu app de autenticación cada vez que inicias sesión.</p>
        <button class="camp-prev-cancel mfa-danger" onclick="mfaDisable('${verified.id}')"><i class="fa-solid fa-shield-halved"></i> Desactivar 2FA</button>`);
    } else {
      mfaRender(`
        <div class="mfa-status off"><i class="fa-solid fa-shield-halved"></i> 2FA desactivado</div>
        <p class="mfa-p">Suma una capa extra de seguridad: además de tu contraseña, un código de 6 dígitos desde tu celular (Google Authenticator, Authy o Microsoft Authenticator).</p>
        <button class="btn-primary" onclick="mfaStartEnroll()"><i class="fa-solid fa-plus"></i> Activar 2FA</button>`);
    }
  } catch (e) {
    mfaRender(`<div class="mfa-status off">Error: ${escapeHtml(e.message)}</div>`);
  }
}

async function mfaStartEnroll() {
  mfaRender('<div class="mfa-loading">Generando código…</div>');
  try {
    // Limpia enrolamientos previos sin verificar (evita topar el límite de factores)
    const { data: existing } = await sb.auth.mfa.listFactors();
    for (const f of (existing?.all || [])) {
      if (f.status !== 'verified') { try { await sb.auth.mfa.unenroll({ factorId: f.id }); } catch (_) {} }
    }
    // issuer = nombre que muestra la app de autenticación (sin esto saldría el host, ej. localhost:3000)
    const { data, error } = await sb.auth.mfa.enroll({ factorType: 'totp', issuer: 'CretumDesk', friendlyName: 'Cretum-' + Date.now() });
    if (error) throw error;
    mfaEnrollData = { factorId: data.id };
    const qr = data.totp.qr_code || '';
    const secret = data.totp.secret || '';
    const qrHtml = qr.trim().startsWith('<svg') ? qr : `<img src="${escapeHtml(qr)}" alt="QR 2FA">`;
    mfaRender(`
      <p class="mfa-p"><strong>1.</strong> Escanea este código con tu app de autenticación:</p>
      <div class="mfa-qr">${qrHtml}</div>
      <p class="mfa-p mfa-secret">¿No puedes escanear? Ingresa esta clave a mano:<br><code>${escapeHtml(secret)}</code></p>
      <label class="camp-f-lbl"><strong>2.</strong> Escribe el código de 6 dígitos que muestra la app</label>
      <input id="mfaEnrollCode" class="camp-f-inp" inputmode="numeric" maxlength="6" placeholder="000000" onkeydown="if(event.key==='Enter')mfaConfirmEnroll()">
      <div class="camp-modal-msg" id="mfaEnrollMsg"></div>
      <div class="mfa-actions">
        <button class="camp-prev-cancel" onclick="mfaCancelEnroll()">Cancelar</button>
        <button class="btn-primary" id="mfaEnrollBtn" onclick="mfaConfirmEnroll()"><i class="fa-solid fa-check"></i> Confirmar</button>
      </div>`);
    setTimeout(() => document.getElementById('mfaEnrollCode')?.focus(), 60);
  } catch (e) {
    mfaRender(`<div class="mfa-status off">Error: ${escapeHtml(e.message)}</div><button class="btn-primary" onclick="mfaRefresh()">Volver</button>`);
  }
}
async function mfaConfirmEnroll() {
  const code = (document.getElementById('mfaEnrollCode').value || '').trim();
  const msg = document.getElementById('mfaEnrollMsg');
  const btn = document.getElementById('mfaEnrollBtn');
  if (!/^\d{6}$/.test(code)) { msg.textContent = 'Ingresa los 6 dígitos.'; msg.className = 'camp-modal-msg err'; return; }
  if (!mfaEnrollData) return;
  btn.disabled = true;
  try {
    const { data: ch, error: e1 } = await sb.auth.mfa.challenge({ factorId: mfaEnrollData.factorId });
    if (e1) throw e1;
    const { error: e2 } = await sb.auth.mfa.verify({ factorId: mfaEnrollData.factorId, challengeId: ch.id, code });
    if (e2) throw e2;
    mfaEnrollData = null;
    toast('2FA activado correctamente');
    await mfaRefresh();
  } catch (err) {
    btn.disabled = false;
    msg.textContent = /invalid|incorrect|expired/i.test(err.message || '') ? 'Código incorrecto o expirado, intenta de nuevo.' : ('Error: ' + err.message);
    msg.className = 'camp-modal-msg err';
  }
}
async function mfaCancelEnroll() {
  if (mfaEnrollData) { try { await sb.auth.mfa.unenroll({ factorId: mfaEnrollData.factorId }); } catch (_) {} mfaEnrollData = null; }
  await mfaRefresh();
}
async function mfaDisable(factorId) {
  if (!confirm('¿Desactivar la verificación en dos pasos?\nTu cuenta quedará protegida solo con contraseña.')) return;
  try {
    const { error } = await sb.auth.mfa.unenroll({ factorId });
    if (error) throw error;
    toast('2FA desactivado');
    await mfaRefresh();
  } catch (e) { toast('Error: ' + e.message); }
}

// Boot: init Supabase y revisa si hay sesión activa
window.addEventListener('DOMContentLoaded', async () => {
  try {
    await initSupabase();
    const { data } = await sb.auth.getSession();
    if (data?.session?.user) {
      // 2FA: exige el código solo si la confianza por inactividad expiró
      if (await mfaGateNeeded(data.session.user.id)) {
        const ok = await mfaPromptLogin();
        if (!ok) { await sb.auth.signOut(); return; }  // queda en la pantalla de login
      }
      await enterApp(data.session.user);
    }
  } catch (e) {
    console.error('Boot error', e);
    setTimeout(() => toast('Error de configuración: ' + e.message), 100);
  }
});

/* ═══════════════════════════════════════════
   API — carga y guarda en Vercel
═══════════════════════════════════════════ */
async function loadData() {
  if (!currentUser) return;
  setSyncStatus('loading');
  try {
    const r = await authedFetch('/api/tasks');
    if (!r.ok) {
      let detail = 'HTTP ' + r.status;
      if (r.status === 401) detail = 'sesión expirada — recarga la página';
      throw new Error(detail);
    }
    state = await r.json();
    ['simple','progress','assigned','invites'].forEach(k => {
      if (!Array.isArray(state[k])) state[k] = [];
    });
    render();
    setSyncStatus('ok');
  } catch(e) {
    setSyncStatus('error');
    toast('No se pudo sincronizar: ' + e.message);
    render();
  }
}

async function saveData() {
  if (!currentUser) return;
  setSyncStatus('saving');
  try {
    const r = await authedFetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state)
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    setSyncStatus('ok');
  } catch(e) {
    setSyncStatus('error');
    toast('Error al guardar — reintentando…');
    setTimeout(saveData, 4000);
  }
}

// Debounced save — espera 800ms después del último cambio
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveData, 800);
}

function setSyncStatus(s) {
  const dot = document.getElementById('syncDot');
  const lbl = document.getElementById('syncLabel');
  dot.className = 'sync-dot' + (s === 'saving' ? ' saving' : s === 'error' ? ' error' : '');
  lbl.textContent = s === 'loading' ? 'Cargando…' : s === 'saving' ? 'Guardando…' : s === 'error' ? 'Sin conexión' : 'Sincronizado';
}

/* ═══════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════ */
function animateCounter(id, to) {
  const el = document.getElementById(id);
  if (!el) return;
  const from = parseInt(el.textContent) || 0;
  if (from === to) { el.textContent = to; return; }
  const dur = 450, start = performance.now();
  function step(now) {
    const p = Math.min(1, (now - start) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(from + (to - from) * eased);
    if (p < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

function fmtD(d) {
  if (!d) return '';
  const dt = new Date(d + 'T12:00:00');
  const today = new Date(); today.setHours(0,0,0,0);
  const diff = Math.round((dt - today) / 86400000);
  if (diff === 0) return 'Hoy';
  if (diff === 1) return 'Mañana';
  if (diff === -1) return 'Ayer';
  return dt.toLocaleDateString('es-MX', { day: 'numeric', month: 'short' });
}
function isOD(d) { return d && new Date(d + 'T12:00:00') < new Date(); }
function prioC(p) { return p === 'Alta' ? 'lp-a' : p === 'Media' ? 'lp-m' : 'lp-b'; }
function pct(t) { return Math.min(100, Math.round((t.done / t.total) * 100)); }
function isDone(t) { return t.kind === 'simple' ? t.done : t.done >= t.total; }
function allTasks() {
  return [
    ...state.simple.map(t => ({ ...t, kind: 'simple' })),
    ...state.progress.map(t => ({ ...t, kind: 'progress' }))
  ];
}
function myTasks() {
  return allTasks().filter(t => !t.owner || t.owner === currentUser);
}

/* ═══════════════════════════════════════════
   RENDER
═══════════════════════════════════════════ */
function render() {
  // invites para el usuario actual
  const myInvites = state.invites.filter(iv => iv.to === currentUser);
  document.getElementById('invitesEl').innerHTML = myInvites.map(iv => {
    const isProg = typeof iv.total === 'number' && iv.total > 0;
    const progLbl = isProg ? ` · ${iv.total} ${iv.unit || 'unidades'}` : '';
    return `
    <div class="tk-invite">
      <div class="tk-invite-info">
        <div class="tk-invite-from"><i class="fa-solid fa-user-plus"></i> ${USERS[iv.from]?.name || iv.from} te asignó una tarea${isProg ? ' con progreso' : ''}</div>
        <div class="tk-invite-name">${iv.name}</div>
        <div class="tk-invite-due">${iv.due ? 'Vence ' + fmtD(iv.due) + ' · ' : ''}${iv.prio} prioridad${progLbl}</div>
      </div>
      <button class="inv-accept" onclick="acceptInvite('${iv.id}')">Aceptar</button>
      <button class="inv-decline" onclick="declineInvite('${iv.id}')">Declinar</button>
    </div>`;
  }).join('');

  // stats (mis tareas)
  const mt = myTasks();
  const pend = mt.filter(t => !isDone(t)).length;
  const inprog = state.progress.filter(t => t.owner === currentUser && t.done > 0 && t.done < t.total).length;
  const done = mt.filter(t => isDone(t)).length;
  animateCounter('sPend',  pend);
  animateCounter('sProg',  inprog);
  animateCounter('sDone',  done);
  animateCounter('sTotal', mt.length);
  document.getElementById('rPend').textContent = pend;
  document.getElementById('rDone').textContent = done;

  // scope UI
  const isEquipo = tkScope === 'equipo';
  const isOtros  = tkScope === 'otros';
  document.getElementById('viewToggle').style.display = (isEquipo || isOtros) ? 'none' : 'flex';
  // En "Equipo" se asigna vía openAssignModal (botón propio en renderEquipo);
  // "Otros miembros" es solo lectura.
  // El botón "Nueva tarea" personal solo aplica en scope personal.
  document.getElementById('newTaskBtn').style.display = (isEquipo || isOtros) ? 'none' : 'flex';

  if (isEquipo) { renderEquipo(); return; }
  if (isOtros)  { renderOtros();  return; }

  const c = document.getElementById('viewContainer');
  if (tkView === 'lista')       c.innerHTML = buildLista();
  else if (tkView === 'kanban') c.innerHTML = buildKanban();
  else                          c.innerHTML = buildTimeline();
}

/* ── LISTA ── */
function buildLista() {
  const tasks = myTasks();
  if (!tasks.length) return '<div style="padding:32px;text-align:center;color:var(--gray-400)">Sin tareas</div>';
  return `<div class="list-view">${tasks.map((t, i) => {
    const done = isDone(t);
    const od = isOD(t.due) && !done;
    const delay = `style="animation-delay:${Math.min(i, 12) * 30}ms"`;
    if (t.kind === 'simple') return `
      <div class="list-item ${done ? 'done-item' : ''}" ${delay}>
        <div class="li-chk ${done ? 'on' : ''}" onclick="toggle('${t.id}','simple')">✓</div>
        <div class="li-name">${t.name}</div>
        <div class="li-meta">
          ${t.due ? `<span class="li-due ${od ? 'od' : ''}">${fmtD(t.due)}</span>` : ''}
          <span class="li-prio ${prioC(t.prio)}">${t.prio}</span>
          ${t.collab ? '<span class="li-tag">Colaborativa</span>' : ''}
          ${done
            ? `<button class="sm-btn sm-red" onclick="toggle('${t.id}','simple')">Reabrir</button>`
            : ''}
        </div>
        <button class="li-del" onclick="del('${t.id}','simple')"><i class="fa-solid fa-xmark"></i></button>
      </div>`;
    else {
      const p = pct(t);
      return `
      <div class="list-item ${done ? 'done-item' : ''}" ${delay}>
        <div class="li-chk ${done ? 'on' : ''}">✓</div>
        <div style="flex:1;min-width:0">
          <div class="li-name ${done ? 'struck' : ''}">${t.name}</div>
          <div class="li-prog">
            <div class="li-prog-bar"><div class="li-prog-fill" style="width:${p}%"></div></div>
            <span>${t.done}/${t.total} ${t.unit} · ${p}%</span>
          </div>
        </div>
        <div class="li-meta">
          ${t.due ? `<span class="li-due ${od ? 'od' : ''}">${fmtD(t.due)}</span>` : ''}
          <span class="li-prio ${prioC(t.prio)}">${t.prio}</span>
          ${done
            ? `<button class="sm-btn sm-red" onclick="toggle('${t.id}','progress')">Reabrir</button>`
            : `<span style="display:flex;align-items:center;gap:4px">
                <input type="number" placeholder="" id="l-${t.id}"
                  title="Positivo para sumar, negativo para corregir"
                  style="width:74px;padding:5px 9px;border:1px solid var(--gray-200);border-radius:var(--r-sm);font-size:13px;text-align:center;outline:none"
                  onkeydown="if(event.key==='Enter')addInc('${t.id}')">
                <button class="sm-btn sm-solid" onclick="addInc('${t.id}')">+</button>
                ${t.log.length ? `<button class="sm-btn sm-red" onclick="undoLog('${t.id}')" title="Deshacer última entrada">↩</button>` : ''}
              </span>`}
        </div>
        <button class="li-del" onclick="del('${t.id}','progress')"><i class="fa-solid fa-xmark"></i></button>
      </div>`;
    }
  }).join('')}</div>`;
}

/* ── KANBAN ── */
function buildKanban() {
  const tasks = myTasks();
  if (!tasks.length) return '<div style="padding:32px;text-align:center;color:var(--gray-400)">Sin tareas</div>';
  const cols = [
    { key: 'pending',  label: 'Pendiente',   dot: 'var(--gray-300)', tasks: [] },
    { key: 'progress', label: 'En progreso',  dot: 'var(--amber)',    tasks: [] },
    { key: 'done',     label: 'Completado',   dot: 'var(--green)',    tasks: [] },
  ];
  tasks.forEach(t => {
    if (isDone(t)) cols[2].tasks.push(t);
    else if (t.kind === 'progress' && t.done > 0) cols[1].tasks.push(t);
    else cols[0].tasks.push(t);
  });
  return `<div class="kanban-view">${cols.map(col => `
    <div class="kb-col">
      <div class="kb-col-head">
        <div class="kb-col-dot" style="background:${col.dot}"></div>
        <div class="kb-col-title">${col.label}</div>
        <span class="kb-col-count">${col.tasks.length}</span>
      </div>
      <div class="kb-cards">
        ${col.tasks.map((t, i) => {
          const done = isDone(t);
          const od = isOD(t.due) && !done;
          const p = t.kind === 'progress' ? pct(t) : null;
          const delay = `style="animation-delay:${Math.min(i, 12) * 35}ms"`;
          return `<div class="kb-card ${done ? 'done-card' : ''}" ${delay}>
            <button class="kb-del" onclick="del('${t.id}','${t.kind}')" title="Eliminar"><i class="fa-solid fa-xmark"></i></button>
            ${p !== null ? `
              <div class="kb-prog-label">${t.done}/${t.total} ${t.unit}</div>
              <div class="kb-prog"><div class="kb-prog-fill ${done ? 'complete' : ''}" style="width:${p}%"></div></div>` : ''}
            <div class="kb-card-name ${done ? 'struck' : ''}">${t.name}</div>
            <div class="kb-card-foot">
              ${t.due ? `<span class="kb-due ${od ? 'od' : ''}"><i class="fa-regular fa-calendar" style="font-size:10px"></i> ${fmtD(t.due)}</span>` : ''}
              <span class="kb-prio ${prioC(t.prio)}">${t.prio}</span>
              ${t.kind === 'simple' && !done
                ? `<button class="sm-btn sm-navy" style="margin-left:auto" onclick="toggle('${t.id}','simple')">Marcar lista</button>`
                : ''}
              ${t.kind === 'simple' && done
                ? `<button class="sm-btn sm-red" style="margin-left:auto" onclick="toggle('${t.id}','simple')">Reabrir</button>`
                : ''}
              ${t.kind === 'progress' && !done
                ? `<span style="display:flex;align-items:center;gap:4px;margin-left:auto">
                    <input type="number" placeholder="" id="k-${t.id}"
                      style="width:62px;padding:4px 8px;border:1px solid var(--gray-200);border-radius:var(--r-sm);font-size:12px;text-align:center;outline:none"
                      onkeydown="if(event.key==='Enter')addInc('${t.id}')">
                    <button class="sm-btn sm-solid" onclick="addInc('${t.id}')">+</button>
                    ${t.log.length ? `<button class="sm-btn sm-red" onclick="undoLog('${t.id}')" title="Deshacer">↩</button>` : ''}
                  </span>`
                : ''}
              ${t.kind === 'progress' && done
                ? `<button class="sm-btn sm-red" style="margin-left:auto" onclick="toggle('${t.id}','progress')">Reabrir</button>`
                : ''}
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>`).join('')}</div>`;
}

/* ── TIMELINE ── */
function buildTimeline() {
  const tasks = myTasks();
  if (!tasks.length) return '<div style="padding:32px;text-align:center;color:var(--gray-400)">Sin tareas</div>';
  const todayStr = new Date().toISOString().slice(0, 10);
  const grouped = {};
  tasks.forEach(t => {
    const k = t.due || 'sin-fecha';
    if (!grouped[k]) grouped[k] = [];
    grouped[k].push(t);
  });
  const sorted = Object.keys(grouped).sort((a, b) => {
    if (a === 'sin-fecha') return 1; if (b === 'sin-fecha') return -1;
    return a < b ? -1 : 1;
  });
  return `<div class="timeline-view">${sorted.map(day => {
    const isToday = day === todayStr;
    const isPast = day < todayStr && day !== 'sin-fecha';
    const lbl = day === 'sin-fecha' ? 'Sin fecha' : isToday ? 'Hoy · ' + fmtD(day) : fmtD(day);
    return `<div class="tl-day">
      <div class="tl-day-label ${isToday ? 'today-lbl' : ''}">${lbl}</div>
      <div class="tl-items">${grouped[day].map((t, i) => {
        const done = isDone(t);
        const od = isPast && !done;
        const p = t.kind === 'progress' ? pct(t) : null;
        const delay = `style="animation-delay:${Math.min(i, 12) * 30}ms"`;
        return `<div class="tl-item ${done ? 'ti-done' : od ? 'ti-overdue' : isToday ? 'ti-today' : ''}" ${delay}>
          ${t.kind === 'simple'
            ? `<div class="li-chk ${done ? 'on' : ''}" onclick="toggle('${t.id}','simple')">✓</div>`
            : ''}
          <div style="flex:1;min-width:0">
            <div class="tl-name ${done ? 'struck' : ''}">${t.name}</div>
            ${p !== null ? `
              <div style="margin-top:5px">
                <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--gray-400);margin-bottom:2px">
                  <span>${t.done}/${t.total} ${t.unit}</span><span>${p}%</span>
                </div>
                <div style="height:5px;background:var(--gray-100);border-radius:3px;overflow:hidden">
                  <div style="height:100%;background:${done ? 'var(--green)' : 'var(--navy)'};width:${p}%;border-radius:3px"></div>
                </div>
              </div>` : ''}
          </div>
          <div class="tl-side">
            <span class="li-prio ${prioC(t.prio)}">${t.prio}</span>
            ${t.kind === 'simple' && done
              ? `<button class="sm-btn sm-red" onclick="toggle('${t.id}','simple')">Reabrir</button>` : ''}
            ${t.kind === 'progress' && !done
              ? `<span style="display:flex;gap:4px;align-items:center">
                  <input type="number" placeholder="" id="t-${t.id}"
                    style="width:62px;padding:4px 8px;border:1px solid var(--gray-200);border-radius:var(--r-sm);font-size:12px;text-align:center;outline:none"
                    onkeydown="if(event.key==='Enter')addInc('${t.id}')">
                  <button class="sm-btn sm-solid" onclick="addInc('${t.id}')">+</button>
                  ${t.log.length ? `<button class="sm-btn sm-red" onclick="undoLog('${t.id}')" title="Deshacer">↩</button>` : ''}
                </span>` : ''}
            ${t.kind === 'progress' && done
              ? `<button class="sm-btn sm-red" onclick="toggle('${t.id}','progress')">Reabrir</button>` : ''}
            <button class="li-del" onclick="del('${t.id}','${t.kind}')"><i class="fa-solid fa-xmark"></i></button>
          </div>
        </div>`;
      }).join('')}</div>
    </div>`;
  }).join('')}</div>`;
}

/* ── EQUIPO ── */
function renderEquipo() {
  const myAssigned = state.assigned.filter(a => a.assignedBy === currentUser);
  const container = document.getElementById('viewContainer');

  const assignBtn = `
    <div style="text-align:center;margin-bottom:14px">
      <button class="tk-new-btn" onclick="openAssignModal()" style="display:inline-flex">
        <i class="fa-solid fa-paper-plane"></i> Asignar nueva tarea
      </button>
    </div>`;

  if (!myAssigned.length) {
    container.innerHTML = `
      ${assignBtn}
      <div style="font-size:11px;color:var(--gray-400);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px">Tareas asignadas por mí</div>
      <div style="padding:32px;text-align:center;color:var(--gray-400)">Aún no has asignado tareas — usa el botón de arriba.</div>`;
    return;
  }

  const rows = myAssigned.map(a => {
    const task = a.taskId
      ? (state.simple.find(t => t.id === a.taskId) || state.progress.find(t => t.id === a.taskId))
      : null;
    const isProgress = task && typeof task.done === 'number';
    const completed = task && (isProgress ? task.done >= task.total : task.done === true);

    let badge, progressBar = '';
    if (!a.accepted) {
      badge = '<span class="team-status ts-pen"><i class="fa-regular fa-clock"></i> Esperando</span>';
    } else if (!task) {
      badge = '<span class="team-status ts-warn"><i class="fa-solid fa-trash-can"></i> Eliminada</span>';
    } else if (completed) {
      badge = '<span class="team-status ts-done"><i class="fa-solid fa-check"></i> Completada</span>';
    } else if (isProgress) {
      const pct = Math.min(100, Math.round((task.done / task.total) * 100));
      badge = `<span class="team-status ts-ok">${pct}%</span>`;
      progressBar = `
        <div class="team-prog-wrap">
          <div class="team-prog-bar"><div class="team-prog-fill" style="width:${pct}%"></div></div>
          <span class="team-prog-lbl">${task.done}/${task.total} ${task.unit || ''}</span>
        </div>`;
    } else {
      badge = '<span class="team-status ts-ok"><i class="fa-solid fa-circle-play"></i> En progreso</span>';
    }

    return `
      <div class="team-item">
        <div class="team-av">${USERS[a.to]?.initials || a.to.slice(0,2).toUpperCase()}</div>
        <div style="flex:1;min-width:0">
          <div class="team-name">${a.name}</div>
          <div class="team-sub">→ ${USERS[a.to]?.name || a.to} · ${a.due ? fmtD(a.due) : 'Sin fecha'} · ${a.prio}</div>
          ${progressBar}
        </div>
        ${badge}
        ${!a.accepted ? `<button class="team-edit" onclick="openEditAssigned('${a.id}')" title="Editar tarea"><i class="fa-solid fa-pen"></i></button>` : ''}
        <button class="team-del" onclick="deleteAssigned('${a.id}')" title="Eliminar de mi lista">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>`;
  }).join('');

  container.innerHTML = `
    ${assignBtn}
    <div style="font-size:11px;color:var(--gray-400);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px">Tareas asignadas por mí</div>
    <div class="team-list">${rows}</div>`;
}

/* ═══════════════════════════════════════════
   OTROS MIEMBROS (acordeón read-only)
═══════════════════════════════════════════ */
const otrosOpen = new Set();   // miembros desplegados (uid → expandido)

function activeTasksOf(uid) {
  const simples = state.simple.filter(t => t.owner === uid && !t.done);
  const progs   = state.progress.filter(t => t.owner === uid && (t.done || 0) < t.total);
  return [...simples, ...progs].sort((a, b) => {
    // ordenar por fecha (los sin fecha al final)
    if (!a.due && !b.due) return 0;
    if (!a.due) return 1;
    if (!b.due) return -1;
    return a.due.localeCompare(b.due);
  });
}

function getAssignerId(task) {
  // Si la tarea no es colaborativa, fue creada por el propio owner.
  if (!task.collab) return null;
  // Buscar en assigned el registro cuya taskId apunte a esta tarea.
  const a = state.assigned.find(x => x.to === task.owner && x.taskId === task.id);
  return a ? a.assignedBy : null;
}

function renderOtros() {
  const container = document.getElementById('viewContainer');
  const others = Object.entries(USERS)
    .filter(([uid]) => uid !== currentUser)
    .sort((a, b) => (a[1].name || '').localeCompare(b[1].name || ''));

  if (!others.length) {
    container.innerHTML = `<div style="padding:32px;text-align:center;color:var(--gray-400)">No hay otros miembros registrados.</div>`;
    return;
  }

  const rows = others.map(([uid, u]) => {
    const tasks = activeTasksOf(uid);
    const isOpen = otrosOpen.has(uid);
    const countLbl = `${tasks.length} activa${tasks.length === 1 ? '' : 's'}`;

    let bodyHtml = '';
    if (isOpen) {
      if (!tasks.length) {
        bodyHtml = `<div class="om-body"><div class="om-empty">Sin tareas activas.</div></div>`;
      } else {
        const taskRows = tasks.map(t => {
          const isProg = typeof t.done === 'number';
          const progLbl = isProg ? ` · ${t.done}/${t.total} ${t.unit || 'unidades'}` : '';
          const assignerId = getAssignerId(t);
          let assignerHtml;
          if (!assignerId || assignerId === uid) {
            assignerHtml = `<span class="om-assigner om-assigner-self"><i class="fa-solid fa-user-pen"></i>Propia</span>`;
          } else if (assignerId === currentUser) {
            assignerHtml = `<span class="om-assigner"><i class="fa-solid fa-user-pen"></i>Asignada por ti</span>`;
          } else {
            const name = USERS[assignerId]?.name || assignerId;
            assignerHtml = `<span class="om-assigner"><i class="fa-solid fa-user-pen"></i>Asignada por ${name}</span>`;
          }
          const prioCls = t.prio === 'Alta' ? 'om-prio-alta' : t.prio === 'Baja' ? 'om-prio-baja' : 'om-prio-media';
          const dueHtml = t.due
            ? `<span class="${isOD(t.due) ? 'om-overdue' : ''}"><i class="fa-regular fa-calendar"></i>${fmtD(t.due)}${isOD(t.due) ? ' (vencida)' : ''}</span>`
            : `<span style="color:var(--gray-400)"><i class="fa-regular fa-calendar"></i>Sin fecha</span>`;
          return `
            <div class="om-task">
              <div class="om-task-name">${t.name}${progLbl}</div>
              <div class="om-task-meta">
                ${dueHtml}
                <span class="om-prio ${prioCls}">${t.prio}</span>
                ${assignerHtml}
              </div>
            </div>`;
        }).join('');
        bodyHtml = `<div class="om-body">${taskRows}</div>`;
      }
    }

    return `
      <div class="om-member ${isOpen ? 'open' : ''}">
        <button class="om-member-head" onclick="toggleOtroMember('${uid}')">
          <div class="om-av">${u.initials}</div>
          <div class="om-name">${u.name}</div>
          <div class="om-count">${countLbl}</div>
          <i class="fa-solid fa-chevron-down om-chev"></i>
        </button>
        ${bodyHtml}
      </div>`;
  }).join('');

  container.innerHTML = `
    <div style="font-size:11px;color:var(--gray-400);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px">Tareas activas de los demás miembros</div>
    <div class="om-list">${rows}</div>`;
}

function toggleOtroMember(uid) {
  if (otrosOpen.has(uid)) otrosOpen.delete(uid);
  else otrosOpen.add(uid);
  renderOtros();
}

/* ═══════════════════════════════════════════
   CONTROLES DE VISTA
═══════════════════════════════════════════ */
function setView(v) {
  tkView = v;
  ['lista','kanban','timeline'].forEach(k =>
    document.getElementById('vbtn-'+k)?.classList.toggle('on', k === v));
  render();
}
function setScope(s) {
  tkScope = s;
  document.getElementById('togPersonal')?.classList.toggle('on', s === 'personal');
  document.getElementById('togEquipo')?.classList.toggle('on', s === 'equipo');
  document.getElementById('togOtros')?.classList.toggle('on', s === 'otros');
  render();
}
function setType(t) {
  tkType = t;
  document.getElementById('tt-simple')?.classList.toggle('on', t === 'simple');
  document.getElementById('tt-progress')?.classList.toggle('on', t === 'progress');
  document.getElementById('formSimple').style.display = t === 'simple' ? 'block' : 'none';
  document.getElementById('formProgress').style.display = t === 'progress' ? 'block' : 'none';
}
function setAssignType(t) {
  document.getElementById('at-simple')?.classList.toggle('on', t === 'simple');
  document.getElementById('at-progress')?.classList.toggle('on', t === 'progress');
  document.getElementById('formAssignSimple').style.display = t === 'simple' ? 'block' : 'none';
  document.getElementById('formAssignProgress').style.display = t === 'progress' ? 'block' : 'none';
}
function toggleAssignee(btn) {
  btn.classList.toggle('on');
}
function toggleDrawer(btnId, bodyId) {
  const btn = document.getElementById(btnId);
  const body = document.getElementById(bodyId);
  const open = body.classList.toggle('open');
  btn?.classList.toggle('open', open);
}

/* ═══════════════════════════════════════════
   ACCIONES
═══════════════════════════════════════════ */
function toggle(id, kind) {
  if (kind === 'simple') {
    const t = state.simple.find(x => x.id === id);
    if (t) { t.done = !t.done; toast(t.done ? 'Tarea completada ✓' : 'Tarea reabierta'); }
  }
  if (kind === 'progress') {
    const t = state.progress.find(x => x.id === id);
    if (t) {
      if (t.done >= t.total) {
        t.done = Math.max(0, t.total - 1);
        toast('Tarea reabierta');
      } else {
        t.done = t.total;
        toast('Tarea completada ✓');
      }
    }
  }
  scheduleSave(); render();
}

async function deleteAssigned(id) {
  const a = state.assigned.find(x => x.id === id);
  if (!a) return;
  const targetName = USERS[a.to]?.name || a.to;
  const msg = a.accepted
    ? `"${a.name}" ya no aparecerá en tu lista. ${targetName} conservará su copia de la tarea.`
    : `Se cancelará la invitación enviada a ${targetName} de "${a.name}".`;
  const ok = await showConfirm('¿Eliminar asignación?', msg);
  if (!ok) return;

  state.assigned = state.assigned.filter(x => x.id !== id);
  // Si está pendiente de aceptar, también cancela la invitación al destinatario
  if (!a.accepted) {
    state.invites = state.invites.filter(x => x.id !== id);
  }
  scheduleSave();
  render();
  toast('Asignación eliminada');
}

async function del(id, kind) {
  const list = kind === 'simple' ? state.simple : state.progress;
  const t = list.find(x => x.id === id);
  const ok = await showConfirm(
    '¿Eliminar tarea?',
    `"${t?.name || 'esta tarea'}" se eliminará permanentemente. Esta acción no se puede deshacer.`
  );
  if (!ok) return;
  if (kind === 'simple')    state.simple   = state.simple.filter(x => x.id !== id);
  else                      state.progress = state.progress.filter(x => x.id !== id);
  scheduleSave(); render(); toast('Tarea eliminada');
}

/* Modal de confirmación interno */
let _confirmResolve = null;
function showConfirm(title, msg) {
  return new Promise(resolve => {
    document.getElementById('confirmTitle').textContent = title;
    document.getElementById('confirmMsg').textContent = msg;
    document.getElementById('confirmModal').classList.add('show');
    document.getElementById('confirmOk').focus();
    _confirmResolve = resolve;
  });
}
function closeConfirm(ok) {
  document.getElementById('confirmModal').classList.remove('show');
  if (_confirmResolve) { _confirmResolve(ok); _confirmResolve = null; }
}
document.addEventListener('keydown', (e) => {
  if (!document.getElementById('confirmModal').classList.contains('show')) return;
  if (e.key === 'Escape') closeConfirm(false);
  if (e.key === 'Enter')  closeConfirm(true);
});

function addInc(id) {
  const inp = document.getElementById('l-'+id) || document.getElementById('k-'+id) || document.getElementById('t-'+id);
  const raw = inp?.value || ''; if (!raw.trim()) return;
  const n = parseInt(raw); if (isNaN(n) || n === 0) return;
  const t = state.progress.find(x => x.id === id); if (!t) return;
  const today = new Date().toISOString().slice(0, 10);
  const newDone = Math.min(t.total, Math.max(0, t.done + n));
  const delta = newDone - t.done; if (delta === 0) { if (inp) inp.value = ''; return; }
  const entry = t.log.find(l => l.date === today);
  if (entry) { entry.n = Math.max(0, entry.n + delta); if (entry.n === 0) t.log = t.log.filter(l => l.date !== today); }
  else if (delta > 0) t.log.push({ date: today, n: delta });
  t.done = newDone;
  if (inp) inp.value = '';
  scheduleSave(); render();
  toast(delta > 0 ? `+${delta} ${t.unit} registradas` : `${delta} ${t.unit} corregidas`);
}

function undoLog(id) {
  const t = state.progress.find(x => x.id === id); if (!t || !t.log.length) return;
  const last = t.log[t.log.length - 1];
  t.done = Math.max(0, t.done - last.n);
  t.log = t.log.slice(0, -1);
  scheduleSave(); render(); toast(`Entrada del ${fmtD(last.date)} deshecha (−${last.n} ${t.unit})`);
}

function openTaskModal() {
  const m = document.getElementById('taskModal');
  if (!m) return;
  setType('simple');
  m.classList.add('show');
  setTimeout(() => document.getElementById('fName')?.focus(), 80);
}
function closeTaskModal() {
  document.getElementById('taskModal')?.classList.remove('show');
}
function openAssignModal() {
  const m = document.getElementById('assignModal');
  if (!m) return;
  setAssignType('simple');
  document.querySelectorAll('#aAssignees .multi-pill.on').forEach(p => p.classList.remove('on'));
  ['aName','aDue','aNote','apName','apUnit','apTotal','apDue','apNote'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  resetPrio('aPrio');
  resetPrio('apPrio');
  m.classList.add('show');
  setTimeout(() => document.getElementById('aName')?.focus(), 80);
}
function closeAssignModal() {
  document.getElementById('assignModal')?.classList.remove('show');
}

let editingAssignedId = null;
function openEditAssigned(id) {
  const a = state.assigned.find(x => x.id === id);
  const iv = state.invites.find(x => x.id === id);
  if (!a || !iv) { toast('No se pudo abrir esta tarea'); return; }
  if (a.accepted) { toast('Ya fue aceptada — no se puede editar'); return; }

  editingAssignedId = id;
  const isProgress = typeof a.total === 'number' && a.total > 0;

  document.getElementById('editTaskType').textContent = isProgress ? '· Con progreso' : '· Tarea rápida';
  document.getElementById('eName').value = a.name || '';
  document.getElementById('eDue').value  = a.due  || '';
  document.getElementById('eNote').value = a.note || '';

  document.getElementById('ePrio').value = a.prio || 'Media';
  document.querySelectorAll('#editAssignModal .prio-pill').forEach(p => {
    p.classList.toggle('active', p.dataset.prio === (a.prio || 'Media'));
  });

  document.getElementById('eProgressFields').style.display = isProgress ? 'block' : 'none';
  if (isProgress) {
    document.getElementById('eUnit').value  = a.unit || '';
    document.getElementById('eTotal').value = a.total || '';
  }

  // Candidatos: todos menos uno mismo y los ya asignados con el mismo nombre por mí
  const alreadyAssignees = state.assigned
    .filter(x => x.assignedBy === currentUser && x.name === a.name)
    .map(x => x.to);
  const wrap = document.getElementById('eAssignees');
  wrap.innerHTML = Object.entries(USERS)
    .filter(([k]) => k !== currentUser && !alreadyAssignees.includes(k))
    .map(([k,v]) => `
      <button type="button" class="multi-pill" data-uid="${k}" onclick="toggleAssignee(this)">
        <span class="multi-pill-av">${v.initials}</span>
        <span class="multi-pill-name">${v.name}</span>
      </button>`).join('');

  document.getElementById('editAssignModal').classList.add('show');
  setTimeout(() => document.getElementById('eName')?.focus(), 80);
}

function closeEditAssignedModal() {
  document.getElementById('editAssignModal')?.classList.remove('show');
  editingAssignedId = null;
}

function saveEditAssigned() {
  if (!editingAssignedId) return;
  const a  = state.assigned.find(x => x.id === editingAssignedId);
  const iv = state.invites.find(x => x.id === editingAssignedId);
  if (!a || !iv) { toast('No se pudo guardar'); return; }
  if (a.accepted) { toast('Ya fue aceptada — no se puede editar'); return; }

  const isProgress = typeof a.total === 'number' && a.total > 0;

  const n = document.getElementById('eName').value.trim();
  if (!n) { toast('Escribe la descripción'); return; }
  const due  = document.getElementById('eDue').value;
  const prio = document.getElementById('ePrio').value;
  const note = document.getElementById('eNote').value.trim();

  let unit, total;
  if (isProgress) {
    unit  = document.getElementById('eUnit').value.trim() || 'unidades';
    total = parseInt(document.getElementById('eTotal').value);
    if (!total || total < 1) { toast('Total inválido'); return; }
  }

  Object.assign(a,  { name: n, due, prio, note });
  Object.assign(iv, { name: n, due, prio, note });
  if (isProgress) {
    a.unit = unit; a.total = total;
    iv.unit = unit; iv.total = total;
  }

  const newAssignees = Array.from(document.querySelectorAll('#eAssignees .multi-pill.on'))
    .map(el => el.dataset.uid);
  newAssignees.forEach(to => {
    const inviteId = 'I' + (++tkId);
    const base = { id: inviteId, name: n, due, prio, note, createdAt: new Date().toISOString() };
    if (isProgress) { base.unit = unit; base.total = total; }
    state.invites.push({ ...base, from: currentUser, to });
    state.assigned.push({ ...base, assignedBy: currentUser, to, accepted: false });
  });

  const extra = newAssignees.length
    ? ` · ${newAssignees.length} persona${newAssignees.length > 1 ? 's' : ''} más asignada${newAssignees.length > 1 ? 's' : ''}`
    : '';
  scheduleSave(); render(); toast('Tarea actualizada' + extra);
  closeEditAssignedModal();
}

function pickPrio(btn, hiddenId) {
  document.getElementById(hiddenId).value = btn.dataset.prio;
  btn.parentElement.querySelectorAll('.prio-pill').forEach(p => {
    p.classList.toggle('active', p === btn);
  });
}

function resetPrio(hiddenId) {
  document.getElementById(hiddenId).value = 'Media';
  const group = document.getElementById(hiddenId)?.parentElement?.querySelector('.prio-group');
  group?.querySelectorAll('.prio-pill').forEach(p => {
    p.classList.toggle('active', p.dataset.prio === 'Media');
  });
}

function addSimple() {
  const n = document.getElementById('fName').value.trim();
  if (!n) { toast('Escribe una descripción'); return; }
  state.simple.unshift({
    id: 'S' + (++tkId),
    name: n,
    due: document.getElementById('fDue').value,
    prio: document.getElementById('fPrio').value,
    done: false,
    collab: false,
    owner: currentUser,
    createdAt: new Date().toISOString()
  });
  document.getElementById('fName').value = '';
  document.getElementById('fDue').value = '';
  resetPrio('fPrio');
  scheduleSave(); render(); toast('Tarea agregada');
  closeTaskModal();
}

function addProgress() {
  const n = document.getElementById('pName').value.trim();
  const total = parseInt(document.getElementById('pTotal').value);
  const unit = document.getElementById('pUnit').value.trim() || 'unidades';
  if (!n || !total || total < 1) { toast('Completa nombre y total'); return; }
  state.progress.unshift({
    id: 'P' + (++tkId),
    name: n, unit, total, done: 0, log: [],
    due: document.getElementById('pDue').value,
    prio: document.getElementById('pPrio').value,
    owner: currentUser,
    createdAt: new Date().toISOString()
  });
  document.getElementById('pName').value = '';
  document.getElementById('pTotal').value = '';
  document.getElementById('pUnit').value = '';
  document.getElementById('pDue').value = '';
  resetPrio('pPrio');
  scheduleSave(); render(); toast('Tarea con progreso creada');
  closeTaskModal();
}

/* Notificación por email al asignar / aceptar / declinar tareas.
   Si falla, muestra toast al asignador y dispara email al admin (server-side). */
async function notifyAssignment(payload) {
  if (!sb) return;
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return;
    const r = await fetch('/api/notify-assignment', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify(payload),
    });
    const data = await r.json().catch(() => ({}));
    if (!data.ok) {
      const name = USERS[payload.recipientUserId]?.name || 'el destinatario';
      toast(`⚠️ No pudimos avisar a ${name} por email`);
    }
  } catch (err) {
    console.error('notifyAssignment falló:', err);
  }
}

function doAssign() {
  const isProgress = document.getElementById('at-progress')?.classList.contains('on');
  const assignees = Array.from(document.querySelectorAll('#aAssignees .multi-pill.on'))
    .map(el => el.dataset.uid);
  if (!assignees.length) { toast('Selecciona al menos una persona'); return; }

  let n, due, prio, note, unit, total;
  if (isProgress) {
    n     = document.getElementById('apName').value.trim();
    total = parseInt(document.getElementById('apTotal').value);
    unit  = document.getElementById('apUnit').value.trim() || 'unidades';
    if (!n || !total || total < 1) { toast('Completa nombre y total'); return; }
    due  = document.getElementById('apDue').value;
    prio = document.getElementById('apPrio').value;
    note = document.getElementById('apNote').value.trim();
  } else {
    n = document.getElementById('aName').value.trim();
    if (!n) { toast('Escribe la descripción'); return; }
    due  = document.getElementById('aDue').value;
    prio = document.getElementById('aPrio').value;
    note = document.getElementById('aNote').value.trim();
  }

  const actorName = currentProfile?.full_name || 'Alguien';

  assignees.forEach(to => {
    // Si ya hay invite pendiente del mismo asignador → mismo destinatario → misma tarea, no spam
    const alreadyPending = state.invites.some(iv =>
      iv.from === currentUser && iv.to === to && iv.name === n
    );

    const inviteId = 'I' + (++tkId);
    const base = { id: inviteId, name: n, due, prio, note, createdAt: new Date().toISOString() };
    if (isProgress) { base.unit = unit; base.total = total; }
    state.invites.push({ ...base, from: currentUser, to });
    state.assigned.push({ ...base, assignedBy: currentUser, to, accepted: false });

    if (!alreadyPending) {
      notifyAssignment({
        type: 'new_assignment',
        recipientUserId: to,
        actorName,
        taskName: n,
        due,
      });
    }
  });

  const lbl = assignees.length === 1
    ? (USERS[assignees[0]]?.name || assignees[0])
    : `${assignees.length} personas`;
  scheduleSave(); render(); toast(`Tarea enviada a ${lbl}`);
  closeAssignModal();
}

function acceptInvite(id) {
  const iv = state.invites.find(x => x.id === id); if (!iv) return;
  const inviterId = iv.from;
  const taskName = iv.name;
  const isProgress = typeof iv.total === 'number' && iv.total > 0;
  const newTaskId = (isProgress ? 'P' : 'S') + (++tkId);

  if (isProgress) {
    state.progress.unshift({
      id: newTaskId,
      name: iv.name,
      unit: iv.unit || 'unidades',
      total: iv.total,
      done: 0, log: [],
      due: iv.due, prio: iv.prio,
      owner: currentUser, collab: true,
      createdAt: new Date().toISOString()
    });
  } else {
    state.simple.unshift({
      id: newTaskId,
      name: iv.name, due: iv.due, prio: iv.prio,
      done: false, collab: true,
      owner: currentUser,
      createdAt: new Date().toISOString()
    });
  }

  state.invites = state.invites.filter(x => x.id !== id);
  const a = state.assigned.find(x => x.id === id);
  if (a) {
    a.accepted = true;
    a.taskId = newTaskId;
    a.acceptedBy = currentUser;
    a.acceptedAt = new Date().toISOString();
  }
  scheduleSave(); render(); toast('Tarea aceptada y agregada a tu lista');

  if (inviterId && inviterId !== currentUser) {
    notifyAssignment({
      type: 'accepted',
      recipientUserId: inviterId,
      actorName: currentProfile?.full_name || 'Alguien',
      taskName,
    });
  }
}

function declineInvite(id) {
  const iv = state.invites.find(x => x.id === id);
  if (!iv) return;
  const inviterId = iv.from;
  const taskName = iv.name;
  state.invites = state.invites.filter(x => x.id !== id);
  scheduleSave(); render(); toast('Invitación declinada');

  if (inviterId && inviterId !== currentUser) {
    notifyAssignment({
      type: 'declined',
      recipientUserId: inviterId,
      actorName: currentProfile?.full_name || 'Alguien',
      taskName,
    });
  }
}

/* ═══════════════════════════════════════════
   TOAST
═══════════════════════════════════════════ */
let _tt;
function toast(msg) {
  clearTimeout(_tt);
  const el = document.getElementById('toast');
  document.getElementById('toastMsg').textContent = msg;
  el.classList.add('show');
  _tt = setTimeout(() => el.classList.remove('show'), 3000);
}

/* ═══════════════════════════════════════════
   SETTINGS
═══════════════════════════════════════════ */
function toggleSettings(e) {
  e?.stopPropagation();
  const pop = document.getElementById('settingsPop');
  const btn = document.getElementById('headerUserBtn');
  const isOpening = !pop.classList.contains('show');
  if (isOpening && currentProfile) {
    document.getElementById('dropdownAv').textContent = currentProfile.initials || '—';
    document.getElementById('dropdownUserName').textContent = currentProfile.full_name || '—';
    document.getElementById('dropdownUserRole').textContent = currentProfile.role || '';
    applyThemeToggleState();
    // Toggle "Ver como" — solo para quien es admin REAL (sirve para probar la UI de editor/viewer)
    const showSwitch = roleReal === 'admin';
    const blk = document.getElementById('roleSwitchBlock');
    const sep = document.getElementById('roleSwitchSep');
    if (blk) blk.style.display = showSwitch ? '' : 'none';
    if (sep) sep.style.display = showSwitch ? '' : 'none';
    if (showSwitch) applyRoleSwitchUI();
    // Asegurar que el editor de nombre vuelva a estado cerrado al abrir el menú
    cancelEditName();
  }
  pop.classList.toggle('show');
  btn?.classList.toggle('open');
}

/* ── "Ver como" (solo admin real): cambia el rol SOLO en esta sesión del
   navegador para probar la UI de editor/viewer. No toca la base; al refrescar
   vuelve el rol real. El backend sigue viendo tu rol real (admin). ── */
function setRolePreview(r) {
  if (!['admin', 'editor', 'viewer'].includes(r)) return;
  if (roleReal === null) roleReal = currentProfile?.role || 'admin';
  if (!currentProfile) return;
  currentProfile.role = r;
  document.getElementById('dropdownUserRole').textContent = r + (r === roleReal ? '' : ' (vista de prueba)');
  applyRoleSwitchUI();
  renderNavList();
  renderHomeModules();
  if (currentView === 'campaigns') loadCampaigns();
  toast(r === roleReal ? 'Viendo con tu rol real (admin)' : `Viendo como ${r} (solo tú, no afecta la base)`);
}
function applyRoleSwitchUI() {
  document.querySelectorAll('#roleSwitchBlock .role-switch-btn')
    .forEach(b => b.classList.toggle('on', b.dataset.role === currentProfile?.role));
}

/* ── Edición de nombre de perfil (click en el ícono de lápiz del dropdown) ── */
function startEditName() {
  const nameEl = document.getElementById('dropdownUserName');
  const editBtn = document.querySelector('.settings-userhead-edit');
  const input = document.getElementById('dropdownUserNameInput');
  if (!input || !nameEl) return;
  input.value = currentProfile?.full_name || '';
  input.dataset.canceled = '';
  nameEl.style.display = 'none';
  if (editBtn) editBtn.style.display = 'none';
  input.style.display = 'block';
  setTimeout(() => { input.focus(); input.select(); }, 0);
}

function cancelEditName() {
  const nameEl = document.getElementById('dropdownUserName');
  const editBtn = document.querySelector('.settings-userhead-edit');
  const input = document.getElementById('dropdownUserNameInput');
  if (!input || !nameEl) return;
  nameEl.style.display = '';
  if (editBtn) editBtn.style.display = '';
  input.style.display = 'none';
}

async function saveProfileName(newName) {
  const input = document.getElementById('dropdownUserNameInput');
  if (input?.dataset.canceled === '1') {
    input.dataset.canceled = '';
    cancelEditName();
    return;
  }
  const trimmed = (newName || '').trim();
  cancelEditName();
  if (!trimmed || !currentProfile) return;
  if (trimmed === currentProfile.full_name) return;

  // Iniciales auto: primera letra del primer y último nombre, o 2 primeras letras si una sola palabra
  const parts = trimmed.split(/\s+/).filter(Boolean);
  const initials = (parts.length >= 2
    ? parts[0][0] + parts[parts.length - 1][0]
    : trimmed.slice(0, 2)
  ).toUpperCase();

  try {
    const { error } = await sb.from('profiles')
      .update({ full_name: trimmed, initials })
      .eq('id', currentUser);
    if (error) throw error;

    currentProfile.full_name = trimmed;
    currentProfile.initials = initials;
    if (USERS[currentUser]) {
      USERS[currentUser].name = trimmed;
      USERS[currentUser].initials = initials;
    }
    document.getElementById('headerAv').textContent = initials;
    document.getElementById('headerUser').textContent = trimmed;
    document.getElementById('dropdownAv').textContent = initials;
    document.getElementById('dropdownUserName').textContent = trimmed;

    // Refrescar partes de la UI que usan el nombre o iniciales
    if (typeof render === 'function') render();
    const homeUserName = document.getElementById('homeUserName');
    if (homeUserName) homeUserName.textContent = (trimmed.split(' ')[0] || trimmed);
    const selUserName = document.getElementById('selUserName');
    if (selUserName) selUserName.textContent = (trimmed.split(' ')[0] || trimmed);

    toast('Nombre actualizado');
  } catch (e) {
    toast('Error al guardar: ' + e.message);
  }
}
/* ── Recordatorios — preferencias por usuario, persistidas en Supabase ── */
const DAYS_ES = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

function fmtHour12(h) {
  const period = h < 12 ? 'AM' : 'PM';
  return `${h % 12 || 12}:00 ${period}`;
}

function populateReminderSelectors() {
  const daySel = document.getElementById('reminderDay');
  if (daySel && !daySel.options.length) {
    daySel.innerHTML = DAYS_ES.map((d, i) => `<option value="${i}">${d}</option>`).join('');
  }
  const hourSel = document.getElementById('reminderHour');
  if (hourSel && !hourSel.options.length) {
    let html = '';
    for (let h = 0; h < 24; h++) html += `<option value="${h}">${fmtHour12(h)}</option>`;
    hourSel.innerHTML = html;
  }
}

async function loadReminderPrefs() {
  if (!currentUser) return;
  populateReminderSelectors();
  try {
    const { data, error } = await sb.from('profiles')
      .select('reminder_enabled, reminder_day, reminder_hour')
      .eq('id', currentUser).single();
    if (error) throw error;
    document.getElementById('reminderToggle').checked = !!data.reminder_enabled;
    document.getElementById('reminderDay').value = String(data.reminder_day ?? 1);
    document.getElementById('reminderHour').value = String(data.reminder_hour ?? 9);
    document.getElementById('reminderConfig').classList.toggle('show', !!data.reminder_enabled);
    updateReminderBanner();
  } catch (e) {
    console.error('loadReminderPrefs:', e);
  }
}

function updateReminderBanner() {
  const banner = document.getElementById('reminderBanner');
  if (!banner) return;
  const enabled = document.getElementById('reminderToggle')?.checked;
  const day = parseInt(document.getElementById('reminderDay')?.value || '1');
  const dayMatches = new Date().getDay() === day;
  banner.style.display = enabled && dayMatches ? 'flex' : 'none';
}

async function setReminderEnabled(on) {
  document.getElementById('reminderConfig').classList.toggle('show', on);
  try {
    const { error } = await sb.from('profiles').update({ reminder_enabled: on }).eq('id', currentUser);
    if (error) throw error;
    updateReminderBanner();
    toast(on ? 'Recordatorios activados' : 'Recordatorios desactivados');
  } catch (e) { toast('Error al guardar: ' + e.message); }
}

async function setReminderDay(d) {
  const day = parseInt(d);
  try {
    const { error } = await sb.from('profiles').update({ reminder_day: day }).eq('id', currentUser);
    if (error) throw error;
    updateReminderBanner();
    toast(`Recordatorio los ${DAYS_ES[day]}`);
  } catch (e) { toast('Error al guardar: ' + e.message); }
}

async function setReminderHour(h) {
  const hour = parseInt(h);
  try {
    const { error } = await sb.from('profiles').update({ reminder_hour: hour }).eq('id', currentUser);
    if (error) throw error;
    toast(`Recordatorio a las ${fmtHour12(hour)}`);
  } catch (e) { toast('Error al guardar: ' + e.message); }
}

async function sendReminderNow() {
  const btn = document.getElementById('sendReminderBtn');
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  btn.classList.add('sending');
  try {
    const r = await authedFetch('/api/reminder', { method: 'POST' });
    const data = await r.json();
    if (!r.ok || !data?.ok) throw new Error(data?.error || ('HTTP ' + r.status));
    toast(data.sentTo ? `Resumen enviado a ${data.sentTo}` : 'Resumen enviado');
    document.getElementById('settingsPop')?.classList.remove('show');
    document.getElementById('headerUserBtn')?.classList.remove('open');
  } catch (err) {
    console.error(err);
    toast('Error al enviar: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.classList.remove('sending');
  }
}

function setDarkMode(on) {
  if (on) document.documentElement.setAttribute('data-theme', 'dark');
  else document.documentElement.removeAttribute('data-theme');
  localStorage.setItem('theme', on ? 'dark' : 'light');
  toast(on ? 'Modo oscuro activado' : 'Modo claro activado');
}

function applyThemeToggleState() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const t = document.getElementById('darkToggle');
  if (t) t.checked = isDark;
}
document.addEventListener('click', (e) => {
  const pop = document.getElementById('settingsPop');
  const btn = document.getElementById('headerUserBtn');
  if (!pop?.classList.contains('show')) return;
  if (pop.contains(e.target) || btn?.contains(e.target)) return;
  pop.classList.remove('show');
  btn?.classList.remove('open');
});

/* ═══════════════════════════════════════════
   NAV + VIEW SWITCHING
═══════════════════════════════════════════ */
let currentView = 'tasks';

function openNav() {
  document.getElementById('navDrawer').classList.add('open');
  document.getElementById('navBackdrop').classList.add('show');
}
function closeNav() {
  document.getElementById('navDrawer').classList.remove('open');
  document.getElementById('navBackdrop').classList.remove('show');
}

let currentOrg = null;  // 'cretum' | 'mvp' | null (en selector)

const ORG_NAMES = { cretum: 'Cretum', mvp: 'MVP' };

const ORG_MODULES = {
  cretum: [
    { view: 'tasks', icon: 'fa-list-check', title: 'To Do Dashboard',
      desc: 'Crea, organiza y da seguimiento a tareas tuyas y del equipo',
      iconClass: 'home-ico-tasks' },
    { view: 'db', icon: 'fa-database', title: 'Base de Datos',
      desc: 'Consulta inversionistas, empresas y posiciones del portafolio',
      iconClass: 'home-ico-db' },
    { view: 'dropbox', icon: 'fa-dropbox', iconBrand: true, title: 'Dropbox',
      desc: 'Archivos compartidos del equipo desde Dropbox',
      iconClass: 'home-ico-dropbox' },
    { view: 'campaigns', icon: 'fa-bolt', title: 'Campañas',
      desc: 'Ranking de interacción de los LPs y la campaña actual del fondo',
      iconClass: 'home-ico-campaigns' },
    { view: 'portal', icon: 'fa-share-nodes', title: 'Portal de clientes',
      desc: 'Sube dashboards externos y da acceso a clientes con su propio usuario',
      iconClass: 'home-ico-portal', editorOrAdmin: true },
  ],
  mvp: [
    { view: 'db', icon: 'fa-database', title: 'Base de Datos',
      desc: 'Datos del proyecto MVP',
      iconClass: 'home-ico-mvp' },
    { view: 'fundTrackers', icon: 'fa-chart-column', title: 'MVP Fund Trackers',
      desc: 'Valuación de fondos por empresa subyacente',
      iconClass: 'home-ico-trackers' },
    { view: 'reports', icon: 'fa-chart-pie', title: 'Reportes',
      desc: 'Genera el reporte de distribuciones de un LP desde las cartas de Altareturn',
      iconClass: 'home-ico-reportes' },
    { view: 'portal', icon: 'fa-share-nodes', title: 'Portal de clientes',
      desc: 'Sube dashboards de MVP y da acceso a clientes con su propio usuario',
      iconClass: 'home-ico-portal', editorOrAdmin: true },
    { view: 'altareturn', icon: 'fa-chart-line', title: 'Altareturn',
      desc: 'Ingesta y consulta de documentos del portafolio MVP',
      iconClass: 'home-ico-reports', disabled: true },
  ],
};

const ORG_NAV = {
  cretum: [
    { view: 'home',    icon: 'fa-house',       label: 'Inicio' },
    { view: 'tasks',   icon: 'fa-list-check',  label: 'To Do Dashboard' },
    { view: 'db',      icon: 'fa-database',    label: 'Base de Datos' },
    { view: 'dropbox', icon: 'fa-dropbox',     label: 'Dropbox', brand: true },
    { view: 'campaigns', icon: 'fa-bolt',      label: 'Campañas' },
    { view: 'portal',    icon: 'fa-share-nodes', label: 'Portal de clientes', editorOrAdmin: true },
  ],
  mvp: [
    { view: 'home',         icon: 'fa-house',         label: 'Inicio' },
    { view: 'db',           icon: 'fa-database',      label: 'Base de Datos' },
    { view: 'fundTrackers', icon: 'fa-chart-column',  label: 'Fund Trackers' },
    { view: 'reports',      icon: 'fa-chart-pie',     label: 'Reportes' },
    { view: 'portal',       icon: 'fa-share-nodes',   label: 'Portal de clientes', editorOrAdmin: true },
  ],
};

const ORG_SOON = {
  cretum: [
    { icon: 'fa-solid fa-calendar-days', label: 'Calendario' },
  ],
  mvp: [
    { icon: 'fa-solid fa-calendar-days', label: 'Calendario' },
  ],
};

function applyOrgTheme() {
  // Aplica colores del org en variables CSS + cambia los logos
  if (currentOrg) {
    document.documentElement.setAttribute('data-org', currentOrg);
  } else {
    document.documentElement.removeAttribute('data-org');
  }
  const headerLogo = document.querySelector('.header-logo');
  if (headerLogo) {
    headerLogo.src = currentOrg === 'mvp' ? '/logo-mvp.png' : '/logo-icon.png';
  }
  const navLogo = document.querySelector('.nav-logo');
  if (navLogo) {
    navLogo.src = currentOrg === 'mvp' ? '/logo-mvp.png' : '/logo.png';
  }
  // Botón "Cambiar a X" en el drawer: solo se muestra cuando hay org activo
  const switchBtn = document.getElementById('orgSwitchBtn');
  const switchSep = document.getElementById('orgSwitchSep');
  const switchLbl = document.getElementById('orgSwitchLabel');
  if (switchBtn && switchSep && switchLbl) {
    if (currentOrg === 'cretum') {
      switchBtn.style.display = '';
      switchSep.style.display = '';
      switchLbl.textContent = 'Cambiar a MVP';
    } else if (currentOrg === 'mvp') {
      switchBtn.style.display = '';
      switchSep.style.display = '';
      switchLbl.textContent = 'Cambiar a Cretum';
    } else {
      switchBtn.style.display = 'none';
      switchSep.style.display = 'none';
    }
  }
}

function selectOrg(org) {
  const isOrgChange = currentOrg && currentOrg !== org;
  currentOrg = org;
  applyOrgTheme();
  renderHomeModules();
  renderNavList();
  if (isOrgChange) viewHistory = [];  // cambio de empresa = contexto fresco
  switchView('home', isOrgChange);  // si cambió org, no apila historial
}

function switchToOtherOrg() {
  if (!currentOrg) return;
  const other = currentOrg === 'cretum' ? 'mvp' : 'cretum';
  const overlay = document.getElementById('orgTransition');
  const logoImg = document.getElementById('orgTransitionLogo');
  if (!overlay || !logoImg) { selectOrg(other); return; }

  // Cierra el drawer antes para que la animación se vea limpia
  closeNav();

  overlay.className = 'org-transition org-trans-' + other;
  logoImg.src = other === 'mvp' ? '/logo-mvp.png' : '/logo.png';

  // Force reflow para reiniciar la animación
  void overlay.offsetWidth;
  overlay.classList.add('show');

  // Switch al pico de la animación (overlay totalmente expandido)
  setTimeout(() => { selectOrg(other); }, 380);
  // Fade-out del overlay
  setTimeout(() => { overlay.classList.remove('show'); }, 560);
}

function renderHomeModules() {
  const el = document.getElementById('homeModules');
  if (!el || !currentOrg) return;
  const isAdmin = currentProfile?.role === 'admin';
  const isEditorOrAdmin = isAdmin || currentProfile?.role === 'editor';
  const mods = (ORG_MODULES[currentOrg] || []).filter(m =>
    (!m.adminOnly || isAdmin) && (!m.editorOrAdmin || isEditorOrAdmin));
  el.innerHTML = mods.map(m => `
    <button class="home-module${m.disabled ? ' disabled' : ''}"${m.disabled ? ' disabled aria-disabled="true"' : ` onclick="switchView('${m.view}')"`}>
      ${m.disabled ? '<span class="home-module-badge">Pronto</span>' : ''}
      <div class="home-module-ico ${m.iconClass}"><i class="${m.iconBrand ? 'fa-brands' : 'fa-solid'} ${m.icon}"></i></div>
      <div class="home-module-content">
        <div class="home-module-title">${m.title}</div>
        <div class="home-module-desc">${m.desc}</div>
      </div>
    </button>
  `).join('');
  document.getElementById('homeQuestion').textContent = '¿Con qué quieres empezar hoy?';

  // Próximamente — items dependen del org
  const soonGrid = document.getElementById('homeSoonGrid');
  if (soonGrid) {
    const soonItems = ORG_SOON[currentOrg] || [];
    soonGrid.innerHTML = soonItems.map(it => `
      <div class="home-soon-item"><i class="${it.icon}"></i> ${it.label}</div>
    `).join('');
  }

  // Panel ejecutivo MVP: ahora vive en Base de Datos → botón "Full LATAM MVP Snapshot".
  const kpiHost = document.getElementById('homeKpis');
  if (kpiHost) { kpiHost.style.display = 'none'; kpiHost.innerHTML = ''; }
}

// Formato compacto de USD
function fmtUsdShort(v) {
  v = Number(v) || 0;
  const s = v < 0 ? '-' : '';
  v = Math.abs(v);
  if (v >= 1e9) return s + '$' + (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return s + '$' + (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return s + '$' + Math.round(v / 1e3) + 'K';
  return s + '$' + Math.round(v).toLocaleString('en-US');
}

let _mvpKpisLoaded = false;
// Calcula el snapshot MVP-LATAM (live desde la DB). Reusado por el panel de Inicio
// y por el modal "Full LATAM MVP Snapshot" de Base de Datos.
async function _computeMvpSnapshot() {
  const [inv, dist, comps] = await Promise.all([
    sbFetchAll('investments', 'investor_id,company_id,commitment,commitment_actual,distributed_at'),
    sbFetchAll('investment_distributions', 'value_in_kind,cash_proceeds'),
    sbFetchAll('companies', 'id,name')
  ]);
  const n = v => (Number(v) || 0);
  const active = inv.filter(r => !r.distributed_at);
  const committed = active.reduce((s, r) => s + n(r.commitment), 0);
  const nav = active.reduce((s, r) => s + (n(r.commitment_actual) || n(r.commitment)), 0);
  const moic = committed ? nav / committed : 0;
  const distrib = dist.reduce((s, r) => s + n(r.value_in_kind) + n(r.cash_proceeds), 0);
  const nInv = new Set(inv.map(r => r.investor_id)).size;
  const nPos = active.length;
  const cname = Object.fromEntries(comps.map(c => [c.id, c.name]));
  const byCo = {};
  active.forEach(r => { const k = r.company_id; byCo[k] = (byCo[k] || 0) + (n(r.commitment_actual) || n(r.commitment)); });
  const top = Object.entries(byCo).sort((a, b) => b[1] - a[1]).slice(0, 10);
  return { committed, nav, moic, distrib, nInv, nPos, top, cname };
}

function _mvpSnapshotInnerHtml(d, topN) {
  const top = d.top.slice(0, topN || 5);
  const maxv = top.length ? top[0][1] : 1;
  const kpi = (label, val, cls) => `<div class="home-kpi"><div class="home-kpi-l">${label}</div><div class="home-kpi-v ${cls || ''}">${val}</div></div>`;
  return `<div class="home-kpis-grid">` +
      kpi('Capital comprometido', fmtUsdShort(d.committed)) +
      kpi('Valor actual (NAV)', fmtUsdShort(d.nav), 'accent') +
      kpi('MOIC', d.moic.toFixed(2) + 'x', moicClass(d.moic)) +
      kpi('Distribuido a la fecha', fmtUsdShort(d.distrib)) +
      kpi('Inversionistas', d.nInv.toLocaleString('en-US')) +
      kpi('Posiciones activas', d.nPos.toLocaleString('en-US')) +
    `</div>` +
    `<div class="home-top">` +
      `<div class="home-top-h">Top posiciones por valor (NAV activo)</div>` +
      top.map(([cid, v]) => `<div class="home-top-row"><span class="home-top-name">${escapeHtml(d.cname[cid] || '—')}</span><div class="home-top-bar"><div class="home-top-fill" style="width:${(v / maxv * 100).toFixed(1)}%"></div></div><span class="home-top-val">${fmtUsdShort(v)}</span></div>`).join('') +
    `</div>`;
}

async function renderMvpKpis() {
  const host = document.getElementById('homeKpis');
  if (!host || currentOrg !== 'mvp') return;
  if (!_mvpKpisLoaded) host.innerHTML = '<div class="home-kpis-load">Cargando resumen del negocio…</div>';
  try {
    const d = await _computeMvpSnapshot();
    host.innerHTML = `<div class="home-kpis-title">Resumen MVP - LATAM</div>` + _mvpSnapshotInnerHtml(d, 5);
    _mvpKpisLoaded = true;
  } catch (e) {
    host.innerHTML = `<div class="home-kpis-err">No se pudo cargar el resumen: ${escapeHtml(e.message || 'error')}</div>`;
  }
}

// Modal "Full LATAM MVP Snapshot" (Base de Datos) — top 10 posiciones.
async function openMvpSnapshot() {
  const modal = document.getElementById('mvpSnapModal');
  const body = document.getElementById('mvpSnapBody');
  if (!modal || !body) return;
  modal.style.display = '';
  body.innerHTML = '<div class="home-kpis-load">Cargando snapshot…</div>';
  try {
    const d = await _computeMvpSnapshot();
    body.innerHTML = _mvpSnapshotInnerHtml(d, 10);
  } catch (e) {
    body.innerHTML = `<div class="home-kpis-err">No se pudo cargar el snapshot: ${escapeHtml(e.message || 'error')}</div>`;
  }
}
function closeMvpSnapshot() {
  const m = document.getElementById('mvpSnapModal');
  if (m) m.style.display = 'none';
}

function renderNavList() {
  const list = document.getElementById('navList');
  if (!list) return;
  const isAdmin = currentProfile?.role === 'admin';
  const isEditorOrAdmin = isAdmin || currentProfile?.role === 'editor';
  const items = (currentOrg ? ORG_NAV[currentOrg] : []).filter(it =>
    (!it.adminOnly || isAdmin) && (!it.editorOrAdmin || isEditorOrAdmin));
  list.innerHTML = items.map(it => `
    <button class="nav-item" data-view="${it.view}" onclick="switchView('${it.view}')">
      <i class="${it.brand ? 'fa-brands' : 'fa-solid'} ${it.icon}"></i>
      <span>${it.label}</span>
    </button>
  `).join('');
  highlightActiveNav();
}

function highlightActiveNav() {
  document.querySelectorAll('#navList .nav-item').forEach(b => {
    b.classList.toggle('active', b.dataset.view === currentView);
  });
}

let viewHistory = [];

function switchView(view, isBack = false) {
  // History — guarda la vista actual antes de cambiar
  if (!isBack && currentView && currentView !== view) {
    if (viewHistory[viewHistory.length - 1] !== currentView) {
      viewHistory.push(currentView);
    }
  }
  // Selector es la raíz: limpia historial y org
  if (view === 'selector') {
    viewHistory = [];
    if (currentOrg) {
      currentOrg = null;
      applyOrgTheme();
      renderNavList();
    }
  }

  currentView = view;
  document.getElementById('pageSelector').classList.toggle('active', view === 'selector');
  document.getElementById('pageTasks').style.display = view === 'tasks' ? '' : 'none';
  document.getElementById('pageDb').classList.toggle('active', view === 'db');
  document.getElementById('pageHome').classList.toggle('active', view === 'home');
  document.getElementById('pageDbx').classList.toggle('active', view === 'dropbox');
  const pageFt = document.getElementById('pageFundTrackers');
  if (pageFt) pageFt.classList.toggle('active', view === 'fundTrackers');
  document.getElementById('pageCampaigns').classList.toggle('active', view === 'campaigns');
  const pageRep = document.getElementById('pageReports');
  if (pageRep) pageRep.classList.toggle('active', view === 'reports');
  const pagePortal = document.getElementById('pagePortal');
  if (pagePortal) pagePortal.classList.toggle('active', view === 'portal');

  highlightActiveNav();

  const orgPrefix = currentOrg ? ORG_NAMES[currentOrg] + ' · ' : '';
  const viewLabel = {
    'selector':     'Empresas',
    'home':         'Inicio',
    'tasks':        'To Do',
    'db':           'Base de Datos',
    'dropbox':      'Dropbox',
    'fundTrackers': 'Fund Trackers',
    'campaigns':    'Campañas',
    'reports':      'Reportes',
    'portal':       'Portal de clientes',
  }[view] || '';
  document.getElementById('headerBrandText').textContent =
    view === 'selector' ? 'Cretum · Selector' : (orgPrefix + viewLabel);

  // Botón de back: visible si hay historial
  const backBtn = document.getElementById('backBtn');
  if (backBtn) backBtn.style.display = viewHistory.length > 0 ? '' : 'none';

  // Botón "Regresar a Menú" en header: visible en cualquier vista que no sea el selector
  const headerBackBtn = document.getElementById('headerBackMenuBtn');
  if (headerBackBtn) headerBackBtn.style.display = (view === 'selector') ? 'none' : '';

  closeNav();

  if (view === 'db' && !dbLoaded) loadDb();
  if (view === 'dropbox') openDropbox();
  if (view === 'fundTrackers') renderFundTrackerHome();
  if (view === 'campaigns') loadCampaigns();
  if (view === 'reports') loadReports();
  if (view === 'portal') { portalOrg = currentOrg || 'cretum'; loadPortalAdmin(); }

  syncHash();
}

/* ── Routing por hash (#org/vista) — persiste la vista al refrescar ── */
let suppressHashChange = false;

function syncHash() {
  const target = (currentView === 'selector' || !currentOrg)
    ? '#/'
    : `#${currentOrg}/${currentView}`;
  if (location.hash === target) return;
  suppressHashChange = true;   // evita que nuestro propio cambio dispare applyRoute
  location.hash = target;
}

function applyRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const org = parts[0];
  const view = parts[1];
  if (org === 'cretum' || org === 'mvp') {
    if (currentOrg !== org) {
      currentOrg = org;
      applyOrgTheme();
      renderHomeModules();
      renderNavList();
      viewHistory = [];
    }
    const isAdmin = currentProfile?.role === 'admin';
    const allowed = (ORG_NAV[org] || []).some(it => it.view === view && (!it.adminOnly || isAdmin));
    switchView(allowed ? view : 'home', true);
  } else {
    switchView('selector', true);
  }
}

// Back/forward del navegador
window.addEventListener('hashchange', () => {
  if (suppressHashChange) { suppressHashChange = false; return; }
  if (!currentUser) return;   // sin sesión no navegamos
  applyRoute();
});

function goBack() {
  // Caso especial: si estamos en detalle de DB, cerrar detalle primero
  if (currentView === 'db' && document.getElementById('dbDetail').classList.contains('show')) {
    closeDetail();
    return;
  }
  if (viewHistory.length === 0) return;
  const prev = viewHistory.pop();
  switchView(prev, true);
}

/* "Regresar a Menú": siempre lleva al selector de empresas (botones MVP / Cretum),
   sin importar la vista. (Antes iba a 'home' desde sub-vistas, igual que la flecha atrás.) */
function headerBackToMenu() {
  if (currentView !== 'selector') switchView('selector');
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (document.getElementById('taskModal')?.classList.contains('show')) {
    closeTaskModal();
  } else if (document.getElementById('assignModal')?.classList.contains('show')) {
    closeAssignModal();
  } else if (document.getElementById('navDrawer')?.classList.contains('open')) {
    closeNav();
  }
});

/* ═══════════════════════════════════════════
   BASE DE DATOS — carga y render
═══════════════════════════════════════════ */
let dbLoaded = false;

// Columnas disponibles para la lista de inversionistas.
// `locked: true` = siempre visible (no togglable).
const DB_COLUMNS = [
  { key: 'name',     label: 'Nombre',                 locked: true,  default: true  },
  { key: 'titular',  label: 'Titular',                                default: true  },
  { key: 'series',   label: 'Serie',                                  default: true  },
  { key: 'amount',   label: 'Compromiso',                             default: true  },
  { key: 'positions',label: 'Posiciones',                             default: false },
  { key: 'company',  label: 'Empresa',                                default: false },
  { key: 'actual',   label: 'Compromiso ejecutado',                   default: false },
];
let dbVisibleCols = loadVisibleCols();

function loadVisibleCols() {
  try {
    const raw = localStorage.getItem('dbVisibleCols');
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return new Set(arr);
    }
  } catch {}
  return new Set(DB_COLUMNS.filter(c => c.default).map(c => c.key));
}
function saveVisibleCols() {
  try { localStorage.setItem('dbVisibleCols', JSON.stringify([...dbVisibleCols])); } catch {}
}
function isColVisible(key) {
  if (DB_COLUMNS.find(c => c.key === key)?.locked) return true;
  return dbVisibleCols.has(key);
}
function toggleCol(key) {
  const col = DB_COLUMNS.find(c => c.key === key);
  if (!col || col.locked) return;
  if (dbVisibleCols.has(key)) dbVisibleCols.delete(key);
  else dbVisibleCols.add(key);
  saveVisibleCols();
  renderColumnPicker();
  renderDbList();
}
function renderColumnPicker() {
  const panel = document.getElementById('ddColsPanel');
  if (!panel) return;
  panel.innerHTML = DB_COLUMNS.map(c => {
    const on = isColVisible(c.key);
    const cls = 'cdd-opt' + (c.locked ? ' locked' : '');
    const onClick = c.locked ? '' : `onclick="toggleCol('${c.key}');event.stopPropagation()"`;
    return `<div class="${cls}" ${onClick}>
      <input type="checkbox" ${on ? 'checked' : ''} ${c.locked ? 'disabled' : ''}>
      <span>${c.label}${c.locked ? ' (fijo)' : ''}</span>
    </div>`;
  }).join('');
}
let dbInvestors = [];
let dbCompanies = [];
let dbSeries = [];
const dbSelected = new Set();   // investor_ids marcados para portafolio combinado

function toggleInvestorSel(id, checked) {
  if (checked) dbSelected.add(id); else dbSelected.delete(id);
  updateCombineBar();
}
function clearInvestorSel() {
  dbSelected.clear();
  document.querySelectorAll('#dbList input.db-row-check').forEach(c => { c.checked = false; });
  updateCombineBar();
}
function updateCombineBar() {
  const bar = document.getElementById('dbCombineBar');
  if (!bar) return;
  const n = dbSelected.size;
  bar.style.display = n ? '' : 'none';
  const cnt = document.getElementById('dbCombineCount');
  if (cnt) cnt.textContent = n + (n === 1 ? ' seleccionado' : ' seleccionados');
  const btn = document.getElementById('dbCombineGo');
  if (btn) btn.disabled = n < 1;
}
function openSelectedCombined() {
  if (dbSelected.size) openInvestorGroup([...dbSelected]);
}
const dbInvestorCompanies = {};  // investor_id → Set<company_id>
const dbInvestorSeries = {};     // investor_id → Set<series_id>
const dbCompanySeries = {};      // company_id → Set<series_id>  (nivel inversión, para filtrado en cascada)
const dbSeriesCompanies = {};    // series_id → Set<company_id>

const fmtMoney = (n) => {
  if (!n || isNaN(n)) return '—';
  const v = Math.abs(n);
  if (v >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + n.toFixed(0);
};

// Supabase/PostgREST corta en 1000 filas por request. Paginamos con .range()
// hasta traer todo: indispensable porque investments ya supera 1000 filas y la
// agregación por inversionista (posiciones, commitment, actual) saldría incompleta.
async function sbFetchAll(table, columns) {
  const PAGE = 1000;
  let from = 0;
  const all = [];
  while (true) {
    const { data, error } = await sb.from(table).select(columns).range(from, from + PAGE - 1);
    if (error) throw error;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

/* ═══════════════════════════════════════════════════════════════════════
   REPORTES — por LP, desde las cartas de Altareturn (investment_distributions)
   Todo determinístico desde la BD: cero LLM. Template fijo con branding Cretum.
   ═══════════════════════════════════════════════════════════════════════ */
let repLoaded = false;
let repInvestorsAll = [];           // [{id, name}] con ≥1 inversión
let repInvByInvestor = {};          // investor_id → [investment rows]
let repCompanyMap = {};             // company_id → name
let repSeriesMap = {};              // series_id → name
let repLastDoc = '';                // último HTML generado (para imprimir)

const repUsd = (v) => '$' + Math.round(+v || 0).toLocaleString('en-US');
const repNum = (v) => (v != null && v !== '') ? Number(v).toLocaleString('en-US') : '—';
const repMoic = (v) => (v != null && v !== '') ? (Number(v).toFixed(2) + 'x') : '—';
const repPps = (v) => (v != null && v !== '') ? '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
function repFecha(d) {
  if (!d) return '—';
  const [y, m, day] = String(d).slice(0, 10).split('-');
  return `${day} ${['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'][(+m) - 1]} ${y}`;
}

/* ── Búsqueda difusa (tolera errores de tecleo: "ROSAIRO" → "Rosario") ── */
let repSuggMatches = [];   // investors mostrados en el dropdown
let repSuggIdx = -1;       // índice resaltado con teclado

// Normaliza: minúsculas, sin acentos, sin signos
function repNorm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}
// Distancia de edición (Levenshtein)
function repLev(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}
const repSim = (a, b) => (!a || !b) ? 0 : 1 - repLev(a, b) / Math.max(a.length, b.length);

// Puntaje query↔nombre: substring fuerte (>1) o similitud difusa (0..1)
function repScore(q, name) {
  const qn = repNorm(q), nn = repNorm(name);
  if (!qn) return 0;
  if (nn.includes(qn)) return 2 + qn.length / nn.length;       // coincidencia literal
  const nameToks = nn.split(' ');
  const tokBest = (w) => {                                      // mejor match de una palabra
    let b = 0;
    for (const tok of nameToks) {
      b = Math.max(b, repSim(w, tok));
      if (tok.length > w.length) b = Math.max(b, repSim(w, tok.slice(0, w.length)));
    }
    return b;
  };
  let best = Math.max(repSim(qn, nn), tokBest(qn));             // query como una sola palabra
  const qToks = qn.split(' ');
  if (qToks.length > 1) {                                       // query de varias palabras: promedio
    best = Math.max(best, qToks.reduce((s, w) => s + tokBest(w), 0) / qToks.length);
  }
  return best;
}
function repBestMatches(q, limit) {
  // Inclusión con el matcher corregido (substring + fuzzy solo en 4+ chars);
  // repScore solo se usa para ORDENAR los que ya pasaron el filtro.
  return repInvestorsAll
    .filter(i => fuzzyMatch(q, i.name))
    .map(i => ({ i, s: repScore(q, i.name) }))
    .sort((a, b) => b.s - a.s || a.i.name.localeCompare(b.i.name, 'es'))
    .slice(0, limit || 8)
    .map(x => x.i);
}

// Reutilizable en cualquier buscador. Substring primero (sin ruido); la
// tolerancia a errores SOLO se aplica a consultas de ≥4 caracteres con umbral
// alto, para no inundar la lista con falsos positivos al teclear pocas letras.
function fuzzyMatch(q, text, threshold) {
  const qn = repNorm(q), nn = repNorm(text);
  if (!qn) return true;
  if (nn.includes(qn)) return true;                 // substring exacto (cualquier longitud)
  const th = threshold != null ? threshold : 0.7;
  const words = nn.split(' ');
  // ¿alguna palabra del texto contiene o se parece a este término?
  const tokenHit = (tok) => {
    if (!tok) return true;
    if (nn.includes(tok)) return true;              // aparece como substring en cualquier parte
    if (tok.length < 4) return false;               // términos cortos: solo substring (evita ruido)
    return words.some(w => Math.abs(w.length - tok.length) <= 3 && repSim(tok, w) >= th);
  };
  // Búsqueda por términos: si escribes varias palabras, TODAS deben aparecer,
  // sin importar el orden ni que haya palabras en medio. Así "Alejandro Creixell"
  // encuentra "Alejandro Enrique Creixell Castañeda".
  const qToks = qn.split(' ');
  if (qToks.length > 1) return qToks.every(tokenHit);
  if (qn.length < 4) return false;                  // query corta de una palabra: solo substring
  if (repSim(qn, nn) >= th) return true;            // nombre completo parecido (tolera typos)
  return tokenHit(qn);                              // o una sola palabra parecida
}

/* ═══════════════════════════════════════════════════════════════════════
   PORTAL DE CLIENTES (admin) — gestiona dashboards externos y usuarios
   Todo vía /api/portal (service role server-side). Solo admin llega aquí.
   ═══════════════════════════════════════════════════════════════════════ */
let ptDashboards = [], ptUsers = [], ptAccess = [];
let portalOrg = 'cretum';   // empresa que se gestiona en el módulo Portal (según currentOrg)

async function portalApi(body) {
  const r = await authedFetch('/api/portal', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ org: portalOrg, ...body }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
  return d;
}

async function loadPortalAdmin() {
  // Enlace "Abrir portal" + texto del URL según la empresa
  const base = portalOrg === 'mvp' ? '/portal-mvp' : '/portal';
  const openLink = document.getElementById('ptOpenLink'); if (openLink) openLink.href = base;
  const urlText = document.getElementById('ptUrlText'); if (urlText) urlText.textContent = 'cretumdesk.com' + base;
  const dl = document.getElementById('ptDashList'), ul = document.getElementById('ptUserList');
  if (dl) dl.innerHTML = '<div class="pt-empty"><i class="fa-solid fa-spinner fa-spin"></i> Cargando…</div>';
  try {
    const d = await portalApi({ action: 'admin_list' });
    ptDashboards = d.dashboards || []; ptUsers = d.users || []; ptAccess = d.access || [];
    renderPtDashboards(); renderPtUsers();
  } catch (err) {
    if (dl) dl.innerHTML = `<div class="pt-empty">Error: ${escapeHtml(err.message)}</div>`;
  }
}

function renderPtDashboards() {
  const el = document.getElementById('ptDashList');
  if (!ptDashboards.length) { el.innerHTML = '<div class="pt-empty">Aún no hay dashboards. Crea el primero.</div>'; return; }
  const base = portalOrg === 'mvp' ? '/portal-mvp' : '/portal';
  el.innerHTML = ptDashboards.map(d => `<div class="pt-item">
    <div class="nm">${escapeHtml(d.title)}</div>
    <div class="sub">${base} · ${escapeHtml(d.slug)}</div>
    <div class="acts">
      <button class="cdd-btn" onclick="ptDashView(${d.id})"><i class="fa-solid fa-eye"></i> Previsualizar</button>
      <button class="cdd-btn" onclick="ptDashOpen(${d.id})"><i class="fa-solid fa-pen"></i> Editar</button>
      <button class="cdd-btn camp-btn-danger" onclick="ptDashDelete(${d.id})"><i class="fa-solid fa-trash"></i> Eliminar</button>
    </div>
  </div>`).join('');
}

function renderPtUsers() {
  const el = document.getElementById('ptUserList');
  if (!ptUsers.length) { el.innerHTML = '<div class="pt-empty">Aún no hay usuarios-cliente.</div>'; return; }
  const countFor = (uid) => ptAccess.filter(a => a.user_id === uid).length;
  el.innerHTML = ptUsers.map(u => {
    const n = countFor(u.id);
    return `<div class="pt-item">
      <div class="nm">${escapeHtml(u.label || u.username)} ${u.active ? '' : '<span class="pt-badge off">inactivo</span>'}</div>
      <div class="sub">usuario: ${escapeHtml(u.username)} · <span class="pt-badge">${n} dashboard${n === 1 ? '' : 's'}</span></div>
      <div class="acts">
        <button class="cdd-btn" onclick="ptUserOpen(${u.id})"><i class="fa-solid fa-pen"></i> Editar</button>
        <button class="cdd-btn camp-btn-danger" onclick="ptUserDelete(${u.id})"><i class="fa-solid fa-trash"></i></button>
      </div>
    </div>`;
  }).join('');
}

function ptClose(id) { document.getElementById(id).classList.remove('show'); }
const ptSlugify = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function ptDashOpen(id) {
  const d = id ? ptDashboards.find(x => x.id === id) : null;
  document.getElementById('ptDashTitle').textContent = d ? 'Editar dashboard' : 'Nuevo dashboard';
  document.getElementById('ptDashId').value = d ? d.id : '';
  document.getElementById('ptDashTitleInp').value = d ? d.title : '';
  document.getElementById('ptDashSlug').value = d ? d.slug : '';
  document.getElementById('ptDashHtml').value = '';
  const msg = document.getElementById('ptDashMsg'); msg.textContent = ''; msg.className = 'camp-modal-msg';
  // Resetea la vista previa al abrir
  const pw = document.getElementById('ptDashPreviewWrap'); if (pw) pw.style.display = 'none';
  const pb = document.getElementById('ptPrevBtn'); if (pb) pb.innerHTML = '<i class="fa-solid fa-eye"></i> Vista previa';
  document.getElementById('ptDashModal').classList.add('show');
  if (d) {  // trae el HTML actual para editar
    document.getElementById('ptDashHtml').value = 'Cargando…';
    portalApi({ action: 'get_dashboard', id: d.id })
      .then(full => { document.getElementById('ptDashHtml').value = full.html || ''; ptDashPreviewLive(); })
      .catch(() => { document.getElementById('ptDashHtml').value = ''; });
  }
}

// Vista previa del HTML del dashboard (iframe aislado, igual que lo ve el cliente)
let ptPreviewTimer = null;
function ptDashPreviewRender() {
  const f = document.getElementById('ptDashPreview');
  if (f) f.srcdoc = document.getElementById('ptDashHtml').value || '';
}
function ptDashPreviewToggle() {
  const wrap = document.getElementById('ptDashPreviewWrap');
  const btn = document.getElementById('ptPrevBtn');
  if (!wrap) return;
  const show = wrap.style.display === 'none';
  wrap.style.display = show ? '' : 'none';
  if (show) ptDashPreviewRender();
  if (btn) btn.innerHTML = show
    ? '<i class="fa-solid fa-eye-slash"></i> Ocultar vista previa'
    : '<i class="fa-solid fa-eye"></i> Vista previa';
}
function ptDashPreviewLive() {
  const wrap = document.getElementById('ptDashPreviewWrap');
  if (!wrap || wrap.style.display === 'none') return;   // solo si está visible
  clearTimeout(ptPreviewTimer);
  ptPreviewTimer = setTimeout(ptDashPreviewRender, 300);  // debounce al teclear
}

async function ptDashSave() {
  const id = document.getElementById('ptDashId').value;
  const title = document.getElementById('ptDashTitleInp').value.trim();
  let slug = document.getElementById('ptDashSlug').value.trim();
  const html = document.getElementById('ptDashHtml').value;
  const msg = document.getElementById('ptDashMsg');
  if (!title) { msg.textContent = 'Pon un título.'; msg.className = 'camp-modal-msg err'; return; }
  if (!slug) slug = ptSlugify(title);
  if (!html.trim() && !id) { msg.textContent = 'Pega el HTML del dashboard.'; msg.className = 'camp-modal-msg err'; return; }
  try {
    const body = { action: 'save_dashboard', slug, title, html };
    if (id) body.id = +id;
    await portalApi(body);
    ptClose('ptDashModal');
    toast(id ? 'Dashboard actualizado' : 'Dashboard creado');
    loadPortalAdmin();
  } catch (err) { msg.textContent = err.message; msg.className = 'camp-modal-msg err'; }
}

async function ptDashDelete(id) {
  const d = ptDashboards.find(x => x.id === id);
  if (!confirm(`¿Borrar el dashboard "${d?.title}"? Los usuarios perderán acceso.`)) return;
  try { await portalApi({ action: 'delete_dashboard', id }); toast('Dashboard borrado'); loadPortalAdmin(); }
  catch (err) { toast('Error: ' + err.message); }
}

// Previsualiza un dashboard YA guardado (trae su HTML y lo muestra en iframe aislado)
async function ptDashView(id) {
  const d = ptDashboards.find(x => x.id === id);
  document.getElementById('ptViewTitle').textContent = d ? d.title : 'Vista previa';
  const f = document.getElementById('ptViewFrame');
  if (f) f.srcdoc = '<p style="font-family:sans-serif;color:#889;padding:24px">Cargando…</p>';
  document.getElementById('ptViewModal').classList.add('show');
  try {
    const full = await portalApi({ action: 'get_dashboard', id });
    if (f) f.srcdoc = full.html || '<p style="font-family:sans-serif;color:#889;padding:24px">Este dashboard no tiene HTML.</p>';
  } catch (err) {
    if (f) f.srcdoc = `<p style="font-family:sans-serif;color:#c0392b;padding:24px">No se pudo cargar: ${escapeHtml(err.message)}</p>`;
  }
}

function ptUserOpen(id) {
  const u = id ? ptUsers.find(x => x.id === id) : null;
  document.getElementById('ptUserTitle').textContent = u ? 'Editar usuario' : 'Nuevo usuario';
  document.getElementById('ptUserId').value = u ? u.id : '';
  document.getElementById('ptUserName').value = u ? u.username : '';
  document.getElementById('ptUserLabel').value = u ? (u.label || '') : '';
  document.getElementById('ptUserPw').value = '';
  document.getElementById('ptUserPwLbl').innerHTML = u
    ? 'Nueva contraseña <span class="camp-opt">dejar vacío = no cambiar</span>'
    : 'Contraseña <span class="camp-req">*</span>';
  document.getElementById('ptUserActive').checked = u ? u.active : true;
  const mine = new Set(u ? ptAccess.filter(a => a.user_id === u.id).map(a => a.dashboard_id) : []);
  document.getElementById('ptUserDashes').innerHTML = ptDashboards.length
    ? ptDashboards.map(d => `<label><input type="checkbox" value="${d.id}" ${mine.has(d.id) ? 'checked' : ''}> ${escapeHtml(d.title)}</label>`).join('')
    : '<div class="pt-empty" style="padding:8px">Primero crea un dashboard.</div>';
  const msg = document.getElementById('ptUserMsg'); msg.textContent = ''; msg.className = 'camp-modal-msg';
  document.getElementById('ptUserModal').classList.add('show');
}

async function ptUserSave() {
  const id = document.getElementById('ptUserId').value;
  const username = document.getElementById('ptUserName').value.trim().toLowerCase();
  const label = document.getElementById('ptUserLabel').value.trim();
  const password = document.getElementById('ptUserPw').value;
  const active = document.getElementById('ptUserActive').checked;
  const dashboardIds = [...document.querySelectorAll('#ptUserDashes input:checked')].map(c => +c.value);
  const msg = document.getElementById('ptUserMsg');
  if (!username) { msg.textContent = 'Pon un usuario.'; msg.className = 'camp-modal-msg err'; return; }
  if (!id && !password) { msg.textContent = 'La contraseña es obligatoria.'; msg.className = 'camp-modal-msg err'; return; }
  try {
    const body = { action: 'save_user', username, label, active, dashboardIds };
    if (id) body.id = +id;
    if (password) body.password = password;
    await portalApi(body);
    ptClose('ptUserModal');
    toast(id ? 'Usuario actualizado' : 'Usuario creado');
    loadPortalAdmin();
  } catch (err) { msg.textContent = err.message; msg.className = 'camp-modal-msg err'; }
}

async function ptUserDelete(id) {
  const u = ptUsers.find(x => x.id === id);
  if (!confirm(`¿Borrar el usuario "${u?.username}"?`)) return;
  try { await portalApi({ action: 'delete_user', id }); toast('Usuario borrado'); loadPortalAdmin(); }
  catch (err) { toast('Error: ' + err.message); }
}

function repSuggest() {
  const q = (document.getElementById('repSearch').value || '').trim();
  const box = document.getElementById('repSugg');
  if (q.length < 2 || !repInvestorsAll.length) { repHideSugg(); return; }
  repSuggMatches = repBestMatches(q, 8);
  repSuggIdx = -1;
  if (!repSuggMatches.length) {
    box.innerHTML = '<div class="rep-sugg-empty">Sin coincidencias parecidas.</div>';
    box.style.display = ''; return;
  }
  box.innerHTML = repSuggMatches.map((i, idx) => {
    const n = repInvByInvestor[i.id]?.length || 0;
    return `<div class="rep-sugg-item" data-idx="${idx}" onmousedown="event.preventDefault()" onclick="repPick(${idx})">
      <span class="nm">${escapeHtml(i.name)}</span>
      <span class="pos">${n} posición${n === 1 ? '' : 'es'}</span>
    </div>`;
  }).join('');
  box.style.display = '';
}
function repHideSugg() { const b = document.getElementById('repSugg'); if (b) b.style.display = 'none'; }
function repPick(idx) {
  const inv = repSuggMatches[idx];
  if (!inv) return;
  document.getElementById('repSearch').value = inv.name;
  repHideSugg();
  repGenerate();
}
function repKey(e) {
  const box = document.getElementById('repSugg');
  const open = box && box.style.display !== 'none' && repSuggMatches.length;
  if (e.key === 'ArrowDown' && open) {
    e.preventDefault(); repSuggIdx = Math.min(repSuggIdx + 1, repSuggMatches.length - 1); repHighlight();
  } else if (e.key === 'ArrowUp' && open) {
    e.preventDefault(); repSuggIdx = Math.max(repSuggIdx - 1, 0); repHighlight();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (open && repSuggIdx >= 0) repPick(repSuggIdx);
    else if (open && repSuggMatches.length) repPick(0);
    else repGenerate();
  } else if (e.key === 'Escape') {
    repHideSugg();
  }
}
function repHighlight() {
  document.querySelectorAll('#repSugg .rep-sugg-item').forEach((el, i) =>
    el.classList.toggle('on', i === repSuggIdx));
}

async function loadReports() {
  if (repLoaded) return;
  const hint = document.getElementById('repHint');
  if (hint) hint.textContent = 'Cargando inversionistas…';
  try {
    const [investors, investments, companies, series] = await Promise.all([
      sbFetchAll('investors', 'id, name'),
      sbFetchAll('investments', 'id, investor_id, company_id, series_id, commitment, commitment_actual, shares, entry_pps, current_ev_pps, dpi_moic'),
      sbFetchAll('companies', 'id, name'),
      sbFetchAll('series', 'id, name'),
    ]);
    companies.forEach(c => { repCompanyMap[c.id] = c.name; });
    series.forEach(s => { repSeriesMap[s.id] = s.name; });
    investments.forEach(x => {
      (repInvByInvestor[x.investor_id] ||= []).push(x);
    });
    repInvestorsAll = investors
      .filter(i => repInvByInvestor[i.id]?.length)
      .sort((a, b) => a.name.localeCompare(b.name, 'es'));
    repLoaded = true;
    if (hint) hint.textContent = `${repInvestorsAll.length} inversionistas disponibles. Escribe o elige un LP.`;
  } catch (err) {
    console.error('[reports]', err);
    if (hint) hint.textContent = 'Error al cargar inversionistas: ' + err.message;
  }
}

async function repGenerate() {
  const name = (document.getElementById('repSearch').value || '').trim();
  const hint = document.getElementById('repHint');
  if (!name) return;
  let inv = repInvestorsAll.find(i => i.name.toLowerCase() === name.toLowerCase())
    || repInvestorsAll.find(i => i.name.toLowerCase().includes(name.toLowerCase()))
    || repBestMatches(name, 1)[0];   // tolera errores de tecleo
  if (!inv) { if (hint) hint.textContent = `No encontré nada parecido a "${name}".`; return; }
  document.getElementById('repSearch').value = inv.name;   // refleja el LP resuelto
  repHideSugg();

  const investments = repInvByInvestor[inv.id] || [];
  const ids = investments.map(x => x.id);
  if (hint) hint.textContent = 'Generando reporte…';
  try {
    let dists = [];
    if (ids.length) {
      const { data, error } = await sb.from('investment_distributions')
        .select('investment_id, letter_type, underlying_company, distribution_date, shares_distributed, value_in_kind, cash_proceeds, letter_url')
        .in('investment_id', ids);
      if (error) throw error;
      dists = data || [];
    }
    repLastDoc = repBuildDoc(inv, investments, dists);
    document.getElementById('repFrame').srcdoc = repLastDoc;
    document.getElementById('repFrameWrap').style.display = '';
    document.getElementById('repPlaceholder').style.display = 'none';
    document.getElementById('repPrintBtn').style.display = '';
    if (hint) hint.textContent = `Reporte de ${inv.name} — ${dists.length} carta${dists.length === 1 ? '' : 's'}.`;
  } catch (err) {
    console.error('[reports]', err);
    if (hint) hint.textContent = 'Error al generar: ' + err.message;
  }
}

function repPrint() {
  const f = document.getElementById('repFrame');
  if (f && f.contentWindow) { f.contentWindow.focus(); f.contentWindow.print(); }
}

function repBuildDoc(inv, investments, dists) {
  // Agrupa distribuciones por investment
  const byInv = {};
  dists.forEach(d => { (byInv[d.investment_id] ||= []).push(d); });

  // Totales consolidados
  let totCommit = 0, totActual = 0, totInKind = 0, totCash = 0;
  investments.forEach(x => { totCommit += +x.commitment || 0; totActual += +x.commitment_actual || 0; });
  dists.forEach(d => { totInKind += +d.value_in_kind || 0; totCash += +d.cash_proceeds || 0; });
  const totDist = totInKind + totCash;
  const base = totActual > 0 ? totActual : totCommit;
  const dpi = base > 0 ? (totDist / base) : 0;
  const fechas = dists.map(d => d.distribution_date).filter(Boolean).sort();
  const asOf = fechas.length ? fechas[fechas.length - 1] : null;

  // Posiciones (una por investment), ordenadas por compromiso
  const positions = investments.map(x => {
    const ds = byInv[x.id] || [];
    let pInKind = 0, pCash = 0;
    ds.forEach(d => { pInKind += +d.value_in_kind || 0; pCash += +d.cash_proceeds || 0; });
    return {
      company: repCompanyMap[x.company_id] || '—',
      fund: repSeriesMap[x.series_id] || '—',
      commitment: +x.commitment || 0,
      shares: x.shares,
      entry: x.entry_pps,
      current: x.current_ev_pps,
      moic: x.dpi_moic,
      valorActual: (x.shares != null && x.current_ev_pps != null) ? (+x.shares * +x.current_ev_pps) : null,
      distrib: pInKind + pCash,
      nLetters: ds.length,
    };
  }).sort((a, b) => b.commitment - a.commitment);

  // MOIC consolidado: promedio ponderado por compromiso (consistente con la columna MOIC por posición)
  let moicW = 0, moicBase = 0;
  positions.forEach(p => { if (p.moic != null && p.moic !== '' && p.commitment > 0) { moicBase += p.commitment; moicW += p.commitment * (+p.moic); } });
  const portMoic = moicBase > 0 ? moicW / moicBase : 0;

  // Distribuciones agregadas por empresa subyacente recibida
  const byUnder = {};
  dists.forEach(d => {
    const k = (d.underlying_company || '—').replace(/,?\s*(Inc|LLC|Ltd|Corp)\.?$/i, '').trim() || '—';
    const u = (byUnder[k] ||= { n: 0, shares: 0, inkind: 0, cash: 0 });
    u.n++; u.shares += +d.shares_distributed || 0; u.inkind += +d.value_in_kind || 0; u.cash += +d.cash_proceeds || 0;
  });
  const underRows = Object.entries(byUnder)
    .map(([k, v]) => ({ name: k, ...v, total: v.inkind + v.cash }))
    .sort((a, b) => b.total - a.total || b.shares - a.shares);

  // Historial cronológico (más reciente primero)
  const fundShort = (s) => (s || '—').replace(/^MVP\s+/, '').replace(/\s*LLC,?/, '').replace(/\s*LP$/, '');
  const invFund = {}; investments.forEach(x => { invFund[x.id] = repSeriesMap[x.series_id] || '—'; });
  // Agrupadas por fondo (Fondo I, II, III…) y dentro por nombre de oportunidad; cronológico al final
  const hist = dists.slice().sort((a, b) => {
    const f = (invFund[a.investment_id] || '').localeCompare(invFund[b.investment_id] || '', 'es');
    if (f) return f;
    const u = (a.underlying_company || '').localeCompare(b.underlying_company || '', 'es');
    if (u) return u;
    return String(a.distribution_date).localeCompare(String(b.distribution_date));
  });

  const tipoBadge = (t) => t === 'distribution_in_kind'
    ? '<span class="badge bk">En especie</span>'
    : '<span class="badge bc">Efectivo</span>';

  const posRows = positions.map(p => `<tr>
    <td><strong>${escapeHtml(p.company)}</strong><div class="sub">${escapeHtml(p.fund)}</div></td>
    <td class="num">${repUsd(p.commitment)}</td>
    <td class="num">${repPps(p.entry)}</td>
    <td class="num">${repPps(p.current)}</td>
    <td class="num">${p.shares != null ? repNum(p.shares) : '—'}</td>
    <td class="num">${p.valorActual != null ? repUsd(p.valorActual) : '—'}</td>
    <td class="num">${repMoic(p.moic)}</td>
  </tr>`).join('');

  const underRowsHtml = underRows.map(u => `<tr>
    <td><strong>${escapeHtml(u.name)}</strong></td>
    <td class="num">${u.n}</td>
    <td class="num">${u.shares > 0 ? repNum(Math.round(u.shares)) : '—'}</td>
    <td class="num">${u.inkind > 0 ? repUsd(u.inkind) : '—'}</td>
    <td class="num">${u.cash > 0 ? repUsd(u.cash) : '—'}</td>
    <td class="num"><strong>${repUsd(u.total)}</strong></td>
  </tr>`).join('');

  const histRows = hist.map(d => {
    const val = (+d.value_in_kind || 0) + (+d.cash_proceeds || 0);
    return `<tr>
      <td class="nowrap">${repFecha(d.distribution_date)}</td>
      <td>${escapeHtml(fundShort(invFund[d.investment_id]))}</td>
      <td>${tipoBadge(d.letter_type)}</td>
      <td>${escapeHtml((d.underlying_company || '—'))}</td>
      <td class="num">${d.shares_distributed != null ? repNum(Math.round(d.shares_distributed)) : '—'}</td>
      <td class="num">${val > 0 ? repUsd(val) : '—'}</td>
      <td class="ctr">${d.letter_url ? `<a href="${escapeHtml(d.letter_url)}" target="_blank" rel="noopener">Ver</a>` : '—'}</td>
    </tr>`;
  }).join('');

  const hoy = repFecha(new Date().toISOString());
  const calledCard = totActual > 0
    ? `<div class="card"><div class="k">Account Balance</div><div class="v">${repUsd(totActual)}</div></div>` : '';

  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root{--navy:#17436b;--navy2:#1f5a8f;--ink:#1a1f2e;--soft:#6b7689;--line:#e4e9f0;--bg:#f5f7fb;
        --green:#0f9b5a;--greenbg:#e7f6ee;--amber:#b07d20;--amberbg:#fbf3e0;}
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,'Segoe UI',Arial,sans-serif;color:var(--ink);background:var(--bg);font-size:13.5px;line-height:1.5}
  .wrap{max-width:900px;margin:0 auto;padding:24px}
  .hd{background:linear-gradient(135deg,var(--navy),var(--navy2));color:#fff;border-radius:14px;padding:26px 28px;margin-bottom:22px}
  .hd .eye{font-size:10.5px;letter-spacing:2px;opacity:.75;margin-bottom:8px}
  .hd h1{margin:0 0 4px;font-size:23px;font-weight:500}
  .hd .meta{font-size:12.5px;opacity:.85;margin-top:8px}
  h2{font-size:15px;color:var(--navy);font-weight:600;margin:28px 0 10px;padding-bottom:7px;border-bottom:1px solid var(--line)}
  .cards{display:flex;gap:12px;flex-wrap:wrap;margin:4px 0}
  .card{flex:1;min-width:150px;background:#fff;border:1px solid var(--line);border-radius:11px;padding:14px 16px}
  .card .k{font-size:10.5px;letter-spacing:.5px;text-transform:uppercase;color:var(--soft)}
  .card .v{font-size:21px;font-weight:600;color:var(--navy);margin-top:5px}
  .card.hl{background:var(--greenbg);border-color:#bfe6cf}
  .card.hl .v{color:var(--green)}
  table{width:100%;border-collapse:collapse;margin:8px 0;font-size:12.5px;background:#fff;border:1px solid var(--line);border-radius:10px;overflow:hidden}
  th,td{padding:9px 11px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}
  th{background:var(--navy);color:#fff;font-weight:600;font-size:11px;letter-spacing:.3px}
  tr:last-child td{border-bottom:none}
  td.num,th.num{text-align:right;white-space:nowrap}
  td.ctr,th.ctr{text-align:center}
  td.nowrap{white-space:nowrap}
  .sub{font-size:11px;color:var(--soft);margin-top:2px}
  .badge{display:inline-block;padding:2px 8px;border-radius:20px;font-size:10.5px;font-weight:600}
  .badge.bk{background:var(--amberbg);color:var(--amber)}
  .badge.bc{background:var(--greenbg);color:var(--green)}
  tbody tr:nth-child(even) td{background:#fafbfd}
  a{color:var(--navy2)}
  .foot{margin-top:26px;padding-top:14px;border-top:1px solid var(--line);font-size:10.5px;color:var(--soft);line-height:1.6}
  @page{margin:14mm}
  @media print{body{background:#fff}.wrap{max-width:none;padding:0}.hd{box-shadow:none}}
</style></head><body><div class="wrap">
  <div class="hd">
    <div class="eye">CRETUM PARTNERS · REPORTE DE DISTRIBUCIONES</div>
    <h1>${escapeHtml(inv.name)}</h1>
    <div class="meta">Generado: ${hoy}${asOf ? ` &nbsp;·&nbsp; Datos al ${repFecha(asOf)}` : ''} &nbsp;·&nbsp; ${investments.length} posicion${investments.length === 1 ? '' : 'es'}</div>
  </div>

  <div class="cards">
    <div class="card"><div class="k">Compromiso total</div><div class="v">${repUsd(totCommit)}</div></div>
    ${calledCard}
    <div class="card hl"><div class="k">Total distribuido</div><div class="v">${repUsd(totDist)}</div></div>
    <div class="card"><div class="k">MOIC</div><div class="v">${portMoic.toFixed(2)}x</div></div>
  </div>
  ${totInKind > 0 && totCash > 0 ? `<div class="cards"><div class="card"><div class="k">En especie (acciones)</div><div class="v" style="font-size:17px">${repUsd(totInKind)}</div></div><div class="card"><div class="k">En efectivo</div><div class="v" style="font-size:17px">${repUsd(totCash)}</div></div></div>` : ''}

  <h2>Posiciones</h2>
  <table>
    <thead><tr><th>Empresa / Fondo</th><th class="num">Compromiso</th><th class="num">PPS Entrada</th><th class="num">PPS Actual</th><th class="num">Acciones</th><th class="num">Valor Actual</th><th class="num">MOIC</th></tr></thead>
    <tbody>${posRows || '<tr><td colspan="7">Sin posiciones registradas.</td></tr>'}</tbody>
  </table>

  ${underRows.length ? `<h2>Distribuciones por empresa recibida</h2>
  <table>
    <thead><tr><th>Empresa subyacente</th><th class="num">Cartas</th><th class="num">Acciones</th><th class="num">En especie</th><th class="num">Efectivo</th><th class="num">Total</th></tr></thead>
    <tbody>${underRowsHtml}</tbody>
  </table>` : ''}

  ${hist.length ? `<h2>Historial de distribuciones (${hist.length})</h2>
  <table>
    <thead><tr><th>Fecha</th><th>Fondo</th><th>Tipo</th><th>Empresa subyacente</th><th class="num">Acciones</th><th class="num">Valor</th><th class="ctr">Carta</th></tr></thead>
    <tbody>${histRows}</tbody>
  </table>` : ''}

  <div class="foot">
    <strong>Notas:</strong> "En especie" = distribución de acciones de la empresa subyacente; "Efectivo" = proceeds en USD. El valor en especie se toma de la carta de Altareturn cuando está disponible; algunas cartas tempranas solo reportan acciones sin valuación, por lo que el total distribuido puede subestimar ligeramente.
    MOIC consolidado = promedio ponderado por compromiso; por posición, según el último dato de la base.
    <br>Documento interno de Cretum Partners generado desde Cretum Desk — cifras sujetas a verificación. ${hoy}.
  </div>
</div></body></html>`;
}

async function loadDb() {
  const list = document.getElementById('dbList');
  list.innerHTML = '<div class="db-loading"><i class="fa-solid fa-spinner fa-spin"></i> Cargando datos…</div>';
  try {
    // Inversionistas + agregados (todas paginadas: ver sbFetchAll)
    const [investors, investments, companies, series] = await Promise.all([
      sbFetchAll('investors', 'id, name, titular'),
      sbFetchAll('investments', 'investor_id, company_id, series_id, commitment, commitment_actual'),
      sbFetchAll('companies', 'id, name, is_public'),
      sbFetchAll('series', 'id, name'),
    ]);

    dbSeries = series.sort((a, b) => a.name.localeCompare(b.name));

    // Agrega por investor + construye mapas de filtro
    const invMap = {};
    investments.forEach(x => {
      if (!invMap[x.investor_id]) invMap[x.investor_id] = { positions: 0, commitment: 0, actual: 0 };
      invMap[x.investor_id].positions++;
      invMap[x.investor_id].commitment += +x.commitment || 0;
      invMap[x.investor_id].actual += +x.commitment_actual || 0;
      // mapas para filtros
      if (!dbInvestorCompanies[x.investor_id]) dbInvestorCompanies[x.investor_id] = new Set();
      dbInvestorCompanies[x.investor_id].add(x.company_id);
      if (!dbInvestorSeries[x.investor_id]) dbInvestorSeries[x.investor_id] = new Set();
      dbInvestorSeries[x.investor_id].add(x.series_id);
      // relación empresa↔serie a nivel inversión (para filtrado en cascada de los dropdowns)
      if (x.company_id != null && x.series_id != null) {
        (dbCompanySeries[x.company_id] ||= new Set()).add(x.series_id);
        (dbSeriesCompanies[x.series_id] ||= new Set()).add(x.company_id);
      }
    });
    dbInvestors = investors.map(i => ({
      ...i,
      positions: invMap[i.id]?.positions || 0,
      commitment: invMap[i.id]?.commitment || 0,
      actual: invMap[i.id]?.actual || 0,
    })).sort((a, b) => b.commitment - a.commitment || a.name.localeCompare(b.name));

    // Agrega por company
    const compMap = {};
    investments.forEach(x => {
      if (!compMap[x.company_id]) compMap[x.company_id] = { positions: 0, investors: new Set(), commitment: 0, actual: 0 };
      compMap[x.company_id].positions++;
      compMap[x.company_id].investors.add(x.investor_id);
      compMap[x.company_id].commitment += +x.commitment || 0;
      compMap[x.company_id].actual += +x.commitment_actual || 0;
    });
    dbCompanies = companies.map(c => ({
      ...c,
      positions: compMap[c.id]?.positions || 0,
      investors: compMap[c.id]?.investors.size || 0,
      commitment: compMap[c.id]?.commitment || 0,
      actual: compMap[c.id]?.actual || 0,
    })).sort((a, b) => b.commitment - a.commitment || a.name.localeCompare(b.name));

    dbLoaded = true;
    populateFilters();
    renderColumnPicker();
    renderDbList();
  } catch (err) {
    console.error(err);
    list.innerHTML = `<div class="db-error">Error: ${err.message}</div>`;
  }
}

function cddToggle(id) {
  const cdd = document.getElementById(id);
  if (!cdd) return;
  const wasOpen = cdd.classList.contains('open');
  // Close other custom dropdowns first
  document.querySelectorAll('.cdd.open').forEach(el => {
    if (el.id !== id) el.classList.remove('open');
  });
  cdd.classList.toggle('open', !wasOpen);
  // Al abrir un desplegable con buscador: limpia, muestra todo y enfoca
  if (!wasOpen) {
    const si = cdd.querySelector('.cdd-search input');
    if (si) {
      const panel = cdd.querySelector('.cdd-panel');
      si.value = '';
      if (panel) cddFilterOpts(panel.id, '');
      setTimeout(() => si.focus(), 40);
    }
  }
}

function cddPick(id, value, label) {
  const cdd = document.getElementById(id);
  if (!cdd) return;
  cdd.dataset.value = value;
  const labelEl = cdd.querySelector('.cdd-label');
  if (labelEl) labelEl.textContent = label;
  cdd.classList.remove('open');
  cdd.classList.toggle('active', !!value);
  cdd.querySelectorAll('.cdd-opt').forEach(opt => {
    opt.classList.toggle('selected', opt.dataset.value === value);
  });
  renderDbList();
}

// Dropdowns de filtro con selección MÚLTIPLE
const MULTI_CDD = new Set(['ddCompany', 'ddSeries', 'ddTitular']);

// Valores seleccionados (no vacíos) de un dropdown multi
function cddValues(id) {
  const cdd = document.getElementById(id);
  if (!cdd) return [];
  return [...cdd.querySelectorAll('.cdd-opt.selected')].map(o => o.dataset.value).filter(Boolean);
}

// Actualiza el texto del botón según cuántas opciones haya seleccionadas
function updateCddLabel(cdd) {
  const labelEl = cdd.querySelector('.cdd-label');
  const allOpt = cdd.querySelector('.cdd-opt[data-value=""]');
  const def = (allOpt && allOpt.textContent.trim()) || (labelEl ? labelEl.textContent : '');
  const sel = [...cdd.querySelectorAll('.cdd-opt.selected')].filter(o => o.dataset.value);
  if (!sel.length) { labelEl.textContent = def; cdd.classList.remove('active'); }
  else if (sel.length === 1) { labelEl.textContent = sel[0].textContent.trim(); cdd.classList.add('active'); }
  else { labelEl.textContent = sel.length + ' seleccionadas'; cdd.classList.add('active'); }
}

// Click en una opción de un dropdown multi: alterna sin cerrar el panel
function cddPickMulti(id, opt) {
  const cdd = document.getElementById(id);
  if (!cdd) return;
  const allOpt = cdd.querySelector('.cdd-opt[data-value=""]');
  if (!opt.dataset.value) {
    // "Todas…" → limpiar todo
    cdd.querySelectorAll('.cdd-opt').forEach(o => o.classList.toggle('selected', o === allOpt));
  } else {
    opt.classList.toggle('selected');
    if (allOpt) allOpt.classList.remove('selected');
    const anySel = [...cdd.querySelectorAll('.cdd-opt.selected')].some(o => o.dataset.value);
    if (!anySel && allOpt) allOpt.classList.add('selected');  // sin nada → vuelve a "Todas…"
  }
  updateCddLabel(cdd);
  renderDbList();  // el panel queda abierto para seguir eligiendo
}

function populateFilters() {
  const buildPanel = (panelId, allLabel, items, ph) => {
    const panel = document.getElementById(panelId);
    if (!panel) return;
    panel.innerHTML =
      `<div class="cdd-search"><i class="fa-solid fa-magnifying-glass"></i>` +
      `<input type="text" placeholder="${ph}" autocomplete="off" oninput="cddFilterOpts('${panelId}', this.value)"></div>` +
      `<div class="cdd-opt selected" data-value="">${allLabel}</div>` +
      items.map(it => `<div class="cdd-opt" data-value="${escapeHtml(String(it.id))}">${escapeHtml(it.name)}</div>`).join('') +
      `<div class="cdd-noopt" data-noopt style="display:none">Sin coincidencias</div>`;
  };
  buildPanel('ddCompanyPanel', 'Todas las empresas',
    [...dbCompanies].sort((a, b) => a.name.localeCompare(b.name)), 'Buscar empresa…');
  buildPanel('ddSeriesPanel', 'Todas las series', dbSeries, 'Buscar serie…');
  // Titulares distintos por PERSONA (las cuentas conjuntas "A & B" se separan en A y B)
  const titSet = new Set();
  dbInvestors.forEach(i => titularPeople(i.titular).forEach(p => titSet.add(p)));
  const titulares = [...titSet].sort((a, b) => a.localeCompare(b, 'es')).map(t => ({ id: t, name: t }));
  buildPanel('ddTitularPanel', 'Todos los titulares', titulares, 'Buscar titular…');
}

// Filtrado en cascada: valores válidos de un dropdown según lo seleccionado en LOS OTROS.
// Devuelve Set<string> de valores permitidos, o null si no hay restricción.
// Empresa↔Serie se cruzan a nivel inversión (series reales de la empresa); titular a nivel inversionista.
function facetValid(which) {
  const f = getDbFilters();
  let valid = null;
  const intersect = (set) => {
    if (valid == null) valid = new Set(set);
    else valid = new Set([...valid].filter(v => set.has(v)));
  };
  if (which === 'series') {
    if (f.companyIds.length) {
      const s = new Set();
      f.companyIds.forEach(c => (dbCompanySeries[c] || []).forEach(id => s.add(String(id))));
      intersect(s);
    }
    if (f.titulars.length) {
      const s = new Set();
      dbInvestors.forEach(r => { const ps = titularPeople(r.titular); if (f.titulars.some(t => ps.includes(t))) (dbInvestorSeries[r.id] || []).forEach(id => s.add(String(id))); });
      intersect(s);
    }
  } else if (which === 'company') {
    if (f.seriesIds.length) {
      const s = new Set();
      f.seriesIds.forEach(sid => (dbSeriesCompanies[sid] || []).forEach(id => s.add(String(id))));
      intersect(s);
    }
    if (f.titulars.length) {
      const s = new Set();
      dbInvestors.forEach(r => { const ps = titularPeople(r.titular); if (f.titulars.some(t => ps.includes(t))) (dbInvestorCompanies[r.id] || []).forEach(id => s.add(String(id))); });
      intersect(s);
    }
  } else if (which === 'titular') {
    if (f.companyIds.length || f.seriesIds.length) {
      const s = new Set();
      dbInvestors.forEach(r => {
        const okC = !f.companyIds.length || f.companyIds.some(c => dbInvestorCompanies[r.id]?.has(+c));
        const okS = !f.seriesIds.length || f.seriesIds.some(x => dbInvestorSeries[r.id]?.has(+x));
        if (okC && okS) titularPeople(r.titular).forEach(p => s.add(p));
      });
      intersect(s);
    }
  }
  return valid;
}

// Filtra las opciones visibles de un panel: por búsqueda difusa Y por cascada (facetValid)
function cddFilterOpts(panelId, q) {
  const panel = document.getElementById(panelId);
  if (!panel) return;
  const which = { ddCompanyPanel: 'company', ddSeriesPanel: 'series', ddTitularPanel: 'titular' }[panelId];
  const valid = which ? facetValid(which) : null;
  let visibles = 0;
  panel.querySelectorAll('.cdd-opt').forEach(opt => {
    if (!opt.dataset.value) { opt.style.display = ''; return; }  // "Todas…" siempre
    const okQ = fuzzyMatch(q, opt.textContent);
    const okFacet = !valid || valid.has(opt.dataset.value) || opt.classList.contains('selected');
    const show = okQ && okFacet;
    opt.style.display = show ? '' : 'none';
    if (show) visibles++;
  });
  const noopt = panel.querySelector('[data-noopt]');
  if (noopt) noopt.style.display = visibles ? 'none' : '';
}

// Delegación: click en una opción o fuera del dropdown
document.addEventListener('click', (e) => {
  const opt = e.target.closest('.cdd-opt');
  if (opt) {
    const cdd = opt.closest('.cdd');
    if (cdd) {
      if (MULTI_CDD.has(cdd.id)) cddPickMulti(cdd.id, opt);
      else cddPick(cdd.id, opt.dataset.value || '', opt.textContent.trim());
    }
    return;
  }
  if (!e.target.closest('.cdd')) {
    document.querySelectorAll('.cdd.open').forEach(el => el.classList.remove('open'));
  }
});

function clearFilters() {
  document.getElementById('dbSearch').value = '';
  ['ddCompany', 'ddSeries', 'ddTitular'].forEach(id => {
    const cdd = document.getElementById(id);
    if (!cdd) return;
    const allOpt = cdd.querySelector('.cdd-opt[data-value=""]');
    cdd.querySelectorAll('.cdd-opt').forEach(o => o.classList.toggle('selected', o === allOpt));
    updateCddLabel(cdd);
  });
  renderDbList();
}

// filterIds: array de ids seleccionados (multi). Si hay, resalta los que matchean.
function investorSeriesLabel(invId, filterIds) {
  let ids = [...(dbInvestorSeries[invId] || [])];
  if (!ids.length) return '—';
  if (filterIds && filterIds.length) {
    const set = new Set(filterIds.map(Number));
    const inter = ids.filter(id => set.has(id));
    if (inter.length) ids = inter;
  }
  const names = ids.map(id => dbSeries.find(s => s.id === id)?.name).filter(Boolean);
  if (names.length <= 2) return names.join(', ');
  return `${names[0]}, ${names[1]} +${names.length - 2}`;
}

function investorCompanyLabel(invId, filterIds) {
  let ids = [...(dbInvestorCompanies[invId] || [])];
  if (!ids.length) return '—';
  if (filterIds && filterIds.length) {
    const set = new Set(filterIds.map(Number));
    const inter = ids.filter(id => set.has(id));
    if (inter.length) ids = inter;
  }
  const names = ids.map(id => dbCompanies.find(c => c.id === id)?.name).filter(Boolean);
  if (names.length <= 2) return names.join(', ');
  return `${names[0]}, ${names[1]} +${names.length - 2}`;
}

// Filtros activos de la BD (búsqueda + empresa + serie). Fuente única de verdad
// para render y export, así el export respeta exactamente lo que se ve.
function getDbFilters() {
  return {
    q: (document.getElementById('dbSearch').value || '').trim().toLowerCase(),
    companyIds: cddValues('ddCompany'),
    seriesIds: cddValues('ddSeries'),
    titulars: cddValues('ddTitular'),
  };
}

// Un titular puede ser conjunto: "Persona A & Persona B" (o "and"/"/"). Devuelve la lista.
function titularPeople(t) {
  return String(t || '').split(/\s*(?:&|\band\b|\/)\s*/i).map(s => s.trim()).filter(Boolean);
}

function getFilteredInvestors() {
  const { q, companyIds, seriesIds, titulars } = getDbFilters();
  let filtered = dbInvestors;
  if (q) filtered = filtered.filter(r => fuzzyMatch(q, r.name) || fuzzyMatch(q, r.titular || ''));
  if (companyIds.length) filtered = filtered.filter(r => companyIds.some(c => dbInvestorCompanies[r.id]?.has(+c)));
  if (seriesIds.length)  filtered = filtered.filter(r => seriesIds.some(s => dbInvestorSeries[r.id]?.has(+s)));
  if (titulars.length)   filtered = filtered.filter(r => { const ps = titularPeople(r.titular); return titulars.some(t => ps.includes(t)); });
  // Con búsqueda: ordena por RELEVANCIA (mejor coincidencia arriba), no por monto.
  // Si no, el resultado buscado queda enterrado por compromiso y "solo aparece
  // cuando escribes casi el nombre completo".
  if (q) {
    filtered = filtered.slice().sort((a, b) => {
      const sa = Math.max(repScore(q, a.name), repScore(q, a.titular || ''));
      const sb = Math.max(repScore(q, b.name), repScore(q, b.titular || ''));
      return sb - sa || (b.commitment || 0) - (a.commitment || 0) || a.name.localeCompare(b.name, 'es');
    });
  }
  return filtered;
}

function renderDbList() {
  const { q, companyIds, seriesIds, titulars } = getDbFilters();
  const list = document.getElementById('dbList');
  list.style.display = '';
  document.getElementById('dbDetail').classList.remove('show');
  const snapBtn = document.getElementById('dbSnapBtn');
  if (snapBtn) snapBtn.style.display = currentOrg === 'mvp' ? '' : 'none';

  const anyFilter = !!(q || companyIds.length || seriesIds.length || titulars.length);
  document.getElementById('dbClear').style.display = anyFilter ? '' : 'none';

  const filtered = getFilteredInvestors();
  document.getElementById('dbCount').textContent = filtered.length + (filtered.length === 1 ? ' resultado' : ' resultados');

  if (!filtered.length) {
    list.innerHTML = '<div class="db-list-wrap"><div class="db-list-empty">Sin resultados</div></div>';
    return;
  }

  // Headers de la tabla
  const headers = ['<th class="db-check-col"></th>', '<th class="col-name">Nombre</th>'];
  if (isColVisible('titular'))   headers.push('<th>Titular</th>');
  if (isColVisible('series'))    headers.push('<th>Serie</th>');
  if (isColVisible('company'))   headers.push('<th>Empresa</th>');
  if (isColVisible('positions')) headers.push('<th class="num">Posiciones</th>');
  if (isColVisible('actual'))    headers.push('<th class="num">Compromiso ejecutado</th>');
  if (isColVisible('amount'))    headers.push('<th class="num">Compromiso</th>');
  headers.push('<th class="col-arrow"></th>');

  // Filas
  const rows = filtered.map(i => {
    const cells = [
      `<td class="db-check-col" onclick="event.stopPropagation()"><input type="checkbox" class="db-row-check" ${dbSelected.has(i.id) ? 'checked' : ''} onclick="toggleInvestorSel(${i.id}, this.checked)" title="Seleccionar para portafolio combinado"></td>`,
      `<td class="col-name">${escapeHtml(i.name)}</td>`,
    ];
    if (isColVisible('titular')) {
      cells.push(`<td>${i.titular ? escapeHtml(i.titular) : '<span class="db-cell-empty">—</span>'}</td>`);
    }
    if (isColVisible('series')) {
      const lbl = investorSeriesLabel(i.id, seriesIds);
      cells.push(`<td>${lbl === '—' ? '<span class="db-cell-empty">—</span>' : `<span class="db-cell-pill">${escapeHtml(lbl)}</span>`}</td>`);
    }
    if (isColVisible('company')) {
      const lbl = investorCompanyLabel(i.id, companyIds);
      cells.push(`<td>${lbl === '—' ? '<span class="db-cell-empty">—</span>' : `<span class="db-cell-pill muted">${escapeHtml(lbl)}</span>`}</td>`);
    }
    if (isColVisible('positions')) cells.push(`<td class="num muted">${i.positions}</td>`);
    if (isColVisible('actual'))    cells.push(`<td class="num muted">${fmtMoney(i.actual)}</td>`);
    if (isColVisible('amount'))    cells.push(`<td class="num">${fmtMoney(i.commitment)}</td>`);
    cells.push('<td class="col-arrow"><i class="fa-solid fa-chevron-right"></i></td>');
    return `<tr onclick="openInvestor(${i.id})">${cells.join('')}</tr>`;
  });

  list.innerHTML = `
    <div class="db-list-wrap">
      <table class="db-list-table">
        <thead><tr>${headers.join('')}</tr></thead>
        <tbody>${rows.join('')}</tbody>
      </table>
    </div>`;
  updateCombineBar();
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

/* ═══════════════════════════════════════════
   EXPORT — PDF / CSV / Excel (respeta filtros y columnas visibles)
═══════════════════════════════════════════ */

// Carga un <script> externo una sola vez (lazy-load de librerías de export).
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[data-src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.dataset.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('No se pudo cargar la librería de export'));
    document.head.appendChild(s);
  });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Construye {cols, rows} de la BD con los filtros y columnas visibles actuales.
// rows contiene valores crudos (números sin formato) para CSV/Excel usables.
function getExportTable() {
  const { companyIds, seriesIds } = getDbFilters();
  const cols = [{ key: 'name', label: 'Nombre', type: 'text' }];
  if (isColVisible('titular'))   cols.push({ key: 'titular',   label: 'Titular',              type: 'text'  });
  if (isColVisible('series'))    cols.push({ key: 'series',    label: 'Serie',                type: 'text'  });
  if (isColVisible('company'))   cols.push({ key: 'company',   label: 'Empresa',              type: 'text'  });
  if (isColVisible('positions')) cols.push({ key: 'positions', label: 'Posiciones',           type: 'num'   });
  if (isColVisible('actual'))    cols.push({ key: 'actual',    label: 'Compromiso ejecutado', type: 'money' });
  if (isColVisible('amount'))    cols.push({ key: 'amount',    label: 'Compromiso',           type: 'money' });

  const rows = getFilteredInvestors().map(i => cols.map(c => {
    switch (c.key) {
      case 'name':      return i.name;
      case 'titular':   return i.titular || '';
      case 'series':    return investorSeriesLabel(i.id, seriesIds);
      case 'company':   return investorCompanyLabel(i.id, companyIds);
      case 'positions': return i.positions;
      case 'actual':    return i.actual;
      case 'amount':    return i.commitment;
      default:          return '';
    }
  }));
  return { cols, rows };
}

function exportFilename() {
  return `cretum_inversionistas_${new Date().toISOString().slice(0, 10)}`;
}

async function exportData(format) {
  document.getElementById('ddExport')?.classList.remove('open');
  const { cols, rows } = getExportTable();
  if (!rows.length) { toast('No hay datos para exportar'); return; }
  try {
    if (format === 'csv')        exportCSV(cols, rows);
    else if (format === 'excel') await exportExcel(cols, rows);
    else if (format === 'pdf')   await exportPDF(cols, rows);
  } catch (e) {
    console.error('[export]', e);
    toast('Error al exportar: ' + e.message);
  }
}

function exportCSV(cols, rows) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [cols.map(c => esc(c.label)).join(',')];
  rows.forEach(r => lines.push(r.map(esc).join(',')));
  // BOM (﻿) para que Excel lea UTF-8 (acentos) correctamente
  const csv = '﻿' + lines.join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  downloadBlob(blob, exportFilename() + '.csv');
  toast(`Exportadas ${rows.length} filas a CSV`);
}

async function exportExcel(cols, rows) {
  await loadScript('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js');
  const aoa = [cols.map(c => c.label), ...rows];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  // Ancho de columnas según el header
  ws['!cols'] = cols.map(c => ({ wch: Math.max(c.label.length + 2, 14) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Inversionistas');
  XLSX.writeFile(wb, exportFilename() + '.xlsx');
  toast(`Exportadas ${rows.length} filas a Excel`);
}

async function exportPDF(cols, rows) {
  await loadScript('https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js');
  await loadScript('https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.2/dist/jspdf.plugin.autotable.min.js');
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();

  // Formatea dinero solo para el PDF (CSV/Excel llevan número crudo)
  const body = rows.map(r => r.map((cell, idx) =>
    cols[idx].type === 'money' ? fmtMoney(cell) : (cell == null ? '' : String(cell))
  ));

  doc.setFontSize(15);
  doc.setTextColor(26, 58, 107);
  doc.text('Inversionistas — Cretum', 14, 16);
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text(`Generado ${new Date().toLocaleDateString('es-MX')} · ${rows.length} registros`, 14, 22);

  doc.autoTable({
    head: [cols.map(c => c.label)],
    body,
    startY: 27,
    styles: { fontSize: 8, cellPadding: 3 },
    headStyles: { fillColor: [26, 58, 107], textColor: 255 },
    alternateRowStyles: { fillColor: [244, 247, 252] },
  });
  doc.save(exportFilename() + '.pdf');
  toast(`Exportadas ${rows.length} filas a PDF`);
}

/* ═══════════════════════════════════════════
   EXPORT ENRIQUECIDO — detalle de UN inversionista (posiciones + cartas)
   Usa los datos ya cargados en lastInvestorDetail; no re-consulta.
═══════════════════════════════════════════ */

// Reúne y calcula todos los datos del inversionista abierto, listos para exportar.
function buildInvestorExport(posId) {
  const d = lastInvestorDetail;
  if (!d || !d.inv) return null;
  const { inv, contacts } = d;
  let positions = d.positions || [];
  if (posId != null) positions = positions.filter(p => p.id === posId);

  const pos = positions.map(p => {
    const dists = p.investment_distributions || [];
    let inkind = 0, cash = 0;
    dists.forEach(x => { inkind += +x.value_in_kind || 0; cash += +x.cash_proceeds || 0; });
    const num = (v) => (v != null && v !== '') ? +v : null;
    const shares = num(p.shares);
    const base = (+p.commitment_actual || +p.commitment || 0);
    return {
      cuenta: p._acct || null,
      company: p.companies?.name || '—',
      series: p.series?.name || '—',
      estado: p.distributed_at ? 'Terminada' : 'Activa',
      commitment: +p.commitment || 0,
      commitment_actual: +p.commitment_actual || 0,
      carry: num(p.carry_pct),
      shares,
      entry_ev_b: num(p.entry_ev_b),
      entry_pps: num(p.entry_pps),
      current_ev_b: num(p.current_ev_b),
      current_pps: num(p.current_ev_pps),
      all_in_pps: (shares && base) ? base / shares : null,
      moic: num(p.dpi_moic),
      valor_actual: (shares != null && num(p.current_ev_pps) != null) ? shares * (+p.current_ev_pps) : null,
      distribuido: inkind + cash,
      n_cartas: dists.length,
      inicio: p.start_date || '',
      fin: p.end_date || '',
      duracion: num(p.duration_years),
      carta_ca: p.last_ca_letter || '',
      _dists: dists,
    };
  }).sort((a, b) => b.commitment - a.commitment);

  // Cartas (todas las distribuciones, aplanadas con su posición)
  const letters = [];
  pos.forEach(p => {
    (p._dists || []).forEach(x => {
      const val = (+x.value_in_kind || 0) + (+x.cash_proceeds || 0);
      const num = (v) => (v != null && v !== '') ? +v : null;
      letters.push({
        company: p.company, series: p.series,
        fecha: x.distribution_date || '',
        tipo: x.letter_type === 'distribution_cash' ? 'Efectivo' : 'En especie',
        subyacente: x.underlying_company || '',
        shares: num(x.shares_distributed),
        pps: num(x.price_per_share),
        cash: num(x.cash_proceeds),
        especie: num(x.value_in_kind),
        total: val || null,
        carta: x.letter_url || '',
        notas: x.notes || '',
      });
    });
  });
  letters.sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''));

  // Valor actual estimado por posición: el real (acciones×PPS) o, si no hay acciones,
  // el aportado × MOIC (así siempre tenemos un valor para graficar el desempeño).
  pos.forEach(p => {
    const aportado = p.commitment_actual || p.commitment;
    p.valor_estimado = p.valor_actual != null ? p.valor_actual
      : (p.moic != null && aportado ? aportado * p.moic : null);
  });

  // Totales
  const totCommit = pos.reduce((s, p) => s + p.commitment, 0);
  const totActual = pos.reduce((s, p) => s + p.commitment_actual, 0);
  const totDist = pos.reduce((s, p) => s + p.distribuido, 0);
  const valorEstimado = pos.reduce((s, p) => s + (p.valor_estimado || 0), 0);
  let moicW = 0, moicBase = 0;
  pos.forEach(p => { if (p.moic != null && p.commitment > 0) { moicBase += p.commitment; moicW += p.commitment * p.moic; } });
  const portMoic = moicBase > 0 ? moicW / moicBase : 0;
  // DPI estándar = distribuido / capital comprometido (paid-in), no sobre el valor marcado
  const dpi = totCommit > 0 ? totDist / totCommit : 0;

  const combined = !!inv._combined;
  return { inv, combined, contacts: contacts || [], pos, letters, totals: { totCommit, totActual, totDist, valorEstimado, portMoic, dpi } };
}

// Nombre de archivo seguro a partir del nombre del inversionista (+ etiqueta opcional)
function invExportFilename(inv, extra) {
  const clean = (s) => String(s || '').replace(/[^\w\sáéíóúñÁÉÍÓÚÑ-]/gi, '').trim().replace(/\s+/g, '_').slice(0, 40);
  const parts = ['cretum', clean(inv.name) || 'inversionista'];
  if (extra) { const e = clean(extra); if (e) parts.push(e); }
  return parts.join('_') + '_' + new Date().toISOString().slice(0, 10);
}

// Quita las columnas que están vacías en TODAS las filas (evita huecos feos).
function dropEmptyCols(headers, rows, meta) {
  const keep = headers.map((_, c) => rows.some(r => { const v = r[c]; return v != null && v !== ''; }));
  if (!keep.some(Boolean)) keep[0] = true;   // conserva al menos una
  return {
    headers: headers.filter((_, c) => keep[c]),
    rows: rows.map(r => r.filter((_, c) => keep[c])),
    meta: meta.filter((_, c) => keep[c]),
  };
}

// Construye una hoja con anchos + formatos numéricos por columna + autofiltro.
function sheetWithFormats(headers, rows, meta) {
  const aoa = [headers, ...rows.map(r => r.map(v => v == null ? '' : v))];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = meta.map((m, i) => ({ wch: m.w || Math.max(String(headers[i]).length + 2, 12) }));
  ws['!autofilter'] = { ref: ws['!ref'] };
  ws['!freeze'] = { xSplit: 0, ySplit: 1 };
  const range = XLSX.utils.decode_range(ws['!ref']);
  for (let c = 0; c < meta.length; c++) {
    const z = meta[c] && meta[c].z;
    if (!z) continue;
    for (let r = 1; r <= range.e.r; r++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (cell && typeof cell.v === 'number') { cell.t = 'n'; cell.z = z; }
    }
  }
  return ws;
}

// Formatea un eje monetario compacto según la magnitud máxima de la serie.
function moneyAxisFmt(maxVal) {
  if (maxVal >= 1e6) return (v) => '$' + (v / 1e6).toFixed(v / 1e6 >= 10 ? 0 : 1) + 'M';
  if (maxVal >= 1e3) return (v) => '$' + (v / 1e3).toFixed(0) + 'K';
  return (v) => '$' + Number(v).toLocaleString('en-US');
}

// Renderiza una config de Chart.js a PNG (dataURL) en un canvas fuera de pantalla.
async function renderChartPng(config, w, h) {
  await loadScript('https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js');
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.style.cssText = 'position:fixed;left:-10000px;top:0';
  document.body.appendChild(canvas);
  config.options = config.options || {};
  config.options.animation = false;
  config.options.responsive = false;
  config.options.devicePixelRatio = 2;
  config.options.layout = { padding: 10 };
  const chart = new Chart(canvas.getContext('2d'), config);
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const dataUrl = canvas.toDataURL('image/png', 1.0);
  chart.destroy();
  canvas.remove();
  return { dataUrl, w, h };
}

// Construye las imágenes de gráficas para un inversionista (puede devolver 0, 1 o 2).
async function investorChartImages(data) {
  const out = [];
  const short = (s) => { s = String(s || ''); return s.length > 16 ? s.slice(0, 15) + '…' : s; };
  // Paleta MVP: naranja líder + neutros discretos; verde/rojo solo para ganancia/pérdida
  const MVP = '#E8650D', SLATE = '#9aa3b5', POS = '#2E9E5B', NEG = '#C0392B';
  const PAL = ['#E8650D', '#1F3A5F', '#E0A458', '#5B8C7B', '#9B6A8F', '#7A93B0', '#C9572E', '#3F6B5E', '#B8923E', '#6B7689'];
  try {
    // 1) Aportado vs. valor actual estimado (por posición) — siempre que haya posiciones con monto
    const conMonto = data.pos.filter(p => (p.commitment_actual || p.commitment) > 0);
    if (conMonto.length) {
      const labels = conMonto.map(p => short(p.company));
      const aportado = conMonto.map(p => p.commitment || p.commitment_actual);   // costo (capital comprometido)
      const valor = conMonto.map(p => p.valor_estimado != null ? p.valor_estimado : null);
      const maxV = Math.max(...aportado, ...valor.map(v => v || 0));
      const fmt = moneyAxisFmt(maxV);
      out.push(await renderChartPng({
        type: 'bar',
        data: { labels, datasets: [
          { label: 'Comprometido', data: aportado, backgroundColor: SLATE, borderRadius: 4, maxBarThickness: 64 },
          { label: 'Valor actual est.', data: valor, backgroundColor: MVP, borderRadius: 4, maxBarThickness: 64 },
        ] },
        options: {
          plugins: {
            legend: { position: 'top', labels: { font: { size: 13 }, usePointStyle: true, boxWidth: 8 } },
            title: { display: true, text: 'Comprometido vs. valor actual estimado', font: { size: 16, weight: '600' }, color: '#1a1f2e', padding: { bottom: 12 } },
          },
          scales: {
            y: { beginAtZero: true, ticks: { callback: fmt, font: { size: 12 }, color: '#6b7689' }, grid: { color: '#eef1f6' } },
            x: { ticks: { font: { size: 12 }, color: '#1a1f2e' }, grid: { display: false } },
          },
        },
      }, 1000, 360));
    }

    // 2) Distribuciones acumuladas en el tiempo — solo si hay 2+ cartas fechadas
    const dated = data.letters.filter(x => x.fecha && (x.total || 0) > 0)
      .slice().sort((a, b) => (a.fecha || '').localeCompare(b.fecha || ''));
    if (dated.length >= 2) {
      let acc = 0;
      const labels = dated.map(x => x.fecha);
      const cum = dated.map(x => (acc += (x.total || 0)));
      const fmt = moneyAxisFmt(Math.max(...cum));
      out.push(await renderChartPng({
        type: 'line',
        data: { labels, datasets: [{ label: 'Distribuido acumulado', data: cum, borderColor: MVP, backgroundColor: 'rgba(232,101,13,.15)', fill: true, tension: .25, pointRadius: 3, pointBackgroundColor: MVP, borderWidth: 2.5 }] },
        options: {
          plugins: {
            legend: { display: false },
            title: { display: true, text: 'Distribuciones acumuladas en el tiempo', font: { size: 16, weight: '600' }, color: '#1a1f2e', padding: { bottom: 12 } },
          },
          scales: {
            y: { beginAtZero: true, ticks: { callback: fmt, font: { size: 12 }, color: '#6b7689' }, grid: { color: '#eef1f6' } },
            x: { ticks: { font: { size: 11 }, color: '#6b7689', maxRotation: 45, minRotation: 0 }, grid: { display: false } },
          },
        },
      }, 1000, 340));
    }
    // NAV activo por posición (base consistente con el 360 y el snapshot)
    const activePos = data.pos.filter(p => p.estado === 'Activa');
    const navOf = p => (+p.commitment_actual || +p.commitment || 0);
    const donutOpts = (title) => ({
      plugins: {
        legend: { position: 'right', labels: { font: { size: 12 }, usePointStyle: true, boxWidth: 8 } },
        title: { display: true, text: title, font: { size: 16, weight: '600' }, color: '#1a1f2e', padding: { bottom: 12 } },
      },
      cutout: '58%',
    });

    // 3) Composición del portafolio por empresa (NAV activo) — dona
    const byCo = {};
    activePos.forEach(p => { if (navOf(p) > 0) byCo[p.company] = (byCo[p.company] || 0) + navOf(p); });
    let coEntries = Object.entries(byCo).sort((a, b) => b[1] - a[1]);
    if (coEntries.length) {
      const top = coEntries.slice(0, 8);
      const rest = coEntries.slice(8);
      if (rest.length) top.push(['Otros', rest.reduce((s, [, v]) => s + v, 0)]);
      out.push(await renderChartPng({
        type: 'doughnut',
        data: { labels: top.map(e => e[0]), datasets: [{ data: top.map(e => e[1]), backgroundColor: PAL, borderColor: '#fff', borderWidth: 2 }] },
        options: donutOpts('Composición por empresa (NAV activo)'),
      }, 600, 360));
    }

    // 4) Exposición por tema/sector (NAV activo) — dona
    const byTheme = {};
    activePos.forEach(p => { if (navOf(p) > 0) { const th = companyTheme(p.company); byTheme[th] = (byTheme[th] || 0) + navOf(p); } });
    const thEntries = Object.entries(byTheme).sort((a, b) => b[1] - a[1]);
    if (thEntries.length) {
      out.push(await renderChartPng({
        type: 'doughnut',
        data: { labels: thEntries.map(e => e[0]), datasets: [{ data: thEntries.map(e => e[1]), backgroundColor: PAL, borderColor: '#fff', borderWidth: 2 }] },
        options: donutOpts('Exposición por tema (NAV activo)'),
      }, 600, 360));
    }

    // 5) MOIC por posición — barras horizontales (verde >=1x, rojo <1x)
    const moicPos = activePos
      .filter(p => p.moic != null && (+p.commitment || +p.commitment_actual) > 0)
      .map(p => ({ name: p.company, moic: +p.moic }))
      .sort((a, b) => b.moic - a.moic)
      .slice(0, 14);
    if (moicPos.length) {
      out.push(await renderChartPng({
        type: 'bar',
        data: { labels: moicPos.map(p => short(p.name)), datasets: [{ label: 'MOIC', data: moicPos.map(p => p.moic), backgroundColor: moicPos.map(p => p.moic >= 1 ? POS : NEG), borderRadius: 4, maxBarThickness: 26 }] },
        options: {
          indexAxis: 'y',
          plugins: {
            legend: { display: false },
            title: { display: true, text: 'MOIC por posición', font: { size: 16, weight: '600' }, color: '#1a1f2e', padding: { bottom: 12 } },
          },
          scales: {
            x: { beginAtZero: true, ticks: { callback: v => v + 'x', font: { size: 12 }, color: '#6b7689' }, grid: { color: '#eef1f6' } },
            y: { ticks: { font: { size: 11 }, color: '#1a1f2e' }, grid: { display: false } },
          },
        },
      }, 980, Math.max(280, 70 + moicPos.length * 26)));
    }
  } catch (e) {
    console.warn('[charts] no se pudo generar gráfica:', e);
  }
  return out;
}

async function exportInvestorXlsx(posId) {
  const data = buildInvestorExport(posId);
  if (!data) { toast('Abre un inversionista primero'); return; }
  if (posId != null && !data.pos.length) { toast('No encontré esa posición'); return; }
  const single = posId != null;
  const extra = single && data.pos[0] ? data.pos[0].company : '';
  try {
    await loadScript('https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js');
    const charts = await investorChartImages(data);
    const wb = new ExcelJS.Workbook();
    wb.creator = 'MVP Manager';

    const NAVY = 'FF17436B', ORANGE = 'FFE8650D', GREEN = 'FF0F9B5A', RED = 'FFC0392B', GRAY = 'FF8A93A6', INK = 'FF1A1F2E', ZEBRA = 'FFF4F7FC';
    const Z = { money: '"$"#,##0', money2: '"$"#,##0.00', pct: '0.00%', moic: '0.00"x"', evb: '"$"0.00"B"', sh: '#,##0', dur: '0.00" yrs"' };
    const t = data.totals;

    // Tabla estilizada (header navy, zebra, formatos, autofiltro, freeze)
    const styledTable = (ws, headers, rows, meta) => {
      const hr = ws.getRow(1);
      headers.forEach((h, i) => {
        const c = hr.getCell(i + 1);
        c.value = h;
        c.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
        c.alignment = { vertical: 'middle', horizontal: meta[i].num ? 'right' : 'left' };
      });
      hr.height = 18;
      rows.forEach((r, ri) => {
        const row = ws.getRow(2 + ri);
        r.forEach((v, i) => {
          const c = row.getCell(i + 1);
          c.value = (v === '' ? null : v);
          if (meta[i].z && typeof c.value === 'number') c.numFmt = meta[i].z;
          c.alignment = { horizontal: meta[i].num ? 'right' : 'left' };
          c.font = { size: 10, color: { argb: INK } };
          if (ri % 2 === 1) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ZEBRA } };
        });
      });
      headers.forEach((h, i) => { ws.getColumn(i + 1).width = meta[i].w || Math.max(String(h).length + 2, 12); });
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
      ws.views = [{ state: 'frozen', ySplit: 1, showGridLines: false }];
    };

    // ── Hoja Resumen (hero + KPIs + gráfica) ──
    const R = wb.addWorksheet('Resumen', { views: [{ showGridLines: false }] });
    R.mergeCells('A1:F1');
    const tcell = R.getCell('A1');
    tcell.value = data.inv.name;
    tcell.font = { size: 22, bold: true, color: { argb: ORANGE } };
    R.getRow(1).height = 30;
    R.mergeCells('A2:F2');
    const subParts = [];
    if (data.inv._accounts) subParts.push(data.inv._accounts.map(a => a.name).join(' + '));
    else if (data.inv.titular) subParts.push('Titular: ' + data.inv.titular);
    if (single && data.pos[0]) subParts.push(data.pos[0].company + ' · ' + data.pos[0].series);
    else subParts.push(data.pos.length + ' posiciones');
    subParts.push('Generado ' + new Date().toLocaleDateString('es-MX'));
    R.getCell('A2').value = subParts.join('   ·   ');
    R.getCell('A2').font = { size: 10, color: { argb: GRAY } };

    const kpis = [
      { l: 'Compromiso total', v: t.totCommit, z: Z.money, accent: ORANGE, big: true },
      { l: 'Comp. ejecutado', v: t.totActual, z: Z.money, accent: INK },
      { l: 'Valor actual est.', v: t.valorEstimado || null, z: Z.money, accent: (t.valorEstimado >= t.totActual ? GREEN : RED) },
      { l: 'Distribuido', v: t.totDist, z: Z.money, accent: INK },
      { l: 'MOIC', v: t.portMoic, z: Z.moic, accent: INK },
      { l: 'DPI', v: t.dpi, z: Z.moic, accent: INK },
    ];
    kpis.forEach((k, i) => {
      const col = i + 1;
      const lc = R.getCell(4, col);
      lc.value = k.l.toUpperCase();
      lc.font = { size: 8, bold: true, color: { argb: GRAY } };
      const vc = R.getCell(5, col);
      vc.value = k.v;
      if (typeof k.v === 'number') vc.numFmt = k.z;
      vc.font = { size: k.big ? 17 : 14, bold: true, color: { argb: k.accent } };
      R.getColumn(col).width = 17;
    });
    R.getRow(5).height = 24;

    // Gráfica(s) embebidas
    let imgRow = 7;
    charts.forEach(ch => {
      const id = wb.addImage({ base64: ch.dataUrl.split(',')[1], extension: 'png' });
      const dispW = 560, dispH = Math.round(dispW * ch.h / ch.w);
      R.addImage(id, { tl: { col: 0, row: imgRow }, ext: { width: dispW, height: dispH } });
      imgRow += Math.ceil(dispH / 20) + 2;
    });

    // Contactos debajo de la(s) gráfica(s)
    if (data.contacts.length) {
      const cStart = imgRow + 1;
      R.getCell(cStart, 1).value = 'CONTACTOS';
      R.getCell(cStart, 1).font = { size: 9, bold: true, color: { argb: GRAY } };
      data.contacts.forEach((c, i) => {
        R.getCell(cStart + 1 + i, 1).value = c.name || '—';
        R.getCell(cStart + 1 + i, 2).value = c.email || '';
        R.getCell(cStart + 1 + i, 1).font = { size: 10, color: { argb: INK } };
        R.getCell(cStart + 1 + i, 2).font = { size: 10, color: { argb: GRAY } };
      });
    }

    // ── Hoja Posiciones ──
    const acctCol = data.combined;
    const posHead = (acctCol ? ['Cuenta'] : []).concat(['Empresa', 'Series', 'Estado', 'Compromiso', 'Comp. ejecutado', 'Carry', 'Acciones', 'Entry EV', 'Entry PPS', 'Current EV', 'Current PPS', 'All-in PPS', 'MOIC', 'Valor actual est.', 'Distribuido', '# Cartas', 'Inicio', 'Fin', 'Duración', 'Última carta (CA)']);
    const posRows = data.pos.map(p => (acctCol ? [p.cuenta || '—'] : []).concat([p.company, p.series, p.estado, p.commitment, p.commitment_actual, p.carry, p.shares, p.entry_ev_b, p.entry_pps, p.current_ev_b, p.current_pps, p.all_in_pps, p.moic, p.valor_estimado, p.distribuido, p.n_cartas, p.inicio, p.fin, p.duracion, p.carta_ca]));
    const posMeta = (acctCol ? [{ w: 24 }] : []).concat([{ w: 26 }, { w: 18 }, { w: 11 }, { w: 15, z: Z.money, num: 1 }, { w: 15, z: Z.money, num: 1 }, { w: 9, z: Z.pct, num: 1 }, { w: 13, z: Z.sh, num: 1 }, { w: 11, z: Z.evb, num: 1 }, { w: 11, z: Z.money2, num: 1 }, { w: 11, z: Z.evb, num: 1 }, { w: 12, z: Z.money2, num: 1 }, { w: 12, z: Z.money2, num: 1 }, { w: 9, z: Z.moic, num: 1 }, { w: 16, z: Z.money, num: 1 }, { w: 15, z: Z.money, num: 1 }, { w: 9, z: Z.sh, num: 1 }, { w: 12 }, { w: 12 }, { w: 11, z: Z.dur, num: 1 }, { w: 44 }]);
    const P = dropEmptyCols(posHead, posRows, posMeta);
    styledTable(wb.addWorksheet('Posiciones', { views: [{ showGridLines: false }] }), P.headers, P.rows, P.meta);

    // ── Hoja Distribuciones (cartas) ──
    if (data.letters.length) {
      const lHead = ['Empresa', 'Series', 'Fecha', 'Tipo', 'Empresa subyacente', 'Acciones', 'PPS', 'Efectivo', 'En especie', 'Total', 'Carta', 'Notas'];
      const lRows = data.letters.map(x => [x.company, x.series, x.fecha, x.tipo, x.subyacente, x.shares, x.pps, x.cash, x.especie, x.total, x.carta, x.notas]);
      const lMeta = [{ w: 24 }, { w: 18 }, { w: 12 }, { w: 11 }, { w: 24 }, { w: 13, z: Z.sh, num: 1 }, { w: 11, z: Z.money2, num: 1 }, { w: 14, z: Z.money, num: 1 }, { w: 14, z: Z.money, num: 1 }, { w: 14, z: Z.money, num: 1 }, { w: 44 }, { w: 30 }];
      const L = dropEmptyCols(lHead, lRows, lMeta);
      styledTable(wb.addWorksheet('Distribuciones', { views: [{ showGridLines: false }] }), L.headers, L.rows, L.meta);
    }

    const buf = await wb.xlsx.writeBuffer();
    downloadBlob(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), invExportFilename(data.inv, extra) + '.xlsx');
    toast(single ? `Excel: ${extra}` : `Excel: ${data.pos.length} posiciones · ${data.letters.length} cartas`);
  } catch (e) {
    console.error('[export inv xlsx]', e);
    toast('Error al exportar: ' + e.message);
  }
}

async function exportInvestorPdf(posId) {
  const data = buildInvestorExport(posId);
  if (!data) { toast('Abre un inversionista primero'); return; }
  if (posId != null && !data.pos.length) { toast('No encontré esa posición'); return; }
  const single = posId != null;
  const extra = single && data.pos[0] ? data.pos[0].company : '';
  try {
    await loadScript('https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js');
    await loadScript('https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.2/dist/jspdf.plugin.autotable.min.js');
    const charts = await investorChartImages(data);
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
    const orange = [232, 101, 13], dark = [31, 42, 68], green = [15, 155, 90], red = [192, 57, 67], ink = [26, 31, 46], gray = [122, 134, 152];
    const navy = orange;   // acento principal = naranja MVP
    const PW = doc.internal.pageSize.getWidth();
    const PH = doc.internal.pageSize.getHeight();
    const M = 32;
    const t = data.totals;

    const line = [232, 236, 242];
    const sectionTitle = (txt, yy) => {
      doc.setFillColor(orange[0], orange[1], orange[2]); doc.rect(M, yy - 9, 3, 12, 'F');
      doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(dark[0], dark[1], dark[2]);
      doc.text(txt, M + 9, yy);
      doc.setDrawColor(line[0], line[1], line[2]); doc.setLineWidth(0.5); doc.line(M, yy + 7, PW - M, yy + 7);
    };

    // Encabezado limpio: regla de marca + eyebrow + acento + título (estilo dashboard)
    doc.setFillColor(orange[0], orange[1], orange[2]);
    doc.rect(0, 0, PW, 5, 'F');
    const sub = [];
    if (data.inv._accounts) sub.push(data.inv._accounts.map(a => a.name).join(' + '));
    else if (data.inv.titular) sub.push('Titular: ' + data.inv.titular);
    if (single && data.pos[0]) sub.push('Oportunidad: ' + data.pos[0].company + ' · ' + data.pos[0].series);
    else sub.push(data.pos.length + ' posiciones');
    sub.push('Generado ' + new Date().toLocaleDateString('es-MX'));
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(orange[0], orange[1], orange[2]);
    doc.text(single ? 'MVP · REPORTE DE OPORTUNIDAD' : 'MVP · REPORTE DE PORTAFOLIO', M, 32);
    doc.setFillColor(orange[0], orange[1], orange[2]); doc.rect(M, 41, 3.5, 24, 'F');
    doc.setFontSize(22); doc.setTextColor(dark[0], dark[1], dark[2]);
    doc.text(data.inv.name, M + 12, 60);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(gray[0], gray[1], gray[2]);
    doc.text(sub.join('   ·   '), M + 12, 76);

    // KPIs en barra unificada (label + valor por celda, divididas)
    const kpis = [
      { l: 'COMPROMISO TOTAL', v: fmtMoney(t.totCommit), accent: orange },
      { l: 'COMP. EJECUTADO', v: fmtMoney(t.totActual), accent: ink },
      { l: 'VALOR ACTUAL EST.', v: t.valorEstimado ? fmtMoney(t.valorEstimado) : '—', accent: (t.valorEstimado >= t.totActual ? green : red) },
      { l: 'DISTRIBUIDO', v: fmtMoney(t.totDist), accent: ink },
      { l: 'MOIC', v: t.portMoic.toFixed(2) + 'x', accent: ink },
      { l: 'DPI', v: t.dpi.toFixed(2) + 'x', accent: ink },
    ];
    const gap = 12, stripY = 92, stripH = 58;
    doc.setFillColor(250, 251, 253); doc.setDrawColor(228, 233, 240); doc.setLineWidth(0.5);
    doc.roundedRect(M, stripY, PW - 2 * M, stripH, 7, 7, 'FD');
    const cw = (PW - 2 * M) / kpis.length;
    kpis.forEach((k, i) => {
      const cx = M + i * cw;
      if (i > 0) { doc.setDrawColor(line[0], line[1], line[2]); doc.line(cx, stripY + 12, cx, stripY + stripH - 12); }
      doc.setFont('helvetica', 'bold'); doc.setFontSize(7); doc.setTextColor(gray[0], gray[1], gray[2]);
      doc.text(k.l, cx + 14, stripY + 22);
      doc.setFontSize(15); doc.setTextColor(k.accent[0], k.accent[1], k.accent[2]);
      doc.text(String(k.v), cx + 14, stripY + 43);
    });

    let y = stripY + stripH + 20;

    // Gráficas en tarjetas con borde (2 columnas; última sola → ancho completo)
    if (charts.length) {
      const pad = 12, colW = (PW - 2 * M - gap) / 2, footer = 34;
      for (let i = 0; i < charts.length; i += 2) {
        const pair = charts.slice(i, i + 2);
        const full = pair.length === 1;
        const rowH = Math.max(...pair.map(ch => {
          const w = full ? (PW - 2 * M) : colW;
          return Math.round((w - 2 * pad) * ch.h / ch.w) + 2 * pad;
        }));
        if (y + rowH > PH - footer) { doc.addPage(); y = 40; }
        pair.forEach((ch, j) => {
          const w = full ? (PW - 2 * M) : colW;
          const x = M + j * (colW + gap);
          doc.setFillColor(255, 255, 255); doc.setDrawColor(228, 233, 240); doc.setLineWidth(0.5);
          doc.roundedRect(x, y, w, rowH, 6, 6, 'FD');
          const iw = w - 2 * pad, ih = Math.round(iw * ch.h / ch.w);
          doc.addImage(ch.dataUrl, 'PNG', x + pad, y + pad, iw, ih);
        });
        y += rowH + gap;
      }
    }

    const money = (v) => v == null ? '' : fmtMoney(v);
    const pps = (v) => v == null ? '' : '$' + (+v).toFixed(2);
    const sh = (v) => v == null ? '' : Number(v).toLocaleString('en-US');

    if (y > PH - 130) { doc.addPage(); y = 40; }   // que el título + tabla no queden pegados al borde
    sectionTitle('Posiciones', y);
    const acctCol = data.combined;   // combinado → muestra de qué cuenta es cada posición
    const posHead = (acctCol ? ['Cuenta'] : []).concat(['Empresa', 'Series', 'Estado', 'Compromiso', 'Carry', 'Acciones', 'Entry PPS', 'Current PPS', 'All-in PPS', 'MOIC', 'Valor est.', 'Distribuido', 'Cartas']);
    const numFrom = acctCol ? 4 : 3;   // índice de la 1ª columna numérica (Compromiso)
    const colStyles = {};
    for (let c = numFrom; c <= numFrom + 9; c++) colStyles[c] = { halign: 'right' };
    doc.autoTable({
      startY: y + 16,
      margin: { left: M, right: M, top: 40, bottom: 28 },
      head: [posHead],
      body: data.pos.map(p => (acctCol ? [p.cuenta || '—'] : []).concat([p.company, p.series, p.estado, money(p.commitment), (p.carry != null ? (p.carry * 100).toFixed(1) + '%' : ''), sh(p.shares), pps(p.entry_pps), pps(p.current_pps), pps(p.all_in_pps), (p.moic != null ? p.moic.toFixed(2) + 'x' : ''), money(p.valor_estimado), money(p.distribuido), p.n_cartas || ''])),
      styles: { fontSize: 7.5, cellPadding: 4, overflow: 'linebreak', lineColor: line, lineWidth: 0.3, textColor: [45, 52, 70] },
      headStyles: { fillColor: dark, textColor: 255, fontSize: 7.5, cellPadding: 5 },
      alternateRowStyles: { fillColor: [248, 250, 252] },
      columnStyles: colStyles,
    });

    if (data.letters.length) {
      let ly = doc.lastAutoTable.finalY + 26;
      if (ly > PH - 90) { doc.addPage(); ly = 46; }
      sectionTitle('Distribuciones (cartas)', ly);
      doc.autoTable({
        startY: ly + 16,
        margin: { left: M, right: M, top: 40, bottom: 28 },
        head: [['Empresa', 'Fecha', 'Tipo', 'Empresa subyacente', 'Acciones', 'PPS', 'Efectivo', 'En especie', 'Total', 'Carta']],
        body: data.letters.map(x => [x.company, x.fecha, x.tipo, x.subyacente, sh(x.shares), pps(x.pps), money(x.cash), money(x.especie), money(x.total), (x.carta ? 'Ver' : '')]),
        styles: { fontSize: 7.5, cellPadding: 4, overflow: 'linebreak', lineColor: line, lineWidth: 0.3, textColor: [45, 52, 70] },
        headStyles: { fillColor: dark, textColor: 255, fontSize: 7.5, cellPadding: 5 },
        alternateRowStyles: { fillColor: [248, 250, 252] },
        columnStyles: { 4: { halign: 'right' }, 5: { halign: 'right' }, 6: { halign: 'right' }, 7: { halign: 'right' }, 8: { halign: 'right' }, 9: { halign: 'center', textColor: navy } },
        didDrawCell: (hk) => {
          if (hk.section === 'body' && hk.column.index === 9) {
            const row = data.letters[hk.row.index];
            if (row && row.carta) doc.link(hk.cell.x, hk.cell.y, hk.cell.width, hk.cell.height, { url: row.carta });
          }
        },
      });
    }

    // Pie con fecha en cada página
    const pages = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pages; i++) {
      doc.setPage(i);
      doc.setFontSize(7.5); doc.setTextColor(160);
      doc.text(`MVP Manager · documento interno · ${new Date().toLocaleDateString('es-MX')} · pág. ${i}/${pages}`, M, PH - 16);
    }

    doc.save(invExportFilename(data.inv, extra) + '.pdf');
    toast(single ? `PDF: ${extra}` : 'PDF generado');
  } catch (e) {
    console.error('[export inv pdf]', e);
    toast('Error al generar PDF: ' + e.message);
  }
}

async function openInvestor(id) {
  const inv = dbInvestors.find(x => x.id === id);
  if (!inv) return;
  showDetailLoading();
  try {
    const [{ data: contacts }, { data: positions }] = await Promise.all([
      sb.from('contacts').select('id, name, email').eq('investor_id', id).order('id'),
      sb.from('investments')
        .select(`id, entry_ev_b, entry_pps, current_ev_b, current_ev_pps, shares,
                 commitment, commitment_actual, dpi_moic, carry_pct,
                 start_date, end_date, duration_years, distributed_at, last_ca_letter,
                 series(name), companies(id, name, is_public),
                 investment_distributions(distribution_date, letter_type, underlying_company,
                   price_per_share, shares_distributed, cash_proceeds, value_in_kind, letter_url, notes)`)
        .eq('investor_id', id),
    ]);
    renderInvestorDetail(inv, contacts || [], positions || []);
  } catch (err) {
    document.getElementById('dbDetailContent').innerHTML = `<div class="db-error">Error: ${err.message}</div>`;
  }
}

// Portafolio COMBINADO: une las posiciones de varios inversionistas en una sola vista 360.
async function openInvestorGroup(ids) {
  if (!ids || !ids.length) return;
  if (ids.length === 1) return openInvestor(ids[0]);
  const invs = ids.map(id => dbInvestors.find(x => x.id === id)).filter(Boolean);
  if (!invs.length) return;
  showDetailLoading();
  try {
    const [{ data: contacts }, { data: positions }] = await Promise.all([
      sb.from('contacts').select('id, name, email, investor_id').in('investor_id', ids).order('id'),
      sb.from('investments')
        .select(`id, investor_id, entry_ev_b, entry_pps, current_ev_b, current_ev_pps, shares,
                 commitment, commitment_actual, dpi_moic, carry_pct,
                 start_date, end_date, duration_years, distributed_at, last_ca_letter,
                 series(name), companies(id, name, is_public),
                 investment_distributions(distribution_date, letter_type, underlying_company,
                   price_per_share, shares_distributed, cash_proceeds, value_in_kind, letter_url, notes)`)
        .in('investor_id', ids),
    ]);
    const nameById = Object.fromEntries(invs.map(i => [i.id, i.name]));
    (positions || []).forEach(p => { p._acct = nameById[p.investor_id] || '—'; });
    const synthetic = {
      _combined: true,
      _accounts: invs.map(i => ({ id: i.id, name: i.name })),
      name: 'Portafolio combinado',
      titular: null,
      positions: (positions || []).length,
      commitment: invs.reduce((s, i) => s + (+i.commitment || 0), 0),
      actual: invs.reduce((s, i) => s + (+i.actual || 0), 0),
    };
    renderInvestorDetail(synthetic, contacts || [], positions || []);
  } catch (err) {
    document.getElementById('dbDetailContent').innerHTML = `<div class="db-error">Error: ${err.message}</div>`;
  }
}

// Guarda el "Titular" (a quién pertenece la cuenta) de un inversionista
async function saveTitular(id, value) {
  const v = (value || '').trim();
  const inv = dbInvestors.find(x => x.id === id);
  if (!inv) return;
  if ((inv.titular || '') === v) return;   // sin cambios
  const { error } = await sb.from('investors').update({ titular: v || null }).eq('id', id);
  if (error) { toast('Error al guardar titular: ' + error.message); return; }
  inv.titular = v || null;
  if (lastInvestorDetail?.inv?.id === id) lastInvestorDetail.inv.titular = v || null;
  toast('Titular actualizado');
}

// Editar nombre/email de un contacto (editor/admin)
async function contactSave(id, field, el) {
  const v = (el.value || '').trim();
  const c = lastInvestorDetail?.contacts?.find(x => x.id === id);
  if (c && (c[field] || '') === v) return;   // sin cambios
  const { error } = await sb.from('contacts').update({ [field]: v || null }).eq('id', id);
  if (error) { toast('Error al guardar contacto: ' + error.message); return; }
  if (c) c[field] = v || null;
  // refresca las iniciales del avatar si cambió el nombre
  if (field === 'name') { const row = document.querySelector(`.db-contact[data-cid="${id}"] .db-contact-av`); if (row) row.textContent = (v || '?').slice(0, 2).toUpperCase(); }
  toast('Contacto actualizado');
}
async function contactAdd(investorId) {
  const { data, error } = await sb.from('contacts').insert({ investor_id: investorId, name: null, email: null }).select('id').single();
  if (error) { toast('Error al añadir: ' + error.message); return; }
  if (lastInvestorDetail?.contacts) lastInvestorDetail.contacts.push({ id: data.id, name: null, email: null });
  openInvestor(investorId);   // re-render para mostrar la fila editable nueva
}
async function contactDelete(id) {
  if (!confirm('¿Borrar este contacto?')) return;
  const invId = lastInvestorDetail?.inv?.id;
  const { error } = await sb.from('contacts').delete().eq('id', id);
  if (error) { toast('Error al borrar: ' + error.message); return; }
  toast('Contacto borrado');
  if (invId) openInvestor(invId);
}

async function openCompany(id) {
  const co = dbCompanies.find(x => x.id === id);
  if (!co) return;
  showDetailLoading();
  try {
    const { data: positions } = await sb.from('investments')
      .select(`entry_ev_b, current_ev_b, shares, commitment, commitment_actual, dpi_moic,
               series(name), investors(id, name)`)
      .eq('company_id', id);
    renderCompanyDetail(co, positions || []);
  } catch (err) {
    document.getElementById('dbDetailContent').innerHTML = `<div class="db-error">Error: ${err.message}</div>`;
  }
}

function showDetailLoading() {
  document.getElementById('dbList').style.display = 'none';
  document.getElementById('dbDetail').classList.add('show');
  // El export de la barra exporta TODA la lista; dentro de un detalle no aplica.
  const tbExport = document.getElementById('ddExport');
  if (tbExport) tbExport.style.display = 'none';
  const cb = document.getElementById('dbCombineBar');
  if (cb) cb.style.display = 'none';   // ocultar barra de combinado dentro del detalle
  document.getElementById('dbDetailContent').innerHTML = '<div class="db-loading"><i class="fa-solid fa-spinner fa-spin"></i> Cargando…</div>';
}

function closeDetail() {
  document.getElementById('dbDetail').classList.remove('show');
  document.getElementById('dbList').style.display = '';
  const tbExport = document.getElementById('ddExport');
  if (tbExport) tbExport.style.display = '';
  updateCombineBar();   // restaura la barra de combinado si sigue habiendo selección
}

/* ─── Selector de columnas del detalle del inversionista ─── */
const POSITION_COLUMNS = [
  { key: 'company',           label: 'Empresa',     locked: true,  default: true  },
  { key: 'series',            label: 'Series',                      default: true  },
  { key: 'commitment',        label: 'Commitment',                  default: true  },
  { key: 'commitment_actual', label: 'Comp. ejec.',                 default: true  },
  { key: 'dpi_moic',          label: 'DPI / MOIC',                  default: true  },
  { key: 'carry_pct',         label: 'Carry',                       default: false },
  { key: 'shares',            label: 'Shares',                      default: true  },
  { key: 'entry_ev_b',        label: 'Entry EV',                    default: true  },
  { key: 'entry_pps',         label: 'Entry PPS',                   default: false },
  { key: 'current_ev_b',      label: 'Current EV',                  default: true  },
  { key: 'current_ev_pps',    label: 'Current PPS',                 default: false },
  { key: 'start_date',        label: 'Inicio',                      default: false },
  { key: 'end_date',          label: 'Fin',                         default: false },
  { key: 'duration_years',    label: 'Duración',                    default: false },
  { key: 'last_ca_letter',    label: 'Última carta (CA)',           default: true  },
];
let dbPosVisibleCols = loadPosVisibleCols();
let lastInvestorDetail = null;   // caché para re-render al toggle (evita re-fetch)

function loadPosVisibleCols() {
  try {
    const raw = localStorage.getItem('dbPosVisibleCols');
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return new Set(arr);
    }
  } catch {}
  return new Set(POSITION_COLUMNS.filter(c => c.default).map(c => c.key));
}
function savePosVisibleCols() {
  try { localStorage.setItem('dbPosVisibleCols', JSON.stringify([...dbPosVisibleCols])); } catch {}
}
function isPosColVisible(key) {
  if (POSITION_COLUMNS.find(c => c.key === key)?.locked) return true;
  return dbPosVisibleCols.has(key);
}
function togglePosCol(key) {
  const col = POSITION_COLUMNS.find(c => c.key === key);
  if (!col || col.locked) return;
  if (dbPosVisibleCols.has(key)) dbPosVisibleCols.delete(key);
  else dbPosVisibleCols.add(key);
  savePosVisibleCols();
  // Re-render del detalle desde caché y reabre el dropdown para seguir tocando
  if (lastInvestorDetail) {
    const wasOpen = document.getElementById('ddPosCols')?.classList.contains('open');
    renderInvestorDetail(lastInvestorDetail.inv, lastInvestorDetail.contacts, lastInvestorDetail.positions);
    if (wasOpen) document.getElementById('ddPosCols')?.classList.add('open');
  }
}
function renderPosColumnPicker() {
  const panel = document.getElementById('ddPosColsPanel');
  if (!panel) return;
  panel.innerHTML = POSITION_COLUMNS.map(c => {
    const on = isPosColVisible(c.key);
    const cls = 'cdd-opt' + (c.locked ? ' locked' : '');
    const onClick = c.locked ? '' : `onclick="togglePosCol('${c.key}');event.stopPropagation()"`;
    return `<div class="${cls}" ${onClick}>
      <input type="checkbox" ${on ? 'checked' : ''} ${c.locked ? 'disabled' : ''}>
      <span>${c.label}${c.locked ? ' (fijo)' : ''}</span>
    </div>`;
  }).join('');
}

function renderPositionsBlock(title, rows, showAcct) {
  if (!rows.length) return '';
  const dash = '<span style="color:var(--gray-300)">—</span>';
  const fmt = {
    num:   (v) => (v != null && v !== '') ? Number(v).toLocaleString('en-US') : dash,
    ev:    (v) => (v != null && v !== '') ? '$' + (+v).toFixed(2) + 'B' : dash,
    pps:   (v) => (v != null && v !== '') ? '$' + (+v).toFixed(2) : dash,
    moic:  (v) => (v != null && v !== '') ? (+v).toFixed(2) + 'x' : dash,
    carry: (v) => (v != null && v !== '') ? (+v * 100).toFixed(2) + '%' : dash,
    dur:   (v) => (v != null && v !== '') ? (+v).toFixed(2) + ' yrs' : dash,
    date:  (v) => v ? new Date(v + 'T12:00:00').toLocaleDateString('es-MX', { day:'numeric', month:'short', year:'numeric' }) : dash,
    money: (v) => fmtMoney(+v),
  };
  const numericKeys = new Set(['commitment','commitment_actual','dpi_moic','carry_pct','shares','entry_ev_b','entry_pps','current_ev_b','current_ev_pps','duration_years']);

  const cellFor = (p, key) => {
    switch (key) {
      case 'company':           return `<td class="col-name">${escapeHtml(p.companies?.name || '—')}</td>`;
      case 'series':            return `<td>${escapeHtml(p.series?.name || '—')}</td>`;
      case 'commitment':        return `<td class="num">${fmt.money(p.commitment)}</td>`;
      case 'commitment_actual': return `<td class="num muted">${fmt.money(p.commitment_actual)}</td>`;
      case 'dpi_moic':          return `<td class="num">${fmt.moic(p.dpi_moic)}</td>`;
      case 'carry_pct':         return `<td class="num muted">${fmt.carry(p.carry_pct)}</td>`;
      case 'shares':            return `<td class="num muted">${p.shares != null ? fmt.num(p.shares) : (p.companies?.is_public ? '<span style="color:var(--gray-400);font-style:italic">Public</span>' : dash)}</td>`;
      case 'entry_ev_b':        return `<td class="num muted">${fmt.ev(p.entry_ev_b)}</td>`;
      case 'entry_pps':         return `<td class="num muted">${fmt.pps(p.entry_pps)}</td>`;
      case 'current_ev_b':      return `<td class="num muted">${fmt.ev(p.current_ev_b)}</td>`;
      case 'current_ev_pps':    return `<td class="num muted">${fmt.pps(p.current_ev_pps)}</td>`;
      case 'start_date':        return `<td class="muted">${fmt.date(p.start_date)}</td>`;
      case 'end_date':          return `<td class="muted">${fmt.date(p.end_date)}</td>`;
      case 'duration_years':    return `<td class="num muted">${fmt.dur(p.duration_years)}</td>`;
      case 'last_ca_letter':    return `<td>${p.last_ca_letter ? `<a href="${escapeHtml(p.last_ca_letter)}" target="_blank" rel="noopener"><i class="fa-solid fa-file-pdf"></i> PDF</a>` : dash}</td>`;
      default: return '<td></td>';
    }
  };

  const visible = POSITION_COLUMNS.filter(c => isPosColVisible(c.key));
  const acctHead = showAcct ? '<th>Cuenta</th>' : '';
  const headers = acctHead + visible.map(c => `<th class="${numericKeys.has(c.key) ? 'num' : ''}">${escapeHtml(c.label)}</th>`).join('');
  const body = rows.map(p => `<tr>${showAcct ? `<td><span class="db-cell-pill muted">${escapeHtml(p._acct || '—')}</span></td>` : ''}${visible.map(c => cellFor(p, c.key)).join('')}</tr>`).join('');

  return `
    <div class="db-section">
      <div class="db-section-h">${escapeHtml(title)} (${rows.length})</div>
      <div class="db-list-wrap">
        <table class="db-list-table">
          <thead><tr>${headers}</tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>
    </div>`;
}

function renderDistrosBlock(title, rows) {
  if (!rows.length) return '';
  return `
    <div class="db-section">
      <div class="db-section-h">${escapeHtml(title)} (${rows.length})</div>
      <table class="db-table">
        <thead>
          <tr>
            <th>Fecha</th>
            <th>Empresa</th>
            <th class="hide-mobile">Series</th>
            <th>Tipo</th>
            <th class="num">Cash</th>
            <th class="num hide-mobile">Shares</th>
            <th class="num hide-mobile">PPS</th>
            <th class="hide-mobile">Carta</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(d => `
            <tr>
              <td>${escapeHtml(d.distribution_date || '—')}</td>
              <td>${escapeHtml(d.underlying_company || d._company)}</td>
              <td class="hide-mobile">${escapeHtml(d._series)}</td>
              <td>${d.letter_type === 'distribution_cash' ? 'Cash' : 'In-Kind'}</td>
              <td class="num">${d.cash_proceeds != null ? fmtMoney(+d.cash_proceeds) : '—'}</td>
              <td class="num hide-mobile">${d.shares_distributed != null ? Number(d.shares_distributed).toLocaleString('en-US') : '—'}</td>
              <td class="num hide-mobile">${d.price_per_share != null ? '$' + (+d.price_per_share).toFixed(2) : '—'}</td>
              <td class="hide-mobile">${d.letter_url ? `<a href="${escapeHtml(d.letter_url)}" target="_blank" rel="noopener"><i class="fa-solid fa-file-pdf"></i> PDF</a>` : '—'}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

// ── Vista 360 del LP: temas, lock-ups SpaceX, métricas ──
function companyTheme(name) {
  const n = (name || '').toLowerCase();
  if (/diversified|all-star|all star/.test(n)) return 'Fondos All-Star';
  if (/space|spacex|x\.ai|capella|hawkeye/.test(n)) return 'Espacio & Satélites';
  if (/saronic|chaos|second front|epirus|mach|anduril|palantir/.test(n)) return 'Defensa';
  if (/anthropic|cohere|groq|mythic|decart|figure|agility|openai/.test(n)) return 'IA & Robótica';
  if (/base power|radiant/.test(n)) return 'Energía';
  if (/klarna|kraken|payward|revolut|bolt|quantstamp|coinbase|amaze/.test(n)) return 'Fintech & Cripto';
  if (/lime|neutron|lyft|turo|kodiak|transfix|forto|platform science|instacart|maplebear|rappi/.test(n)) return 'Movilidad & Logística';
  if (/epic|automattic|asana|patreon|udemy|rapidsos|bluevoyant|cohesity|trusted|wefox|job and talent|jobandtalent|loft|pinterest|spotify|airbnb|draftkings/.test(n)) return 'Software & Consumo';
  return 'Otros';
}
const SPX_LOCKUP_B = [
  { date: '2026-07-31', pct: '20%', label: '1er cliff (tras Q2 2026)' },
  { date: '2026-08-21', pct: '7%',  label: 'Día 70' },
  { date: '2026-09-10', pct: '7%',  label: 'Día 90' },
  { date: '2026-09-25', pct: '7%',  label: 'Día 105' },
  { date: '2026-10-10', pct: '7%',  label: 'Día 120' },
  { date: '2026-10-25', pct: '7%',  label: 'Día 135' },
  { date: '2026-11-15', pct: '28%', label: '2º cliff (tras Q3 2026)' },
  { date: '2026-12-09', pct: 'Remanente', label: 'Día 180 — expiración total' },
];
const SPX_LOCKUP_A_EXT = [
  { date: '2027-02-15', pct: '20%', label: 'Lock-up extendido (tras Q4 2026)' },
  { date: '2027-03-19', pct: '10%', label: 'Día 280' },
  { date: '2027-05-15', pct: '20%', label: 'Tras Q1 2027' },
  { date: '2027-05-18', pct: '10%', label: 'Día 340' },
  { date: '2027-06-13', pct: '20%', label: 'Día 366' },
  { date: '2027-08-15', pct: '20%', label: 'Tras Q2 2027 — liberación final' },
];
function spxStructures(seriesName) {
  const s = seriesName || '';
  if (/All-Star Fund IV/i.test(s)) return ['A', 'B'];
  if (/22K|22J|26B/i.test(s)) return ['A'];   // 26B (todas sus variantes) = Calendario 1 / Estructura A, como 22J/22K
  return ['B'];
}

// Estructuras completas de lock-up (detalle, espejo del catálogo del reporte SpaceX)
const SPX_STRUCTURES = {
  B: {
    label: 'Lock-up escalonado de 180 días',
    summary: 'Liberación escalonada y ligada a desempeño dentro de la ventana estándar de <b>180 días</b>. Expira por completo ~9 de diciembre de 2026.',
    phases: [
      { hito: '1er cliff — tras Q2 2026 (jul–sep 2026)', pct: '20%', detalle: 'Acumulado: 20%.' },
      { hito: 'Bono por desempeño', pct: '+10%', detalle: 'Si la acción cotiza ≥30% arriba del IPO en 5 de 10 días consecutivos (pre-Q2). Acumulado: 30%.' },
      { hito: 'Día 70 (~21 ago 2026)', pct: '7%', detalle: 'Acumulado: 37%.' },
      { hito: 'Día 90 (~10 sep 2026)', pct: '7%', detalle: 'Acumulado: 44%.' },
      { hito: 'Día 105 (~25 sep 2026)', pct: '7%', detalle: 'Acumulado: 51%.' },
      { hito: 'Día 120 (~10 oct 2026)', pct: '7%', detalle: 'Acumulado: 58%.' },
      { hito: 'Día 135 (~25 oct 2026)', pct: '7%', detalle: 'Acumulado: 65%.' },
      { hito: '2º cliff — tras Q3 2026 (oct–dic 2026)', pct: '28%', detalle: 'Acumulado: 93%.' },
      { hito: 'Día 180 (~9 dic 2026)', pct: 'Remanente', detalle: 'Expiración total. Acumulado: 100%.' },
    ],
    nota: 'Fechas y porcentajes estimados con base en el S-1 de SpaceX (mayo 2026); el prospecto final es la autoridad.',
  },
  A: {
    label: 'Liberación en dos mitades (hasta ~13 meses)',
    summary: 'La posición se libera en <b>dos mitades</b>. La primera (~50%) durante los primeros ~6 meses (lock-up de 180 días); la segunda (~50%) en un <b>lock-up extendido</b> que se estira hasta ~13-14 meses post-IPO (liberación final ~ agosto 2027).',
    groups: [
      { label: 'Primera mitad (~50%) — lock-up de 180 días', phases: [
        { hito: '2 días tras Q2 2026', pct: '20%', detalle: 'Primer cliff de esta mitad.' },
        { hito: '~mismo período', pct: '+10% bonus', detalle: 'Solo si el precio cierra ≥30% arriba del precio de oferta en 5 de los 10 días siguientes a Q2 2026.' },
        { hito: 'Cada 15-20 días', pct: '7% por bloque', detalle: 'Bloques sucesivos (~ago–oct 2026).' },
        { hito: 'Tras resultados Q3', pct: '28%', detalle: '~noviembre 2026.' },
        { hito: 'Día 180 (~9 dic 2026)', pct: 'Remanente', detalle: 'Cierre de la primera mitad.' },
      ] },
      { label: 'Segunda mitad (~50%) — lock-up extendido (patrón 20/10/20/10/20/20)', phases: [
        { hito: '2 días tras Q4 2026 (~feb 2027)', pct: '20%', detalle: 'Inicio del lock-up extendido.' },
        { hito: 'Día 280 (~19 mar 2027)', pct: '10%', detalle: '' },
        { hito: '2 días tras Q1 2027 (~may 2027)', pct: '20%', detalle: '' },
        { hito: 'Día 340 (~18 may 2027)', pct: '10%', detalle: '' },
        { hito: 'Día 366 (~13 jun 2027)', pct: '20%', detalle: '' },
        { hito: '2 días tras Q2 2027 (~ago 2027)', pct: '20%', detalle: 'Remanente — liberación final.' },
      ] },
    ],
    nota: 'Fechas y porcentajes estimados con base en el S-1 de SpaceX (mayo 2026); el prospecto final es la autoridad. Liquidez total ~ agosto 2027 (~13-14 meses post-IPO).',
  },
};
function spxShort(sname) {
  const m = (sname || '').match(/Series\s+([\w-]+)/i);
  return /All-Star Fund IV/i.test(sname) ? 'Fund IV' : /All-Star Fund V/i.test(sname) ? 'Fund V' : (m ? 'Serie ' + m[1] : 'SpaceX');
}
function spxTranches(sname) {
  const s = sname || '';
  if (/All-Star Fund IV/i.test(s)) return [{ portion: 0.20, structure: 'A' }, { portion: 0.80, structure: 'B' }];
  if (/22K|22J|26B/i.test(s)) return [{ portion: 1.0, structure: 'A' }];   // 26B = Calendario 1 / Estructura A
  return [{ portion: 1.0, structure: 'B' }];
}
function spxLockupDetail(spxPos) {
  const agg = { A: [], B: [] };
  spxPos.forEach(p => {
    const sname = p.series?.name || '';
    const short = spxShort(sname);
    spxTranches(sname).forEach(tr => agg[tr.structure].push({ short, portion: tr.portion }));
  });
  const phaseTable = phases => `<table class="lp-phase"><thead><tr><th>Hito</th><th>%</th><th>Detalle</th></tr></thead><tbody>${phases.map(ph => `<tr><td>${escapeHtml(ph.hito)}</td><td class="lp-phase-pct">${escapeHtml(ph.pct)}</td><td>${escapeHtml(ph.detalle || '')}</td></tr>`).join('')}</tbody></table>`;
  let html = '';
  ['B', 'A'].forEach(k => {
    const scopes = agg[k];
    if (!scopes.length) return;
    const st = SPX_STRUCTURES[k];
    const seen = new Set(), applies = [];
    scopes.forEach(x => { const key = x.short + '|' + x.portion; if (seen.has(key)) return; seen.add(key); applies.push(x.portion < 1 ? `${Math.round(x.portion * 100)}% de ${x.short}` : x.short); });
    html += `<div class="lp-dd-struct"><div class="lp-dd-h">${escapeHtml(st.label)}</div>` +
      `<div class="lp-dd-applies">Aplica a: ${escapeHtml(applies.join(' · '))}</div>` +
      `<div class="lp-dd-sum">${st.summary}</div>`;
    if (st.groups) st.groups.forEach(g => { html += `<div class="lp-dd-glabel">${escapeHtml(g.label)}</div>` + phaseTable(g.phases); });
    else if (st.phases) html += phaseTable(st.phases);
    html += `<div class="lp-dd-nota">${escapeHtml(st.nota)}</div></div>`;
  });
  return html;
}
function fmtEventDate(d) {
  try { return new Date(d + 'T00:00:00').toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' }); }
  catch (e) { return d; }
}
let _lp360 = null;
function buildLp360(positions) {
  const num = v => (Number(v) || 0);
  const active = positions.filter(p => !p.distributed_at);
  const committedActive = active.reduce((a, p) => a + num(p.commitment), 0);
  const navActive = active.reduce((a, p) => a + (num(p.commitment_actual) || num(p.commitment)), 0);
  const moic = committedActive ? navActive / committedActive : 0;
  const committedTotal = positions.reduce((a, p) => a + num(p.commitment), 0);
  let distrib = 0;
  positions.forEach(p => (p.investment_distributions || []).forEach(d => { distrib += num(d.value_in_kind) + num(d.cash_proceeds); }));
  const dpi = committedTotal ? distrib / committedTotal : 0;
  const byCo = {}, byTheme = {};
  active.forEach(p => {
    const isFund = p.companies?.id === 10;
    const val = num(p.commitment_actual) || num(p.commitment);
    const label = isFund ? (p.series?.name || 'Fondo').replace('MVP ', '') : (p.companies?.name || '—');
    byCo[label] = (byCo[label] || 0) + val;
    const theme = isFund ? 'Fondos All-Star' : companyTheme(p.companies?.name);
    byTheme[theme] = (byTheme[theme] || 0) + val;
  });
  const companyExp = Object.entries(byCo).sort((a, b) => b[1] - a[1]);
  const themeExp = Object.entries(byTheme).sort((a, b) => b[1] - a[1]);
  const spxPos = active.filter(p => p.companies?.id === 27 || /All-Star Fund (IV|V)/i.test(p.series?.name || ''));
  let lockup = null;
  if (spxPos.length) {
    const by = { A: [], B: [] };
    spxPos.forEach(p => {
      const sname = p.series?.name || '';
      const short = spxShort(sname);
      spxStructures(sname).forEach(st => { if (!by[st].includes(short)) by[st].push(short); });
    });
    const today = new Date().toISOString().slice(0, 10);
    const nextB = SPX_LOCKUP_B.find(e => e.date >= today);
    const blocks = [];
    if (by.B.length) blocks.push({ scope: by.B.join(' · '), summary: 'Liberación escalonada y ligada a desempeño dentro de la ventana de 180 días. Expira por completo ~9 dic 2026.' });
    if (by.A.length) blocks.push({ scope: by.A.join(' · '), summary: 'Una porción sigue un lock-up extendido (en parcialidades) hasta ~13-14 meses post-IPO; liberación final ~ago 2027.' });
    lockup = { blocks, next: nextB || null, detail: spxLockupDetail(spxPos) };
  }
  _lp360 = { companyExp, themeExp };
  return { moic, distrib, dpi, nActive: active.length, companyExp, themeExp, lockup, hasSpx: spxPos.length > 0 };
}
async function draw360Theme() {
  const cv = document.getElementById('lpThemeChart');
  if (!cv || !_lp360 || !_lp360.themeExp.length) return;
  try { await loadScript('https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js'); } catch (e) { return; }
  const labels = _lp360.themeExp.map(t => t[0]);
  const data = _lp360.themeExp.map(t => t[1]);
  const colors = ['#e8650d', '#1a3a6b', '#0f9b5a', '#9b59b6', '#e1b12c', '#3b65b0', '#c0392b', '#16a085'];
  if (cv._chart) cv._chart.destroy();
  cv._chart = new Chart(cv.getContext('2d'), {
    type: 'doughnut',
    data: { labels, datasets: [{ data, backgroundColor: colors.slice(0, labels.length), borderWidth: 2, borderColor: '#fff' }] },
    options: { responsive: false, plugins: { legend: { position: 'bottom', labels: { font: { size: 11 }, boxWidth: 10, usePointStyle: true } } }, cutout: '60%' }
  });
}

function renderInvestorDetail(inv, contacts, positions) {
  lastInvestorDetail = { inv, contacts, positions };
  const combined = !!inv._combined;
  const canEditTitular = !combined && (currentProfile?.role === 'admin' || currentProfile?.role === 'editor');
  const totalEv = positions.reduce((s, p) => s + (+p.current_ev_b || 0), 0);
  const DIVERSIFIED_FUND_ID = 10;
  const activePositions = positions.filter(p => !p.distributed_at);
  const terminatedPositions = positions.filter(p => p.distributed_at);
  const distrosSpv = [];
  const distrosFund = [];
  positions.forEach(p => {
    const isFund = p.companies?.id === DIVERSIFIED_FUND_ID;
    (p.investment_distributions || []).forEach(d => {
      const row = {
        ...d,
        _company: p.companies?.name || '—',
        _series: p.series?.name || '—',
      };
      (isFund ? distrosFund : distrosSpv).push(row);
    });
  });
  const sortDesc = (a, b) => (b.distribution_date || '').localeCompare(a.distribution_date || '');
  distrosSpv.sort(sortDesc);
  distrosFund.sort(sortDesc);
  const _lp = buildLp360(positions);
  const _lpkpi = (l, v, c) => `<div class="lp-kpi"><div class="lp-kpi-l">${l}</div><div class="lp-kpi-v ${c || ''}">${v}</div></div>`;
  const lpKpis = `<div class="lp-kpis">
    ${_lpkpi('MOIC', _lp.moic.toFixed(2) + 'x', moicClass(_lp.moic))}
    ${_lpkpi('Distribuido a la fecha', fmtUsdShort(_lp.distrib))}
    ${_lpkpi('DPI', _lp.dpi.toFixed(2) + 'x')}
    ${_lpkpi('Posiciones activas', String(_lp.nActive))}
  </div>`;
  const _maxCo = _lp.companyExp.length ? _lp.companyExp[0][1] : 1;
  const exposicion = _lp.companyExp.length ? `<div class="db-section">
    <div class="db-section-h">Exposición del portafolio</div>
    <div class="lp-expo">
      <div class="lp-expo-bars">
        <div class="lp-expo-sub">Por empresa / fondo · NAV activo</div>
        ${_lp.companyExp.slice(0, 8).map(([nm, v]) => `<div class="lp-bar-row"><span class="lp-bar-name" title="${escapeHtml(nm)}">${escapeHtml(nm)}</span><div class="lp-bar"><div class="lp-bar-fill" style="width:${(v / _maxCo * 100).toFixed(1)}%"></div></div><span class="lp-bar-val">${fmtUsdShort(v)}</span></div>`).join('')}
      </div>
      <div class="lp-expo-donut">
        <div class="lp-expo-sub">Por tema</div>
        <canvas id="lpThemeChart" width="240" height="240"></canvas>
      </div>
    </div>
  </div>` : '';
  const eventos = (_lp.hasSpx && _lp.lockup) ? `<div class="db-section">
    <div class="db-section-h">Lock-up SpaceX · liquidez estimada</div>
    ${_lp.lockup.next ? `<div class="lp-lock-next"><i class="fa-solid fa-unlock"></i> Próxima liberación estimada: <b>${fmtEventDate(_lp.lockup.next.date)}</b> &middot; ${escapeHtml(_lp.lockup.next.pct)} de la posición</div>` : ''}
    ${_lp.lockup.blocks.map(b => `<div class="lp-lock-block"><div class="lp-lock-scope">${escapeHtml(b.scope)}</div><div class="lp-lock-sum">${escapeHtml(b.summary)}</div></div>`).join('')}
    <div class="lp-events-note">Estimado con base en el S-1 de SpaceX (IPO 12-jun-2026); el prospecto final es la autoridad.</div>
    ${_lp.lockup.detail ? `<details class="lp-distdetail"><summary><i class="fa-solid fa-circle-info"></i> Información detallada de distribución</summary><div class="lp-dd-body">${_lp.lockup.detail}</div></details>` : ''}
  </div>` : '';
  const html = `
    <div class="db-detail-head">
      <div class="db-detail-topbar">
        <div>
          <div class="db-detail-name">${escapeHtml(inv.name)}</div>
          <div class="db-detail-sub">${combined ? `${inv._accounts.length} cuentas combinadas` : 'Inversionista'}</div>
        </div>
        <div class="db-detail-export">
          <button class="dbx-btn" onclick="exportInvestorXlsx()" title="Exportar todo su detalle a Excel"><i class="fa-solid fa-file-excel"></i> Excel</button>
          <button class="dbx-btn pdf" onclick="exportInvestorPdf()" title="Exportar todo su detalle a PDF"><i class="fa-solid fa-file-pdf"></i> PDF</button>
        </div>
      </div>
      ${combined
        ? `<div class="db-detail-accounts">
             <span class="db-titular-lbl"><i class="fa-solid fa-user-group"></i> Cuentas combinadas</span>
             ${inv._accounts.map(a => `<span class="db-acct-chip">${escapeHtml(a.name)}</span>`).join('')}
           </div>`
        : `<div class="db-detail-titular">
             <span class="db-titular-lbl"><i class="fa-solid fa-user-tag"></i> Titular</span>
             ${canEditTitular
               ? `<input id="dbTitularInp" class="db-titular-inp" value="${escapeHtml(inv.titular || '')}" placeholder="A quién pertenece la cuenta" autocomplete="off" onkeydown="if(event.key==='Enter')this.blur()" onblur="saveTitular(${inv.id}, this.value)">`
               : `<span class="db-titular-val">${inv.titular ? escapeHtml(inv.titular) : '—'}</span>`}
           </div>`}
      <div class="db-detail-stats">
        <div class="db-stat"><div class="db-stat-l">Posiciones</div><div class="db-stat-v">${inv.positions}</div></div>
        <div class="db-stat"><div class="db-stat-l">Commitment total</div><div class="db-stat-v">${fmtMoney(inv.commitment)}</div></div>
        <div class="db-stat"><div class="db-stat-l">Commitment actual</div><div class="db-stat-v">${fmtMoney(inv.actual)}</div></div>
      </div>
    </div>

    ${lpKpis}

    ${(contacts.length || canEditTitular) ? `
      <div class="db-section">
        <div class="db-section-h">Contactos</div>
        ${contacts.map(c => canEditTitular ? `
          <div class="db-contact" data-cid="${c.id}">
            <div class="db-contact-av">${(c.name || '?').slice(0,2).toUpperCase()}</div>
            <input class="db-contact-inp nm" value="${escapeHtml(c.name || '')}" placeholder="Nombre" onblur="contactSave(${c.id},'name',this)" onkeydown="if(event.key==='Enter')this.blur()">
            <input class="db-contact-inp ml" value="${escapeHtml(c.email || '')}" placeholder="correo@dominio.com" onblur="contactSave(${c.id},'email',this)" onkeydown="if(event.key==='Enter')this.blur()">
            <button class="db-contact-del" title="Borrar contacto" onclick="contactDelete(${c.id})"><i class="fa-solid fa-xmark"></i></button>
          </div>` : `
          <div class="db-contact">
            <div class="db-contact-av">${(c.name || '?').slice(0,2).toUpperCase()}</div>
            <div class="db-contact-name">${escapeHtml(c.name)}</div>
            <div class="db-contact-mail">${escapeHtml(c.email || '')}</div>
          </div>`).join('')}
        ${canEditTitular ? `<button class="cdd-btn" style="margin-top:4px" onclick="contactAdd(${inv.id})"><i class="fa-solid fa-user-plus"></i> Añadir contacto</button>` : ''}
      </div>` : ''}

    ${(activePositions.length || terminatedPositions.length) ? `
      <div class="db-pos-toolbar">
        <div class="db-pos-toolbar-label">Columnas de posiciones</div>
        <div class="cdd db-cdd db-cols-cdd" id="ddPosCols">
          <button class="cdd-btn" type="button" onclick="cddToggle('ddPosCols')">
            <i class="fa-solid fa-table-columns cdd-ico"></i>
            <span class="cdd-label">Columnas</span>
            <i class="fa-solid fa-chevron-down cdd-chev"></i>
          </button>
          <div class="cdd-panel" id="ddPosColsPanel"></div>
        </div>
      </div>` : ''}

    ${exposicion}
    ${eventos}
    ${renderPositionsBlock('Posiciones activas', activePositions, combined)}
    ${renderPositionsBlock('Posiciones terminadas', terminatedPositions, combined)}

    ${renderDistrosBlock('Distribuciones · Oportunidades en directo (SPVs)', distrosSpv)}
    ${renderDistrosBlock('Distribuciones · Fondos MVP', distrosFund)}`;
  document.getElementById('dbDetailContent').innerHTML = html;
  renderPosColumnPicker();   // pobla el panel después de que el DOM existe
  draw360Theme();
}

function renderCompanyDetail(co, positions) {
  const html = `
    <div class="db-detail-head">
      <div class="db-detail-name">${escapeHtml(co.name)}</div>
      <div class="db-detail-sub">${co.is_public ? 'Empresa pública' : 'Empresa privada'}</div>
      <div class="db-detail-stats">
        <div class="db-stat"><div class="db-stat-l">Inversionistas</div><div class="db-stat-v">${co.investors}</div></div>
        <div class="db-stat"><div class="db-stat-l">Posiciones</div><div class="db-stat-v">${co.positions}</div></div>
        <div class="db-stat"><div class="db-stat-l">Commitment total</div><div class="db-stat-v">${fmtMoney(co.commitment)}</div></div>
      </div>
    </div>
    <div class="db-section">
      <div class="db-section-h">Posiciones (${positions.length})</div>
      <table class="db-table">
        <thead>
          <tr>
            <th>Inversionista</th>
            <th>Series</th>
            <th class="num hide-mobile">Entry EV</th>
            <th class="num hide-mobile">Current EV</th>
            <th class="num">Commitment</th>
            <th class="num">MOIC</th>
          </tr>
        </thead>
        <tbody>
          ${positions.map(p => `
            <tr>
              <td>${escapeHtml(p.investors?.name || '—')}</td>
              <td>${escapeHtml(p.series?.name || '—')}</td>
              <td class="num hide-mobile">${p.entry_ev_b ? '$' + (+p.entry_ev_b).toFixed(2) + 'B' : '—'}</td>
              <td class="num hide-mobile">${p.current_ev_b ? '$' + (+p.current_ev_b).toFixed(2) + 'B' : '—'}</td>
              <td class="num">${fmtMoney(+p.commitment)}</td>
              <td class="num">${p.dpi_moic ? (+p.dpi_moic).toFixed(2) + 'x' : '—'}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  document.getElementById('dbDetailContent').innerHTML = html;
}

// Auto-refresh cada 30s para ver cambios del socio (solo si está en vista de tareas)
setInterval(() => {
  if (currentUser && currentView === 'tasks' && !document.hidden) loadData();
}, 30000);

// Al regresar al app (cambio de pestaña, desbloquear cel, etc.) → recarga
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && currentUser && currentView === 'tasks') {
    loadData();
  }
});

// Click en el indicador de sync → recarga manual
document.getElementById('syncStatus')?.addEventListener('click', () => {
  if (currentUser && currentView === 'tasks') loadData();
});

// ═══════════════════════════════════════════
// DROPBOX — explorador
// ═══════════════════════════════════════════
let dbxState = {
  path: '',
  view: 'grid',           // 'grid' | 'list'
  entries: [],
  searching: false,
  searchQuery: '',
  loaded: false,
};
let dbxSearchTimer = null;
const dbxThumbCache = new Map();   // path → object URL
const dbxPreviewUrls = [];          // a revocar al cerrar el modal

const FILE_ICONS = {
  pdf:  { icon: 'fa-file-pdf',          color: '#e74c3c' },
  doc:  { icon: 'fa-file-word',         color: '#2b579a' },
  docx: { icon: 'fa-file-word',         color: '#2b579a' },
  xls:  { icon: 'fa-file-excel',        color: '#217346' },
  xlsx: { icon: 'fa-file-excel',        color: '#217346' },
  csv:  { icon: 'fa-file-csv',          color: '#217346' },
  ppt:  { icon: 'fa-file-powerpoint',   color: '#d24726' },
  pptx: { icon: 'fa-file-powerpoint',   color: '#d24726' },
  txt:  { icon: 'fa-file-lines',        color: '#888' },
  md:   { icon: 'fa-file-lines',        color: '#888' },
  zip:  { icon: 'fa-file-zipper',       color: '#b07d20' },
  rar:  { icon: 'fa-file-zipper',       color: '#b07d20' },
  '7z': { icon: 'fa-file-zipper',       color: '#b07d20' },
  mp3:  { icon: 'fa-file-audio',        color: '#9b59b6' },
  wav:  { icon: 'fa-file-audio',        color: '#9b59b6' },
  m4a:  { icon: 'fa-file-audio',        color: '#9b59b6' },
  mp4:  { icon: 'fa-file-video',        color: '#3498db' },
  mov:  { icon: 'fa-file-video',        color: '#3498db' },
  webm: { icon: 'fa-file-video',        color: '#3498db' },
};
const IMAGE_EXTS = new Set(['jpg','jpeg','png','gif','webp','heic','bmp','tiff']);
const VIDEO_EXTS = new Set(['mp4','mov','webm','m4v']);
const AUDIO_EXTS = new Set(['mp3','wav','m4a','aac','ogg']);
const OFFICE_PREVIEWABLE = new Set(['doc','docx','xls','xlsx','ppt','pptx','rtf','csv','txt']);

function extOf(name){
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}
function iconForFile(name){
  return FILE_ICONS[extOf(name)] || { icon: 'fa-file', color: '#9aa3b5' };
}
function fmtSize(bytes){
  if (bytes == null) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}
function fmtDbxDate(d){
  if (!d) return '';
  return new Date(d).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' });
}

function openDropbox(){
  if (!dbxState.loaded) {
    dbxState.loaded = true;
    loadDbxFolder('');
  }
}

async function loadDbxFolder(path){
  dbxState.searching = false;
  dbxState.searchQuery = '';
  document.getElementById('dbxSearchInput').value = '';
  document.getElementById('dbxSearchClear').classList.remove('show');
  dbxState.path = path || '';
  renderDbxBreadcrumb();
  const container = document.getElementById('dbxContainer');
  container.innerHTML = `<div class="dbx-status"><i class="fa-solid fa-circle-notch fa-spin"></i> Cargando...</div>`;
  try {
    const url = '/api/dropbox?action=list' + (path ? '&path=' + encodeURIComponent(path) : '');
    const r = await authedFetch(url);
    if (!r.ok) throw new Error((await r.json()).error || `HTTP ${r.status}`);
    const data = await r.json();
    dbxState.entries = data.entries || [];
    renderDbxEntries();
  } catch (err) {
    container.innerHTML = `<div class="dbx-status error">
      <i class="fa-solid fa-triangle-exclamation"></i>
      No se pudo cargar la carpeta.<br>
      <span style="font-size:11px;color:var(--gray-400)">${err.message}</span>
    </div>`;
  }
}

async function searchDbx(query){
  const q = (query || '').trim();
  if (!q) {
    loadDbxFolder(dbxState.path);
    return;
  }
  dbxState.searching = true;
  dbxState.searchQuery = q;
  renderDbxBreadcrumb();
  const container = document.getElementById('dbxContainer');
  container.innerHTML = `<div class="dbx-status"><i class="fa-solid fa-circle-notch fa-spin"></i> Buscando...</div>`;
  try {
    const r = await authedFetch('/api/dropbox?action=search&q=' + encodeURIComponent(q));
    if (!r.ok) throw new Error((await r.json()).error || `HTTP ${r.status}`);
    const data = await r.json();
    dbxState.entries = data.entries || [];
    renderDbxEntries();
  } catch (err) {
    container.innerHTML = `<div class="dbx-status error">
      <i class="fa-solid fa-triangle-exclamation"></i>
      Error en la búsqueda.<br>
      <span style="font-size:11px;color:var(--gray-400)">${err.message}</span>
    </div>`;
  }
}

function renderDbxBreadcrumb(){
  const bc = document.getElementById('dbxBreadcrumb');
  if (dbxState.searching) {
    bc.innerHTML = `
      <button class="dbx-crumb" onclick="loadDbxFolder('')"><i class="fa-solid fa-house" style="font-size:11px;margin-right:4px"></i>Inicio</button>
      <span class="dbx-crumb-sep">/</span>
      <span class="dbx-crumb last">Resultados de "${dbxState.searchQuery.replace(/"/g, '&quot;')}"</span>
    `;
    return;
  }
  const parts = dbxState.path.split('/').filter(Boolean);
  let cumulative = '';
  const crumbs = [`<button class="dbx-crumb${parts.length === 0 ? ' last' : ''}" onclick="loadDbxFolder('')"><i class="fa-solid fa-house" style="font-size:11px;margin-right:4px"></i>Inicio</button>`];
  parts.forEach((p, i) => {
    cumulative += '/' + p;
    const isLast = i === parts.length - 1;
    crumbs.push(`<span class="dbx-crumb-sep">/</span>`);
    if (isLast) {
      crumbs.push(`<span class="dbx-crumb last">${p}</span>`);
    } else {
      const path = cumulative;
      crumbs.push(`<button class="dbx-crumb" onclick="loadDbxFolder('${path.replace(/'/g, "\\'")}')">${p}</button>`);
    }
  });
  bc.innerHTML = crumbs.join('');
}

function renderDbxEntries(){
  const container = document.getElementById('dbxContainer');
  if (!dbxState.entries.length) {
    container.innerHTML = `<div class="dbx-status">
      <i class="fa-solid fa-folder-open"></i>
      ${dbxState.searching ? 'Sin resultados' : 'Carpeta vacía'}
    </div>`;
    return;
  }
  if (dbxState.view === 'grid') renderDbxGrid();
  else renderDbxListView();
  // Lazy-load thumbnails
  setTimeout(loadVisibleThumbnails, 50);
}

function renderDbxGrid(){
  const container = document.getElementById('dbxContainer');
  container.innerHTML = `<div class="dbx-grid">${
    dbxState.entries.map((e, i) => {
      if (e.type === 'folder') {
        return `
          <div class="dbx-card dbx-card-folder" data-idx="${i}" onclick="onDbxClick(${i})">
            <div class="dbx-card-thumb"><i class="fa-solid fa-folder"></i></div>
            <div class="dbx-card-name">${escapeHtml(e.name)}</div>
          </div>`;
      }
      const ext = extOf(e.name);
      const isImg = IMAGE_EXTS.has(ext);
      const ico = iconForFile(e.name);
      return `
        <div class="dbx-card" data-idx="${i}" onclick="onDbxClick(${i})">
          <div class="dbx-card-thumb" ${isImg ? `data-thumb="${escapeAttr(e.path)}"` : ''}>
            ${isImg
              ? `<i class="fa-solid ${ico.icon}" style="color:${ico.color}"></i>`
              : `<i class="fa-solid ${ico.icon}" style="color:${ico.color}"></i>`}
          </div>
          <div class="dbx-card-name">${escapeHtml(e.name)}</div>
          <div class="dbx-card-meta">${fmtSize(e.size)}</div>
        </div>`;
    }).join('')
  }</div>`;
}

function renderDbxListView(){
  const container = document.getElementById('dbxContainer');
  container.innerHTML = `<div class="dbx-list">${
    dbxState.entries.map((e, i) => {
      if (e.type === 'folder') {
        return `
          <div class="dbx-row dbx-row-folder" data-idx="${i}" onclick="onDbxClick(${i})">
            <div class="dbx-row-ico"><i class="fa-solid fa-folder"></i></div>
            <div class="dbx-row-name">${escapeHtml(e.name)}</div>
            <div class="dbx-row-meta">Carpeta</div>
          </div>`;
      }
      const ext = extOf(e.name);
      const isImg = IMAGE_EXTS.has(ext);
      const ico = iconForFile(e.name);
      return `
        <div class="dbx-row" data-idx="${i}" onclick="onDbxClick(${i})">
          <div class="dbx-row-ico" ${isImg ? `data-thumb="${escapeAttr(e.path)}"` : ''}>
            <i class="fa-solid ${ico.icon}" style="color:${ico.color}"></i>
          </div>
          <div class="dbx-row-name">${escapeHtml(e.name)}</div>
          <div class="dbx-row-meta">${fmtSize(e.size)} · ${fmtDbxDate(e.modified)}</div>
        </div>`;
    }).join('')
  }</div>`;
}

// escapeHtml definida arriba (sección BD). escapeAttr es su alias semántico.
function escapeAttr(s){
  return escapeHtml(s);
}

function onDbxClick(idx){
  const e = dbxState.entries[idx];
  if (!e) return;
  if (e.type === 'folder') {
    loadDbxFolder(e.path);
  } else {
    openDbxPreview(e);
  }
}

async function loadVisibleThumbnails(){
  const els = document.querySelectorAll('[data-thumb]');
  for (const el of els) {
    const path = el.getAttribute('data-thumb');
    if (!path) continue;
    if (dbxThumbCache.has(path)) {
      injectThumb(el, dbxThumbCache.get(path));
      continue;
    }
    try {
      const r = await authedFetch('/api/dropbox?action=thumbnail&path=' + encodeURIComponent(path) + '&size=w256h256');
      if (!r.ok) continue;
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      dbxThumbCache.set(path, url);
      injectThumb(el, url);
    } catch (e) { /* silencioso */ }
  }
}

function injectThumb(container, url){
  if (container.querySelector('img')) return;
  const img = document.createElement('img');
  img.onload = () => img.classList.add('loaded');
  img.src = url;
  // Reemplaza el ícono por la imagen
  const icon = container.querySelector('i');
  if (icon) icon.remove();
  container.appendChild(img);
}

function setDbxView(v){
  dbxState.view = v;
  document.getElementById('dbxViewGrid').classList.toggle('on', v === 'grid');
  document.getElementById('dbxViewList').classList.toggle('on', v === 'list');
  renderDbxEntries();
}

function clearDbxSearch(){
  document.getElementById('dbxSearchInput').value = '';
  document.getElementById('dbxSearchClear').classList.remove('show');
  loadDbxFolder(dbxState.path);
}

document.getElementById('dbxSearchInput')?.addEventListener('input', (e) => {
  const v = e.target.value;
  document.getElementById('dbxSearchClear').classList.toggle('show', v.length > 0);
  clearTimeout(dbxSearchTimer);
  dbxSearchTimer = setTimeout(() => {
    if (v.trim()) searchDbx(v);
    else if (dbxState.searching) loadDbxFolder(dbxState.path);
  }, 350);
});

// ── PREVIEW ──
async function openDbxPreview(entry){
  const modal = document.getElementById('dbxPreview');
  const body = document.getElementById('dbxPreviewBody');
  document.getElementById('dbxPreviewName').textContent = entry.name;
  body.innerHTML = `<div class="dbx-preview-loading">
    <div class="dbx-preview-spinner"></div>
    <div>Cargando vista previa...</div>
  </div>`;
  modal.classList.add('show');

  const ext = extOf(entry.name);

  // Botón descargar — siempre carga el link temporal al hacer click
  const dlBtn = document.getElementById('dbxPreviewDownload');
  dlBtn.onclick = async () => {
    dlBtn.disabled = true;
    try {
      const r = await authedFetch('/api/dropbox?action=link&path=' + encodeURIComponent(entry.path));
      const data = await r.json();
      if (data.link) window.open(data.link, '_blank');
    } finally {
      dlBtn.disabled = false;
    }
  };

  try {
    if (IMAGE_EXTS.has(ext)) {
      const r = await authedFetch('/api/dropbox?action=link&path=' + encodeURIComponent(entry.path));
      const data = await r.json();
      if (!data.link) throw new Error('Sin link temporal');
      body.innerHTML = `<img src="${data.link}" alt="${escapeAttr(entry.name)}">`;
    }
    else if (VIDEO_EXTS.has(ext) || AUDIO_EXTS.has(ext)) {
      const r = await authedFetch('/api/dropbox?action=link&path=' + encodeURIComponent(entry.path));
      const data = await r.json();
      if (!data.link) throw new Error('Sin link temporal');
      const tag = VIDEO_EXTS.has(ext) ? 'video' : 'audio';
      body.innerHTML = `<${tag} src="${data.link}" controls autoplay></${tag}>`;
    }
    else if (ext === 'pdf') {
      // Proxy via server: el link temporal de Dropbox viene con
      // Content-Disposition: attachment, lo que fuerza descarga en iframe.
      const r = await authedFetch('/api/dropbox?action=download&path=' + encodeURIComponent(entry.path));
      if (!r.ok) throw new Error('No se pudo cargar el PDF');
      const buf = await r.arrayBuffer();
      const blob = new Blob([buf], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      dbxPreviewUrls.push(url);
      body.innerHTML = `<iframe src="${url}#toolbar=1" allow="fullscreen"></iframe>`;
    }
    else if (OFFICE_PREVIEWABLE.has(ext)) {
      // Pide a Dropbox un preview en PDF (binario) y lo mostramos en iframe
      const r = await authedFetch('/api/dropbox?action=preview&path=' + encodeURIComponent(entry.path));
      if (!r.ok) throw new Error('Vista previa no disponible');
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      dbxPreviewUrls.push(url);
      body.innerHTML = `<iframe src="${url}#toolbar=1" allow="fullscreen"></iframe>`;
    }
    else {
      // Sin vista previa
      body.innerHTML = `<div class="dbx-preview-unsupported">
        <i class="fa-solid fa-file"></i>
        <h3>Sin vista previa</h3>
        <p>Este tipo de archivo no se puede previsualizar dentro del dashboard. Usa "Descargar" para abrirlo en Dropbox.</p>
        <button class="dbx-preview-btn" onclick="document.getElementById('dbxPreviewDownload').click()">
          <i class="fa-solid fa-download"></i> Descargar / Abrir
        </button>
      </div>`;
    }
  } catch (err) {
    body.innerHTML = `<div class="dbx-preview-unsupported">
      <i class="fa-solid fa-triangle-exclamation"></i>
      <h3>No se pudo cargar la vista previa</h3>
      <p>${escapeHtml(err.message)}</p>
      <button class="dbx-preview-btn" onclick="document.getElementById('dbxPreviewDownload').click()">
        <i class="fa-solid fa-download"></i> Abrir en Dropbox
      </button>
    </div>`;
  }
}

function closeDbxPreview(){
  const modal = document.getElementById('dbxPreview');
  modal.classList.remove('show');
  setTimeout(() => {
    document.getElementById('dbxPreviewBody').innerHTML = '';
    while (dbxPreviewUrls.length) URL.revokeObjectURL(dbxPreviewUrls.pop());
  }, 250);
}

// Cerrar preview con Escape (en orden de prioridad respeto al handler global)
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.getElementById('dbxPreview')?.classList.contains('show')) {
    closeDbxPreview();
  }
});

/* ============================================================================
 * MVP FUND TRACKERS
 * Refleja el "Valuation Overview" del Excel de cada fondo.
 * Fund IV: data del archivo "Fund IV Tracker.xlsx" (cutoff 2026-08-06).
 * Fund V : placeholder hasta recibir el Excel.
 * ========================================================================= */

const FUND_TRACKERS = {
  fundIV: {
    id: 'fundIV',
    name: 'MVP All-Star Fund IV',
    subtitle: 'Valuation Overview',
    cutoff: '2026-08-06',
    status: 'Preliminary, Unaudited',
    confidentiality: 'CONFIDENTIAL',
    columns: [
      { key: 'company', label: 'Company' },
      { key: 'invested', label: 'Investment Amount', type: 'money' },
      { key: 'pct',      label: '% of Invested Capital', type: 'pct' },
      { key: 'mtm',      label: 'Mark-to-Market Valuation', type: 'money' },
      { key: 'moic',     label: 'MTM MOIC (x)', type: 'moic' },
      { key: 'corpVal',  label: 'Corp. Valuation ($B)', type: 'num' },
      { key: 'pps',      label: 'Current Mark (PPS)', type: 'num' },
      { key: 'entry',    label: 'Weighted Avg. Entry (PPS)', type: 'num' },
      { key: 'shares',   label: 'MVP Shares', type: 'int' },
      { key: 'fdso',     label: 'Current FDSO (M)', type: 'num' }
    ],
    active: [
      { company: 'RapidSOS, Inc.',                              invested: 11320276, pct: 0.088, mtm: 16669264, moic: 1.4725, corpVal: 1,      pps: 1.71,    entry: 1.16,    shares: 9761237,  fdso: 585.6 },
      { company: 'BlueVoyant, Inc.',                            invested: 9074404,  pct: 0.071, mtm: 12215672, moic: 1.3462, corpVal: 1.728,  pps: 2.25,    entry: 1.68,    shares: 5391889,  fdso: 767.9 },
      { company: 'Job and Talent Holding, Ltd',                 invested: 8011558,  pct: 0.062, mtm: 8959202,  moic: 1.1183, corpVal: 2.095,  pps: 23.61,   entry: 23.61,   shares: 339321,   fdso: 88.7  },
      { company: 'Epic Games, Inc.',                            invested: 7838750,  pct: 0.061, mtm: 5593029,  moic: 0.7135, corpVal: 30.364, pps: 696.43,  entry: 976.06,  shares: 8031,     fdso: 43.6  },
      { company: 'Space Exploration Technologies Corp. (X)',    invested: 7320000,  pct: 0.057, mtm: 19655325, moic: 2.6852, corpVal: 1770,   pps: 135,     entry: 50.28,   shares: 145595,   fdso: 2373.8},
      { company: 'Platform Science, Inc.',                      invested: 5999999,  pct: 0.047, mtm: 10664808, moic: 1.7775, corpVal: 1.988,  pps: 10.91,   entry: 8.51,    shares: 3352634,  fdso: 182.1 },
      { company: 'Patreon, Inc.',                               invested: 5603191,  pct: 0.044, mtm: 1460185,  moic: 0.2606, corpVal: 1.506,  pps: 15.71,   entry: 60.28,   shares: 92955,    fdso: 95.9  },
      { company: 'Wefox Holding AG',                            invested: 5235977,  pct: 0.041, mtm: 8953521,  moic: 1.7100, corpVal: 7.144,  pps: 194.48,  entry: 113.71,  shares: 4453292,  fdso: 36.7  },
      { company: 'Cohere',                                      invested: 4868890,  pct: 0.038, mtm: 8382848,  moic: 1.7217, corpVal: 7,      pps: 230.71,  entry: 134,     shares: 36335,    fdso: 30.3  },
      { company: 'Hawkeye 360, Inc.',                           invested: 4816730,  pct: 0.037, mtm: 10856231, moic: 2.2539, corpVal: 1.823,  pps: 18.86,   entry: 8.37,    shares: 575622,   fdso: 96.7  },
      { company: 'Cohesity Global, Inc.',                       invested: 4799372,  pct: 0.037, mtm: 4799372,  moic: 1.0000, corpVal: 6.389,  pps: 17,      entry: 17,      shares: 282316,   fdso: 375.8 },
      { company: 'Trusted, Inc.',                               invested: 3970451,  pct: 0.031, mtm: 3204906,  moic: 0.8072, corpVal: 0.162,  pps: 0.28,    entry: 1.31,    shares: 7617310,  fdso: 582.1 },
      { company: 'Forto Logistics GmbH & Co',                   invested: 3000000,  pct: 0.023, mtm: 2658222,  moic: 0.8861, corpVal: 1.785,  pps: 9198,    entry: 10380.62,shares: 289,      fdso: 0.2   },
      { company: 'Revolut Ltd',                                 invested: 2061842,  pct: 0.016, mtm: 5466235,  moic: 2.6511, corpVal: 75,     pps: 1381.06, entry: 520.93,  shares: 3958,     fdso: 54.3  },
      { company: 'Quantstamp, Inc.',                            invested: 1999995,  pct: 0.016, mtm: 2010394,  moic: 1.0052, corpVal: 1.024,  pps: 123.52,  entry: 122.88,  shares: 16276,    fdso: 8.3   },
      { company: 'Groq, Inc.',                                  invested: 1506552,  pct: 0.012, mtm: 6677427,  moic: 4.4323, corpVal: 14.198, pps: 68.7,    entry: 15.5,    shares: 97197,    fdso: 206.7 },
      { company: 'IONQ (Capella Space Corp.)',                  invested: 1366439,  pct: 0.011, mtm: 1209681,  moic: 0.8853, corpVal: 9.558,  pps: 27,      entry: 30.5,    shares: 44803,    fdso: 354   },
      { company: 'Transfix, Inc.',                              invested: 1031895,  pct: 0.008, mtm: 1032549,  moic: 1.0006, corpVal: 0.559,  pps: 6.31,    entry: 6.31,    shares: 163637,   fdso: 88.6  },
      { company: 'Loft Holdings, Ltd',                          invested: 1000017,  pct: 0.008, mtm: 859242,   moic: 0.8592, corpVal: 3.286,  pps: 66.06,   entry: 76.88,   shares: 13007,    fdso: 49.7  },
      { company: 'Automattic, Inc.',                            invested: 904924,   pct: 0.007, mtm: 840508,   moic: 0.9288, corpVal: 3.312,  pps: 42.75,   entry: 46.03,   shares: 19661,    fdso: 77.5  },
      { company: 'Figure AI Inc.',                              invested: 873359,   pct: 0.007, mtm: 12490436, moic: 14.3016,corpVal: 39,     pps: 194.93,  entry: 13.63,   shares: 64076,    fdso: 200.1 },
      { company: 'Amazegroup, Inc.',                            invested: 786004,   pct: 0.006, mtm: 350505,   moic: 0.4459, corpVal: 0.015,  pps: 0.21,    entry: 0.47,    shares: 1666691,  fdso: 72.4  },
      { company: 'Neutron Holdings, Inc., DBA Lime',            invested: 765039,   pct: 0.006, mtm: 3021661,  moic: 3.9497, corpVal: 4.061,  pps: 0.10,    entry: 0.03,    shares: 30307529, fdso: 40729.9},
      { company: 'Space Exploration Technologies Corp.',        invested: 375300,   pct: 0.003, mtm: 8444250,  moic: 22.500, corpVal: 1770,   pps: 135,     entry: 6,       shares: 62550,    fdso: 2373.8},
      { company: 'Payward Inc., DBA Kraken',                    invested: 248200,   pct: 0.002, mtm: 337347,   moic: 1.3592, corpVal: 20,     pps: 61.47,   entry: 45.23,   shares: 5488,     fdso: 325.4 },
      { company: 'Turo, Inc.',                                  invested: 99750,    pct: 0.001, mtm: 99750,    moic: 1.0000, corpVal: 2.906,  pps: 21,      entry: 21,      shares: 4750,     fdso: 140.2 }
    ],
    activeTotal:      { invested: 94878914,  mtm: 156912570, moic: 1.6538 },
    distributed: [
      { company: 'Klarna Holding AB',           invested: 11297454, pct: 0.088, mtm: 9286151,  moic: 0.8220, corpVal: 6.292,  pps: 15.05, entry: 18.31, shares: 617020, fdso: 418.1 },
      { company: 'Bolt Financial, Inc.',        invested: 7505795,  pct: 0.058, mtm: 401219,   moic: 0.0535, corpVal: 0.323,  pps: 1.47,  entry: 27.5,  shares: 272938, fdso: 219.5 },
      { company: 'IONQ (Capella Space Corp.)',  invested: 5523644,  pct: 0.043, mtm: 7646205,  moic: 1.3843, corpVal: 14.945, pps: 42.22, entry: 30.5,  shares: 181110, fdso: 354   },
      { company: 'Instacart',                   invested: 4482095,  pct: 0.035, mtm: 953588,   moic: 0.2128, corpVal: 8.134,  pps: 26.07, entry: 122.54,shares: 36578,  fdso: 312   },
      { company: 'Groq, Inc.',                  invested: 3493454,  pct: 0.027, mtm: 15483888, moic: 4.4323, corpVal: 14.198, pps: 68.7,  entry: 15.5,  shares: 225384, fdso: 206.7 },
      { company: 'Udemy',                       invested: 960094,   pct: 0.007, mtm: 308052,   moic: 0.3209, corpVal: 1.261,  pps: 9.22,  entry: 28.74, shares: 33406,  fdso: 136.8 },
      { company: 'Figure AI Inc.',              invested: 426634,   pct: 0.003, mtm: 5446374,  moic: 12.7659,corpVal: 34.812, pps: 174,   entry: 13.63, shares: 31301,  fdso: 200.1 }
    ],
    overallTotal:     { invested: 128568084, mtm: 196438047, moic: 1.5279 },
    overallTotal2:    { label: 'Total — Overall (Commitment)', invested: 154000000, mtm: 196438047, moic: 1.2756 },
    logos: {
      'RapidSOS, Inc.':'rapidsos.com',
      'BlueVoyant, Inc.':'bluevoyant.com',
      'Job and Talent Holding, Ltd':'jobandtalent.com',
      'Epic Games, Inc.':'epicgames.com',
      'Space Exploration Technologies Corp. (X)':'spacex.com',
      'Platform Science, Inc.':'platformscience.com',
      'Patreon, Inc.':'patreon.com',
      'Wefox Holding AG':'wefox.com',
      'Cohere':'cohere.com',
      'Hawkeye 360, Inc.':'he360.com',
      'Cohesity Global, Inc.':'cohesity.com',
      'Trusted, Inc.':'trustedhealth.com',
      'Forto Logistics GmbH & Co':'forto.com',
      'Revolut Ltd':'revolut.com',
      'Quantstamp, Inc.':'quantstamp.com',
      'Groq, Inc.':'groq.com',
      'IONQ (Capella Space Corp.)':'capellaspace.com',
      'Transfix, Inc.':'transfix.io',
      'Loft Holdings, Ltd':'loft.com.br',
      'Automattic, Inc.':'automattic.com',
      'Figure AI Inc.':'figure.ai',
      'Neutron Holdings, Inc., DBA Lime':'li.me',
      'Payward Inc., DBA Kraken':'kraken.com',
      'Turo, Inc.':'turo.com',
      'Klarna Holding AB':'klarna.com',
      'Bolt Financial, Inc.':'bolt.com',
      'Instacart':'instacart.com',
      'Udemy':'udemy.com'
    },
    companyInfo: {
      'RapidSOS, Inc.':{category:'Datos de emergencia',stage:'Crecimiento',tagline:'Plataforma de datos de emergencia que conecta dispositivos, apps y sensores con los centros de 911.',product:{name:'RapidSOS',desc:'Enruta ubicación y datos críticos a los servicios de emergencia en tiempo real.'},markets:['Seguridad pública','911','IoT','Datos'],thesis:'Infraestructura con efecto de red entre operadores, fabricantes y respondedores de emergencia.'},
      'BlueVoyant, Inc.':{category:'Ciberseguridad',stage:'Crecimiento',tagline:'Ciberseguridad gestionada: detección y respuesta (MDR) más defensa de la cadena de suministro.',product:{name:'MDR + Supply Chain Defense',desc:'Monitoreo 24/7 y gestión de riesgo de terceros para empresas y gobierno.'},markets:['Ciberseguridad','MDR','Empresas','Gobierno'],thesis:'Demanda estructural de ciberdefensa gestionada ante amenazas crecientes.'},
      'Job and Talent Holding, Ltd':{category:'Staffing · marketplace',stage:'Crecimiento',tagline:'Marketplace de empleo on-demand que conecta trabajadores temporales con empresas.',product:{name:'Jobandtalent',desc:'Contratación y gestión de personal temporal a escala.'},markets:['Staffing','Marketplace','RRHH','Europa'],thesis:'Digitaliza un mercado laboral temporal enorme y fragmentado.'},
      'Epic Games, Inc.':{category:'Gaming · software',stage:'Tardía',tagline:'Creador de Fortnite y de Unreal Engine, el motor gráfico estándar de la industria.',product:{name:'Fortnite · Unreal Engine',desc:'Ecosistema de juego, motor 3D, tienda y visión de metaverso.'},markets:['Gaming','Motor 3D','App stores','Metaverso'],thesis:'Marca icónica con ingresos masivos; sus litigios antimonopolio podrían abrir el mercado de app stores.'},
      'Space Exploration Technologies Corp. (X)':{category:'Espacio · satélites',stage:'Pública (SPCX)',tagline:'SpaceX: líder mundial en lanzamientos reutilizables e internet satelital Starlink.',product:{name:'Falcon/Starship · Starlink',desc:'Cohetes reutilizables y la mayor constelación de internet satelital.'},markets:['Lanzamientos','Internet satelital','Defensa','Gobierno'],thesis:'Cotiza desde jun-2026 (SPCX); valuación re-marcada al mercado. Posición de alta convicción.'},
      'Platform Science, Inc.':{category:'Telemática · trucking',stage:'Crecimiento',tagline:'Plataforma de telemática y software conectado para flotas de transporte de carga.',product:{name:'Connected Vehicle Platform',desc:'Apps y datos a bordo para optimizar flotas y cumplimiento.'},markets:['Trucking','Telemática','Flotas','SaaS'],thesis:'Digitaliza la operación de flotas; alianzas con grandes fabricantes de camiones.'},
      'Patreon, Inc.':{category:'Creator economy',stage:'Crecimiento',tagline:'Plataforma de membresías para que creadores cobren suscripciones recurrentes a sus fans.',product:{name:'Patreon',desc:'Suscripciones, contenido exclusivo y comunidad para creadores.'},markets:['Creator economy','Suscripciones','Media','Comunidad'],thesis:'Ingresos recurrentes para creadores; entró en valuación alta y se marcó a la baja.'},
      'Wefox Holding AG':{category:'Insurtech',stage:'Crecimiento',tagline:'Insurtech europea: distribución digital de seguros a través de agentes y plataforma.',product:{name:'Plataforma de seguros',desc:'Conecta aseguradoras, agentes y clientes en un modelo digital.'},markets:['Insurtech','Seguros','Europa','Distribución'],thesis:'Digitaliza la distribución de seguros; ejecución y rentabilidad bajo escrutinio.'},
      'Cohere':{category:'IA empresarial',stage:'Crecimiento',tagline:'Modelos de lenguaje (Command) y búsqueda (Rerank) enfocados 100% en empresas.',product:{name:'Command / Rerank',desc:'LLM y búsqueda con privacidad y despliegue on-premise.'},markets:['Empresas','B2B','Búsqueda','On-premise'],thesis:'Alternativa neutral para corporativos que no quieren depender de OpenAI o Anthropic.'},
      'Hawkeye 360, Inc.':{category:'Geoespacial · RF',stage:'Crecimiento',tagline:'Analítica geoespacial de radiofrecuencia: detecta y geolocaliza señales desde satélites.',product:{name:'RF Analytics',desc:'Inteligencia de señales para defensa, seguridad marítima y monitoreo.'},markets:['Geoespacial','Defensa','Satélites','Inteligencia'],thesis:'Datos únicos de RF desde el espacio, con demanda creciente en defensa y seguridad.'},
      'Cohesity Global, Inc.':{category:'Gestión de datos',stage:'Tardía',tagline:'Gestión, respaldo y recuperación de datos empresariales; fusionada con Veritas.',product:{name:'Data Cloud',desc:'Backup, recuperación y seguridad de datos contra ransomware.'},markets:['Datos','Backup','Ciberseguridad','Empresas'],thesis:'Líder consolidado en protección de datos tras la fusión con Veritas; rumbo a IPO.'},
      'Trusted, Inc.':{category:'Healthtech · staffing',stage:'Crecimiento',tagline:'Marketplace de personal de salud que conecta enfermeras con hospitales.',product:{name:'Trusted Health',desc:'Contratación y gestión de enfermería (travel nursing) de forma digital.'},markets:['Salud','Staffing','Marketplace','Enfermería'],thesis:'Digitaliza el staffing de salud ante la escasez crónica de personal.'},
      'Forto Logistics GmbH & Co':{category:'Logística digital',stage:'Crecimiento',tagline:'Freight forwarding digital: gestiona envíos internacionales de carga de punta a punta.',product:{name:'Plataforma de carga',desc:'Cotización, reserva y visibilidad de envíos en una sola plataforma.'},markets:['Logística','Freight','Supply chain','Europa'],thesis:'Digitaliza el forwarding tradicional; sensible al ciclo del comercio global.'},
      'Revolut Ltd':{category:'Fintech · neobanco',stage:'Tardía',tagline:'Súper-app financiera: cuentas, tarjetas, FX, cripto e inversiones para decenas de millones.',product:{name:'Revolut',desc:'Banca, pagos, FX, cripto y trading en una sola app.'},markets:['Fintech','Neobanco','Pagos','Cripto'],thesis:'Decacornio global (~$75B); de las fintech más grandes del mundo, rumbo a IPO.'},
      'Quantstamp, Inc.':{category:'Cripto · seguridad',stage:'Crecimiento',tagline:'Seguridad de blockchain: auditorías de smart contracts y protocolos Web3.',product:{name:'Auditorías Web3',desc:'Revisión y aseguramiento de contratos inteligentes.'},markets:['Cripto','Seguridad','Web3','Auditoría'],thesis:'Capa de confianza para Web3; demanda ligada a la actividad cripto.'},
      'Groq, Inc.':{category:'Semiconductores · IA',stage:'Adquirida',tagline:'Diseña la LPU, chip de inferencia de IA con latencia ultra baja y velocidad líder.',product:{name:'LPU / GroqCloud',desc:'Inferencia de IA de altísima velocidad; acuerdos de gran escala (incl. Nvidia).'},markets:['Semiconductores','Inferencia','Cloud','IA'],thesis:'Ataca el cuello de botella de la inferencia —el costo dominante de la IA en producción.'},
      'IONQ (Capella Space Corp.)':{displayName:'Capella Space',category:'Espacio · satélites SAR',stage:'Adquirida',tagline:'Capella Space: satélites de radar de apertura sintética (SAR) que captan imágenes de la Tierra de día o de noche y a través de las nubes.',product:{name:'Satélites SAR',desc:'Imágenes de radar bajo cualquier clima y sin luz, con entrega rápida bajo demanda.'},markets:['Espacio','Observación de la Tierra','Defensa','Geoespacial'],thesis:'Adquirida por IonQ para impulsar redes cuánticas vía satélite; datos SAR con fuerte demanda en defensa e inteligencia.'},
      'Transfix, Inc.':{category:'Logística · freight',stage:'Crecimiento',tagline:'Marketplace digital de carga que conecta a remitentes con transportistas.',product:{name:'Transfix',desc:'Plataforma de matching y gestión de fletes de camión.'},markets:['Trucking','Freight','Marketplace','Logística'],thesis:'Eficiencia en un mercado de carga fragmentado; sensible al ciclo de fletes.'},
      'Loft Holdings, Ltd':{category:'Proptech',stage:'Crecimiento',tagline:'Proptech brasileña: marketplace para comprar, vender y rentar inmuebles en línea.',product:{name:'Loft',desc:'Plataforma de transacciones inmobiliarias residenciales en Brasil.'},markets:['Proptech','Real estate','Brasil','Marketplace'],thesis:'Digitaliza el real estate en LatAm; afectada por tasas y down-rounds.'},
      'Automattic, Inc.':{category:'Software · web',stage:'Tardía',tagline:'Compañía detrás de WordPress.com, WooCommerce, Tumblr y Jetpack.',product:{name:'WordPress.com · WooCommerce',desc:'Publicación web y e-commerce para una enorme parte de la web.'},markets:['Web','CMS','E-commerce','Open source'],thesis:'Sustenta una fracción enorme de los sitios del mundo; marca y distribución dominantes.'},
      'Figure AI Inc.':{category:'Robótica humanoide',stage:'Tardía',tagline:'Robots humanoides de propósito general (Figure 02/03) con su propia pila de IA.',product:{name:'Figure 02 / 03',desc:'Humanoides con IA propia; integran modelos de lenguaje para tareas.'},markets:['Robótica','Industrial','IA','Logística'],thesis:'La posición de mayor múltiplo del fondo; pilotos industriales (p. ej. con BMW).'},
      'Amazegroup, Inc.':{category:'Holding · cripto',stage:'Temprana',tagline:'Holding con exposición a un negocio australiano relacionado con criptomonedas.',markets:['Cripto','Holding'],thesis:'Posición pequeña y especulativa; marcada a la baja.'},
      'Neutron Holdings, Inc., DBA Lime':{category:'Micromovilidad',stage:'Tardía',tagline:'Lime: scooters y bicicletas eléctricas compartidas en cientos de ciudades.',product:{name:'Lime',desc:'Flota compartida de e-scooters y e-bikes vía app.'},markets:['Micromovilidad','Transporte','Ciudades','App'],thesis:'Líder de micromovilidad, rentable y rumbo a IPO.'},
      'Payward Inc., DBA Kraken':{category:'Cripto · exchange',stage:'Tardía',tagline:'Opera Kraken, uno de los exchanges de cripto más antiguos y regulados del mundo.',product:{name:'Kraken',desc:'Trading, staking, custodia y servicios institucionales de cripto.'},markets:['Cripto','Trading','Custodia','Institucional'],thesis:'Beneficiaria del ciclo cripto y de mayor claridad regulatoria; candidata a IPO.'},
      'Turo, Inc.':{category:'Marketplace · movilidad',stage:'Tardía',tagline:'Marketplace de renta de autos entre particulares ("el Airbnb de los autos").',product:{name:'Turo',desc:'Plataforma P2P para rentar y poner autos en renta.'},markets:['Movilidad','Marketplace','Viajes','P2P'],thesis:'Líder en car-sharing P2P en un mercado grande; candidata a IPO.'},
      'Klarna Holding AB':{category:'Fintech · pagos',stage:'Pública',tagline:'Fintech sueca de "compra ahora, paga después" (BNPL) con decenas de millones de usuarios.',product:{name:'Klarna',desc:'Pagos diferidos, banca, tarjeta y compras asistidas por IA.'},markets:['Fintech','Pagos','BNPL','Banca'],thesis:'Líder global de BNPL; ya cotiza en bolsa.'},
      'Bolt Financial, Inc.':{category:'Fintech · pagos',stage:'Crecimiento',tagline:'Checkout de un clic que permite pagos rápidos y sin fricción en e-commerce.',product:{name:'Bolt Checkout',desc:'Red de identidad y pago "one-click" para comercios online.'},markets:['Fintech','Pagos','E-commerce','Checkout'],thesis:'Apuesta al checkout sin fricción; entró alto y se marcó fuertemente a la baja.'},
      'Instacart':{category:'E-commerce · delivery',stage:'Pública',tagline:'Plataforma de entrega de súper bajo demanda en Norteamérica (público: CART).',product:{name:'Instacart',desc:'Entrega de abarrotes y publicidad para retailers.'},markets:['Delivery','Grocery','Retail media','E-commerce'],thesis:'Líder de grocery delivery con un negocio de publicidad rentable; cotiza como CART.'},
      'Udemy':{category:'Edtech',stage:'Pública',tagline:'Marketplace global de cursos en línea para consumidores y empresas (público: UDMY).',product:{name:'Udemy / Udemy Business',desc:'Cursos a la carta y capacitación corporativa.'},markets:['Edtech','Cursos','B2B','Marketplace'],thesis:'Marketplace de aprendizaje con un brazo empresarial (Udemy Business) en crecimiento.'}
    }
  },
  fundV: {
    id: 'fundV',
    name: 'MVP All-Star Fund V',
    subtitle: 'Valuation Overview',
    cutoff: '2026-06-30',
    status: 'Preliminary, Unaudited',
    confidentiality: 'CONFIDENTIAL',
    committedParFill: true,
    columns: [
      { key: 'company', label: 'Company' },
      { key: 'invested', label: 'Investment Amount', type: 'money' },
      { key: 'pct',      label: '% of Invested Capital', type: 'pct' },
      { key: 'mtm',      label: 'Mark-to-Market Valuation', type: 'money' },
      { key: 'moic',     label: 'MTM MOIC (x)', type: 'moic' },
      { key: 'corpVal',  label: 'Corp. Valuation ($B)', type: 'num' },
      { key: 'pps',      label: 'Current Mark (PPS)', type: 'num' },
      { key: 'entry',    label: 'Weighted Avg. Entry (PPS)', type: 'num' },
      { key: 'shares',   label: 'MVP Shares', type: 'int' },
      { key: 'fdso',     label: 'Current FDSO (M)', type: 'num' }
    ],
    active: [
      { company: 'Decart.AI, Inc.',        invested: 25749946, pct: 0.170, mtm: 25749946,   moic: 1.0000,  corpVal: 3.916,  pps: 197.78, entry: 197.78, shares: 130197,    fdso: 19.8   },
      { company: 'Saronic Technologies',   invested: 20000000, pct: 0.132, mtm: 20000000,   moic: 1.0000,  corpVal: 9.249,  pps: 27.45,  entry: 27.45,  shares: 728730,    fdso: 337    },
      { company: 'Anthropic PBC',          invested: 18587304, pct: 0.123, mtm: 62330216,   moic: 3.3534,  corpVal: 965,    pps: 589.01, entry: 175.65, shares: 105822,    fdso: 1638.34},
      { company: 'X.AI Corp. (SpaceX)',    invested: 15000870, pct: 0.099, mtm: 53228475,   moic: 3.5484,  corpVal: 1770,   pps: 135,    entry: 38.05,  shares: 394285,    fdso: 11869  },
      { company: 'CHAOS Industries',       invested: 9999962,  pct: 0.066, mtm: 9999962,    moic: 1.0000,  corpVal: 4.446,  pps: 138.94, entry: 138.94, shares: 71975,     fdso: 32     },
      { company: 'Base Power, Inc.',       invested: 9280871,  pct: 0.061, mtm: 27088498,   moic: 2.9187,  corpVal: 12,     pps: 352.94, entry: 120.92, shares: 76751,     fdso: 34     },
      { company: 'Second Front Systems',   invested: 7500000,  pct: 0.050, mtm: 7500000,    moic: 1.0000,  corpVal: 0.023,  pps: 1,      entry: 1,      shares: 7500000,   fdso: 22.7   },
      { company: 'Payward (Kraken)',       invested: 6375000,  pct: 0.042, mtm: 8557300,    moic: 1.3423,  corpVal: 20.002, pps: 61.47,  entry: 45.79,  shares: 139211,    fdso: 325.4  },
      { company: 'Agility Robotics',       invested: 5211514,  pct: 0.034, mtm: 5211514,    moic: 1.0000,  corpVal: 1.859,  pps: 66.15,  entry: 66.15,  shares: 78789,     fdso: 28.1   },
      { company: 'Kodiak Robotics',        invested: 5000000,  pct: 0.033, mtm: 15967848,   moic: 3.1936,  corpVal: 1.597,  pps: 7.31,   entry: 2.29,   shares: 2183041,   fdso: 218.3  },
      { company: 'Epirus, Inc.',           invested: 4999998,  pct: 0.033, mtm: 4999998,    moic: 1.0000,  corpVal: 1.011,  pps: 2.77,   entry: 2.77,   shares: 1801996,   fdso: 364.2  },
      { company: 'Radiant Industries',     invested: 4999989,  pct: 0.033, mtm: 4999989,    moic: 1.0000,  corpVal: 1.879,  pps: 42.32,  entry: 42.32,  shares: 118155,    fdso: 44.4   },
      { company: 'Cohere Inc.',            invested: 4999771,  pct: 0.033, mtm: 4999771,    moic: 1.0000,  corpVal: 6.991,  pps: 230.71, entry: 230.71, shares: 21671,     fdso: 30.3   },
      { company: 'Groq, Inc.',             invested: 2363484,  pct: 0.016, mtm: 7102853,    moic: 3.0052,  corpVal: 14.2,   pps: 68.7,   entry: 22.86,  shares: 103389,    fdso: 206.7  },
      { company: 'Mythic Inc.',            invested: 2000000,  pct: 0.013, mtm: 2000000,    moic: 1.0000,  corpVal: 0.159,  pps: 0.0024, entry: 0.0024, shares: 827061450, fdso: 65930.2},
      { company: 'Epic Games, Inc.',       invested: 1833323,  pct: 0.012, mtm: 2633898,    moic: 1.4367,  corpVal: 30.364, pps: 696.43, entry: 484.75, shares: 3782,      fdso: 43.6   },
      { company: 'Figure AI Inc.',         invested: 1300007,  pct: 0.009, mtm: 18592184,   moic: 14.3016, corpVal: 39.006, pps: 194.93, entry: 13.63,  shares: 95378,     fdso: 200.1  }
    ],
    activeTotal:      { invested: 145202039, mtm: 280962452, moic: 1.9350 },
    pendingTitle: 'Pending Positions (Q2 2026)',
    pending: [],
    pendingTotal:     { invested: 0, mtm: 0, moic: 0 },
    distributed: [
      { company: 'Groq, Inc. (Distributed)', invested: 5480542, pct: 0.036, mtm: 16470384, moic: 3.0052, corpVal: 14.2,   pps: 68.7, entry: 22.86, shares: 239744, fdso: 206.7 },
      { company: 'Klarna Holding AB',        invested: 436638,  pct: 0.003, mtm: 266292,   moic: 0.6099, corpVal: 5.435,  pps: 13,   entry: 21.32, shares: 20484,  fdso: 418.1 }
    ],
    overallLabel:     'Total — Overall (Invested)',
    overallTotal:     { invested: 151119219, mtm: 297699128, moic: 1.9700 },
    overallTotal2:    { label: 'Total — Overall (Commitment)', invested: 293000000, mtm: 439579909, moic: 1.5003 },
    // Dominio para el logo (Clearbit). Fallback a monograma si no carga.
    logos: {
      'Decart.AI, Inc.':          'decart.ai',
      'Saronic Technologies':     'saronic.com',
      'Anthropic PBC':            'anthropic.com',
      'X.AI Corp. (SpaceX)':      'spacex.com',
      'CHAOS Industries':         'chaosindustries.com',
      'Base Power, Inc.':         'basepowercompany.com',
      'Second Front Systems':     'secondfront.com',
      'Payward (Kraken)':         'kraken.com',
      'Agility Robotics':         'agilityrobotics.com',
      'Kodiak Robotics':          'kodiak.ai',
      'Epirus, Inc.':             'epirusinc.com',
      'Radiant Industries':       'radiantnuclear.com',
      'Cohere Inc.':              'cohere.com',
      'Groq, Inc.':               'groq.com',
      'Mythic Inc.':              'mythic.ai',
      'Epic Games, Inc.':         'epicgames.com',
      'Figure AI Inc.':           'figure.ai',
      'Groq, Inc. (Distributed)': 'groq.com',
      'Klarna Holding AB':        'klarna.com'
    },
    // Logos provistos a mano (prioridad sobre el favicon)
    logoOverrides: {
      'CHAOS Industries': '/chaos-industries.png'
    },
    // Info enriquecida por empresa (pestaña "Empresas").
    companyInfo: {
      'Decart.AI, Inc.': {
        category:'IA generativa en tiempo real', stage:'Temprana',
        tagline:'Genera video y mundos interactivos cuadro a cuadro, a partir de texto o de una cámara en vivo — sin motor de videojuego.',
        product:{name:'Oasis', desc:'Entornos jugables y navegables donde la IA "imagina" cada fotograma.'},
        markets:['Gaming','Media','Simulación','Publicidad'],
        thesis:'Apuesta por ser la infraestructura de experiencias inmersivas generadas por IA. Posición temprana con alto potencial de revaluación.'
      },
      'Saronic Technologies': {
        category:'Defensa · drones marítimos', stage:'Crecimiento',
        tagline:'Diseña y fabrica embarcaciones de superficie autónomas (no tripuladas) para defensa naval, producidas a escala.',
        product:{name:'Buques autónomos', desc:'Naves asequibles y "sacrificables" para vigilancia, patrullaje y misiones navales.'},
        markets:['Defensa','Naval','Autonomía','Gobierno'],
        thesis:'Beneficiaria directa de la prioridad del Pentágono por masa autónoma de bajo costo (programa Replicator). Defense-tech de crecimiento explosivo.'
      },
      'Anthropic PBC': {
        category:'IA · modelos fundacionales', stage:'Tardía',
        tagline:'Laboratorio líder de IA y creador de la familia de modelos Claude; constituida como Public Benefit Corporation.',
        product:{name:'Claude', desc:'Familia de modelos de lenguaje con enfoque en seguridad ("Constitutional AI").'},
        markets:['Empresas','API','Desarrolladores','Consumo'],
        thesis:'Posición estrella del fondo. Ingresos creciendo muy rápido; competidor directo de OpenAI con un diferenciador claro en seguridad y alineación.'
      },
      'X.AI Corp. (SpaceX)': {
        category:'Espacio · satélites', stage:'Pública (SPCX)',
        tagline:'Exposición a SpaceX: líder mundial en lanzamientos orbitales con cohetes reutilizables e internet satelital Starlink.',
        product:{name:'Falcon/Starship · Starlink', desc:'Cohetes reutilizables y la mayor constelación de internet satelital del mundo.'},
        markets:['Lanzamientos','Internet satelital','Defensa','Gobierno'],
        thesis:'Cotiza públicamente desde jun-2026 (SPCX); valuación re-marcada al precio de mercado en vivo. De las posiciones más grandes y líquidas del fondo.'
      },
      'CHAOS Industries': {
        category:'Defensa · sensado', stage:'Crecimiento',
        tagline:'Sistemas avanzados de sensado, radar y comunicaciones de radiofrecuencia de nueva generación para misiones críticas.',
        product:{name:'Plataformas RF / radar', desc:'Detección, vigilancia y defensa electrónica frente a amenazas modernas.'},
        markets:['Defensa','Radar','Comunicaciones','Gobierno'],
        thesis:'Aprovecha el fuerte aumento de presupuesto y la modernización electrónica del sector defensa.'
      },
      'Base Power, Inc.': {
        category:'Energía residencial', stage:'Crecimiento',
        tagline:'Instala baterías de respaldo en los hogares y las opera en conjunto como una "central eléctrica virtual".',
        product:{name:'Batería + servicios de red', desc:'Respaldo y ahorro para el hogar, más venta de servicios a la red (aplanar picos de demanda).'},
        markets:['Energía','Residencial','Red eléctrica','Texas'],
        thesis:'Ataca la fragilidad de la red y la demanda eléctrica disparada por la IA y los autos eléctricos. Crecimiento acelerado en Texas.'
      },
      'Second Front Systems': {
        category:'Software de defensa', stage:'Temprana',
        tagline:'Plataforma SaaS que permite desplegar software comercial dentro de entornos clasificados de defensa, de forma segura y acreditada.',
        product:{name:'Game Warden', desc:'Elimina el cuello de botella de acreditación de seguridad (ATO), pasando de meses a días.'},
        markets:['Defensa','SaaS','Gobierno','Cloud'],
        thesis:'Acelera el "time-to-mission" de contratistas y agencias del DoD de EE.UU. Posición temprana marcada cerca del costo.'
      },
      'Payward (Kraken)': {
        category:'Cripto · exchange', stage:'Tardía',
        tagline:'Opera Kraken, uno de los exchanges de criptomonedas más antiguos, regulados y confiables del mundo.',
        product:{name:'Kraken', desc:'Trading, staking, custodia y servicios institucionales de cripto.'},
        markets:['Cripto','Trading','Custodia','Institucional'],
        thesis:'Beneficiaria del ciclo alcista cripto y de mayor claridad regulatoria; candidata a salir a bolsa.'
      },
      'Agility Robotics': {
        category:'Robótica humanoide', stage:'Crecimiento',
        tagline:'Fabrica Digit, un robot humanoide bípedo diseñado para logística y almacenes.',
        product:{name:'Digit', desc:'Humanoide que mueve totes y cajas en espacios diseñados para personas.'},
        markets:['Logística','Almacenes','Robótica','Automatización'],
        thesis:'Apuesta a la escasez estructural de mano de obra y a la automatización del trabajo físico.'
      },
      'Kodiak Robotics': {
        category:'Conducción autónoma', stage:'Pública',
        tagline:'Desarrolla el "Kodiak Driver", sistema de conducción autónoma para camiones de carga de larga distancia.',
        product:{name:'Kodiak Driver', desc:'Autonomía para trucking de larga distancia y una variante para defensa / terreno off-road.'},
        markets:['Trucking','Logística','Defensa','Autonomía'],
        thesis:'Ataca la escasez crónica de operadores y la eficiencia del transporte de mercancías.'
      },
      'Epirus, Inc.': {
        category:'Defensa · energía dirigida', stage:'Crecimiento',
        tagline:'Sistemas de energía dirigida por microondas de alta potencia para neutralizar enjambres de drones.',
        product:{name:'Leonidas', desc:'Microondas de estado sólido, escalables y con costo casi nulo por disparo.'},
        markets:['Defensa','Anti-drones','Energía dirigida','Gobierno'],
        thesis:'Los drones se han vuelto la amenaza dominante en los conflictos modernos; demanda creciente por contramedidas asequibles.'
      },
      'Radiant Industries': {
        category:'Energía · nuclear', stage:'Temprana',
        tagline:'Desarrolla microreactores nucleares portátiles que caben en un contenedor de transporte.',
        product:{name:'Kaleidos', desc:'Energía limpia y desplegable para bases remotas, zonas de desastre y data centers.'},
        markets:['Energía','Nuclear','Data centers','Defensa'],
        thesis:'Surfea dos olas a la vez: el apetito energético de la IA y la descarbonización.'
      },
      'Cohere Inc.': {
        category:'IA empresarial', stage:'Crecimiento',
        tagline:'Modelos de lenguaje (Command) y de búsqueda/embeddings (Rerank) enfocados 100% en empresas.',
        product:{name:'Command / Rerank', desc:'LLM y búsqueda con énfasis en privacidad y despliegue on-premise.'},
        markets:['Empresas','B2B','Búsqueda','On-premise'],
        thesis:'Alternativa neutral para corporativos que no quieren depender de OpenAI o Anthropic.'
      },
      'Groq, Inc.': {
        category:'Semiconductores · IA', stage:'Adquirida',
        tagline:'Diseña la LPU, un chip de inferencia de IA con latencia ultra baja y velocidad de generación de tokens líder en la industria.',
        product:{name:'LPU / GroqCloud', desc:'Inferencia de IA de altísima velocidad; acuerdos de gran escala (incl. la transacción con Nvidia).'},
        markets:['Semiconductores','Inferencia','Cloud','IA'],
        thesis:'Ataca el cuello de botella de la inferencia —el costo dominante de la IA en producción— no el entrenamiento.'
      },
      'Mythic Inc.': {
        category:'Semiconductores · edge', stage:'Temprana',
        tagline:'Chips de cómputo analógico-en-memoria para IA en el borde (edge), de muy bajo consumo.',
        product:{name:'Procesador analógico', desc:'Ejecuta inferencia sin mover datos constantemente a memoria, reduciendo drásticamente la energía.'},
        markets:['Edge','Semiconductores','IoT','Bajo consumo'],
        thesis:'Nicho técnico diferenciado para dispositivos donde la batería y el calor importan.'
      },
      'Epic Games, Inc.': {
        category:'Gaming · software', stage:'Tardía',
        tagline:'Creador de Fortnite y de Unreal Engine, el motor gráfico estándar de videojuegos, cine y simulación.',
        product:{name:'Fortnite · Unreal Engine', desc:'Ecosistema de juego, herramientas de creación, tienda propia y visión de "metaverso".'},
        markets:['Gaming','Motor 3D','App stores','Metaverso'],
        thesis:'Marca icónica con ingresos masivos; sus litigios antimonopolio (vs. Apple/Google) podrían abrirle el mercado de las app stores.'
      },
      'Figure AI Inc.': {
        category:'Robótica humanoide', stage:'Tardía',
        tagline:'Desarrolla robots humanoides de propósito general (Figure 02/03) con su propia pila de IA para visión y control.',
        product:{name:'Figure 02 / 03', desc:'Humanoides con IA propia; integra modelos de lenguaje para entender y ejecutar tareas.'},
        markets:['Robótica','Industrial','IA','Logística'],
        thesis:'La posición de mayor múltiplo del fondo. Una de las apuestas más codiciadas en humanoides; pilotos industriales (p. ej. con BMW).'
      },
      'Groq, Inc. (Distributed)': {
        category:'Semiconductores · IA', stage:'Distribuida',
        tagline:'Misma compañía que Groq (LPU y GroqCloud); esta porción ya fue distribuida a los inversionistas.',
        product:{name:'LPU / GroqCloud', desc:'Inferencia de IA de altísima velocidad.'},
        markets:['Semiconductores','Inferencia','Cloud','IA'],
        thesis:'Porción realizada que refleja la fuerte apreciación de Groq; marcada a su MOIC al momento de la distribución.'
      },
      'Klarna Holding AB': {
        category:'Fintech · pagos', stage:'Pública',
        tagline:'Fintech sueca de "compra ahora, paga después" (BNPL) con decenas de millones de usuarios globales.',
        product:{name:'Klarna BNPL', desc:'Pagos diferidos, banca, tarjeta y compras asistidas por IA.'},
        markets:['Fintech','Pagos','BNPL','Banca'],
        thesis:'Posición distribuida: el fondo entró en una valuación alta y se marcó a la baja (down-round), con MOIC por debajo de 1x.'
      }
    }
  }
};

/* ── SpaceX (SPCX, pública desde 2026-06-12) — mark en vivo ──
   El sync de marks (Lun-Vie 15:30) escribe el precio público de SPCX en
   investments.current_ev_pps / current_ev_b (company_id=27, solo activas).
   Aquí lo leemos vía Supabase y re-marcamos las filas SpaceX de los trackers:
   pps y corpVal vivos, mtm = shares × pps, moic = mtm / invested, totales por delta.
   Al terminar el lock-up las investments quedarán distribuidas (distributed_at)
   → la query no regresa filas y el tracker vuelve a los valores del Excel oficial. */
let _spcxLive = null;
let _spcxFetchStarted = false;
let _spcxCurrentFund = null;
const SPCX_ROW_RE = /space exploration|spacex/i;

function fetchSpacexLiveMark() {
  if (_spcxFetchStarted || !sb) return;
  _spcxFetchStarted = true;
  sb.from('investments')
    .select('current_ev_pps,current_ev_b')
    .eq('company_id', 27)
    .is('distributed_at', null)
    .limit(1)
    .then(({ data, error }) => {
      if (error || !data || !data.length || !data[0].current_ev_pps) return;
      _spcxLive = { pps: data[0].current_ev_pps, evB: data[0].current_ev_b };
      applySpacexLiveToTrackers();
      const det = document.getElementById('ftDetail');
      if (det && det.classList.contains('show') && _spcxCurrentFund) {
        renderFundTrackerDetail(_spcxCurrentFund);
      }
    });
}

// Recalcula los totales de un fondo SIEMPRE desde las filas (nunca hardcodeados),
// para que cambiar cualquier valuación los actualice automáticamente.
// overallTotal2 (base Commitment) valora el capital comprometido aún no invertido a la par.
function computeFundTotals(f) {
  if (!f || f.placeholder || !f.active) return;
  const sum = (arr, k) => (arr || []).reduce((s, r) => s + (+r[k] || 0), 0);
  const aInv = sum(f.active, 'invested'), aMtm = sum(f.active, 'mtm');
  f.activeTotal = { invested: aInv, mtm: aMtm, moic: aInv ? aMtm / aInv : 0 };
  const oInv = aInv + sum(f.distributed, 'invested');
  const oMtm = aMtm + sum(f.distributed, 'mtm');
  f.overallTotal = { invested: oInv, mtm: oMtm, moic: oInv ? oMtm / oInv : 0 };
  if (f.committed || (f.overallTotal2 && f.overallTotal2.invested)) {
    const committed = f.committed || f.overallTotal2.invested;
    const label = (f.overallTotal2 && f.overallTotal2.label) || 'Total — Overall (Commitment)';
    // committedParFill: valorar el capital comprometido aún no invertido a la par (solo fondos que lo usan)
    const fill = f.committedParFill ? Math.max(0, committed - oInv) : 0;
    const o2Mtm = oMtm + fill;
    f.committed = committed;
    f.overallTotal2 = { label, invested: committed, mtm: o2Mtm, moic: committed ? o2Mtm / committed : 0 };
  }
}

function applySpacexLiveToTrackers() {
  if (!_spcxLive) return;
  for (const f of [FUND_TRACKERS.fundIV, FUND_TRACKERS.fundV]) {
    if (!f || f.placeholder || !f.active) continue;
    let hit = false;
    for (const row of f.active) {
      if (!SPCX_ROW_RE.test(row.company) || !row.shares) continue;
      row.pps = _spcxLive.pps;
      if (_spcxLive.evB) row.corpVal = _spcxLive.evB;
      row.mtm = Math.round(row.shares * _spcxLive.pps);
      if (row.invested) row.moic = row.mtm / row.invested;
      hit = true;
    }
    if (!hit) continue;
    computeFundTotals(f); // los totales se recalculan desde las filas (incluye SpaceX live)
    f._spcxLiveNote = 'SpaceX @ mercado (SPCX $' +
      _spcxLive.pps.toLocaleString('en-US', { maximumFractionDigits: 2 }) + ')';
  }
}

function fmtTrackerCell(value, type) {
  if (value === null || value === undefined || value === '') return '—';
  if (type === 'money') {
    return '$' + Math.round(value).toLocaleString('en-US');
  }
  if (type === 'pct') {
    return (value * 100).toFixed(1) + '%';
  }
  if (type === 'moic') {
    return value.toFixed(2) + 'x';
  }
  if (type === 'int') {
    return Math.round(value).toLocaleString('en-US');
  }
  if (type === 'num') {
    if (typeof value !== 'number') return value;
    if (Math.abs(value) >= 100) return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
    return value.toFixed(2);
  }
  return value;
}

function moicClass(moic) {
  if (moic == null) return '';
  if (moic >= 1.05) return 'moic-pos';
  if (moic <= 0.95) return 'moic-neg';
  return 'moic-flat';
}

function renderFundTrackerHome() {
  const sel = document.getElementById('ftSelector');
  const det = document.getElementById('ftDetail');
  if (!sel || !det) return;
  sel.style.display = 'block';
  det.classList.remove('show');
  det.style.display = 'none';
  const cards = document.getElementById('ftCards');
  if (!cards) return;
  const funds = [FUND_TRACKERS.fundIV, FUND_TRACKERS.fundV];
  funds.forEach(computeFundTotals);
  cards.innerHTML = funds.map(f => {
    const isPh = !!f.placeholder;
    const stat = isPh
      ? `<div class="ft-card-meta">En desarrollo</div>`
      : `<div class="ft-card-meta">
           <span><strong>${f.active.length}</strong> activas</span>
           ${f.pending && f.pending.length ? `<span><strong>${f.pending.length}</strong> pendientes</span>` : ''}
           <span><strong>${f.distributed.length}</strong> distribuidas</span>
           <span class="${moicClass((f.overallTotal2 || f.overallTotal).moic)}"><strong>${(f.overallTotal2 || f.overallTotal).moic.toFixed(2)}x</strong> MOIC overall</span>
         </div>`;
    return `
      <div class="ft-card${isPh ? ' ft-card-placeholder' : ''}" onclick="openFundTracker('${f.id}')">
        <div class="ft-card-ico"><i class="fa-solid fa-chart-column"></i></div>
        <div class="ft-card-body">
          <div class="ft-card-title">${escapeHtml(f.name)}</div>
          <div class="ft-card-sub">${escapeHtml(f.subtitle || '')}</div>
          ${stat}
        </div>
        <div class="ft-card-chev"><i class="fa-solid fa-chevron-right"></i></div>
      </div>`;
  }).join('');
}

function openFundTracker(fundId) {
  const f = FUND_TRACKERS[fundId];
  if (!f) return;
  const sel = document.getElementById('ftSelector');
  const det = document.getElementById('ftDetail');
  sel.style.display = 'none';
  det.style.display = 'block';
  det.classList.add('show');
  _spcxCurrentFund = fundId;
  fetchSpacexLiveMark();
  renderFundTrackerDetail(fundId);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function closeFundTracker() {
  renderFundTrackerHome();
}

function renderFundTrackerDetail(fundId) {
  const f = FUND_TRACKERS[fundId];
  const host = document.getElementById('ftDetailContent');
  if (!f || !host) return;
  computeFundTotals(f);

  if (f.placeholder) {
    host.innerHTML = `
      <div class="ft-header">
        <div class="ft-name">${escapeHtml(f.name)}</div>
        <div class="ft-sub">${escapeHtml(f.subtitle)}</div>
      </div>
      <div class="ft-empty">
        <div class="ft-empty-ico"><i class="fa-solid fa-clock"></i></div>
        <div class="ft-empty-h">Tracker en desarrollo</div>
        <div>El Valuation Overview de ${escapeHtml(f.name)} se publicará en cuanto esté disponible el archivo oficial.</div>
      </div>`;
    return;
  }

  const cutoffPretty = new Date(f.cutoff + 'T00:00:00').toLocaleDateString('es-MX', { year: 'numeric', month: 'long', day: 'numeric' });

  const renderRow = (row) => {
    return `<tr>` + f.columns.map(c => {
      const v = row[c.key];
      const cls = c.key === 'moic' ? moicClass(v) : '';
      const alignCls = c.type && c.type !== undefined && c.key !== 'company' ? ' ft-num' : '';
      return `<td class="${cls}${alignCls}">${escapeHtml(fmtTrackerCell(v, c.type))}</td>`;
    }).join('') + `</tr>`;
  };

  const renderTotalRow = (label, t) => {
    const cells = f.columns.map(c => {
      if (c.key === 'company') return `<td class="ft-total-lbl">${escapeHtml(label)}</td>`;
      if (c.key === 'invested') return `<td class="ft-num">${fmtTrackerCell(t.invested, 'money')}</td>`;
      if (c.key === 'mtm')      return `<td class="ft-num">${fmtTrackerCell(t.mtm, 'money')}</td>`;
      if (c.key === 'moic')     return `<td class="ft-num ${moicClass(t.moic)}">${fmtTrackerCell(t.moic, 'moic')}</td>`;
      return `<td></td>`;
    }).join('');
    return `<tr class="ft-total">${cells}</tr>`;
  };

  const head = f.columns.map(c => {
    const alignCls = c.key === 'company' ? '' : ' ft-num';
    return `<th class="${alignCls.trim()}">${escapeHtml(c.label)}</th>`;
  }).join('');

  const activeBody = f.active.map(renderRow).join('') + renderTotalRow('Total — Active', f.activeTotal);
  const distBody   = f.distributed.map(renderRow).join('');
  const overallRow = renderTotalRow(f.overallLabel || 'Total — Overall', f.overallTotal)
    + (f.overallTotal2 ? renderTotalRow(f.overallTotal2.label, f.overallTotal2) : '');

  const pendingSection = (f.pending && f.pending.length) ? `
    <div class="ft-section">
      <div class="ft-section-title">${escapeHtml(f.pendingTitle || 'Pending Positions')}</div>
      <div class="ft-table-wrap">
        <table class="ft-table">
          <thead><tr>${head}</tr></thead>
          <tbody>${f.pending.map(renderRow).join('')}${renderTotalRow('Total — Pending', f.pendingTotal)}</tbody>
        </table>
      </div>
    </div>` : '';

  const overviewPanel = `
    <div class="ft-section">
      <div class="ft-section-title">Active Positions</div>
      <div class="ft-table-wrap">
        <table class="ft-table">
          <thead><tr>${head}</tr></thead>
          <tbody>${activeBody}</tbody>
        </table>
      </div>
    </div>
    ${pendingSection}
    <div class="ft-section">
      <div class="ft-section-title">Distributed Positions</div>
      <div class="ft-table-wrap">
        <table class="ft-table">
          <thead><tr>${head}</tr></thead>
          <tbody>${distBody}${overallRow}</tbody>
        </table>
      </div>
    </div>`;

  // Pestaña "Empresas": valuación entrada (= actual ÷ MOIC) → actual, + descripción
  let tabsBar = '', companiesPanel = '';
  if (f.companyInfo) {
    tabsBar = `
      <div class="ft-tabs">
        <button class="ft-tab active" data-fttab="overview" onclick="switchFtTab('overview')"><i class="fa-solid fa-table-list"></i> Valuation Overview</button>
        <button class="ft-tab" data-fttab="companies" onclick="switchFtTab('companies')"><i class="fa-solid fa-building"></i> Empresas</button>
      </div>`;
    companiesPanel = `
      <div id="ftTabCompanies" class="ft-tab-panel" style="display:none">
        <div class="ft-co-note">Valuación corporativa. La de entrada se deriva de la apreciación del PPS (valuación actual ÷ MOIC).</div>
        <div class="ft-co-grid">${ftCompanyCards(f)}</div>
      </div>`;
  }
  host.innerHTML = `
    <div class="ft-header">
      <div class="ft-header-top">
        <div>
          <div class="ft-name">${escapeHtml(f.name)} — ${escapeHtml(f.subtitle)}</div>
          <div class="ft-sub">${escapeHtml(f.status)} · ${escapeHtml(f.confidentiality)} · Cutoff ${escapeHtml(cutoffPretty)}${f._spcxLiveNote ? ' · ' + escapeHtml(f._spcxLiveNote) : ''}</div>
        </div>
        <div class="ft-export-grp">
          <button class="ft-export-btn" data-ftexp="overview" onclick="exportFundTrackerExcel('${f.id}', this)"><i class="fa-solid fa-file-excel"></i> Descargar Excel</button>
          ${f.companyInfo ? `<button class="ft-export-btn ft-export-btn-pdf" data-ftexp="companies" style="display:none" onclick="exportCompaniesPDF('${f.id}', this)"><i class="fa-solid fa-file-pdf"></i> Descargar PDF</button>
          <button class="ft-export-btn ft-export-btn-alt" data-ftexp="companies" style="display:none" onclick="exportCompaniesHTML('${f.id}', this)"><i class="fa-solid fa-file-code"></i> Descargar HTML</button>` : ''}
        </div>
      </div>
      <div class="ft-stats">
        <div>
          <div class="ft-stat-l">${f.overallTotal2 ? 'Committed (overall)' : 'Invested (overall)'}</div>
          <div class="ft-stat-v">${fmtTrackerCell((f.overallTotal2 || f.overallTotal).invested, 'money')}</div>
        </div>
        <div>
          <div class="ft-stat-l">MTM Valuation</div>
          <div class="ft-stat-v">${fmtTrackerCell((f.overallTotal2 || f.overallTotal).mtm, 'money')}</div>
        </div>
        <div>
          <div class="ft-stat-l">MOIC overall</div>
          <div class="ft-stat-v ${moicClass((f.overallTotal2 || f.overallTotal).moic)}">${fmtTrackerCell((f.overallTotal2 || f.overallTotal).moic, 'moic')}</div>
        </div>
      </div>
    </div>
    ${tabsBar}
    <div id="ftTabOverview" class="ft-tab-panel">${overviewPanel}</div>
    ${companiesPanel}`;
}

// Construye las tarjetas de empresas (reutilizado por la pestaña y por export HTML/PDF)
function ftCompanyCards(f, opts) {
  opts = opts || {};
  const _seenCo = new Set();
  const allCos = [...f.active, ...(f.distributed || [])].filter(r => {
    const base = (r.company || '').replace(/\s*\((?:Distributed|X)\)\s*$/i, '').trim();
    if (_seenCo.has(base)) return false;
    _seenCo.add(base); return true;
  });
  const sec = (icon, title, body) =>
    `<div class="ft-co-sec"><div class="ft-co-sec-ico"><i class="fa-solid ${icon}"></i></div>` +
    `<div class="ft-co-sec-body"><div class="ft-co-sec-h">${escapeHtml(title)}</div>${body}</div></div>`;
  return allCos.map(r => {
    const cur = r.corpVal;
    const moic = (r.moic && r.moic > 0) ? r.moic : 1;
    const entry = cur / moic;
    const info = (f.companyInfo || {})[r.company] || {};
    let valNote;
    if (Math.abs(moic - 1) < 0.02) valNote = 'Sin cambio: entrada en la ronda más reciente — marca fresca, no estancamiento.';
    else if (moic > 1) valNote = `Apreciación de ${moic.toFixed(2)}x desde la entrada.`;
    else valNote = `Marca a la baja respecto a la entrada (down-round · ${moic.toFixed(2)}x).`;
    const ov0 = (f.logoOverrides || {})[r.company];
    const override = ov0 ? (/^https?:/i.test(ov0) ? ov0 : (location.origin + ov0)) : null;
    const domain = (f.logos || {})[r.company];
    const dn = info.displayName || r.company;
    const mono = `<span class="ft-co-mono">${escapeHtml(coInitials(dn))}</span>`;
    let logoHtml;
    if (override) {
      logoHtml = `<div class="ft-co-logo">${mono}<img class="ft-co-logo-img" alt="" loading="lazy" src="${override}" onerror="this.remove()"></div>`;
    } else if (domain) {
      const g = `https://www.google.com/s2/favicons?sz=128&domain=${domain}`;
      const d = `https://icons.duckduckgo.com/ip3/${domain}.ico`;
      if (opts.proxyLogos) {
        // same-origin (proxy) → seguro para canvas/PDF
        const pg = '/api/logo?u=' + encodeURIComponent(g), pd = '/api/logo?u=' + encodeURIComponent(d);
        logoHtml = `<div class="ft-co-logo">${mono}<img class="ft-co-logo-img" alt="" src="${pg}" onerror="if(!this.dataset.fb){this.dataset.fb=1;this.src='${pd}';}else{this.remove();}"></div>`;
      } else {
        logoHtml = `<div class="ft-co-logo">${mono}` +
          `<img class="ft-co-logo-img" alt="" loading="lazy" ` +
          `src="https://www.google.com/s2/favicons?sz=128&amp;domain=${domain}" ` +
          `onerror="if(!this.dataset.fb){this.dataset.fb=1;this.src='https://icons.duckduckgo.com/ip3/${domain}.ico';}else{this.remove();}"></div>`;
      }
    } else {
      logoHtml = `<div class="ft-co-logo">${mono}</div>`;
    }
    const tags = [
      info.category ? `<span class="ft-co-tag ft-co-tag-cat">${escapeHtml(info.category)}</span>` : '',
      info.stage ? `<span class="ft-co-tag ft-co-tag-stage">${escapeHtml(info.stage)}</span>` : ''
    ].join('');
    const hasDetail = info.product || info.markets || info.thesis;
    return `
      <div class="ft-co-card">
        <div class="ft-co-head">
          ${logoHtml}
          <div class="ft-co-headtext">
            <div class="ft-co-name">${escapeHtml(dn)}</div>
            ${tags ? `<div class="ft-co-tags">${tags}</div>` : ''}
          </div>
        </div>
        ${info.tagline ? `<p class="ft-co-tagline">${escapeHtml(info.tagline)}</p>` : ''}
        <div class="ft-co-vals">
          <div class="ft-co-valbox"><span class="ft-co-vl">Entrada</span><span class="ft-co-vv">${fmtBil(entry)}</span></div>
          <div class="ft-co-valbox"><span class="ft-co-vl">Valuación actual</span><span class="ft-co-vv ft-co-vv-now">${fmtBil(cur)}</span></div>
        </div>
        <div class="ft-co-vnote"><i class="fa-solid fa-circle-info"></i> ${escapeHtml(valNote)}</div>
        ${hasDetail ? `<hr class="ft-co-div">` : ''}
        ${info.product ? sec('fa-cube', 'Producto · ' + info.product.name, `<div class="ft-co-sec-t">${escapeHtml(info.product.desc)}</div>`) : ''}
        ${info.markets ? sec('fa-globe', 'Mercado objetivo', `<div class="ft-co-chips">${info.markets.map(m => `<span class="ft-co-chip">${escapeHtml(m)}</span>`).join('')}</div>`) : ''}
        ${info.thesis ? sec('fa-arrow-trend-up', 'Tesis de inversión', `<div class="ft-co-sec-t">${escapeHtml(info.thesis)}</div>`) : ''}
      </div>`;
  }).join('');
}

// Documento HTML standalone (para descargar como HTML o imprimir a PDF)
function ftCompaniesDocHtml(f) {
  const cutoffPretty = new Date(f.cutoff + 'T00:00:00').toLocaleDateString('es-MX', { year: 'numeric', month: 'long', day: 'numeric' });
  const css = `
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#f8f9fc;color:#1a1f2e;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.doc{max-width:1120px;margin:0 auto;padding:28px}
.doc-title{font-size:22px;font-weight:700;color:#e8650d;margin-bottom:4px}
.doc-sub{font-size:12.5px;color:#6b7589;margin-bottom:6px}
.doc-note{font-size:12px;color:#6b7589;margin-bottom:18px}
.ft-co-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:16px}
.ft-co-card{background:#fff;border:1px solid #dde1ec;border-radius:14px;padding:18px 20px;display:flex;flex-direction:column;break-inside:avoid;page-break-inside:avoid}
.ft-co-head{display:flex;align-items:center;gap:13px;margin-bottom:12px}
.ft-co-headtext{min-width:0}
.ft-co-name{font-size:16px;font-weight:700;color:#1a1f2e;line-height:1.25}
.ft-co-tags{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.ft-co-tag{font-size:11px;font-weight:600;padding:3px 9px;border-radius:999px}
.ft-co-tag-cat{background:#fceee0;color:#e8650d}
.ft-co-tag-stage{background:#eef0f5;color:#3d4559}
.ft-co-tagline{font-size:13.5px;color:#3d4559;line-height:1.5;margin:0 0 14px}
.ft-co-logo{position:relative;flex:0 0 auto;width:52px;height:52px;border-radius:13px;background:#fff;border:1px solid #dde1ec;overflow:hidden;display:flex;align-items:center;justify-content:center}
.ft-co-mono{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:17px;font-weight:700;color:#e8650d;background:#fceee0}
.ft-co-logo-img{position:relative;width:100%;height:100%;object-fit:contain;padding:8px;background:#fff;border-radius:13px}
.ft-co-vals{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:10px}
.ft-co-valbox{background:#f8f9fc;border-radius:11px;padding:11px 14px;display:flex;flex-direction:column;gap:3px}
.ft-co-vl{font-size:10.5px;font-weight:600;color:#6b7589;text-transform:uppercase;letter-spacing:.3px}
.ft-co-vv{font-size:21px;font-weight:700;color:#1a1f2e;line-height:1.1}
.ft-co-vv-now{color:#e8650d}
.ft-co-vnote{display:flex;align-items:flex-start;gap:7px;font-size:12px;color:#6b7589;line-height:1.45}
.ft-co-vnote i{margin-top:2px;color:#9aa3b5}
.ft-co-div{border:none;border-top:1px solid #eef0f5;margin:14px 0}
.ft-co-sec{display:flex;gap:12px;margin-bottom:14px}
.ft-co-sec-ico{flex:0 0 auto;width:22px;text-align:center;color:#e8650d;font-size:15px;padding-top:1px}
.ft-co-sec-body{min-width:0}
.ft-co-sec-h{font-size:14px;font-weight:700;color:#1a1f2e;margin-bottom:4px}
.ft-co-sec-t{font-size:13px;color:#3d4559;line-height:1.5}
.ft-co-chips{display:flex;flex-wrap:wrap;gap:7px;margin-top:2px}
.ft-co-chip{font-size:12px;font-weight:500;color:#3d4559;background:#eef0f5;padding:4px 11px;border-radius:999px}
@media print{.doc{padding:0;max-width:none}.ft-co-grid{gap:12px}}
@page{margin:13mm}`;
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(f.name)} — Empresas</title>` +
    `<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css"><style>${css}</style></head>` +
    `<body><div class="doc"><div class="doc-head"><div class="doc-title">${escapeHtml(f.name)} — Empresas</div>` +
    `<div class="doc-sub">${escapeHtml(f.status)} · ${escapeHtml(f.confidentiality)} · Cutoff ${escapeHtml(cutoffPretty)}</div>` +
    `<div class="doc-note">Valuación corporativa. La de entrada se deriva de la apreciación del PPS (valuación actual ÷ MOIC).</div></div>` +
    `<div class="ft-co-grid">${ftCompanyCards(f)}</div></div></body></html>`;
}

function exportCompaniesHTML(fundId, btn) {
  const f = FUND_TRACKERS[fundId]; if (!f || !f.companyInfo) return;
  const blob = new Blob([ftCompaniesDocHtml(f)], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${f.name.replace(/[^a-z0-9]+/gi, '_')}_Empresas.html`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

// Lazy-load jsPDF (UMD)
let _jspdfPromise = null;
function loadJsPDF() {
  if (window.jspdf && window.jspdf.jsPDF) return Promise.resolve();
  if (_jspdfPromise) return _jspdfPromise;
  _jspdfPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
    s.onload = resolve;
    s.onerror = () => { _jspdfPromise = null; reject(new Error('No se pudo cargar jsPDF')); };
    document.head.appendChild(s);
  });
  return _jspdfPromise;
}

// Carga una imagen (proxy same-origin) como dataURL + dims + formato
function loadImgData(url) {
  return fetch(url).then(r => { if (!r.ok) throw new Error('img'); return r.blob(); }).then(blob => {
    const fmt = blob.type.includes('jpeg') ? 'JPEG' : (blob.type.includes('png') ? 'PNG' : null);
    if (!fmt) throw new Error('fmt');
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => {
        const data = fr.result, im = new Image();
        im.onload = () => res({ data, fmt, w: im.naturalWidth || 1, h: im.naturalHeight || 1 });
        im.onerror = () => res({ data, fmt, w: 1, h: 1 });
        im.src = data;
      };
      fr.onerror = rej; fr.readAsDataURL(blob);
    });
  });
}

// jsPDF usa fuentes WinAnsi: reemplaza tipografía que no soporta
function _san(t) {
  return String(t == null ? '' : t).replace(/[—–]/g, '-').replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
}

async function exportCompaniesPDF(fundId, btn) {
  const f = FUND_TRACKERS[fundId]; if (!f || !f.companyInfo) return;
  if (btn) { btn.disabled = true; }
  try {
    await loadJsPDF();
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
    const PW = 210, PH = 297, M = 12, CW = PW - 2 * M;
    const ORANGE = [232,101,13], NAVY = [26,31,46], BODY = [61,69,89], GRAY = [107,117,137],
          MUTED = [154,163,181], BOX = [243,244,247], BORDER = [221,225,236], CHIP = [238,240,245], PALE = [252,238,224];
    const lh = pt => pt * 0.40;
    const T = (t, x, y, o) => doc.text(_san(t), x, y, o);
    const split = (t, w) => doc.splitTextToSize(_san(t), w);

    const seen = new Set();
    const cos = [...f.active, ...(f.distributed || [])].filter(r => {
      const b = (r.company || '').replace(/\s*\((?:Distributed|X)\)\s*$/i, '').trim();
      if (seen.has(b)) return false; seen.add(b); return true;
    });
    const logos = {};
    await Promise.all(cos.map(async r => {
      const ov0 = (f.logoOverrides || {})[r.company], domain = (f.logos || {})[r.company];
      let url = null;
      if (ov0) url = /^https?:/i.test(ov0) ? ov0 : (location.origin + ov0);
      else if (domain) url = '/api/logo?u=' + encodeURIComponent('https://www.google.com/s2/favicons?sz=128&domain=' + domain);
      if (!url) return;
      try { logos[r.company] = await loadImgData(url); } catch (e) { /* sin logo -> monograma */ }
    }));
    const cutoffPretty = new Date(f.cutoff + 'T00:00:00').toLocaleDateString('es-MX', { year: 'numeric', month: 'long', day: 'numeric' });

    function card(r, yTop, draw) {
      const info = (f.companyInfo || {})[r.company] || {};
      const dn = info.displayName || r.company;
      const cur = r.corpVal, moic = (r.moic && r.moic > 0) ? r.moic : 1, entry = cur / moic;
      let note;
      if (Math.abs(moic - 1) < 0.02) note = 'Sin cambio: entrada en la ronda mas reciente, marca fresca.';
      else if (moic > 1) note = 'Apreciacion de ' + moic.toFixed(2) + 'x desde la entrada.';
      else note = 'Marca a la baja respecto a la entrada (down-round, ' + moic.toFixed(2) + 'x).';
      const pad = 6, ix = M + pad, iw = CW - 2 * pad;
      let cy = yTop + pad;

      const logoS = 13;
      if (draw) {
        const lg = logos[r.company];
        if (lg) {
          let dw = logoS, dh = logoS;
          if (lg.w >= lg.h) dh = logoS * lg.h / lg.w; else dw = logoS * lg.w / lg.h;
          doc.setDrawColor.apply(doc, BORDER); doc.setFillColor(255,255,255);
          doc.roundedRect(ix, cy, logoS, logoS, 2.5, 2.5, 'FD');
          try { doc.addImage(lg.data, lg.fmt, ix + (logoS - dw)/2, cy + (logoS - dh)/2, dw, dh); } catch (e) {}
        } else {
          doc.setFillColor.apply(doc, PALE); doc.roundedRect(ix, cy, logoS, logoS, 2.5, 2.5, 'F');
          doc.setTextColor.apply(doc, ORANGE); doc.setFont('helvetica','bold'); doc.setFontSize(13);
          T(coInitials(dn), ix + logoS/2, cy + logoS/2 + 1.6, { align: 'center' });
        }
      }
      const nx = ix + logoS + 4, nw = iw - logoS - 4;
      doc.setFont('helvetica','bold'); doc.setFontSize(12);
      const nameLines = split(dn, nw);
      if (draw) { doc.setTextColor.apply(doc, NAVY); nameLines.forEach((ln,i) => T(ln, nx, cy + 3.5 + i*lh(12))); }
      let hcy = cy + 3.5 + nameLines.length * lh(12);
      const tagParts = [];
      if (info.category) tagParts.push([info.category, ORANGE]);
      if (info.stage) tagParts.push([info.stage, GRAY]);
      if (tagParts.length) {
        if (draw) {
          doc.setFont('helvetica','bold'); doc.setFontSize(8); let tx = nx;
          tagParts.forEach((tp,i) => {
            if (i) { doc.setTextColor.apply(doc, MUTED); T('|', tx, hcy + 2); tx += 2.6; }
            doc.setTextColor.apply(doc, tp[1]); T(tp[0], tx, hcy + 2);
            tx += doc.getTextWidth(_san(tp[0])) + 2.6;
          });
        }
        hcy += 4;
      }
      cy = cy + Math.max(logoS, hcy - cy) + 3;

      if (info.tagline) {
        doc.setFont('helvetica','normal'); doc.setFontSize(9.5);
        const tl = split(info.tagline, iw);
        if (draw) { doc.setTextColor.apply(doc, BODY); tl.forEach((ln,i) => T(ln, ix, cy + 3 + i*lh(9.5))); }
        cy += tl.length * lh(9.5) + 4;
      }

      const boxH = 14, gap = 4, bw = (iw - gap) / 2;
      if (draw) {
        [['Entrada', fmtBil(entry), NAVY, ix], ['Valuacion actual', fmtBil(cur), ORANGE, ix + bw + gap]].forEach(b => {
          doc.setFillColor.apply(doc, BOX); doc.roundedRect(b[3], cy, bw, boxH, 2.5, 2.5, 'F');
          doc.setFont('helvetica','bold'); doc.setFontSize(7.5); doc.setTextColor.apply(doc, GRAY);
          T(b[0].toUpperCase(), b[3] + 4, cy + 5);
          doc.setFontSize(15); doc.setTextColor.apply(doc, b[2]);
          T(b[1], b[3] + 4, cy + 11.5);
        });
      }
      cy += boxH + 4;

      doc.setFont('helvetica','normal'); doc.setFontSize(8);
      const nl = split(note, iw - 4);
      if (draw) { doc.setTextColor.apply(doc, GRAY); nl.forEach((ln,i) => T(ln, ix + 4, cy + 2.5 + i*lh(8))); }
      cy += nl.length * lh(8) + 3;

      if (draw) { doc.setDrawColor.apply(doc, BORDER); doc.line(ix, cy, ix + iw, cy); }
      cy += 4;

      const drawSec = (title, isChips, payload) => {
        doc.setFont('helvetica','bold'); doc.setFontSize(10);
        if (draw) {
          doc.setFillColor.apply(doc, ORANGE); doc.roundedRect(ix, cy - 2.6, 2.4, 2.4, 0.6, 0.6, 'F');
          doc.setTextColor.apply(doc, NAVY); T(title, ix + 4.5, cy);
        }
        cy += lh(10) + 1.5;
        if (isChips) {
          doc.setFont('helvetica','normal'); doc.setFontSize(8.5); let cx = ix;
          payload.forEach(m => {
            const cwid = doc.getTextWidth(_san(m)) + 5;
            if (cx + cwid > ix + iw) { cx = ix; cy += 6; }
            if (draw) {
              doc.setFillColor.apply(doc, CHIP); doc.roundedRect(cx, cy - 3.4, cwid, 5, 2.5, 2.5, 'F');
              doc.setTextColor.apply(doc, BODY); T(m, cx + 2.5, cy);
            }
            cx += cwid + 2.5;
          });
          cy += 6 + 1;
        } else {
          doc.setFont('helvetica','normal'); doc.setFontSize(9);
          const bl = split(payload, iw);
          if (draw) { doc.setTextColor.apply(doc, BODY); bl.forEach((ln,i) => T(ln, ix, cy + i*lh(9))); }
          cy += bl.length * lh(9) + 3;
        }
      };
      if (info.product) drawSec('Producto - ' + info.product.name, false, info.product.desc);
      if (info.markets) drawSec('Mercado objetivo', true, info.markets);
      if (info.thesis)  drawSec('Tesis de inversion', false, info.thesis);

      cy += pad - 2;
      return cy - yTop;
    }

    let y = M;
    doc.setFont('helvetica','bold'); doc.setFontSize(16); doc.setTextColor.apply(doc, ORANGE);
    T(f.name + ' - Empresas', M, y + 3); y += 8;
    doc.setFont('helvetica','normal'); doc.setFontSize(9); doc.setTextColor.apply(doc, GRAY);
    T(f.status + ' - ' + f.confidentiality + ' - Cutoff ' + cutoffPretty, M, y); y += 7;

    for (const r of cos) {
      const h = card(r, 0, false);
      if (y + h > PH - M) { doc.addPage(); y = M; }
      doc.setDrawColor.apply(doc, BORDER); doc.setFillColor(255,255,255);
      doc.roundedRect(M, y, CW, h, 3, 3, 'FD');
      card(r, y, true);
      y += h + 6;
    }
    doc.save(f.name.replace(/[^a-z0-9]+/gi, '_') + '_Empresas.pdf');
  } catch (e) {
    alert('No se pudo generar el PDF: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; }
  }
}

// Cambio de pestaña en el detalle del tracker
function switchFtTab(tab) {
  document.querySelectorAll('.ft-tab').forEach(b => b.classList.toggle('active', b.dataset.fttab === tab));
  const ov = document.getElementById('ftTabOverview'), co = document.getElementById('ftTabCompanies');
  if (ov) ov.style.display = (tab === 'overview') ? 'block' : 'none';
  if (co) co.style.display = (tab === 'companies') ? 'block' : 'none';
  document.querySelectorAll('[data-ftexp]').forEach(b => { b.style.display = (b.dataset.ftexp === tab) ? '' : 'none'; });
}

// Formato de valuación corporativa en $B / $M
function fmtBil(v) {
  if (v == null || isNaN(v)) return '—';
  if (v < 1)   return '$' + Math.round(v * 1000).toLocaleString('en-US') + 'M';
  if (v < 10)  return '$' + v.toFixed(2) + 'B';
  if (v < 100) return '$' + v.toFixed(1) + 'B';
  return '$' + Math.round(v).toLocaleString('en-US') + 'B';
}

// Iniciales para el monograma de fallback del logo
function coInitials(name) {
  let n = String(name || '');
  const paren = n.match(/\(([^)]+)\)/);          // ej. "(SpaceX)" → SpaceX
  if (paren) n = paren[1];
  n = n.replace(/[().,]/g, ' ');
  const stop = new Set(['inc', 'corp', 'llc', 'lp', 'pbc', 'ab', 'sa', 'cv', 'technologies', 'industries', 'systems', 'holding', 'holdings', 'robotics', 'distributed', 'the']);
  const words = n.split(/\s+/).filter(w => w && !stop.has(w.toLowerCase()));
  if (!words.length) return 'MVP';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

// ── Export a Excel (ExcelJS, lazy-load) ──
let _excelJsPromise = null;
function loadExcelJS() {
  if (window.ExcelJS) return Promise.resolve();
  if (_excelJsPromise) return _excelJsPromise;
  _excelJsPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js';
    s.onload = resolve;
    s.onerror = () => { _excelJsPromise = null; reject(new Error('No se pudo cargar ExcelJS')); };
    document.head.appendChild(s);
  });
  return _excelJsPromise;
}

async function exportFundTrackerExcel(fundId, btn) {
  const f = FUND_TRACKERS[fundId];
  if (!f || f.placeholder) return;
  computeFundTotals(f);
  if (btn) { btn.disabled = true; }
  try {
    await loadExcelJS();
    const ORANGE = 'FFE8650D', NAVY = 'FF1F2A44', LIGHT = 'FFFDF1E7', TOTAL_BG = 'FFF5E6D8';
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Cretum Partners';
    const ws = wb.addWorksheet('Valuation Overview', { views: [{ showGridLines: false }] });

    const nCols = f.columns.length;
    ws.columns = f.columns.map(c => ({
      width: c.key === 'company' ? 38 : (c.type === 'money' ? 20 : 15)
    }));

    const fmtFor = (type) => ({
      money: '$#,##0',
      pct:   '0.0%',
      moic:  '0.00"x"',
      int:   '#,##0',
      num:   '#,##0.00'
    })[type] || null;

    let r = 1;
    const titleRow = (text, opts = {}) => {
      ws.mergeCells(r, 1, r, nCols);
      const cell = ws.getCell(r, 1);
      cell.value = text;
      cell.font = { bold: !!opts.bold, size: opts.size || 11, color: { argb: opts.color || NAVY } };
      if (opts.fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: opts.fill } };
      r++;
    };

    titleRow(`${f.name} Tracker`, { bold: true, size: 16 });
    titleRow(f.status, { size: 10 });
    titleRow(f.subtitle, { size: 10 });
    titleRow(`Cutoff: ${f.cutoff}`, { size: 10 });
    titleRow(f.confidentiality, { bold: true, size: 10, color: 'FFC0392B' });
    r++;

    const headerRow = () => {
      f.columns.forEach((c, i) => {
        const cell = ws.getCell(r, i + 1);
        cell.value = c.label;
        cell.font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ORANGE } };
        cell.alignment = { horizontal: i === 0 ? 'left' : 'right', vertical: 'middle', wrapText: true };
        cell.border = { bottom: { style: 'thin', color: { argb: NAVY } } };
      });
      ws.getRow(r).height = 28;
      r++;
    };

    const dataRow = (row, stripe) => {
      f.columns.forEach((c, i) => {
        const cell = ws.getCell(r, i + 1);
        cell.value = row[c.key] != null ? row[c.key] : '';
        const fm = fmtFor(c.type);
        if (fm) cell.numFmt = fm;
        cell.font = { size: 10 };
        cell.alignment = { horizontal: i === 0 ? 'left' : 'right' };
        if (stripe) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LIGHT } };
      });
      r++;
    };

    const totalRow = (label, t) => {
      f.columns.forEach((c, i) => {
        const cell = ws.getCell(r, i + 1);
        if (c.key === 'company') cell.value = label;
        else if (c.key === 'invested') { cell.value = t.invested; cell.numFmt = '$#,##0'; }
        else if (c.key === 'mtm')      { cell.value = t.mtm;      cell.numFmt = '$#,##0'; }
        else if (c.key === 'moic')     { cell.value = t.moic;     cell.numFmt = '0.00"x"'; }
        cell.font = { bold: true, size: 10 };
        cell.alignment = { horizontal: i === 0 ? 'left' : 'right' };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TOTAL_BG } };
        cell.border = { top: { style: 'thin', color: { argb: NAVY } } };
      });
      r++;
    };

    const section = (title, rows, totalLabel, total) => {
      titleRow(title, { bold: true, size: 12, fill: LIGHT });
      headerRow();
      rows.forEach((row, idx) => dataRow(row, idx % 2 === 1));
      if (total) totalRow(totalLabel, total);
      r++;
    };

    section('Active Positions', f.active, 'Total - Active', f.activeTotal);
    if (f.pending && f.pending.length) {
      section(f.pendingTitle || 'Pending Positions', f.pending, 'Total - Pending', f.pendingTotal);
    }
    section('Distributed Positions', f.distributed, null, null);
    r--;
    totalRow((f.overallLabel || 'Total - Overall').replace(/—/g, '-'), f.overallTotal);
    if (f.overallTotal2) totalRow(f.overallTotal2.label.replace(/—/g, '-'), f.overallTotal2);

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${f.name.replace(/[^\w]+/g, '_')}_Tracker_${f.cutoff}.xlsx`;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (e) {
    alert('Error al generar el Excel: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; }
  }
}

window.openFundTracker = openFundTracker;
window.closeFundTracker = closeFundTracker;
window.exportFundTrackerExcel = exportFundTrackerExcel;

/* ═══════════════════════════════════════════
   CAMPAÑAS (Yesware) — solo-admin
   Sube el CSV que exporta Yesware, calcula el nivel ⚡ por LP y mes,
   y muestra la matriz tipo "Bloques de Envios LP's GVV".
   Niveles (acumulativos):
     1 ⚡   = abrió           (touchN_opened)
     2 ⚡⚡  = abrió + click    (touchN_clicked)
     3 ⚡⚡⚡ = abrió+click+resp (touchN_replied) — OOO y llamadas NO cuentan
═══════════════════════════════════════════ */
let campaignsLoaded = false;
let campContacts = [];          // [{email, nombre, nombre_completo, responsable, comentarios}]
let campEditingEmail = null;    // email del contacto en edición (null = modo "añadir")
let campEngagement = [];        // [{email, periodo, nivel, ...}]
let campPending = null;         // upload pendiente de confirmar
let campRespFilter = 'all';     // filtro por responsable: 'all' | 'me' | 'none' | 'p:<key>'

// Un contacto puede tener varios responsables ("A / B"). Devuelve la lista limpia.
function campRespPeople(str) {
  return String(str || '')
    .split(/\s*(?:\/|&|,)\s*/)
    .map(s => s.replace(/\s+/g, ' ').trim())
    .filter(s => s && !['na', 'n/a', '-', 'sin', 'tbd', 'pendiente'].includes(s.toLowerCase()));
}
// Clave normalizada (sin acentos, minúsculas) para agrupar typos: "Armando  NArchi" == "Armando Narchi"
function campRespKey(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
}
function campTitleCase(s) {
  return String(s || '').toLowerCase().split(' ').map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join(' ');
}
// ¿Este contacto cae en el filtro de responsable activo?
function campMatchesResp(c) {
  if (campRespFilter === 'all') return true;
  const keys = campRespPeople(c.responsable).map(campRespKey);
  if (campRespFilter === 'none') return keys.length === 0;
  if (campRespFilter === 'me') {
    const me = campRespKey(currentProfile?.full_name || '');
    return me ? keys.includes(me) : false;
  }
  if (campRespFilter.startsWith('p:')) return keys.includes(campRespFilter.slice(2));
  return true;
}
// Cambia el filtro de responsable y re-renderiza
function campSetResp(v) {
  campRespFilter = v || 'all';
  if (campRespFilter === 'p:') campRespFilter = 'all';
  renderCampaigns();
}
// Llena el <select> de responsables con personas distintas + conteos, y refleja chips activos
function campPopulateResp() {
  const sel = document.getElementById('campRespSel');
  const map = new Map();   // key -> {disp, n}
  campContacts.forEach(c => {
    campRespPeople(c.responsable).forEach(p => {
      const k = campRespKey(p);
      if (!map.has(k)) map.set(k, { disp: campTitleCase(p), n: 0 });
      map.get(k).n++;
    });
  });
  if (sel) {
    const items = [...map.entries()].sort((a, b) => a[1].disp.localeCompare(b[1].disp, 'es'));
    const cur = campRespFilter.startsWith('p:') ? campRespFilter.slice(2) : '';
    sel.innerHTML = `<option value="">Por responsable…</option>` +
      items.map(([k, v]) => `<option value="${escapeHtml(k)}"${k === cur ? ' selected' : ''}>${escapeHtml(v.disp)} (${v.n})</option>`).join('');
    sel.classList.toggle('on', !!cur);
  }
  // Estado activo de los chips (Todos / Mis contactos / Sin responsable)
  document.querySelectorAll('#campFilterbar .camp-fchip').forEach(ch => {
    ch.classList.toggle('on', ch.dataset.rf === campRespFilter);
  });
}

const MESES_ES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio',
                  'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

// 'YYYY-MM-DD' o 'YYYY-MM' → "Abril 2026"
function periodoLabel(p) {
  const [y, m] = String(p).split('-');
  return `${MESES_ES[(+m) - 1] || m} ${y}`;
}
// 'YYYY-MM-DD' → 'YYYY-MM' (clave de agrupación)
const periodoKey = (p) => String(p).slice(0, 7);
const nivelGlyph = (n) => n >= 3 ? '⚡⚡⚡' : n >= 2 ? '⚡⚡' : n >= 1 ? '⚡' : '';

/* ── Parser CSV robusto (respeta comas dentro de comillas) ── */
function parseCSV(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows = []; let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c !== '\r') field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 1 || (r.length === 1 && r[0] !== ''));
}

/* ── CSV de Yesware → [{email, opened, clicked, replied, nivel}] ── */
function deriveEngagement(rows) {
  if (!rows.length) return [];
  const header = rows[0].map(h => h.trim().toLowerCase());
  const emailIdx = header.indexOf('email');
  if (emailIdx < 0) throw new Error('El CSV no tiene columna "email"');
  const cols = (re) => header.map((h, i) => re.test(h) ? i : -1).filter(i => i >= 0);
  const openCols  = cols(/^touch\d+_opened$/);
  const clickCols = cols(/^touch\d+_clicked$/);
  const replyCols = cols(/^touch\d+_replied$/);   // NO matchea touchN_ooo_replied
  if (!openCols.length) throw new Error('El CSV no parece de Yesware (faltan columnas touchN_opened)');
  const isTrue = (v) => String(v ?? '').trim().toLowerCase() === 'true';
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    const email = (cells[emailIdx] || '').trim().toLowerCase();
    if (!email) continue;
    const opened  = openCols.some(i => isTrue(cells[i]));
    const clicked = clickCols.some(i => isTrue(cells[i]));
    const replied = replyCols.some(i => isTrue(cells[i]));
    out.push({ email, opened, clicked, replied, nivel: replied ? 3 : clicked ? 2 : opened ? 1 : 0 });
  }
  // Dedup por email: Yesware puede traer la misma persona repetida. Combinamos
  // sus interacciones (OR) y nos quedamos con un solo registro por email; de lo
  // contrario el upsert falla con "ON CONFLICT ... cannot affect row a second time".
  const byEmail = new Map();
  for (const e of out) {
    const ex = byEmail.get(e.email);
    if (!ex) { byEmail.set(e.email, e); continue; }
    ex.opened = ex.opened || e.opened;
    ex.clicked = ex.clicked || e.clicked;
    ex.replied = ex.replied || e.replied;
    ex.nivel = ex.replied ? 3 : ex.clicked ? 2 : ex.opened ? 1 : 0;
  }
  return [...byEmail.values()];
}

/* ── Carga de datos ── */
let campTab = null;
let campLatestPeriodo = null;   // último mes con datos (para "Último visto")
let campRankRows = [];          // filas del ranking (con historial) para el detalle por LP
let campCurrentParams = null;   // valores del generador de la última campaña publicada

function campSetTab(tab) {
  campTab = tab;
  document.querySelectorAll('#pageCampaigns .camp-tab').forEach(b =>
    b.classList.toggle('on', b.dataset.ctab === tab));
  document.getElementById('campPaneRanking').style.display = tab === 'ranking' ? '' : 'none';
  document.getElementById('campPaneActual').style.display  = tab === 'actual'  ? '' : 'none';
  document.getElementById('campPaneGestion').style.display = tab === 'gestion' ? '' : 'none';
  const tablaPane = document.getElementById('campPaneTabla');
  if (tablaPane) tablaPane.style.display = tab === 'tabla' ? '' : 'none';
  if (tab === 'tabla') loadContactsTabla();
}

// En móvil la matriz está oculta hasta pulsar el botón (es muy ancha).
function campToggleMatrix() {
  const m = document.getElementById('campMatrix');
  const btn = document.getElementById('campMatrixToggle');
  if (!m || !btn) return;
  const show = !m.classList.contains('show');
  m.classList.toggle('show', show);
  btn.classList.toggle('open', show);
  const span = btn.querySelector('span');
  if (span) span.innerHTML = `<i class="fa-solid fa-table-cells-large"></i> ${show ? 'Ocultar' : 'Ver'} tabla de interacción`;
}

async function loadCampaigns() {
  const isAdmin = currentProfile?.role === 'admin';
  // La pestaña Gestión solo es para admin; la Tabla de Contactos para el resto.
  const gTab = document.querySelector('#pageCampaigns .camp-tab-admin');
  if (gTab) gTab.style.display = isAdmin ? '' : 'none';
  const uTab = document.querySelector('#pageCampaigns .camp-tab-user');
  if (uTab) uTab.style.display = isAdmin ? 'none' : '';
  // Pestaña por defecto la primera vez
  if (!campTab) campSetTab('ranking');
  else if (campTab === 'gestion' && !isAdmin) campSetTab('ranking');
  else if (campTab === 'tabla' && isAdmin) campSetTab('ranking');

  // Ranking y Campaña Actual: para TODOS (ranking primero para saber el último mes)
  await loadCampRanking();
  loadCampActual();
  loadCampCarta();

  // Matriz de gestión: solo admin (lee tablas directo; RLS lo permite solo a admin)
  if (!isAdmin) return;
  if (campaignsLoaded) { renderCampaigns(); return; }
  const matrix = document.getElementById('campMatrix');
  if (matrix) matrix.innerHTML = '<div class="db-loading"><i class="fa-solid fa-spinner fa-spin"></i> Cargando…</div>';
  try {
    const [{ data: contacts, error: e1 }, { data: eng, error: e2 }] = await Promise.all([
      sb.from('lp_contacts').select('email, nombre, nombre_completo, responsable, comentarios, cancelado'),
      sb.from('campaign_engagement').select('email, periodo, nivel, opened, clicked, replied'),
    ]);
    if (e1) throw e1; if (e2) throw e2;
    campContacts = contacts || [];
    campEngagement = eng || [];
    campaignsLoaded = true;
    // Mes por defecto = el ANTERIOR (la campaña de un mes se envía la 1ª semana
    // del mes siguiente, así que lo que se sube en junio es el reporte de mayo).
    const sel = document.getElementById('campMonth');
    if (sel && !sel.value) {
      const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1);
      sel.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    }
    renderCampaigns();
  } catch (err) {
    console.error('[campaigns]', err);
    if (matrix) matrix.innerHTML = `<div class="db-loading">Error al cargar: ${escapeHtml(err.message)}</div>`;
  }
}

/* ── Ranking (todos los usuarios) — vía RPC segura campaign_ranking() ── */
async function loadCampRanking() {
  const list = document.getElementById('campRankList');
  if (!list) return;
  list.innerHTML = '<div class="db-loading"><i class="fa-solid fa-spinner fa-spin"></i> Cargando ranking…</div>';
  try {
    const { data, error } = await sb.rpc('campaign_ranking');
    if (error) throw error;
    renderCampRanking(data || []);
  } catch (err) {
    console.error('[ranking]', err);
    list.innerHTML = `<div class="camp-empty-mini">No se pudo cargar el ranking: ${escapeHtml(err.message)}</div>`;
  }
}

function renderCampRanking(rows) {
  const list = document.getElementById('campRankList');
  const note = document.getElementById('campRankNote');
  if (!rows.length) {
    list.innerHTML = `<div class="camp-empty-mini"><i class="fa-solid fa-ranking-star"></i><p>Aún no hay interacciones registradas.</p></div>`;
    if (note) note.textContent = '';
    return;
  }
  campRankRows = rows;
  const maxScore = Math.max(...rows.map(r => r.score), 1);
  const ultimo = rows.map(r => r.ultimo_periodo).filter(Boolean).sort().slice(-1)[0];
  campLatestPeriodo = ultimo || null;
  if (note) note.textContent = ultimo ? `Último mes con datos: ${periodoLabel(ultimo)}` : '';
  const mov = { up: ['up', '▲'], down: ['down', '▼'], flat: ['flat', '–'] };
  list.innerHTML = rows.map((r, i) => {
    const pos = i + 1;
    const [mc, mg] = mov[r.momentum] || mov.flat;
    const topCls = pos === 1 ? ' top1' : pos === 2 ? ' top2' : pos === 3 ? ' top3' : '';
    const pct = Math.round((r.score / maxScore) * 100);
    return `<div class="camp-rank-row${topCls}" onclick="campLpOpen(${i})" title="Ver detalle de interacción">
      <div class="camp-rank-pos">${pos}</div>
      <div class="camp-rank-mov ${mc}" title="${r.momentum === 'up' ? 'Subiendo / constante' : r.momentum === 'down' ? 'Bajó / dejó de ver' : 'Sin cambio'}">${mg}</div>
      <div class="camp-rank-info">
        <div class="camp-rank-name">${escapeHtml(r.nombre)}</div>
        <div class="camp-rank-bar-wrap"><div class="camp-rank-bar" style="width:${pct}%"></div></div>
      </div>
      <div class="camp-rank-stat">
        <div class="camp-rank-score">${r.score}</div>
        <div class="camp-rank-veces">${r.meses_vistos} ${r.meses_vistos === 1 ? 'mes' : 'meses'}</div>
      </div>
    </div>`;
  }).join('');
}

/* ── Campaña Actual (todos) — última plantilla generada por el admin ── */
async function loadCampActual() {
  const frameWrap = document.querySelector('#campPaneActual .camp-actual-frame-wrap');
  const note = document.getElementById('campActualNote');
  const frame = document.getElementById('campActualFrame');
  try {
    const { data, error } = await sb.from('campaign_current').select('html, mes, updated_at, params').eq('id', 1).maybeSingle();
    if (error) throw error;
    campCurrentParams = data?.params || null;
    if (!data || !data.html) {
      if (frameWrap) frameWrap.style.display = 'none';
      if (note) note.innerHTML = `<i class="fa-solid fa-circle-info"></i> Aún no hay una campaña publicada.`;
      return;
    }
    if (frameWrap) frameWrap.style.display = '';
    frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">${data.html}</body></html>`;
    const visto = campLatestPeriodo ? periodoLabel(campLatestPeriodo) : (data.mes || '—');
    note.innerHTML = `<span class="badge">${escapeHtml(data.mes || 'Campaña')}</span> Último visto: ${escapeHtml(visto)}`;
  } catch (err) {
    console.error('[campActual]', err);
    if (note) note.innerHTML = `<i class="fa-solid fa-circle-info"></i> No se pudo cargar la campaña actual.`;
  }
}

/* ── Carta mensual autorizada (Dropbox) — botón "Carta <Mes>" ──
   Cuando la carta está en esta carpeta es porque ya está autorizada y
   confirmada. Se toma el archivo más reciente de la carpeta del año. */
const CARTA_DBX_DIR = '/CRETUM RAIZ/Cretum/Cretum Capital Partners/Marketing/Carta Mensual';
let campCartaFile = null;

async function loadCampCarta() {
  const btn = document.getElementById('campCartaBtn');
  if (!btn || campCartaFile) return;   // ya resuelta en esta sesión
  try {
    const y = new Date().getFullYear();
    let entries = await campCartaList(`${CARTA_DBX_DIR}/${y}`);
    // En enero la última carta autorizada puede seguir en la carpeta del año pasado
    if (!entries.some(e => e.type === 'file')) entries = await campCartaList(`${CARTA_DBX_DIR}/${y - 1}`);
    const files = entries.filter(e => e.type === 'file');
    if (!files.length) { btn.style.display = 'none'; return; }
    files.sort((a, b) => String(b.modified || '').localeCompare(String(a.modified || '')));
    campCartaFile = files[0];
    btn.innerHTML = `<i class="fa-solid fa-file-pdf"></i> Carta ${campCartaMes(campCartaFile)}`;
    btn.style.display = '';
  } catch (err) {
    console.error('[carta]', err);
    btn.style.display = 'none';
  }
}

async function campCartaList(path) {
  const r = await authedFetch('/api/dropbox?action=list&path=' + encodeURIComponent(path));
  if (!r.ok) return [];
  const d = await r.json();
  return d.entries || [];
}

// Mes de la carta: primero busca el nombre del mes en el archivo;
// si no viene, asume el mes anterior a su fecha de subida.
function campCartaMes(f) {
  const low = (f.name || '').toLowerCase();
  const i = MESES_ES.findIndex(m => low.includes(m.toLowerCase()));
  if (i >= 0) {
    const anio = ((f.name || '').match(/20\d{2}/) || [])[0];
    return MESES_ES[i] + (anio ? ' ' + anio : '');
  }
  const d = new Date(f.modified || Date.now());
  d.setDate(1); d.setMonth(d.getMonth() - 1);
  return `${MESES_ES[d.getMonth()]} ${d.getFullYear()}`;
}

async function campCartaOpen() {
  if (!campCartaFile) return;
  // Abrir la pestaña ANTES del fetch para que el bloqueador de popups no la pare
  const w = window.open('', '_blank');
  try {
    const r = await authedFetch('/api/dropbox?action=download&path=' + encodeURIComponent(campCartaFile.path));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    if (w) w.location = url; else window.open(url, '_blank');
  } catch (err) {
    console.error('[carta]', err);
    if (w) w.close();
    toast('No se pudo abrir la carta');
  }
}

/* ── Detalle de interacción por LP (feedback para el vendedor) ── */
// Desde el ranking: usa el historial que trae campaign_ranking() (sin email).
function campLpOpen(i) {
  const r = campRankRows[i];
  if (r) campLpRender(r.nombre, r.historial || []);
}
// Desde la matriz (admin): arma el historial con los datos ya cargados.
function campLpOpenEmail(email) {
  const c = campContacts.find(x => x.email === email);
  const hist = campEngagement
    .filter(e => e.email === email)
    .map(e => ({ periodo: e.periodo, opened: e.opened, clicked: e.clicked, replied: e.replied, nivel: e.nivel }))
    .sort((a, b) => String(a.periodo).localeCompare(String(b.periodo)));
  campLpRender(c?.nombre_completo || c?.nombre || email, hist);
}
function campLpClose() { document.getElementById('campLpModal').classList.remove('show'); }

function campLpRender(nombre, hist) {
  const abiertos = hist.filter(h => h.opened).length;
  const cartas   = hist.filter(h => h.clicked).length;
  const resp     = hist.filter(h => h.replied).length;
  const vistos   = hist.filter(h => h.nivel >= 1);
  document.getElementById('campLpName').innerHTML =
    `<i class="fa-solid fa-user"></i> ${escapeHtml(nombre)}`;
  const body = document.getElementById('campLpBody');
  if (!vistos.length) {
    body.innerHTML = `<div class="camp-empty-mini"><i class="fa-solid fa-envelope"></i>
      <p>Aún no registra interacciones con las campañas.</p></div>`;
  } else {
    const desde = periodoLabel(vistos[0].periodo);
    const frase = `Ha visto la carta <strong>${cartas}</strong> ${cartas === 1 ? 'vez' : 'veces'}, ` +
      `con <strong>${resp}</strong> ${resp === 1 ? 'respuesta' : 'respuestas'}, ` +
      `y ha abierto nuestros correos <strong>${abiertos}</strong> ${abiertos === 1 ? 'vez' : 'veces'} ` +
      `desde <strong>${desde}</strong>.`;
    const DESC = ['Sin interacción', 'Abrió el correo', 'Abrió el correo y vio la carta', 'Abrió, vio la carta y respondió'];
    const tl = hist.map(h => `<div class="camp-lp-tl-row">
        <span class="camp-lp-dot n${h.nivel}"></span>
        <span class="camp-lp-mes">${periodoLabel(h.periodo)}</span>
        <span class="camp-lp-desc n${h.nivel}">${DESC[h.nivel] || DESC[0]}</span>
      </div>`).join('');
    body.innerHTML = `
      <div class="camp-lp-summary">${frase}</div>
      <div class="camp-lp-stats">
        <div class="camp-lp-stat"><div class="camp-lp-stat-n">${abiertos}</div><div class="camp-lp-stat-l">correos abiertos</div></div>
        <div class="camp-lp-stat"><div class="camp-lp-stat-n">${cartas}</div><div class="camp-lp-stat-l">cartas vistas</div></div>
        <div class="camp-lp-stat"><div class="camp-lp-stat-n">${resp}</div><div class="camp-lp-stat-l">respuestas</div></div>
      </div>
      <div class="camp-lp-tl">${tl}</div>`;
  }
  document.getElementById('campLpModal').classList.add('show');
}

/* ── Render de la matriz contactos × meses ── */
function renderCampaigns() {
  const matrix = document.getElementById('campMatrix');
  if (!matrix) return;

  // Periodos presentes (orden cronológico)
  const periods = [...new Set(campEngagement.map(e => periodoKey(e.periodo)))].sort();
  // mapa email|periodo → nivel
  const lvl = new Map();
  campEngagement.forEach(e => lvl.set(`${e.email}|${periodoKey(e.periodo)}`, e.nivel));

  // Refresca el selector de responsables (conteos al día tras editar/cargar)
  campPopulateResp();

  // Filtro de búsqueda + filtro por responsable
  const q = (document.getElementById('campSearch')?.value || '').trim().toLowerCase();
  let contacts = campContacts.slice().sort((a, b) =>
    (a.nombre_completo || a.email).localeCompare(b.nombre_completo || b.email, 'es'));
  contacts = contacts.filter(campMatchesResp);
  if (q) contacts = contacts.filter(c =>
    fuzzyMatch(q, c.nombre_completo || '') ||
    (c.email || '').toLowerCase().includes(q) ||   // email: literal (la similitud no aplica bien)
    fuzzyMatch(q, c.responsable || ''));

  const respLbl = campRespFilter === 'me' ? ' · mis contactos'
    : campRespFilter === 'none' ? ' · sin responsable'
    : campRespFilter.startsWith('p:') ? ' · ' + campTitleCase(campRespFilter.slice(2)) : '';
  document.getElementById('campCount').textContent =
    `${contacts.length} LP${contacts.length === 1 ? '' : 's'} · ${periods.length} mes${periods.length === 1 ? '' : 'es'}${respLbl}`;

  if (!campContacts.length) {
    matrix.innerHTML = `<div class="camp-empty">
      <i class="fa-solid fa-inbox"></i>
      <p>Aún no hay LPs cargados. Pídeme la carga inicial del histórico, o sube tu primer CSV de Yesware arriba.</p>
    </div>`;
    return;
  }

  if (!contacts.length) {
    const msg = campRespFilter === 'me'
      ? 'No tienes contactos asignados como responsable. (Tu nombre debe coincidir con el campo "responsable" del contacto.)'
      : campRespFilter === 'none'
        ? '🎉 Todos los contactos tienen responsable asignado.'
        : 'Ningún contacto coincide con este filtro.';
    matrix.innerHTML = `<div class="camp-empty"><i class="fa-solid fa-filter-circle-xmark"></i><p>${msg}</p></div>`;
    return;
  }

  // Header fila 1: cada mes agrupa 3 sub-columnas; bandas alternadas + botón borrar mes
  const grpCells = periods.map((p, i) =>
    `<th class="camp-mth-grp camp-g${i % 2}" colspan="3" title="${periodoLabel(p)}">` +
      `<span class="camp-mth-lbl">${MESES_ES[(+p.slice(5, 7)) - 1]} '${p.slice(2, 4)}</span>` +
      `<button class="camp-mth-del" title="Borrar ${periodoLabel(p)}" onclick="campDeleteMonthKey('${p}')"><i class="fa-solid fa-xmark"></i></button>` +
    `</th>`
  ).join('');
  // Header fila 2: las sub-columnas ⚡ / ⚡⚡ / ⚡⚡⚡ (subtítulo en azul claro)
  const subCells = periods.map((p, i) =>
    `<th class="camp-sub camp-mth-start camp-g${i % 2}">⚡</th><th class="camp-sub camp-g${i % 2}">⚡⚡</th><th class="camp-sub camp-g${i % 2}">⚡⚡⚡</th>`
  ).join('');

  const bodyRows = contacts.map(c => {
    let vistos = 0;
    const cells = periods.map((p, i) => {
      const n = lvl.get(`${c.email}|${p}`) || 0;
      if (n >= 1) vistos++;
      const g = `camp-g${i % 2}`;
      return `<td class="camp-cell camp-mth-start ${g} camp-l1">${n === 1 ? '⚡' : ''}</td>` +
             `<td class="camp-cell ${g} camp-l2">${n === 2 ? '⚡⚡' : ''}</td>` +
             `<td class="camp-cell ${g} camp-l3">${n === 3 ? '⚡⚡⚡' : ''}</td>`;
    }).join('');
    const nombre = escapeHtml(c.nombre_completo || c.nombre || '—');
    return `<tr class="${c.cancelado ? 'camp-row-cancel' : ''}">
      <td class="camp-name">
        <span class="camp-row-acts">
          <button class="camp-row-act" title="Editar contacto" onclick="campEditContactOpen('${c.email}')"><i class="fa-solid fa-pen"></i></button>
          <button class="camp-row-act" title="${c.cancelado ? 'Reactivar (quitar cancelado)' : 'Marcar como cancelado'}" onclick="campToggleCancel('${c.email}')"><i class="fa-solid ${c.cancelado ? 'fa-rotate-left' : 'fa-ban'}"></i></button>
          <button class="camp-row-act camp-row-del" title="Borrar contacto" onclick="campDeleteContact('${c.email}')"><i class="fa-solid fa-xmark"></i></button>
        </span>
        <div class="camp-name-main" onclick="campLpOpenEmail('${c.email}')" title="Ver detalle de interacción">${nombre}${c.cancelado ? ' <span class="camp-cancel-badge">CANCELÓ</span>' : ''}</div>
        <div class="camp-name-sub">${escapeHtml(c.email)}${c.responsable ? ' · ' + escapeHtml(c.responsable) : ''}</div>
      </td>
      <td class="camp-total">${vistos}</td>
      ${cells}
    </tr>`;
  }).join('');

  matrix.innerHTML = `<div class="camp-table-scroll">
    <table class="camp-table">
      <thead>
        <tr>
          <th class="camp-name camp-name-h" rowspan="2">LP</th>
          <th class="camp-total camp-total-h" rowspan="2" title="Meses con interacción">Vistos</th>
          ${grpCells}
        </tr>
        <tr>${subCells}</tr>
      </thead>
      <tbody>${bodyRows}</tbody>
    </table>
  </div>`;
}

/* ── Carga de CSV (drag-drop o file picker) ── */
function campHandleFiles(files) {
  const file = files && files[0];
  if (!file) return;
  const month = document.getElementById('campMonth').value;
  if (!month) { toast('Elige primero el mes del reporte'); return; }
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const eng = deriveEngagement(parseCSV(String(reader.result)));
      if (!eng.length) { toast('El CSV no trae filas con email'); return; }
      const known = new Set(campContacts.map(c => c.email));
      const matched = eng.filter(e => known.has(e.email));
      const nuevos  = eng.filter(e => !known.has(e.email) && e.nivel >= 1);
      campPending = { periodo: month + '-01', label: file.name, rows: matched, nuevos };
      campShowPreview(eng, matched, nuevos, month);
    } catch (err) {
      console.error('[campaigns csv]', err);
      toast('Error al leer el CSV: ' + err.message);
    }
  };
  reader.onerror = () => toast('No se pudo leer el archivo');
  reader.readAsText(file, 'utf-8');
}

function campShowPreview(eng, matched, nuevos, month) {
  const t = { 1: 0, 2: 0, 3: 0 };
  matched.forEach(e => { if (e.nivel >= 1) t[e.nivel]++; });
  const box = document.getElementById('campPreview');
  box.style.display = '';
  box.innerHTML = `
    <div class="camp-prev-head">
      <i class="fa-solid fa-circle-check"></i>
      Reporte leído para <strong>${periodoLabel(month + '-01')}</strong> — ${eng.length} destinatarios
    </div>
    <div class="camp-prev-stats">
      <div class="camp-stat camp-l1"><span class="camp-stat-n">${t[1]}</span> ⚡ abrieron</div>
      <div class="camp-stat camp-l2"><span class="camp-stat-n">${t[2]}</span> ⚡⚡ + click</div>
      <div class="camp-stat camp-l3"><span class="camp-stat-n">${t[3]}</span> ⚡⚡⚡ + respondieron</div>
      <div class="camp-stat"><span class="camp-stat-n">${matched.length}</span> emparejados con LPs</div>
    </div>
    ${nuevos.length ? `<details class="camp-prev-new">
      <summary>⚠️ ${nuevos.length} con interacción que NO están en tu lista de LPs (no se guardarán)</summary>
      <div class="camp-prev-new-list">${nuevos.map(e => `${escapeHtml(e.email)} <span class="camp-l${e.nivel}">${nivelGlyph(e.nivel)}</span>`).join('<br>')}</div>
    </details>` : ''}
    <div class="camp-prev-actions">
      <button class="btn-primary" onclick="campConfirmUpload()"><i class="fa-solid fa-floppy-disk"></i> Guardar ${periodoLabel(month + '-01')}</button>
      <button class="camp-prev-cancel" onclick="campCancelUpload()">Cancelar</button>
    </div>`;
}

function campCancelUpload() {
  campPending = null;
  const box = document.getElementById('campPreview');
  box.style.display = 'none';
  box.innerHTML = '';
  const inp = document.getElementById('campFileInput');
  if (inp) inp.value = '';
}

async function campConfirmUpload() {
  if (!campPending) return;
  const { periodo, label, rows } = campPending;
  const payload = rows.map(e => ({
    email: e.email, periodo,
    opened: e.opened, clicked: e.clicked, replied: e.replied, nivel: e.nivel,
    campaign: label, uploaded_by: currentUser, uploaded_at: new Date().toISOString(),
  }));
  try {
    const { error } = await sb.from('campaign_engagement')
      .upsert(payload, { onConflict: 'email,periodo' });
    if (error) throw error;
    toast(`Guardado ${periodoLabel(periodo)} — ${payload.length} LPs actualizados`);
    campCancelUpload();
    campaignsLoaded = false;
    await loadCampaigns();
  } catch (err) {
    console.error('[campaigns upsert]', err);
    toast('Error al guardar: ' + err.message);
  }
}

/* ── Drag & drop ── */
function campDragOver(e) { e.preventDefault(); document.getElementById('campDrop').classList.add('drag'); }
function campDragLeave() { document.getElementById('campDrop').classList.remove('drag'); }
function campDrop(e) {
  e.preventDefault();
  document.getElementById('campDrop').classList.remove('drag');
  campHandleFiles(e.dataTransfer.files);
}

/* ── Exportar matriz a Excel — MISMO formato que el Sheets (3 sub-columnas/mes) ── */
async function campExportExcel() {
  if (!campContacts.length) { toast('No hay datos para exportar'); return; }
  const periods = [...new Set(campEngagement.map(e => periodoKey(e.periodo)))].sort();
  const lvl = new Map();
  campEngagement.forEach(e => lvl.set(`${e.email}|${periodoKey(e.periodo)}`, e.nivel));

  // Fila 1 de encabezado: 6 columnas fijas + cada mes ocupando 3 columnas
  const h1 = ['Email', 'Nombre', 'Nombre Completo (Para Registro)', 'Responsable (s) Registrados', 'Comentarios', 'Meses Vistos'];
  periods.forEach(p => h1.push(periodoLabel(p), '', ''));

  const contacts = campContacts.slice().sort((a, b) =>
    (a.nombre_completo || a.email).localeCompare(b.nombre_completo || b.email, 'es'));
  const rows = contacts.map(c => {
    let vistos = 0;
    const cells = [];
    periods.forEach(p => {
      const n = lvl.get(`${c.email}|${p}`) || 0;
      if (n >= 1) vistos++;
      cells.push(n === 1 ? '⚡' : '', n === 2 ? '⚡⚡' : '', n === 3 ? '⚡⚡⚡' : '');
    });
    return [c.email, c.nombre || '', c.nombre_completo || '', c.responsable || '', c.comentarios || '', vistos, ...cells];
  });

  await loadScript('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js');
  const ws = XLSX.utils.aoa_to_sheet([h1, ...rows]);
  // Combina las 3 celdas del encabezado de cada mes (como en tu Sheets)
  ws['!merges'] = periods.map((p, i) => ({ s: { r: 0, c: 6 + i * 3 }, e: { r: 0, c: 6 + i * 3 + 2 } }));
  ws['!cols'] = [{ wch: 30 }, { wch: 14 }, { wch: 28 }, { wch: 24 }, { wch: 30 }, { wch: 7 },
    ...periods.flatMap(() => [{ wch: 5 }, { wch: 5 }, { wch: 5 }])];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'LPs');
  XLSX.writeFile(wb, `cretum_campanas_${new Date().toISOString().slice(0, 10)}.xlsx`);
  toast(`Exportados ${rows.length} LPs a Excel`);
}

/* ── Sincronizar con Google Sheets (puente durante la migración) ──
   Manda la matriz al Apps Script del Sheets (vía /api/sheets, que guarda el
   secreto). El script reescribe la hoja PERO los Comentarios/Responsable que
   el equipo haya escrito allá ganan y se traen de vuelta a lp_contacts. */
async function campSheetsSync() {
  if (!campContacts.length) { toast('No hay datos para sincronizar'); return; }
  const btn = document.getElementById('campSheetsBtn');
  const btnHtml = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Sincronizando…'; }
  try {
    // Misma matriz que el Exportar Excel
    const periods = [...new Set(campEngagement.map(e => periodoKey(e.periodo)))].sort();
    const lvl = new Map();
    campEngagement.forEach(e => lvl.set(`${e.email}|${periodoKey(e.periodo)}`, e.nivel));
    const header = ['Email', 'Nombre', 'Nombre Completo (Para Registro)', 'Responsable (s) Registrados', 'Comentarios', 'Meses Vistos'];
    periods.forEach(p => header.push(periodoLabel(p), '', ''));
    const contacts = campContacts.slice().sort((a, b) =>
      (a.nombre_completo || a.email).localeCompare(b.nombre_completo || b.email, 'es'));
    const vistosPor = new Map();
    const rows = contacts.map(c => {
      let vistos = 0;
      const cells = [];
      periods.forEach(p => {
        const n = lvl.get(`${c.email}|${p}`) || 0;
        if (n >= 1) vistos++;
        cells.push(n === 1 ? '⚡' : '', n === 2 ? '⚡⚡' : '', n === 3 ? '⚡⚡⚡' : '');
      });
      vistosPor.set(c.email, vistos);
      return [c.email, c.nombre || '', c.nombre_completo || '', c.responsable || '', c.comentarios || '', vistos, ...cells];
    });
    const cancelados = campContacts.filter(c => c.cancelado).map(c => c.email);
    // Destacados en naranja claro: vieron la campaña todos los meses (o solo uno menos)
    const umbral = Math.max(1, periods.length - 1);
    const destacados = contacts
      .filter(c => !c.cancelado && (vistosPor.get(c.email) || 0) >= umbral)
      .map(c => c.email);

    const r = await authedFetch('/api/sheets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ header, rows, meses: periods.length, cancelados, destacados }),
    });
    const d = await r.json().catch(() => null);
    if (!r.ok || !d?.ok) throw new Error(d?.error || ('HTTP ' + r.status));

    // Trae de vuelta el seguimiento que el equipo escribió en el Sheets
    const seg = d.seguimiento || {};
    const cambios = [];
    for (const c of campContacts) {
      const s = seg[c.email];
      if (!s) continue;
      const nc = (s.comentarios || '').trim() || null;
      const nr = (s.responsable || '').trim() || null;
      if ((nc || '') !== (c.comentarios || '') || (nr || '') !== (c.responsable || '')) {
        cambios.push({ email: c.email, comentarios: nc, responsable: nr });
      }
    }
    if (cambios.length) {
      const { error } = await sb.from('lp_contacts').upsert(cambios, { onConflict: 'email' });
      if (error) throw error;
      cambios.forEach(ch => {
        const c = campContacts.find(x => x.email === ch.email);
        if (c) { c.comentarios = ch.comentarios; c.responsable = ch.responsable; }
      });
      renderCampaigns();
    }
    toast(`Sheets actualizado (${d.filas} filas)${cambios.length ? ` · ${cambios.length} seguimiento${cambios.length === 1 ? '' : 's'} traído${cambios.length === 1 ? '' : 's'} del Sheets` : ''}`);
  } catch (err) {
    console.error('[sheets sync]', err);
    toast('Error al sincronizar: ' + err.message);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = btnHtml; }
  }
}

/* ── Contactos Apertura (correo diario de noticias de mercados) ──
   Lista aparte de los LPs. Copiar correos → pegar en CCO del cliente de
   correo; Redactar → abre el correo con CCO y asunto ya puestos. */
let aperturaContacts = null;

async function aperturaOpen() {
  document.getElementById('campAperturaModal').classList.add('show');
  if (!aperturaContacts) await aperturaLoad();
  else aperturaRender();
}
function aperturaClose() { document.getElementById('campAperturaModal').classList.remove('show'); }

async function aperturaLoad() {
  const list = document.getElementById('aperturaList');
  list.innerHTML = '<div class="db-loading"><i class="fa-solid fa-spinner fa-spin"></i> Cargando…</div>';
  const { data, error } = await sb.from('apertura_contacts').select('email, nombre').order('email');
  if (error) { list.innerHTML = `<div class="camp-empty-mini">Error: ${escapeHtml(error.message)}</div>`; return; }
  aperturaContacts = data || [];
  aperturaRender();
}

function aperturaRender() {
  const list = document.getElementById('aperturaList');
  const count = document.getElementById('aperturaCount');
  if (count) count.textContent = `${aperturaContacts.length} contacto${aperturaContacts.length === 1 ? '' : 's'}`;
  if (!aperturaContacts.length) {
    list.innerHTML = `<div class="camp-empty-mini"><i class="fa-solid fa-envelope-open"></i>
      <p>Sin contactos aún. Pega abajo los correos (vale separarlos por comas, punto y coma o saltos de línea).</p></div>`;
    return;
  }
  list.innerHTML = aperturaContacts.map(c => `<div class="apertura-row">
    <span class="apertura-mail">${escapeHtml(c.email)}</span>
    ${c.nombre ? `<span class="apertura-nom">${escapeHtml(c.nombre)}</span>` : ''}
    <button class="camp-row-act camp-row-del" title="Quitar de la lista" onclick="aperturaRemove('${c.email}')"><i class="fa-solid fa-xmark"></i></button>
  </div>`).join('');
}

async function aperturaAdd() {
  const inp = document.getElementById('aperturaInput');
  const raw = inp.value.trim();
  if (!raw) return;
  // Acepta uno o muchos: separados por coma, punto y coma, espacios o renglones
  const emails = [...new Set(raw.split(/[\s,;<>"]+/).map(s => s.trim().toLowerCase()).filter(s => s.includes('@') && s.includes('.')))];
  if (!emails.length) { toast('No encontré correos válidos en el texto'); return; }
  const { error } = await sb.from('apertura_contacts').upsert(emails.map(e => ({ email: e })), { onConflict: 'email' });
  if (error) { toast('Error al guardar: ' + error.message); return; }
  inp.value = '';
  await aperturaLoad();
  toast(`${emails.length} contacto${emails.length === 1 ? '' : 's'} en la lista`);
}

async function aperturaRemove(email) {
  const { error } = await sb.from('apertura_contacts').delete().eq('email', email);
  if (error) { toast('Error al borrar: ' + error.message); return; }
  aperturaContacts = aperturaContacts.filter(c => c.email !== email);
  aperturaRender();
}

function aperturaCopy() {
  if (!aperturaContacts?.length) { toast('No hay contactos'); return; }
  const s = aperturaContacts.map(c => c.email).join('; ');
  navigator.clipboard?.writeText(s)
    .then(() => toast('Correos copiados — pégalos en CCO'))
    .catch(() => toast('No se pudo copiar'));
}

function aperturaCompose() {
  if (!aperturaContacts?.length) { toast('No hay contactos'); return; }
  const hoy = new Date();
  const fecha = `${hoy.getDate()} de ${MESES_ES[hoy.getMonth()].toLowerCase()} de ${hoy.getFullYear()}`;
  // CCO para no exponer la lista entre destinatarios
  const bcc = aperturaContacts.map(c => c.email).join(',');
  window.location.href = `mailto:?bcc=${encodeURIComponent(bcc)}&subject=${encodeURIComponent('Apertura de Mercados — ' + fecha)}`;
}

/* ── Añadir / Editar contacto (mini-modal, modo dual) ── */
function campAddContactOpen() {
  campEditingEmail = null;
  ['campCNombre', 'campCFull', 'campCEmail', 'campCResp', 'campCComent'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  const em = document.getElementById('campCEmail'); em.disabled = false;
  document.getElementById('campCEmailHint').style.display = 'none';
  document.getElementById('campCTitle').innerHTML = '<i class="fa-solid fa-user-plus"></i> Añadir contacto';
  document.getElementById('campCSaveBtn').innerHTML = '<i class="fa-solid fa-check"></i> Guardar contacto';
  const msg = document.getElementById('campCMsg'); msg.textContent = ''; msg.className = 'camp-modal-msg';
  document.getElementById('campContactModal').classList.add('show');
  setTimeout(() => document.getElementById('campCNombre').focus(), 60);
}

function campEditContactOpen(email) {
  const c = campContacts.find(x => x.email === email);
  if (!c) return;
  campEditingEmail = email;
  document.getElementById('campCNombre').value = c.nombre || '';
  document.getElementById('campCFull').value   = c.nombre_completo || '';
  const em = document.getElementById('campCEmail'); em.value = c.email; em.disabled = true;
  document.getElementById('campCEmailHint').style.display = '';
  document.getElementById('campCResp').value   = c.responsable || '';
  document.getElementById('campCComent').value = c.comentarios || '';
  document.getElementById('campCTitle').innerHTML = '<i class="fa-solid fa-user-pen"></i> Editar contacto';
  document.getElementById('campCSaveBtn').innerHTML = '<i class="fa-solid fa-check"></i> Guardar cambios';
  const msg = document.getElementById('campCMsg'); msg.textContent = ''; msg.className = 'camp-modal-msg';
  document.getElementById('campContactModal').classList.add('show');
  setTimeout(() => document.getElementById('campCNombre').focus(), 60);
}

function campAddContactClose() { document.getElementById('campContactModal').classList.remove('show'); campEditingEmail = null; }

async function campAddContactSave() {
  const nombre = document.getElementById('campCNombre').value.trim();
  const full   = document.getElementById('campCFull').value.trim();
  const email  = document.getElementById('campCEmail').value.trim().toLowerCase();
  const resp   = document.getElementById('campCResp').value.trim();
  const coment = document.getElementById('campCComent').value.trim();
  const msg    = document.getElementById('campCMsg');
  const fail = (t) => { msg.textContent = t; msg.className = 'camp-modal-msg err'; };
  if (!nombre) return fail('El nombre es obligatorio.');

  if (campEditingEmail) {
    // ── EDITAR: el email es la llave del histórico, no se cambia aquí ──
    const { error } = await sb.from('lp_contacts').update({
      nombre, nombre_completo: full || nombre, responsable: resp || null, comentarios: coment || null,
    }).eq('email', campEditingEmail);
    if (error) return fail('Error al guardar: ' + error.message);
    toast(`Contacto actualizado: ${nombre}`);
  } else {
    // ── AÑADIR ──
    if (!email) return fail('Nombre y email son obligatorios.');
    if (!email.includes('@')) return fail('El email no parece válido.');
    const dup = campContacts.find(c => c.email === email);
    if (dup) return fail(`Ya existe: ${dup.nombre_completo || dup.nombre || email}.`);
    const { error } = await sb.from('lp_contacts').insert({
      email, nombre, nombre_completo: full || nombre, responsable: resp || null, comentarios: coment || null,
    });
    if (error) return fail('Error al guardar: ' + error.message);
    toast(`Contacto añadido: ${nombre}`);
  }
  campAddContactClose();
  campaignsLoaded = false;
  await loadCampaigns();
}

/* ═══════════════════════════════════════════
   TABLA DE CONTACTOS (no-admin) — vía /api/contacts (service role server-side)
   Ven todos; añaden con responsable = ellos mismos; editan/borran solo los suyos.
═══════════════════════════════════════════ */
let ctblContacts = [], ctblMe = '', ctblMineOnly = false, ctblEditEmail = null, ctblLoaded = false;

async function ctblApi(body) {
  const r = await authedFetch('/api/contacts', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
  return d;
}

// ¿Este contacto es de los que el usuario logueado es responsable?
function ctblIsMine(c) {
  const meKey = campRespKey(ctblMe);
  return !!meKey && campRespPeople(c.responsable).map(campRespKey).includes(meKey);
}

async function loadContactsTabla(force) {
  const list = document.getElementById('ctblList');
  if (ctblLoaded && !force) { renderContactsTabla(); return; }
  if (list) list.innerHTML = '<div class="db-loading"><i class="fa-solid fa-spinner fa-spin"></i> Cargando contactos…</div>';
  try {
    const d = await ctblApi({ action: 'list' });
    ctblContacts = d.contacts || [];
    ctblMe = d.me || currentProfile?.full_name || '';
    ctblLoaded = true;
    renderContactsTabla();
  } catch (err) {
    if (list) list.innerHTML = `<div class="db-loading">Error al cargar: ${escapeHtml(err.message)}</div>`;
  }
}

function renderContactsTabla() {
  const list = document.getElementById('ctblList');
  if (!list) return;
  const q = (document.getElementById('ctblSearch')?.value || '').trim().toLowerCase();
  let rows = ctblContacts.slice().sort((a, b) =>
    (a.nombre_completo || a.email).localeCompare(b.nombre_completo || b.email, 'es'));
  if (ctblMineOnly) rows = rows.filter(ctblIsMine);
  if (q) rows = rows.filter(c =>
    fuzzyMatch(q, c.nombre_completo || c.nombre || '') ||
    (c.email || '').toLowerCase().includes(q) ||
    fuzzyMatch(q, c.responsable || ''));

  document.getElementById('ctblMineChip')?.classList.toggle('on', ctblMineOnly);
  document.getElementById('ctblCount').textContent =
    `${rows.length} contacto${rows.length === 1 ? '' : 's'}${ctblMineOnly ? ' · míos' : ''}`;

  if (!rows.length) {
    list.innerHTML = `<div class="camp-empty"><i class="fa-solid fa-address-book"></i><p>${ctblContacts.length ? 'Sin resultados para este filtro.' : 'Aún no hay contactos. Añade el primero.'}</p></div>`;
    return;
  }

  // Calendario global de campañas (meses con datos) para medir rachas continuas
  const allPeriods = [...new Set(ctblContacts.flatMap(c => (c.hist || []).map(h => periodoKey(h.periodo))))].sort();

  const body = rows.map(c => {
    const mine = ctblIsMine(c);
    const resp = c.responsable ? escapeHtml(c.responsable) : '<span style="color:var(--ink-soft,#aab)">—</span>';
    const em = encodeURIComponent(c.email);
    // Interacción: racha de meses seguidos abriendo (desde el mes más reciente hacia atrás) + total
    const nivelBy = {};
    (c.hist || []).forEach(h => { nivelBy[periodoKey(h.periodo)] = h.nivel; });
    const vistos = (c.hist || []).filter(h => h.nivel >= 1).length;
    let streak = 0;
    for (let i = allPeriods.length - 1; i >= 0; i--) { if ((nivelBy[allPeriods[i]] || 0) >= 1) streak++; else break; }
    const inter = streak > 0
      ? `<span class="ctbl-streak" title="${streak} mes${streak === 1 ? '' : 'es'} seguidos abriendo">⚡ ${streak}</span>` +
        (vistos > streak ? ` <span class="ctbl-vistos">· ${vistos} en total</span>` : '')
      : (vistos > 0 ? `<span class="ctbl-vistos">${vistos} mes${vistos === 1 ? '' : 'es'}</span>` : '<span class="ctbl-vistos">—</span>');
    return `<tr class="${c.cancelado ? 'ctbl-row-cancel' : ''}">
      <td><div class="ctbl-nm ctbl-clickable" onclick="ctblOpenDetail('${em}')" title="Ver qué meses vio y qué pasó">${escapeHtml(c.nombre_completo || c.nombre || '—')}</div></td>
      <td class="ctbl-em">${escapeHtml(c.email)}</td>
      <td class="ctbl-inter">${inter}</td>
      <td class="ctbl-resp">${mine ? `<span class="ctbl-resp-mine">${resp}</span>` : resp}</td>
      <td class="ctbl-acts">${mine ? `
        <button class="ctbl-act" title="Editar nombre" onclick="ctblEditOpen('${em}')"><i class="fa-solid fa-pen"></i></button>
        <button class="ctbl-act del" title="Borrar contacto" onclick="ctblDelete('${em}')"><i class="fa-solid fa-xmark"></i></button>` : ''}</td>
    </tr>`;
  }).join('');

  list.innerHTML = `<div class="db-list-wrap"><table class="ctbl-table">
    <thead><tr><th>Nombre</th><th>Email</th><th>Interacción</th><th>Responsable</th><th></th></tr></thead>
    <tbody>${body}</tbody></table></div>`;
}

// Detalle de interacción de un contacto (reusa el modal/render del admin)
function ctblOpenDetail(emailEnc) {
  const email = decodeURIComponent(emailEnc);
  const c = ctblContacts.find(x => x.email === email);
  if (!c) return;
  const hist = (c.hist || [])
    .map(h => ({ periodo: h.periodo, opened: h.opened, clicked: h.clicked, replied: h.replied, nivel: h.nivel }))
    .sort((a, b) => String(a.periodo).localeCompare(String(b.periodo)));
  campLpRender(c.nombre_completo || c.nombre || email, hist);
}

function ctblToggleMine() { ctblMineOnly = !ctblMineOnly; renderContactsTabla(); }

function ctblAddOpen() {
  ctblEditEmail = null;
  document.getElementById('ctblTitle').innerHTML = '<i class="fa-solid fa-user-plus"></i> Añadir contacto';
  document.getElementById('ctblFull').value = '';
  const em = document.getElementById('ctblEmail'); em.value = ''; em.disabled = false;
  document.getElementById('ctblEmailHint').style.display = 'none';
  document.getElementById('ctblRespNote').innerHTML = `Responsable: <b>${escapeHtml(ctblMe || '—')}</b> (tú)`;
  document.getElementById('ctblMsg').textContent = '';
  document.getElementById('ctblModal').classList.add('show');
  setTimeout(() => document.getElementById('ctblFull').focus(), 60);
}

function ctblEditOpen(emailEnc) {
  const email = decodeURIComponent(emailEnc);
  const c = ctblContacts.find(x => x.email === email);
  if (!c) return;
  ctblEditEmail = email;
  document.getElementById('ctblTitle').innerHTML = '<i class="fa-solid fa-pen"></i> Editar contacto';
  document.getElementById('ctblFull').value = c.nombre_completo || c.nombre || '';
  const em = document.getElementById('ctblEmail'); em.value = c.email; em.disabled = true;
  document.getElementById('ctblEmailHint').style.display = '';
  document.getElementById('ctblRespNote').innerHTML = `Responsable: <b>${escapeHtml(c.responsable || '—')}</b>`;
  document.getElementById('ctblMsg').textContent = '';
  document.getElementById('ctblModal').classList.add('show');
  setTimeout(() => document.getElementById('ctblFull').focus(), 60);
}

function ctblClose() { document.getElementById('ctblModal').classList.remove('show'); ctblEditEmail = null; }

async function ctblSave() {
  const full = document.getElementById('ctblFull').value.trim();
  const email = document.getElementById('ctblEmail').value.trim().toLowerCase();
  const msg = document.getElementById('ctblMsg');
  const fail = (t) => { msg.textContent = t; msg.className = 'camp-modal-msg err'; };
  if (!full) return fail('El nombre completo es obligatorio.');
  const btn = document.getElementById('ctblSaveBtn'); btn.disabled = true;
  try {
    if (ctblEditEmail) {
      await ctblApi({ action: 'update', email: ctblEditEmail, nombre_completo: full });
      toast('Contacto actualizado');
    } else {
      if (!email || !email.includes('@')) { btn.disabled = false; return fail('El email no parece válido.'); }
      await ctblApi({ action: 'add', email, nombre_completo: full });
      toast('Contacto añadido');
    }
    ctblClose();
    await loadContactsTabla(true);
  } catch (err) {
    fail(err.message);
  } finally {
    btn.disabled = false;
  }
}

async function ctblDelete(emailEnc) {
  const email = decodeURIComponent(emailEnc);
  const c = ctblContacts.find(x => x.email === email);
  if (!c) return;
  if (!confirm(`¿Borrar a ${c.nombre_completo || c.nombre || email}?\nSe elimina el contacto y su historial de campañas.`)) return;
  try {
    await ctblApi({ action: 'delete', email });
    toast('Contacto borrado');
    await loadContactsTabla(true);
  } catch (err) {
    toast('Error: ' + err.message);
  }
}

/* ── Exportar contactos para Yesware (email + nombre, sin apellido) ──
   Excluye CANCELADOS: si van en la lista de envío, les llega el correo otra
   vez y nos marcan spam. (Siguen en el Excel de seguimiento, no aquí.) ── */
function campExportYesware() {
  if (!campContacts.length) { toast('No hay contactos para exportar'); return; }
  const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const activos = campContacts.filter(c => !c.cancelado);
  const excluidos = campContacts.length - activos.length;
  const list = activos.slice().sort((a, b) => (a.nombre || a.email).localeCompare(b.nombre || b.email, 'es'));
  const hoy = new Date().toISOString().slice(0, 10);
  const toCsv = (rows) => '﻿' + ['email,Nombre', ...rows.map(c => esc(c.email) + ',' + esc(c.nombre || ''))].join('\r\n');

  // Lotes: para subirlos a Yesware espaciados (~1/hora) y no disparar el
  // antispam de Microsoft (límite 30 correos/minuto por buzón).
  const nLotes = Math.max(1, +(document.getElementById('campExportLotes')?.value || 1));
  if (nLotes === 1) {
    downloadBlob(new Blob([toCsv(list)], { type: 'text/csv;charset=utf-8;' }), `yesware_contactos_${hoy}.csv`);
  } else {
    const tam = Math.ceil(list.length / nLotes);
    for (let i = 0; i < nLotes; i++) {
      const chunk = list.slice(i * tam, (i + 1) * tam);
      if (!chunk.length) break;
      // Pequeño escalonamiento: el navegador bloquea descargas simultáneas
      setTimeout(() => downloadBlob(
        new Blob([toCsv(chunk)], { type: 'text/csv;charset=utf-8;' }),
        `yesware_contactos_${hoy}_lote${i + 1}de${nLotes}.csv`), i * 400);
    }
  }
  toast(`Exportados ${list.length} contactos${nLotes > 1 ? ` en ${nLotes} lotes` : ''}${excluidos ? ` · ${excluidos} cancelado${excluidos === 1 ? '' : 's'} excluido${excluidos === 1 ? '' : 's'}` : ''}`);
}

/* ── Borrar los datos de un mes (el seleccionado en "Mes del reporte") ── */
// Borra un mes específico (usado por la × del encabezado de cada mes)
async function campDeleteMonthKey(monthKey) {
  const periodo = monthKey + '-01';
  const n = campEngagement.filter(e => periodoKey(e.periodo) === monthKey).length;
  if (!n) { toast(`No hay datos cargados para ${periodoLabel(periodo)}`); return; }
  if (!confirm(`¿Borrar los ${n} registros de ${periodoLabel(periodo)}?\nEsta acción no se puede deshacer (los contactos NO se borran, solo el engagement de ese mes).`)) return;
  const { error } = await sb.from('campaign_engagement').delete().eq('periodo', periodo);
  if (error) { toast('Error al borrar: ' + error.message); return; }
  toast(`Borrado ${periodoLabel(periodo)} — ${n} registros`);
  campaignsLoaded = false;
  await loadCampaigns();
}

// Botón "Borrar mes": borra el mes elegido en el selector "Mes del reporte"
async function campDeleteMonth() {
  const month = document.getElementById('campMonth').value;
  if (!month) { toast('Elige primero el mes a borrar en "Mes del reporte"'); return; }
  await campDeleteMonthKey(month);
}

/* ── Borrar un contacto (ej. respondió "CANCELAR") — elimina LP + su historial ── */
async function campDeleteContact(email) {
  const c = campContacts.find(x => x.email === email);
  if (!c) return;
  if (!confirm(`¿Borrar a ${c.nombre_completo || c.nombre || email} de la lista de LPs?\nSe elimina el contacto y TODO su historial de campañas. Útil cuando responden "CANCELAR".`)) return;
  const { error: e1 } = await sb.from('campaign_engagement').delete().eq('email', email);
  if (e1) { toast('Error al borrar historial: ' + e1.message); return; }
  const { error: e2 } = await sb.from('lp_contacts').delete().eq('email', email);
  if (e2) { toast('Error al borrar contacto: ' + e2.message); return; }
  toast(`Contacto borrado: ${c.nombre || email}`);
  campaignsLoaded = false;
  await loadCampaigns();
}

/* ── Marcar/desmarcar "CANCELÓ" — pinta la fila de rojo y lo anota ── */
async function campToggleCancel(email) {
  const c = campContacts.find(x => x.email === email);
  if (!c) return;
  const nuevo = !c.cancelado;
  let nota = (c.comentarios || '').replace(/\s*·?\s*CANCELÓ/g, '').trim();  // quita marca previa
  if (nuevo) nota = nota ? `${nota} · CANCELÓ` : 'CANCELÓ';
  const { error } = await sb.from('lp_contacts').update({
    cancelado: nuevo,
    cancelado_at: nuevo ? new Date().toISOString() : null,
    comentarios: nota || null,
  }).eq('email', email);
  if (error) { toast('Error: ' + error.message); return; }
  toast(nuevo ? `${c.nombre || email} marcado como cancelado` : `${c.nombre || email} reactivado`);
  campaignsLoaded = false;
  await loadCampaigns();
}

/* ── Generador de plantilla del correo ── */
const CAMP_TPL = `<div><br /></div>
<div><br /></div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" bgcolor="#f0f1f5">
<tbody>
<tr>
<td style="padding: 20px 0;" align="center">
<table style="max-width: 600px; background: #ffffff; color: #333333; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 5px rgba(0,0,0,0.05); margin: 0 auto;" role="presentation" width="100%" cellspacing="0" cellpadding="0">
<tbody>
<tr>
<td style="padding: 40px 30px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0">
<tbody>
<tr>
<td style="padding-bottom: 20px; border-bottom: 1px solid #eeeeee;" align="center"><a href="http://www.cretumpartners.com" target="_blank" rel="noopener"> <img style="display: block; border: 0; max-width: 180px; height: auto;" src="https://images.ywcontent.com/c9b31bb447702d0be2d91c3d3396d47f1fbdb90f/7c76c59e-2aa0-481d-81e6-704ce3e6cae3" alt="Cretum Partners" width="180" /> </a></td>
</tr>
<tr>
<td style="padding-top: 25px;" align="center">
<h1 style="margin: 0; font-family: 'Georgia', serif; font-size: 24px; color: #17436b; font-weight: normal;">Informe Mensual: <strong>{{MES_ANIO}}</strong></h1>
</td>
</tr>
</tbody>
</table>
<table role="presentation" width="100%">
<tbody>
<tr>
<td style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; font-size: 16px; line-height: 1.6; color: #555555; padding-top: 20px;">
<p style="margin: 0 0 15px 0;">Hola {!Nombre},</p>
<p style="margin: 0 0 20px 0;">Nos complace compartir con usted el desempeño mensual del fondo GVV de <strong>Cretum Capital Partners, LP</strong>.</p>
</td>
</tr>
</tbody>
</table>
<table style="background-color: #f8f9fa; border-radius: 6px; border: 1px solid #e9ecef;" role="presentation" width="100%">
<tbody>
<tr>
<td style="padding: 20px; border-right: 1px solid #e9ecef;" align="center" width="50%">
<p style="font-family: Helvetica, Arial, sans-serif; font-size: 12px; color: #777; text-transform: uppercase; margin: 0 0 5px 0; letter-spacing: 1px;">{{MES_UPPER}}</p>
<p style="font-family: Georgia, serif; font-size: 24px; color: #17436b; font-weight: bold; margin: 0;"><span style="color: {{MENSUAL_COLOR}};">{{MENSUAL}}</span></p>
</td>
<td style="padding: 20px;" align="center" width="50%">
<p style="font-family: Helvetica, Arial, sans-serif; font-size: 12px; color: #777; text-transform: uppercase; margin: 0 0 5px 0; letter-spacing: 1px;">Acumulado {{ANIO}}</p>
<p style="font-family: Georgia, serif; font-size: 24px; color: #28a745; font-weight: bold; margin: 0;"><span style="color: {{ACUM_COLOR}};">{{ACUM}}</span></p>
</td>
</tr>
</tbody>
</table>
<table role="presentation" width="100%">
<tbody>
<tr>
<td style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; font-size: 16px; line-height: 1.6; color: #555555; padding-top: 25px;">
<p style="margin: 0 0 15px 0;">En este informe encontrará el desglose detallado de nuestra estrategia:</p>
<ul style="margin: 0 0 25px 0; padding-left: 20px; color: #333;">
<li style="margin-bottom: 8px;">Análisis del mercado para los próximos meses.</li>
<li style="margin-bottom: 8px;">Factores clave del desempeño anual.</li>
<li style="margin-bottom: 8px;">Sectores estratégicos de interés.</li>
</ul>
<p style="margin: 0 0 25px 0;">Para cualquier consulta o para agendar una reunión personal sobre el fondo, contáctenos directamente.</p>
</td>
</tr>
</tbody>
</table>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0">
<tbody>
<tr>
<td align="center">
<table role="presentation" cellspacing="0" cellpadding="0">
<tbody>
<tr>
<td style="border-radius: 50px;" align="center" bgcolor="#17436b"><a style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; font-size: 16px; color: #ffffff; text-decoration: none; font-weight: bold; display: inline-block; padding: 14px 40px; border: 1px solid #17436b; border-radius: 50px;" href="{{LINK}}" target="_blank" rel="noopener"> Ver Informe Completo → </a></td>
</tr>
</tbody>
</table>
</td>
</tr>
</tbody>
</table>
<table role="presentation" width="100%">
<tbody>
<tr>
<td height="40"><br /></td>
</tr>
</tbody>
</table>
<table style="border-top: 1px solid #eeeeee; padding-top: 20px;" role="presentation" width="100%">
<tbody>
<tr>
<td style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.5; color: #777777;">
<p style="margin: 0 0 5px 0; color: #333;"><strong>Alejandro Creixell</strong></p>
<p style="margin: 0 0 15px 0;">Chief Investment Officer | Cretum Partners</p>
<p style="margin: 0 0 5px 0; font-size: 12px;"><strong>Estructura del Fondo</strong></p>
<p style="margin: 0 0 20px 0; font-size: 12px;">Admin: NAV Consulting | Custodia: Pershing / BNY Mellon</p>
<p style="font-size: 12px; margin: 0;">1015 Prol Paseo de la Reforma Av.<br />Punta Santa Fe, Tower A 22nd Floor<br />Ciudad de México, México</p>
<p style="margin-top: 5px;"><a style="color: #17436b; text-decoration: none; font-size: 12px;" href="https://www.cretumpartners.com/">www.cretumpartners.com</a></p>
</td>
</tr>
</tbody>
</table>
</td>
</tr>
</tbody>
</table>
<table style="max-width: 600px; margin: 0 auto;" role="presentation" width="100%" cellspacing="0" cellpadding="0">
<tbody>
<tr>
<td style="padding: 20px; font-family: Helvetica, Arial, sans-serif; font-size: 10px; line-height: 1.4; color: #999999; text-align: center;">
<p style="margin: 0 0 10px 0;">*Retorno mensual sujeto a verificación final por NAV Consulting (SSAE 18).</p>
<p style="margin: 0;">Para cancelar futuras comunicaciones, responda a este correo con la palabra "Cancelar".<br />© {{ANIO}} Cretum Partners.</p>
</td>
</tr>
</tbody>
</table>
</td>
</tr>
</tbody>
</table>`;

function campTemplateOpen() {
  const sel = document.getElementById('campTplMes');
  if (!sel.options.length) {
    sel.innerHTML = MESES_ES.map((m, i) => `<option value="${i}">${m}</option>`).join('');
  }
  const p = campCurrentParams;
  if (p && p.mes != null) {
    // Pre-llena con la última campaña publicada (no se pierden los números)
    sel.value = String(p.mes);
    document.getElementById('campTplAnio').value = p.anio || String(new Date().getFullYear());
    document.getElementById('campTplMensual').value = p.mensual || '';
    document.getElementById('campTplAcum').value = p.acum || '';
    document.getElementById('campTplLink').value = p.link || '';
  } else {
    // La campaña reporta el mes ANTERIOR (se envía la primera semana del mes siguiente)
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1);
    sel.value = String(d.getMonth());
    document.getElementById('campTplAnio').value = String(d.getFullYear());
  }
  document.getElementById('campTplModal').classList.add('show');
  campTemplateRender();
}
// Cerrar NO guarda: solo Copiar HTML / Descargar publican la Campaña Actual
// (antes cerrar sobreescribía la campaña publicada con campos vacíos).
function campTemplateClose() { document.getElementById('campTplModal').classList.remove('show'); }

// Color por signo: verde si + , rojo si − , azul si vacío/0
function campPctColor(v) {
  const t = String(v).trim();
  if (!t) return '#17436b';
  const num = parseFloat(t.replace(/[%+\s]/g, '').replace(',', '.'));
  if (!Number.isFinite(num)) return '#17436b';
  return num < 0 ? '#c0392b' : num > 0 ? '#28a745' : '#17436b';
}
// Formatea "+7.27" → "+7.27%"; vacío → "" (deja el espacio en blanco)
function campPctFmt(v) {
  const t = String(v).trim();
  if (!t) return '';
  return /%\s*$/.test(t) ? t : t + '%';
}
function campTemplateHtml() {
  const mes  = MESES_ES[+document.getElementById('campTplMes').value] || '';
  const anio = document.getElementById('campTplAnio').value.trim();
  const mensual = document.getElementById('campTplMensual').value;
  const acum    = document.getElementById('campTplAcum').value;
  const link    = document.getElementById('campTplLink').value.trim() || '#';
  const map = {
    '{{MES_ANIO}}': `${mes} ${anio}`.trim(),
    '{{MES_UPPER}}': mes.toUpperCase(),
    '{{ANIO}}': anio,
    '{{MENSUAL_COLOR}}': campPctColor(mensual),
    '{{MENSUAL}}': campPctFmt(mensual),
    '{{ACUM_COLOR}}': campPctColor(acum),
    '{{ACUM}}': campPctFmt(acum),
    '{{LINK}}': link,
  };
  let out = CAMP_TPL;
  for (const [k, val] of Object.entries(map)) out = out.split(k).join(val);
  return out;
}
function campTemplateRender() {
  document.getElementById('campTplFrame').srcdoc =
    `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">${campTemplateHtml()}</body></html>`;
}
// Guarda la plantilla actual como "Campaña Actual" (lo que ven los no-admin)
async function campSaveCurrent() {
  if (currentProfile?.role !== 'admin') return;
  const mesIdx = +document.getElementById('campTplMes').value;
  const mes  = MESES_ES[mesIdx] || '';
  const anio = document.getElementById('campTplAnio').value.trim();
  const params = {
    mes: mesIdx,
    anio,
    mensual: document.getElementById('campTplMensual').value,
    acum: document.getElementById('campTplAcum').value,
    link: document.getElementById('campTplLink').value.trim(),
  };
  try {
    await sb.from('campaign_current').upsert(
      { id: 1, html: campTemplateHtml(), mes: `${mes} ${anio}`.trim(), params, updated_at: new Date().toISOString() },
      { onConflict: 'id' });
    campCurrentParams = params;
  } catch (e) { console.error('[campSaveCurrent]', e); }
}
function campTemplateCopy() {
  const html = campTemplateHtml();
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(html).then(() => toast('HTML copiado — guardado como Campaña Actual')).catch(() => toast('No se pudo copiar — usa Descargar'));
  } else {
    toast('No se pudo copiar — usa Descargar .html');
  }
  campSaveCurrent();
}
function campTemplateDownload() {
  const mes  = (MESES_ES[+document.getElementById('campTplMes').value] || 'campana').toLowerCase();
  const anio = document.getElementById('campTplAnio').value.trim();
  downloadBlob(new Blob([campTemplateHtml()], { type: 'text/html;charset=utf-8;' }), `campana_${mes}_${anio}.html`);
  campSaveCurrent();
}
