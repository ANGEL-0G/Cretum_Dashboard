/* ═══════════════════════════════════════════
   STATE
═══════════════════════════════════════════ */
let sb = null;                   // Supabase JS client
let currentUser = null;          // UUID de auth.users
let currentProfile = null;       // { full_name, initials, role }
let roleReal = null;             // rol REAL del usuario (el toggle "Ver como" muta currentProfile.role solo en memoria)
let USERS = {};                  // map UUID → { name, initials, role }
let state = { simple: [], progress: [], assigned: [], invites: [] };
let tkView = (() => { try { return localStorage.getItem('tkView') || 'kanban'; } catch { return 'kanban'; } })();
let tkScope = 'personal';
let tkType = 'simple';
let tkId = Date.now();
let notesData = [];              // blocs de notas personales (user_notes)
let notesLoaded = false;
const noteSaveTimers = {};       // debounce de guardado por bloc
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
    .select('id, full_name, initials, role, hidden');
  if (error) throw error;
  USERS = {};
  data.forEach(p => {
    // Escapamos aquí (en la fuente): USERS[x].name/initials se interpolan en
    // muchos innerHTML. Un usuario podría fijar su full_name a HTML/JS (XSS
    // almacenado que roba sesiones). USERS solo se lee dentro de plantillas,
    // nunca en textContent, así que escapar en un punto los cubre todos.
    USERS[p.id] = {
      name: escapeHtml(p.full_name),           // para interpolar en innerHTML
      nameRaw: p.full_name || '',              // para textContent (toast/confirm), sin entidades
      initials: escapeHtml(p.initials || (p.full_name || '?').slice(0, 2).toUpperCase()),
      role: p.role,
      // Cuentas de sistema/continuidad (p. ej. admin break-glass): se resuelve
      // su nombre si algo la referencia, pero NO aparece en listas de personas
      // (asignar tareas, vista de compañeros, pendientes).
      hidden: !!p.hidden,
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

  // pills de multi-asignación — incluye a uno mismo (primero, "(yo)") para auto-asignarse
  const wrap = document.getElementById('aAssignees');
  const meU = USERS[currentUser];
  const selfPill = meU ? `
      <button type="button" class="multi-pill" data-uid="${currentUser}" onclick="toggleAssignee(this)">
        <span class="multi-pill-av">${meU.initials}</span>
        <span class="multi-pill-name">${meU.name} (yo)</span>
      </button>` : '';
  wrap.innerHTML = selfPill + Object.entries(USERS)
    .filter(([k, v]) => k !== currentUser && !v.hidden)
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
  if (h < 6)  return t('Buenas noches');
  if (h < 12) return t('Buenos días');
  if (h < 19) return t('Buenas tardes');
  return t('Buenas noches');
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
  // Solo editores/admins guardan (el backend también lo exige). Usamos el rol
  // REAL (no el simulado por "Ver como") para no meter a un viewer en un bucle
  // de reintentos con error 403.
  if (roleReal && roleReal !== 'editor' && roleReal !== 'admin') return;
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
  window.__syncState = s;   // recordado para re-traducir al cambiar de idioma
  const dot = document.getElementById('syncDot');
  const lbl = document.getElementById('syncLabel');
  dot.className = 'sync-dot' + (s === 'saving' ? ' saving' : s === 'error' ? ' error' : '');
  lbl.textContent = s === 'loading' ? t('Cargando…') : s === 'saving' ? t('Guardando…') : s === 'error' ? t('Sin conexión') : t('Sincronizado');
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

// Fecha de creación (relativa y corta) para la mini label de las tareas.
// Solo informativa; las tareas viejas sin createdAt no muestran nada.
function fmtCreated(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(new Date()) - startOf(d)) / 86400000);
  if (days <= 0) return 'hoy';
  if (days === 1) return 'ayer';
  if (days < 7) return `hace ${days} d`;
  return d.toLocaleDateString('es-MX', { day: 'numeric', month: 'short' });
}
// Tooltip con la fecha/hora exacta de creación
const createdTitle = (iso) => iso ? `Creada el ${new Date(iso).toLocaleString('es-MX')}` : '';
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
  // ── Vista Notas (personal): oculta lo de tareas y muestra los blocs ──
  const isNotas = tkView === 'notas' && tkScope === 'personal';
  const np = document.getElementById('notesPanel');
  if (np) np.style.display = isNotas ? '' : 'none';
  if (isNotas) {
    ['tkStats', 'viewContainer', 'invitesEl'].forEach(id => { const e = document.getElementById(id); if (e) e.style.display = 'none'; });
    const ntb = document.getElementById('newTaskBtn'); if (ntb) ntb.style.display = 'none';
    const clrB = document.getElementById('tkClearBanner'); if (clrB) clrB.style.display = 'none';
    syncViewButtons();
    requestAnimationFrame(tkMoveViewSlider);
    refreshTodoBadge();
    if (!notesLoaded) loadNotes();
    return;
  }
  ['tkStats', 'viewContainer', 'invitesEl'].forEach(id => { const e = document.getElementById(id); if (e) e.style.display = ''; });

  // invites para el usuario actual
  const myInvites = state.invites.filter(iv => iv.to === currentUser);
  document.getElementById('invitesEl').innerHTML = myInvites.map(iv => {
    const isProg = typeof iv.total === 'number' && iv.total > 0;
    const progLbl = isProg ? ` · ${iv.total} ${escapeHtml(iv.unit || 'unidades')}` : '';
    return `
    <div class="tk-invite">
      <div class="tk-invite-info">
        <div class="tk-invite-from"><i class="fa-solid fa-user-plus"></i> ${USERS[iv.from]?.name || iv.from} te asignó una tarea${isProg ? ' con progreso' : ''}</div>
        <div class="tk-invite-name">${escapeHtml(iv.name)}</div>
        <div class="tk-invite-due">${iv.due ? 'Vence ' + fmtD(iv.due) + ' · ' : ''}${iv.prio} prioridad${progLbl}</div>
      </div>
      <button class="inv-accept" onclick="acceptInvite('${iv.id}')">Aceptar</button>
      <button class="inv-decline" onclick="declineInvite('${iv.id}')">Declinar</button>
    </div>`;
  }).join('');

  // Mantiene el pulso del módulo To Do (en el menú) en sync con las invitaciones.
  refreshTodoBadge();

  // stats (mis tareas)
  const mt = myTasks();
  const pend = mt.filter(t => !isDone(t)).length;
  const inprog = state.progress.filter(t => t.owner === currentUser && t.done > 0 && t.done < t.total).length;
  const done = mt.filter(t => isDone(t)).length;
  animateCounter('sPend',  pend);
  animateCounter('sProg',  inprog);
  animateCounter('sDone',  done);
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

  const clrB = document.getElementById('tkClearBanner');
  if (isEquipo) { if (clrB) clrB.style.display = 'none'; renderEquipo(); return; }
  if (isOtros)  { if (clrB) clrB.style.display = 'none'; renderOtros();  return; }

  maybeOfferClearCompleted();   // ofrece limpieza mensual de completadas

  syncViewButtons();
  const c = document.getElementById('viewContainer');
  if (tkView === 'lista')         c.innerHTML = buildLista();
  else if (tkView === 'kanban')   c.innerHTML = buildKanban();
  else if (tkView === 'proyectos') c.innerHTML = buildProyectos();
  else                            c.innerHTML = buildTimeline();

  // Si una tarea recién completada aterrizó en "Completadas" colapsado, pulsa
  // su contador para que el ojo vea a dónde fue (la fila entrante está oculta).
  if (tkToggleAnim) {
    if (tkToggleAnim.becameDone) {
      const body = document.querySelector('.tk-done-body');
      if (body && body.style.display === 'none') {
        const n = document.querySelector('.tk-done-toggle .tk-group-n');
        if (n) { n.classList.remove('tk-bump'); void n.offsetWidth; n.classList.add('tk-bump'); }
      }
    }
    tkToggleAnim = null;
  }
}

/* Orden de tareas activas: por fecha (vencidas/próximas primero), sin fecha al
   final; a igualdad de fecha, por prioridad (Alta → Media → Baja). */
function taskSort(a, b) {
  const rank = p => p === 'Alta' ? 0 : p === 'Media' ? 1 : 2;
  const ad = a.due || '9999-99-99', bd = b.due || '9999-99-99';
  if (ad !== bd) return ad < bd ? -1 : 1;
  return rank(a.prio) - rank(b.prio);
}

/* ── Render de UNA fila de tarea (compartido por Lista y Proyectos) ── */
function tkRow(t, i) {
  const done = isDone(t);
  const od = isOD(t.due) && !done;
  const delay = `style="animation-delay:${Math.min(i, 12) * 30}ms"`;
  const enter = (tkToggleAnim && tkToggleAnim.id === t.id) ? ' tk-entering' : '';
  if (t.kind === 'simple') return `
    <div class="li-wrap">
    <div class="list-item ${done ? 'done-item' : ''}${enter}" data-tid="${t.id}" data-kind="simple" ${delay}>
      <div class="li-chk ${done ? 'on' : ''}" onclick="toggle('${t.id}','simple')">✓</div>
      <div class="li-name">${escapeHtml(t.name)}</div>
      <div class="li-meta">
        ${t.createdAt ? `<span class="li-created" title="${createdTitle(t.createdAt)}"><i class="fa-regular fa-clock"></i> ${fmtCreated(t.createdAt)}</span>` : ''}
        ${t.due ? `<span class="li-due ${od ? 'od' : ''}">${fmtD(t.due)}</span>` : ''}
        <span class="li-prio ${prioC(t.prio)}">${t.prio}</span>
        ${t.collab ? '<span class="li-tag">Colaborativa</span>' : ''}
        ${done ? `<button class="sm-btn sm-red" onclick="toggle('${t.id}','simple')">Reabrir</button>` : ''}
      </div>
      ${!done ? `<button class="li-edit" onclick="openEditTask('${t.id}','simple')" title="Editar tarea"><i class="fa-solid fa-pen"></i></button>` : ''}
      <button class="li-del" onclick="del('${t.id}','simple')"><i class="fa-solid fa-xmark"></i></button>
    </div></div>`;
  const p = pct(t);
  return `
    <div class="li-wrap">
    <div class="list-item ${done ? 'done-item' : ''}${enter}" data-tid="${t.id}" data-kind="progress" ${delay}>
      <div class="li-chk ${done ? 'on' : ''}">✓</div>
      <div class="li-body" style="flex:1;min-width:0">
        <div class="li-name ${done ? 'struck' : ''}">${escapeHtml(t.name)}</div>
        <div class="li-prog">
          <div class="li-prog-bar"><div class="li-prog-fill" style="width:${p}%"></div></div>
          <span>${t.done}/${t.total} ${escapeHtml(t.unit)} · ${p}%</span>
        </div>
      </div>
      <div class="li-meta">
        ${t.createdAt ? `<span class="li-created" title="${createdTitle(t.createdAt)}"><i class="fa-regular fa-clock"></i> ${fmtCreated(t.createdAt)}</span>` : ''}
        ${t.due ? `<span class="li-due ${od ? 'od' : ''}">${fmtD(t.due)}</span>` : ''}
        <span class="li-prio ${prioC(t.prio)}">${t.prio}</span>
        ${t.collab ? '<span class="li-tag">Colaborativa</span>' : ''}
        ${done
          ? `<button class="sm-btn sm-red" onclick="toggle('${t.id}','progress')">Reabrir</button>`
          : `<span class="li-inc" style="display:flex;align-items:center;gap:4px">
              <input type="number" placeholder="" id="l-${t.id}"
                title="Positivo para sumar, negativo para corregir"
                style="width:74px;padding:5px 9px;border:1px solid var(--gray-200);border-radius:var(--r-sm);font-size:13px;text-align:center;outline:none"
                onkeydown="if(event.key==='Enter')addInc('${t.id}')">
              <button class="sm-btn sm-solid" onclick="addInc('${t.id}')">+</button>
              ${t.log.length ? `<button class="sm-btn sm-red" onclick="undoLog('${t.id}')" title="Deshacer última entrada">↩</button>` : ''}
            </span>`}
      </div>
      ${!done ? `<button class="li-edit" onclick="openEditTask('${t.id}','progress')" title="Editar tarea"><i class="fa-solid fa-pen"></i></button>` : ''}
      <button class="li-del" onclick="del('${t.id}','progress')"><i class="fa-solid fa-xmark"></i></button>
    </div></div>`;
}

/* ── Sección colapsable de "Completadas" (compartida por Lista y Proyectos) ── */
function tkCompletedSection(done) {
  if (!done.length) return '';
  return `<div class="tk-done-sec${tkDoneOpen ? ' open' : ''}">
    <div class="tk-done-head">
      <button class="tk-done-toggle" onclick="tkToggleDone(this)">
        <i class="fa-solid fa-chevron-right tk-done-chev"></i> Completadas <span class="tk-group-n">${done.length}</span>
      </button>
      <button class="tk-done-clear" onclick="clearCompleted()" title="Eliminar las completadas"><i class="fa-solid fa-broom"></i> Vaciar</button>
    </div>
    <div class="tk-done-body" style="display:${tkDoneOpen ? '' : 'none'}"><div class="tk-rows">${done.map(tkRow).join('')}</div></div>
  </div>`;
}

/* ── LISTA — activas agrupadas por horizonte temporal ── */
function buildLista() {
  const all = myTasks();
  if (!all.length) return '<div class="tk-empty"><i class="fa-regular fa-square-check"></i><p>Sin tareas. Crea la primera con <strong>Nueva tarea</strong>.</p></div>';
  const active = all.filter(t => !isDone(t)).sort(taskSort);
  const done = all.filter(isDone);

  const now = new Date(); now.setHours(0, 0, 0, 0);
  const toStr = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const todayStr = toStr(now);
  const wk = new Date(now); wk.setDate(wk.getDate() + 7); const wkStr = toStr(wk);
  const defs = [
    { label: 'Vencidas',    tone: 'od', test: t => t.due && t.due < todayStr },
    { label: 'Hoy',         tone: '',   test: t => t.due === todayStr },
    { label: 'Esta semana', tone: '',   test: t => t.due && t.due > todayStr && t.due <= wkStr },
    { label: 'Después',     tone: '',   test: t => t.due && t.due > wkStr },
    { label: 'Sin fecha',   tone: '',   test: t => !t.due },
  ];
  const groups = defs.map(g => ({ ...g, tasks: active.filter(g.test).sort(taskSort) })).filter(g => g.tasks.length);
  const showLabels = groups.length > 1;

  let html = '<div class="tk-list">';
  if (!active.length) {
    html += '<div class="tk-empty mini"><i class="fa-regular fa-circle-check"></i><p>¡Todo al día! No tienes tareas activas.</p></div>';
  } else {
    html += groups.map(g => `<div class="tk-group">
      ${showLabels ? `<div class="tk-group-label ${g.tone}">${g.label} <span class="tk-group-n">${g.tasks.length}</span></div>` : ''}
      <div class="tk-rows">${g.tasks.map(tkRow).join('')}</div>
    </div>`).join('');
  }
  html += tkCompletedSection(done);
  html += '</div>';
  return html;
}

/* ── PROYECTOS — activas agrupadas por proyecto (cada proyecto, sus tareas) ── */
function tkProject(t) { return (t.project || '').trim(); }
function buildProyectos() {
  const all = myTasks();
  if (!all.length) return '<div class="tk-empty"><i class="fa-regular fa-folder-open"></i><p>Sin tareas. Crea una y asígnale un <strong>proyecto</strong>.</p></div>';
  const active = all.filter(t => !isDone(t));
  const done = all.filter(isDone);

  const byProj = new Map();
  active.forEach(t => {
    const key = tkProject(t) || '__none__';
    if (!byProj.has(key)) byProj.set(key, []);
    byProj.get(key).push(t);
  });
  // Proyectos nombrados primero (alfabético), "Sin proyecto" al final
  const keys = [...byProj.keys()].sort((a, b) =>
    a === '__none__' ? 1 : b === '__none__' ? -1 : a.localeCompare(b, 'es'));

  let html = '<div class="tk-list">';
  if (!active.length) {
    html += '<div class="tk-empty mini"><i class="fa-regular fa-circle-check"></i><p>¡Todo al día! No tienes tareas activas.</p></div>';
  } else {
    html += keys.map(key => {
      const tasks = byProj.get(key).sort(taskSort);
      const isNone = key === '__none__';
      const label = isNone ? 'Sin proyecto' : key;
      const ico = isNone ? 'fa-folder' : 'fa-folder-open';
      return `<div class="tk-group">
        <div class="tk-group-label${isNone ? ' tk-proj-none' : ''}"><i class="fa-solid ${ico} tk-proj-ico"></i> ${escapeHtml(label)} <span class="tk-group-n">${tasks.length}</span></div>
        <div class="tk-rows">${tasks.map(tkRow).join('')}</div>
      </div>`;
    }).join('');
  }
  html += tkCompletedSection(done);
  html += '</div>';
  return html;
}

// Despliega/colapsa la sección de completadas
function tkToggleDone(btn) {
  const sec = btn.closest('.tk-done-sec');
  if (!sec) return;
  const body = sec.querySelector('.tk-done-body');
  const open = body.style.display === 'none';
  body.style.display = open ? '' : 'none';
  sec.classList.toggle('open', open);
  tkDoneOpen = open;   // recuerda el estado para que no se cierre al re-render
}

/* ── Vaciado de tareas completadas (limpieza) ── */
const _mine = t => !t.owner || t.owner === currentUser;
function countMyDone() {
  return state.simple.filter(t => _mine(t) && t.done).length
       + state.progress.filter(t => _mine(t) && t.done >= t.total).length;
}
function clearCompleted() {
  const n = countMyDone();
  if (!n) { toast('No hay tareas completadas para vaciar'); maybeOfferClearCompleted(); return; }
  if (!confirm(`¿Vaciar ${n} tarea${n === 1 ? '' : 's'} completada${n === 1 ? '' : 's'}? Esto las elimina y no se puede deshacer.`)) return;
  state.simple = state.simple.filter(t => !(_mine(t) && t.done));
  state.progress = state.progress.filter(t => !(_mine(t) && t.done >= t.total));
  try { localStorage.setItem('tkClearPromptAt', String(Date.now())); } catch {}
  scheduleSave();
  render();
  toast(`${n} completada${n === 1 ? '' : 's'} eliminada${n === 1 ? '' : 's'}`);
}
function snoozeClearPrompt() {
  try { localStorage.setItem('tkClearPromptAt', String(Date.now())); } catch {}
  const b = document.getElementById('tkClearBanner'); if (b) b.style.display = 'none';
}
// Una vez al mes, si hay varias completadas acumuladas, ofrece vaciarlas
function maybeOfferClearCompleted() {
  const banner = document.getElementById('tkClearBanner');
  if (!banner) return;
  const n = countMyDone();
  let last = 0; try { last = +(localStorage.getItem('tkClearPromptAt') || 0); } catch {}
  const overdue = !last || (Date.now() - last) > 30 * 24 * 60 * 60 * 1000;
  if (n >= 5 && overdue) {
    banner.innerHTML = `<div class="tk-clear-txt"><i class="fa-solid fa-broom"></i> Tienes <strong>${n}</strong> tareas completadas acumuladas. ¿Las vaciamos para mantener tu lista limpia?</div>
      <div class="tk-clear-acts">
        <button class="sm-btn sm-solid" onclick="clearCompleted()">Vaciar</button>
        <button class="sm-btn" onclick="snoozeClearPrompt()">Ahora no</button>
      </div>`;
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }
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
              <div class="kb-prog-label">${t.done}/${t.total} ${escapeHtml(t.unit)}</div>
              <div class="kb-prog"><div class="kb-prog-fill ${done ? 'complete' : ''}" style="width:${p}%"></div></div>` : ''}
            <div class="kb-card-name ${done ? 'struck' : ''}">${escapeHtml(t.name)}</div>
            <div class="kb-card-foot">
              ${t.createdAt ? `<span class="li-created" title="${createdTitle(t.createdAt)}"><i class="fa-regular fa-clock"></i> ${fmtCreated(t.createdAt)}</span>` : ''}
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
  const tasks = myTasks().filter(t => !isDone(t));   // la línea de tiempo es para lo que falta; las completadas se dejan de lado
  if (!tasks.length) return '<div class="tk-empty"><i class="fa-regular fa-circle-check"></i><p>Sin tareas pendientes. ¡Buen trabajo!</p></div>';
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
            <div class="tl-name ${done ? 'struck' : ''}">${escapeHtml(t.name)}</div>
            ${p !== null ? `
              <div style="margin-top:5px">
                <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--gray-400);margin-bottom:2px">
                  <span>${t.done}/${t.total} ${escapeHtml(t.unit)}</span><span>${p}%</span>
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
          <span class="team-prog-lbl">${task.done}/${task.total} ${escapeHtml(task.unit || '')}</span>
        </div>`;
    } else {
      badge = '<span class="team-status ts-ok"><i class="fa-solid fa-circle-play"></i> En progreso</span>';
    }

    return `
      <div class="team-item">
        <div class="team-av">${USERS[a.to]?.initials || a.to.slice(0,2).toUpperCase()}</div>
        <div style="flex:1;min-width:0">
          <div class="team-name">${escapeHtml(a.name)}</div>
          <div class="team-sub">→ ${USERS[a.to]?.name || a.to} · ${a.due ? fmtD(a.due) : 'Sin fecha'} · ${a.prio}${a.createdAt ? ` · <span class="li-created" title="${createdTitle(a.createdAt)}"><i class="fa-regular fa-clock"></i> creada ${fmtCreated(a.createdAt)}</span>` : ''}</div>
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
    .filter(([uid, u]) => uid !== currentUser && !u.hidden)
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
          const progLbl = isProg ? ` · ${t.done}/${t.total} ${escapeHtml(t.unit || 'unidades')}` : '';
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
              <div class="om-task-name">${escapeHtml(t.name)}${progLbl}</div>
              <div class="om-task-meta">
                ${t.createdAt ? `<span class="li-created" title="${createdTitle(t.createdAt)}"><i class="fa-regular fa-clock"></i> ${fmtCreated(t.createdAt)}</span>` : ''}
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
  try { localStorage.setItem('tkView', v); } catch {}
  syncViewButtons();
  tkMoveViewSlider();
  render();
}
function syncViewButtons() {
  const isNotas = tkView === 'notas';
  // El botón dice fijo "Tipo de vista"; la vista activa se marca dentro del menú.
  document.getElementById('viewPickBtn')?.classList.toggle('active', !isNotas);
  document.getElementById('notesViewBtn')?.classList.toggle('active', isNotas);
  document.querySelectorAll('.tk-view-opt').forEach(o =>
    o.classList.toggle('on', o.dataset.view === tkView));
}

// Desplegable de vistas
function toggleViewMenu(e) {
  if (e) e.stopPropagation();
  const m = document.getElementById('viewMenu');
  const open = !m.classList.contains('open');
  m.classList.toggle('open', open);
  document.getElementById('viewPickBtn')?.setAttribute('aria-expanded', open ? 'true' : 'false');
}
function closeViewMenu() {
  const m = document.getElementById('viewMenu');
  if (m) m.classList.remove('open');
  document.getElementById('viewPickBtn')?.setAttribute('aria-expanded', 'false');
}
function pickView(v) { closeViewMenu(); setView(v); }
document.addEventListener('click', (e) => {
  const p = document.querySelector('.tk-view-picker');
  if (p && !p.contains(e.target)) closeViewMenu();
});

/* ═══════════════════════════════════════════
   NOTAS PERSONALES (por blocs) — privadas por usuario (RLS en user_notes)
   El frontend lee/escribe directo con el cliente Supabase autenticado.
═══════════════════════════════════════════ */
async function loadNotes() {
  const grid = document.getElementById('notesGrid');
  if (grid && !notesData.length) grid.innerHTML = '<div class="notes-empty"><i class="fa-solid fa-spinner fa-spin"></i> Cargando…</div>';
  try {
    const { data, error } = await sb.from('user_notes')
      .select('id,title,content,position,updated_at')
      .order('position', { ascending: true }).order('created_at', { ascending: true });
    if (error) throw error;
    notesData = data || [];
    notesLoaded = true;
    renderNotes();
  } catch (err) {
    notesLoaded = false;
    if (grid) {
      const falta = /relation|does not exist|schema cache|not find the table/i.test(err.message || '');
      grid.innerHTML = `<div class="notes-empty">No se pudieron cargar las notas.${falta ? ' Falta correr la migración de BD (db/08_notes.sql).' : ''}</div>`;
    }
  }
}

function renderNotes() {
  const grid = document.getElementById('notesGrid');
  if (!grid) return;
  if (!notesData.length) {
    grid.innerHTML = '<div class="notes-empty">Aún no tienes notas. Crea tu primer bloc con “Nuevo bloc”.</div>';
    return;
  }
  grid.innerHTML = notesData.map(n => `
    <div class="note-block" data-id="${n.id}">
      <div class="note-head">
        <input class="note-title" value="${escapeHtml(n.title || '')}" placeholder="Título del bloc" maxlength="120"
               oninput="onNoteInput('${n.id}','title',this.value)">
        <button class="note-del" title="Eliminar bloc" aria-label="Eliminar bloc" onclick="deleteNote('${n.id}')"><i class="fa-solid fa-trash"></i></button>
      </div>
      <textarea class="note-body" placeholder="Escribe aquí tus notas…" oninput="onNoteInput('${n.id}','content',this.value)">${escapeHtml(n.content || '')}</textarea>
      <div class="note-foot"><span class="note-saved" data-id="${n.id}"></span></div>
    </div>`).join('');
}

function onNoteInput(id, field, value) {
  const n = notesData.find(x => String(x.id) === String(id));
  if (n) n[field] = value;
  const saved = document.querySelector('.note-saved[data-id="' + id + '"]');
  if (saved) saved.textContent = '';
  clearTimeout(noteSaveTimers[id]);
  noteSaveTimers[id] = setTimeout(() => saveNote(id), 600);
}

async function saveNote(id) {
  const n = notesData.find(x => String(x.id) === String(id));
  if (!n) return;
  const saved = document.querySelector('.note-saved[data-id="' + id + '"]');
  if (saved) saved.textContent = 'Guardando…';
  try {
    const { error } = await sb.from('user_notes')
      .update({ title: n.title, content: n.content, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) throw error;
    if (saved) { saved.textContent = 'Guardado'; setTimeout(() => { if (saved.textContent === 'Guardado') saved.textContent = ''; }, 1500); }
  } catch (err) {
    if (saved) saved.textContent = 'Error al guardar';
  }
}

async function addNoteBlock() {
  try {
    const { data: { session } } = await sb.auth.getSession();
    const uid = session?.user?.id;
    if (!uid) { toast('Sesión no válida'); return; }
    const { data, error } = await sb.from('user_notes')
      .insert({ user_id: uid, title: '', content: '', position: notesData.length })
      .select('id,title,content,position,updated_at').single();
    if (error) throw error;
    notesData.push(data);
    notesLoaded = true;
    renderNotes();
    const t = document.querySelector('.note-block[data-id="' + data.id + '"] .note-title');
    if (t) t.focus();
  } catch (err) {
    const falta = /relation|does not exist|schema cache|not find the table/i.test(err.message || '');
    toast('No se pudo crear la nota' + (falta ? ': falta la migración de BD' : ''));
  }
}

async function deleteNote(id) {
  if (!confirm('¿Borrar este bloc de notas? No se puede deshacer.')) return;
  try {
    const { error } = await sb.from('user_notes').delete().eq('id', id);
    if (error) throw error;
    notesData = notesData.filter(x => String(x.id) !== String(id));
    renderNotes();
    toast('Bloc borrado');
  } catch (err) { toast('No se pudo borrar'); }
}
function setScope(s) {
  tkScope = s;
  document.getElementById('togPersonal')?.classList.toggle('on', s === 'personal');
  document.getElementById('togEquipo')?.classList.toggle('on', s === 'equipo');
  document.getElementById('togOtros')?.classList.toggle('on', s === 'otros');
  tkMoveSlider();
  render();
  requestAnimationFrame(tkMoveViewSlider);   // el toggle de vista reaparece en "personal"
}

// Mueve una pill deslizante tras el botón activo (anchos variables → JS)
function tkSlide(toggleSel, sliderId, btnSel) {
  const wrap = document.querySelector(toggleSel);
  const slider = document.getElementById(sliderId);
  const active = wrap?.querySelector(btnSel + '.on');
  if (!wrap || !slider || !active || !active.offsetWidth) return;   // oculto/sin layout: se reintenta al mostrar
  slider.style.left = active.offsetLeft + 'px';
  slider.style.width = active.offsetWidth + 'px';
}
function tkMoveSlider() { tkSlide('.tk-toggle', 'tkSlider', '.tk-tog-btn'); }
function tkMoveViewSlider() { tkSlide('.tk-view-toggle', 'tkViewSlider', '.tk-view-btn'); }
function tkMoveSliders() { tkMoveSlider(); tkMoveViewSlider(); }
window.addEventListener('resize', () => { if (currentView === 'tasks') tkMoveSliders(); });
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
let tkToggleAnim = null;   // marca la tarea recién (re)abierta para animar su llegada
let tkDoneOpen = false;    // recuerda si la sección "Completadas" quedó desplegada (persiste entre renders)

function toggle(id, kind) {
  const applyToggle = () => {
    let becameDone = false;
    if (kind === 'simple') {
      const t = state.simple.find(x => x.id === id);
      if (t) { t.done = !t.done; becameDone = t.done; toast(t.done ? 'Tarea completada ✓' : 'Tarea reabierta'); }
    } else if (kind === 'progress') {
      const t = state.progress.find(x => x.id === id);
      if (t) {
        if (t.done >= t.total) { t.done = Math.max(0, t.total - 1); toast('Tarea reabierta'); }
        else { t.done = t.total; becameDone = true; toast('Tarea completada ✓'); }
      }
    }
    tkToggleAnim = { id, becameDone };   // render() la marca con animación de entrada
    scheduleSave();
    render();
  };

  // Anima la salida de la fila (se desvanece) antes de re-ubicarla; luego re-render
  const row = document.querySelector(`.list-item[data-tid="${(window.CSS && CSS.escape) ? CSS.escape(id) : id}"]`);
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (row && !reduce) {
    row.classList.add('tk-leaving');
    let fired = false;
    const go = () => { if (fired) return; fired = true; applyToggle(); };
    row.addEventListener('animationend', go, { once: true });
    setTimeout(go, 240);   // respaldo si animationend no dispara
  } else {
    applyToggle();
  }
}

async function deleteAssigned(id) {
  const a = state.assigned.find(x => x.id === id);
  if (!a) return;
  const targetName = USERS[a.to]?.nameRaw || a.to;   // va a showConfirm (textContent), sin escapar
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

/* ── Borrado por deslizamiento (móvil): quita sin confirmar, con "Deshacer" ── */
function swipeDelete(id, kind) {
  const list = kind === 'simple' ? state.simple : state.progress;
  const idx = list.findIndex(x => x.id === id);
  if (idx === -1) return;
  const [removed] = list.splice(idx, 1);   // muta el arreglo real de state
  scheduleSave(); render();
  showUndo('Tarea eliminada', () => {
    const l2 = kind === 'simple' ? state.simple : state.progress;
    l2.splice(Math.min(idx, l2.length), 0, removed);   // reinserta donde estaba
    scheduleSave(); render();
    toast('Tarea restaurada');
  });
}

/* ── Completar por deslizamiento (→): misma lógica que borrar — completa y
   ofrece "Deshacer" (la red de seguridad hace de confirmación). Si la tarea
   ya estaba completada, el gesto la reabre. ── */
function swipeComplete(id, kind) {
  const list = kind === 'simple' ? state.simple : state.progress;
  const t = list.find(x => x.id === id);
  if (!t) return;
  const wasDone = kind === 'simple' ? !!t.done : t.done >= t.total;
  if (wasDone) { toggle(id, kind); return; }   // reabrir: toast normal, sin deshacer
  const prev = t.done;                          // para poder deshacer (bool o número)
  t.done = kind === 'simple' ? true : t.total;
  tkToggleAnim = { id, becameDone: true };
  scheduleSave(); render();
  showUndo('Tarea completada ✓', () => {
    const l2 = kind === 'simple' ? state.simple : state.progress;
    const t2 = l2.find(x => x.id === id);
    if (t2) { t2.done = prev; scheduleSave(); render(); toast('Se deshizo'); }
  });
}

/* Snackbar "Deshacer" (se auto-oculta a los 5s). Reutiliza un único nodo. */
let _undoFn = null, _undoTimer = null;
function showUndo(msg, onUndo) {
  let bar = document.getElementById('undoBar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'undoBar';
    bar.innerHTML = '<span id="undoBarMsg"></span><button id="undoBarBtn" type="button">Deshacer</button>';
    document.body.appendChild(bar);
    bar.querySelector('#undoBarBtn').addEventListener('click', () => {
      clearTimeout(_undoTimer); bar.classList.remove('show');
      const fn = _undoFn; _undoFn = null;
      if (fn) fn();
    });
  }
  bar.querySelector('#undoBarMsg').textContent = msg;
  _undoFn = onUndo;
  bar.classList.add('show');
  clearTimeout(_undoTimer);
  _undoTimer = setTimeout(() => { bar.classList.remove('show'); _undoFn = null; }, 5000);
}

/* ── Gesto de deslizar en tareas (solo teléfono/touch) ──
   Derecha = completar (verde) · Izquierda = borrar con deshacer (rojo).
   Distingue swipe horizontal de scroll vertical; resorte de regreso si no
   alcanza el umbral; dismissal por distancia o velocidad. */
(function initTaskSwipe() {
  let el = null, wrap = null, id = null, kind = null;
  let x0 = 0, y0 = 0, t0 = 0, dx = 0, dragging = false, decided = false;
  const THRESH = 92;   // distancia para disparar la acción (más alto = menos sensible)
  // Táctil (no por ancho): funciona en cualquier teléfono/tablet aunque su
  // ancho CSS sea mayor a 480px.
  const isTouchUI = () => window.matchMedia('(pointer:coarse)').matches;

  function reset(animate) {
    if (el) { el.style.transition = animate ? 'transform .22s cubic-bezier(.23,1,.32,1)' : ''; el.style.transform = 'translateX(0)'; }
    if (wrap) wrap.classList.remove('sw-right', 'sw-left');
    el = wrap = id = kind = null; dragging = decided = false;
  }
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' || !isTouchUI()) return;
    const li = e.target.closest('.list-item');
    if (!li || e.target.closest('input,button,select,a,.li-chk,.li-del,.li-inc')) return;
    el = li; wrap = li.closest('.li-wrap'); if (!wrap) { el = null; return; }
    id = li.dataset.tid; kind = li.dataset.kind;
    x0 = e.clientX; y0 = e.clientY; t0 = performance.now(); dx = 0; dragging = decided = false;
  }, { passive: true });
  document.addEventListener('pointermove', (e) => {
    if (!el) return;
    const ddx = e.clientX - x0, ddy = e.clientY - y0;
    if (!decided) {
      if (Math.abs(ddx) < 8 && Math.abs(ddy) < 8) return;
      decided = true;
      if (Math.abs(ddx) < Math.abs(ddy) * 1.2) { el = null; return; }   // más vertical → es scroll
      dragging = true; el.style.transition = 'none';
    }
    if (!dragging) return;
    e.preventDefault();
    dx = ddx;
    // Sigue el dedo 1:1 hasta bien pasado el umbral; amortigua solo al final
    const a = Math.abs(dx), soft = THRESH * 2;
    const show = Math.sign(dx) * (a > soft ? soft + (a - soft) * 0.4 : a);
    el.style.transform = `translateX(${show}px)`;
    wrap.classList.toggle('sw-right', dx > 8);
    wrap.classList.toggle('sw-left', dx < -8);
  }, { passive: false });
  document.addEventListener('pointerup', () => {
    if (!el || !dragging) { el = null; return; }
    // Menos sensible: exige distancia clara O un flick decidido (no un roce)
    const vel = Math.abs(dx) / Math.max(1, performance.now() - t0);
    const commit = Math.abs(dx) >= THRESH || (vel > 0.55 && Math.abs(dx) > 40);
    const dir = dx > 0 ? 1 : -1, _id = id, _kind = kind, _el = el, _wrap = wrap;
    if (!commit) { reset(true); return; }
    // Ambas direcciones: la fila sale de pantalla y luego se ejecuta la acción,
    // que muestra "Deshacer". Derecha = completar · Izquierda = eliminar.
    _el.style.transition = 'transform .2s cubic-bezier(.4,0,1,1),opacity .2s ease';
    _el.style.transform = `translateX(${dir * window.innerWidth}px)`;
    _el.style.opacity = '0';
    if (_wrap) _wrap.classList.remove('sw-right', 'sw-left');
    el = wrap = null; dragging = decided = false;
    setTimeout(() => { dir > 0 ? swipeComplete(_id, _kind) : swipeDelete(_id, _kind); }, 150);
  }, { passive: true });
  document.addEventListener('pointercancel', () => reset(true), { passive: true });
})();

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

// Proyectos distintos ya usados (para autocompletar en el modal y agrupar)
function tkAllProjects() {
  const set = new Set();
  allTasks().forEach(t => { const p = (t.project || '').trim(); if (p) set.add(p); });
  return [...set].sort((a, b) => a.localeCompare(b, 'es'));
}

// Modo edición del taskModal: si hay id, addSimple/addProgress ACTUALIZAN esa tarea
// en vez de crear una nueva. El mismo modal sirve para crear y editar (reutilizado).
let editingTaskId = null;
let editingTaskKind = null;

// Devuelve el taskModal a modo "crear" (título, tabs visibles, labels de botón, sin edición).
function taskModalResetCreate() {
  editingTaskId = null;
  editingTaskKind = null;
  const title = document.getElementById('taskModalTitle');
  if (title) title.textContent = 'Nueva tarea';
  const tabs = document.querySelector('#taskModal .task-modal-tabs');
  if (tabs) tabs.style.display = '';
  const bS = document.getElementById('btnAddSimple');
  if (bS) bS.innerHTML = '<i class="fa-solid fa-plus"></i> Agregar tarea';
  const bP = document.getElementById('btnAddProgress');
  if (bP) bP.innerHTML = '<i class="fa-solid fa-chart-line"></i> Crear tarea con progreso';
}

function openTaskModal() {
  const m = document.getElementById('taskModal');
  if (!m) return;
  taskModalResetCreate();
  setType('simple');
  // Autocompletado de proyectos existentes + limpia los campos de proyecto
  const dl = document.getElementById('projectList');
  if (dl) dl.innerHTML = tkAllProjects().map(p => `<option value="${escapeHtml(p)}"></option>`).join('');
  ['fName', 'fDue', 'fProject', 'pName', 'pUnit', 'pTotal', 'pDue', 'pProject'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  resetPrio('fPrio'); resetPrio('pPrio');
  const fc = document.getElementById('fCollab'); if (fc) fc.checked = false;
  m.classList.add('show');
  setTimeout(() => document.getElementById('fName')?.focus(), 80);
}

// Abre el taskModal PRECARGADO para editar una tarea activa propia (simple o progress).
function openEditTask(id, kind) {
  const t = (kind === 'progress' ? state.progress : state.simple).find(x => x.id === id);
  if (!t) { toast('No encontré la tarea'); return; }
  const m = document.getElementById('taskModal');
  if (!m) return;
  editingTaskId = id;
  editingTaskKind = kind;
  const dl = document.getElementById('projectList');
  if (dl) dl.innerHTML = tkAllProjects().map(p => `<option value="${escapeHtml(p)}"></option>`).join('');
  setType(kind);
  // UI en modo edición: título, ocultar tabs (no se cambia el tipo), labels de guardar
  const title = document.getElementById('taskModalTitle');
  if (title) title.textContent = 'Editar tarea';
  const tabs = document.querySelector('#taskModal .task-modal-tabs');
  if (tabs) tabs.style.display = 'none';
  const saveLabel = '<i class="fa-solid fa-check"></i> Guardar cambios';
  const bS = document.getElementById('btnAddSimple'); if (bS) bS.innerHTML = saveLabel;
  const bP = document.getElementById('btnAddProgress'); if (bP) bP.innerHTML = saveLabel;
  if (kind === 'simple') {
    document.getElementById('fName').value = t.name || '';
    document.getElementById('fDue').value = t.due || '';
    document.getElementById('fProject').value = t.project || '';
    setPrioActive('fPrio', t.prio || 'Media');
    const fc = document.getElementById('fCollab'); if (fc) fc.checked = !!t.collab;
  } else {
    document.getElementById('pName').value = t.name || '';
    document.getElementById('pUnit').value = t.unit || '';
    document.getElementById('pTotal').value = (t.total != null ? t.total : '');
    document.getElementById('pDue').value = t.due || '';
    document.getElementById('pProject').value = t.project || '';
    setPrioActive('pPrio', t.prio || 'Media');
  }
  m.classList.add('show');
  setTimeout(() => document.getElementById(kind === 'simple' ? 'fName' : 'pName')?.focus(), 80);
}

function closeTaskModal() {
  document.getElementById('taskModal')?.classList.remove('show');
  editingTaskId = null;
  editingTaskKind = null;
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
    .filter(([k, v]) => k !== currentUser && !v.hidden && !alreadyAssignees.includes(k))
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
  setPrioActive(hiddenId, 'Media');
}

// Fija la prioridad (hidden + pill activa) a un valor arbitrario. Usado al precargar el editor.
function setPrioActive(hiddenId, prio) {
  const hidden = document.getElementById(hiddenId);
  if (hidden) hidden.value = prio;
  const group = hidden?.parentElement?.querySelector('.prio-group');
  group?.querySelectorAll('.prio-pill').forEach(p => {
    p.classList.toggle('active', p.dataset.prio === prio);
  });
}

function addSimple() {
  const n = document.getElementById('fName').value.trim();
  if (!n) { toast('Escribe una descripción'); return; }
  // Modo edición: actualiza la tarea existente (conserva done/collab/owner/createdAt).
  const collab = !!document.getElementById('fCollab')?.checked;
  if (editingTaskId && editingTaskKind === 'simple') {
    const t = state.simple.find(x => x.id === editingTaskId);
    if (t) {
      t.name = n;
      t.due = document.getElementById('fDue').value;
      t.prio = document.getElementById('fPrio').value;
      t.project = document.getElementById('fProject').value.trim() || null;
      t.collab = collab;
    }
    scheduleSave(); render(); toast('Tarea actualizada');
    closeTaskModal();
    return;
  }
  state.simple.unshift({
    id: 'S' + (++tkId),
    name: n,
    due: document.getElementById('fDue').value,
    prio: document.getElementById('fPrio').value,
    project: document.getElementById('fProject').value.trim() || null,
    done: false,
    collab: collab,
    owner: currentUser,
    createdAt: new Date().toISOString()
  });
  document.getElementById('fName').value = '';
  document.getElementById('fDue').value = '';
  document.getElementById('fProject').value = '';
  resetPrio('fPrio');
  scheduleSave(); render(); toast('Tarea agregada');
  closeTaskModal();
}

function addProgress() {
  const n = document.getElementById('pName').value.trim();
  const total = parseInt(document.getElementById('pTotal').value);
  const unit = document.getElementById('pUnit').value.trim() || 'unidades';
  if (!n || !total || total < 1) { toast('Completa nombre y total'); return; }
  // Modo edición: actualiza la tarea existente (conserva done/log/owner/createdAt).
  if (editingTaskId && editingTaskKind === 'progress') {
    const t = state.progress.find(x => x.id === editingTaskId);
    if (t) {
      t.name = n;
      t.unit = unit;
      t.total = total;
      t.due = document.getElementById('pDue').value;
      t.prio = document.getElementById('pPrio').value;
      t.project = document.getElementById('pProject').value.trim() || null;
    }
    scheduleSave(); render(); toast('Tarea actualizada');
    closeTaskModal();
    return;
  }
  state.progress.unshift({
    id: 'P' + (++tkId),
    name: n, unit, total, done: 0, log: [],
    due: document.getElementById('pDue').value,
    prio: document.getElementById('pPrio').value,
    project: document.getElementById('pProject').value.trim() || null,
    owner: currentUser,
    createdAt: new Date().toISOString()
  });
  document.getElementById('pName').value = '';
  document.getElementById('pTotal').value = '';
  document.getElementById('pUnit').value = '';
  document.getElementById('pDue').value = '';
  document.getElementById('pProject').value = '';
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
      const name = USERS[payload.recipientUserId]?.nameRaw || 'el destinatario';
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

  assignees.forEach(to => {
    // Auto-asignación: si me la asigno a mí mismo, va DIRECTO a mi lista (sin invitación ni correo).
    // Es "colaborativa" si además se la asigné a alguien más (tarea compartida).
    if (to === currentUser) {
      const shared = assignees.some(a => a !== currentUser);
      const tid = (isProgress ? 'P' : 'S') + (++tkId);
      if (isProgress) {
        state.progress.unshift({
          id: tid, name: n, unit, total, done: 0, log: [],
          due, prio, owner: currentUser, collab: shared, createdAt: new Date().toISOString()
        });
      } else {
        state.simple.unshift({
          id: tid, name: n, due, prio, done: false, collab: shared,
          owner: currentUser, createdAt: new Date().toISOString()
        });
      }
      return;
    }
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
        taskName: n,
        due,
      });
    }
  });

  const others = assignees.filter(a => a !== currentUser);
  const includesSelf = assignees.includes(currentUser);
  let msg;
  if (!others.length) {
    msg = 'Tarea agregada a tu lista';
  } else {
    const lbl = others.length === 1 ? (USERS[others[0]]?.name || others[0]) : `${others.length} personas`;
    msg = `Tarea enviada a ${lbl}${includesSelf ? ' y a ti' : ''}`;
  }
  scheduleSave(); render(); toast(msg);
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
      USERS[currentUser].name = escapeHtml(trimmed);           // mismo escape que en loadAllProfiles
      USERS[currentUser].nameRaw = trimmed;
      USERS[currentUser].initials = escapeHtml(initials);
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
    { view: 'forms', icon: 'fa-clipboard-list', title: 'Formularios',
      desc: 'Utilería y formularios para el equipo administrativo',
      iconClass: 'home-ico-forms' },
    { view: 'portal', icon: 'fa-share-nodes', title: 'Portal de clientes',
      desc: 'Sube dashboards externos y da acceso a clientes con su propio usuario',
      iconClass: 'home-ico-portal' },
    { view: 'ventas', icon: 'fa-chart-line', title: 'Ventas',
      desc: 'Dashboards y análisis de ventas del fondo',
      iconClass: 'home-ico-ventas' },
  ],
  mvp: [
    { view: 'db', icon: 'fa-database', title: 'Base de Datos',
      desc: 'Datos del proyecto MVP',
      iconClass: 'home-ico-mvp' },
    { view: 'fundTrackers', icon: 'fa-chart-column', title: 'MVP Fund Trackers',
      desc: 'Valuación de fondos por empresa subyacente',
      iconClass: 'home-ico-trackers' },
    { view: 'fundraising', icon: 'fa-hand-holding-dollar', title: 'Fund Rising Tracker',
      desc: 'Seguimiento del levantamiento de capital',
      iconClass: 'home-ico-fundraising' },
    { view: 'reports', icon: 'fa-chart-pie', title: 'Reportes',
      desc: 'Genera el reporte de distribuciones de un LP desde las cartas de Altareturn',
      iconClass: 'home-ico-reportes' },
    { view: 'portal', icon: 'fa-share-nodes', title: 'Portal de clientes',
      desc: 'Sube dashboards de MVP y da acceso a clientes con su propio usuario',
      iconClass: 'home-ico-portal' },
  ],
};

const ORG_NAV = {
  cretum: [
    { view: 'home',    icon: 'fa-house',       label: 'Inicio' },
    { view: 'tasks',   icon: 'fa-list-check',  label: 'To Do Dashboard' },
    { view: 'db',      icon: 'fa-database',    label: 'Base de Datos' },
    { view: 'dropbox', icon: 'fa-dropbox',     label: 'Dropbox', brand: true },
    { view: 'campaigns', icon: 'fa-bolt',      label: 'Campañas' },
    { view: 'forms',     icon: 'fa-clipboard-list', label: 'Formularios' },
    { view: 'portal',    icon: 'fa-share-nodes', label: 'Portal de clientes' },
    { view: 'ventas',    icon: 'fa-chart-line', label: 'Ventas' },
  ],
  mvp: [
    { view: 'home',         icon: 'fa-house',         label: 'Inicio' },
    { view: 'db',           icon: 'fa-database',      label: 'Base de Datos' },
    { view: 'fundTrackers', icon: 'fa-chart-column',  label: 'Fund Trackers' },
    { view: 'fundraising',  icon: 'fa-hand-holding-dollar', label: 'Fund Rising Tracker' },
    { view: 'reports',      icon: 'fa-chart-pie',     label: 'Reportes' },
    { view: 'portal',       icon: 'fa-share-nodes',   label: 'Portal de clientes' },
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
      switchLbl.textContent = t('Cambiar a MVP');
    } else if (currentOrg === 'mvp') {
      switchBtn.style.display = '';
      switchSep.style.display = '';
      switchLbl.textContent = t('Cambiar a Cretum');
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

// ── Indicador de notificación del módulo To Do ──
// Cuenta las invitaciones de tarea pendientes por aceptar del usuario actual.
function pendingInviteCount() {
  if (!currentUser) return 0;
  return (state.invites || []).filter(iv => iv.to === currentUser).length;
}

// Sincroniza el pulso del módulo To Do sin re-renderizar todo el menú.
// Se llama desde render() para que aparezca/desaparezca al aceptar o declinar.
function refreshTodoBadge() {
  const grid = document.getElementById('homeModules');
  if (!grid) return;
  const btn = grid.querySelector('.home-module[data-mod="tasks"]');
  if (!btn) return;
  const has = pendingInviteCount() > 0;
  const pulse = btn.querySelector('.home-module-pulse');
  if (has && !pulse) {
    const el = document.createElement('span');
    el.className = 'home-module-pulse';
    el.setAttribute('aria-label', 'Tienes tareas por aceptar');
    btn.appendChild(el);
  } else if (!has && pulse) {
    pulse.remove();
  }
}

function renderHomeModules() {
  const el = document.getElementById('homeModules');
  if (!el || !currentOrg) return;
  const isAdmin = currentProfile?.role === 'admin';
  const isEditorOrAdmin = isAdmin || currentProfile?.role === 'editor';
  const mods = (ORG_MODULES[currentOrg] || []).filter(m =>
    (!m.adminOnly || isAdmin) && (!m.editorOrAdmin || isEditorOrAdmin));
  el.innerHTML = mods.map(m => `
    <button class="home-module${m.disabled ? ' disabled' : ''}" data-mod="${m.view}"${m.disabled ? ' disabled aria-disabled="true"' : ` onclick="switchView('${m.view}')"`}>
      ${m.disabled ? `<span class="home-module-badge">${t('Pronto')}</span>` : ''}
      ${(!m.disabled && m.view === 'tasks' && pendingInviteCount() > 0) ? '<span class="home-module-pulse" aria-label="Tienes tareas por aceptar"></span>' : ''}
      <div class="home-module-ico ${m.iconClass}"><i class="${m.iconBrand ? 'fa-brands' : 'fa-solid'} ${m.icon}"></i></div>
      <div class="home-module-content">
        <div class="home-module-title">${t(m.title)}</div>
        <div class="home-module-desc">${t(m.desc)}</div>
      </div>
    </button>
  `).join('');
  document.getElementById('homeQuestion').textContent = t('¿Con qué quieres empezar hoy?');

  // Próximamente — items dependen del org
  const soonGrid = document.getElementById('homeSoonGrid');
  if (soonGrid) {
    const soonItems = ORG_SOON[currentOrg] || [];
    soonGrid.innerHTML = soonItems.map(it => `
      <div class="home-soon-item"><i class="${it.icon}"></i> ${t(it.label)}</div>
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
  if (v >= 1e6) return s + '$' + (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return s + '$' + (v / 1e3).toFixed(2) + 'K';
  return s + '$' + v.toFixed(2);
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
  // Neteo de reinversiones 22F→26A QP (no inflar comprometido ni distribuido).
  let netTot = { totalRecycled: 0, totalReinvested: 0 };
  try { netTot = await loadReinvestNettingMap(); } catch (e) { console.warn('netting map', e); }
  const active = inv.filter(r => !r.distributed_at);
  const committed = active.reduce((s, r) => s + n(r.commitment), 0) - netTot.totalRecycled;   // comprometido real
  const nav = active.reduce((s, r) => s + (n(r.commitment_actual) || n(r.commitment)), 0);
  const distrib = dist.reduce((s, r) => s + n(r.value_in_kind) + n(r.cash_proceeds), 0) - netTot.totalReinvested;  // distribuido real
  const paidIn = inv.reduce((s, r) => s + n(r.commitment), 0) - netTot.totalRecycled;          // paid-in total (activo + distribuido)
  const moic = paidIn ? (nav + distrib) / paidIn : 0;   // MOIC/TVPI: (NAV + distribuido) / paid-in real
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
  const kpi = (label, val, cls, info, right) => `<div class="home-kpi"><div class="home-kpi-l">${label}${info ? infoIc(info, right) : ''}</div><div class="home-kpi-v ${cls || ''}">${val}</div></div>`;
  return `<div class="home-kpis-grid">` +
      kpi('Capital comprometido', fmtUsdShort(d.committed), '', 'Suma del compromiso de las posiciones activas de todos los LP, neto de reinversiones SpaceX (la 22F vendida y reinvertida en la 26A QP se cuenta una sola vez).') +
      kpi('Valor actual (NAV)', fmtUsdShort(d.nav), 'accent', 'Valor de mercado actual de todas las posiciones activas (mark-to-market, sincronizado con el último precio).', true) +
      kpi('MOIC', d.moic.toFixed(2) + 'x', moicClass(d.moic), 'Múltiplo total (TVPI): (NAV + distribuido real) ÷ capital pagado real (incluye terminadas). Neto de reinversiones.') +
      kpi('Distribuido a la fecha', fmtUsdShort(d.distrib), '', 'Efectivo y acciones devueltos a los LP, incluyendo distribuciones aplicadas a llamadas de capital. Excluye recompras/reinversiones SpaceX.', true) +
      kpi('Inversionistas', d.nInv.toLocaleString('en-US'), '', 'Número de inversionistas (LP) distintos en la base.') +
      kpi('Posiciones activas', d.nPos.toLocaleString('en-US'), '', 'Posiciones aún sin distribuir ni liquidar.', true) +
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
      <span>${t(it.label)}</span>
    </button>
  `).join('');
  highlightActiveNav();
}

function highlightActiveNav() {
  document.querySelectorAll('#navList .nav-item').forEach(b => {
    b.classList.toggle('active', b.dataset.view === currentView);
  });
}

// Hook que llama i18n.js al cambiar de idioma: re-traduce lo dinámico (saludos,
// menú, nav, tareas, estado de sync) sin recargar la página.
window.__afterLang = function () {
  try {
    if (currentProfile) {
      const firstName = (currentProfile.full_name || '').split(' ')[0] || t('tú');
      const greet = greetingForTime();
      ['homeGreet', 'selGreet'].forEach(id => { const e = document.getElementById(id); if (e) e.textContent = greet; });
      ['homeUserName', 'selUserName'].forEach(id => { const e = document.getElementById(id); if (e) e.textContent = firstName; });
    }
    if (typeof applyOrgTheme === 'function') applyOrgTheme();
    if (typeof renderHomeModules === 'function' && currentOrg) renderHomeModules();
    if (typeof renderNavList === 'function') renderNavList();
    if (typeof render === 'function' && currentUser) render();
    if (typeof setSyncStatus === 'function') setSyncStatus(window.__syncState || 'ok');
  } catch (e) { console.error('[afterLang]', e); }
};

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

  // Al salir de la Base de Datos, olvida el detalle recordado (volver = lista)
  if (view !== 'db') forgetDbDetail();

  currentView = view;
  document.getElementById('pageSelector').classList.toggle('active', view === 'selector');
  document.getElementById('pageTasks').style.display = view === 'tasks' ? '' : 'none';
  document.getElementById('pageDb').classList.toggle('active', view === 'db');
  document.getElementById('pageHome').classList.toggle('active', view === 'home');
  document.getElementById('pageDbx').classList.toggle('active', view === 'dropbox');
  const pageFt = document.getElementById('pageFundTrackers');
  if (pageFt) pageFt.classList.toggle('active', view === 'fundTrackers');
  const pageFr = document.getElementById('pageFundraising');
  if (pageFr) pageFr.classList.toggle('active', view === 'fundraising');
  document.getElementById('pageCampaigns').classList.toggle('active', view === 'campaigns');
  const pageRep = document.getElementById('pageReports');
  if (pageRep) pageRep.classList.toggle('active', view === 'reports');
  const pagePortal = document.getElementById('pagePortal');
  if (pagePortal) pagePortal.classList.toggle('active', view === 'portal');
  const pageForms = document.getElementById('pageForms');
  if (pageForms) pageForms.classList.toggle('active', view === 'forms');
  const pageVentas = document.getElementById('pageVentas');
  if (pageVentas) pageVentas.classList.toggle('active', view === 'ventas');

  highlightActiveNav();

  const orgPrefix = currentOrg ? ORG_NAMES[currentOrg] + ' · ' : '';
  const viewLabel = {
    'selector':     'Empresas',
    'home':         'Inicio',
    'tasks':        'To Do',
    'db':           'Base de Datos',
    'dropbox':      'Dropbox',
    'fundTrackers': 'Fund Trackers',
    'fundraising':  'Fund Rising Tracker',
    'campaigns':    'Campañas',
    'reports':      'Reportes',
    'forms':        'Formularios',
    'portal':       'Portal de clientes',
    'ventas':       'Ventas',
  }[view] || '';
  document.getElementById('headerBrandText').textContent =
    view === 'selector' ? 'Cretum · Selector' : (orgPrefix + viewLabel);

  // Botón de back: visible si hay historial
  const backBtn = document.getElementById('backBtn');
  if (backBtn) backBtn.style.display = viewHistory.length > 0 ? '' : 'none';

  // El logo/marca es el botón "Ir al menú": inactivo cuando ya estás en el selector.
  const brandBtn = document.getElementById('headerBrandBtn');
  if (brandBtn) brandBtn.disabled = (view === 'selector');

  closeNav();

  if (view === 'db' && !dbLoaded) loadDb();
  if (view === 'dropbox') openDropbox();
  if (view === 'fundTrackers') renderFundTrackerHome();
  if (view === 'fundraising') loadFr();
  if (view === 'campaigns') loadCampaigns();
  if (view === 'reports') loadReports();
  if (view === 'portal') { portalOrg = currentOrg || 'cretum'; loadPortalAdmin(); }
  if (view === 'forms') formsBackHome();
  if (view === 'ventas') ventasBackHome();
  if (view === 'tasks') requestAnimationFrame(tkMoveSliders);   // coloca las pills una vez visible

  syncHash();
}

// ─── Ventas: menú + dashboards embebidos ───────────────────────────────────
// Muestra el menú de Ventas (una card "GVV Dashboard") y esconde el dashboard.
function ventasBackHome() {
  const menu = document.getElementById('ventasMenu');
  const dash = document.getElementById('ventasDash');
  const page = document.getElementById('pageVentas');
  if (menu) menu.style.display = '';
  if (dash) dash.style.display = 'none';
  if (page) page.classList.remove('gvv-full');
}
// Embebe el GVV Dashboard (archivo estático servido por cretumdesk).
// Carga lazy: el iframe (~1.3 MB) no se baja hasta que le piquen.
function openGvvDashboard() {
  const menu = document.getElementById('ventasMenu');
  const dash = document.getElementById('ventasDash');
  const page = document.getElementById('pageVentas');
  const frame = document.getElementById('ventasGvvFrame');
  if (frame && !frame.getAttribute('src')) frame.setAttribute('src', '/gvv-detalle.html');
  if (menu) menu.style.display = 'none';
  if (dash) dash.style.display = '';
  if (page) page.classList.add('gvv-full');
}

// Descarga el HTML autocontenido del GVV Dashboard (archivo estático de cretumdesk).
function downloadGvvHtml() {
  const a = document.createElement('a');
  a.href = '/gvv-detalle.html';
  a.download = 'GVV-Fund-Dashboard.html';
  document.body.appendChild(a); a.click(); a.remove();
  toast('Descargando HTML del GVV…');
}

// Copia al portapapeles el link público del GVV en cretumpartners.com.
function copyGvvPartnersLink(btn) {
  const url = 'https://cretumpartners.com/gvv-detalle.html';
  const ok = () => {
    toast('Link de cretumpartners copiado');
    if (btn) { const o = btn.innerHTML; btn.innerHTML = '<i class="fa-solid fa-check"></i> Copiado'; setTimeout(() => { btn.innerHTML = o; }, 1600); }
  };
  const fallback = () => {
    const t = document.createElement('textarea');
    t.value = url; t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.appendChild(t); t.select();
    try { document.execCommand('copy'); ok(); } catch (e) { toast('No se pudo copiar: ' + url); }
    t.remove();
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(ok).catch(fallback);
  } else fallback();
}

// Pantalla completa del GVV embebido: el wrapper (iframe + botón) entra a fullscreen nativo.
function toggleGvvFullscreen() {
  const w = document.getElementById('gvvFsWrap');
  if (!w) return;
  if (document.fullscreenElement) {
    (document.exitFullscreen || document.webkitExitFullscreen || function(){}).call(document);
  } else {
    const req = w.requestFullscreen || w.webkitRequestFullscreen;
    if (req) { const r = req.call(w); if (r && r.catch) r.catch(() => toast('No se pudo abrir pantalla completa')); }
    else toast('Tu navegador no permite pantalla completa aquí');
  }
}
// Mantiene el botón sincronizado (icono/texto) al entrar/salir, incluido salir con Esc.
function _gvvFsSync() {
  const b = document.getElementById('gvvFsBtn');
  if (!b) return;
  const on = !!(document.fullscreenElement || document.webkitFullscreenElement);
  b.innerHTML = on
    ? '<i class="fa-solid fa-compress"></i> <span>Salir</span>'
    : '<i class="fa-solid fa-expand"></i> <span>Pantalla completa</span>';
  b.title = on ? 'Salir de pantalla completa' : 'Pantalla completa';
}
document.addEventListener('fullscreenchange', _gvvFsSync);
document.addEventListener('webkitfullscreenchange', _gvvFsSync);

/* ── Routing por hash (#org/vista) — persiste la vista al refrescar ── */
let suppressHashChange = false;

function syncHash() {
  const target = (currentView === 'selector' || !currentOrg)
    ? '#/'
    : `#${currentOrg}/${currentView}`;
  if (location.hash === target) return;
  // location.hash crea una entrada real en el historial: así el botón "atrás"
  // del teléfono navega vista por vista de forma nativa (y nunca se sale de la
  // app desde una pantalla profunda). El back lo maneja hashchange → applyRoute.
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

// Back/forward del navegador (incluye el botón "atrás" del teléfono): cada vista
// es una entrada de historial, así que "atrás" cambia el hash → navegamos a esa vista.
window.addEventListener('hashchange', () => {
  if (suppressHashChange) { suppressHashChange = false; return; }
  if (!currentUser) return;   // sin sesión no navegamos
  // Si hay una capa abierta (modal/detalle), el "atrás" la cierra primero
  // en vez de cambiar de vista, y restauramos el hash de la vista actual.
  if (dismissTopLayer()) { suppressHashChange = true; history.forward(); return; }
  applyRoute();
});

// Cierra la capa "más encima" (modal, detalle, drawer) si hay alguna abierta.
// Devuelve true si cerró algo. Es el orden en que "atrás" debe deshacerlas.
function dismissTopLayer() {
  const q = id => document.getElementById(id);
  // 1) Drawer de navegación
  if (q('navDrawer')?.classList.contains('open')) { closeNav(); return true; }
  // 2) Modales con limpieza propia
  if (q('taskModal')?.classList.contains('show'))   { closeTaskModal();   return true; }
  if (q('assignModal')?.classList.contains('show')) { closeAssignModal(); return true; }
  if (q('confirmModal')?.classList.contains('show')) { closeConfirm(false); return true; }  // = cancelar (resuelve la promesa)
  // 3) Cualquier otro modal/overlay visible (campañas, portal, MFA, confirmaciones…)
  const overlays = document.querySelectorAll('.camp-modal-backdrop.show, .modal-backdrop.show, .mvp-snap-modal.show');
  if (overlays.length) { overlays[overlays.length - 1].classList.remove('show'); return true; }
  // 4) Detalle de base de datos
  if (currentView === 'db' && q('dbDetail')?.classList.contains('show')) { closeDetail(); return true; }
  // 5) Detalle de fund tracker → vuelve a la lista de fondos
  if (q('ftDetail')?.classList.contains('show')) { closeFundTracker(); return true; }
  // 6) Detalle de un formulario → vuelve a la galería
  if (currentView === 'forms' && q('formsDetail') && q('formsDetail').style.display !== 'none') {
    formsBackHome(); return true;
  }
  return false;
}

function goBack() {
  if (dismissTopLayer()) return;
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
  if (v >= 1e3) return '$' + (n / 1e3).toFixed(2) + 'K';
  return '$' + n.toFixed(2);
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
// Estado del modal de dashboard: tipo (html|file), archivo nuevo pendiente, y
// el archivo actual cuando se edita (para conservarlo si no se sube otro).
let ptDashKind = 'html', ptPendingFile = null, ptEditFile = null;
let portalOrg = 'cretum';   // empresa que se gestiona en el módulo Portal (según currentOrg)

// Todo el equipo VE los dashboards y accesos (sin contraseñas); solo editores/
// admins pueden crear/editar/borrar. El backend lo exige igual (canManage).
const ptCanManage = () => currentProfile?.role === 'admin' || currentProfile?.role === 'editor';

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
  // Acciones de crear: solo editores/admins (viewers solo consultan)
  const manage = ptCanManage();
  const ad = document.getElementById('ptActionDash'); if (ad) ad.style.display = manage ? '' : 'none';
  const au = document.getElementById('ptActionUser'); if (au) au.style.display = manage ? '' : 'none';
  const dl = document.getElementById('ptDashList'), ul = document.getElementById('ptUserList');
  if (dl) dl.innerHTML = '<div class="pt-empty"><i class="fa-solid fa-spinner fa-spin"></i> Cargando…</div>';
  try {
    const d = await portalApi({ action: 'admin_list' });
    ptDashboards = d.dashboards || []; ptUsers = d.users || []; ptAccess = d.access || [];
    renderPtDashboards(); renderPtUsers(); ptUpdateDataCount();
  } catch (err) {
    if (dl) dl.innerHTML = `<div class="pt-empty">Error: ${escapeHtml(err.message)}</div>`;
  }
}

// Muestra/oculta la sección "Datos existentes" (listas de dashboards y accesos).
function ptToggleData() {
  const data = document.getElementById('ptData');
  const btn = document.getElementById('ptDataBtn');
  if (!data) return;
  const show = data.hasAttribute('hidden');
  if (show) {
    data.removeAttribute('hidden');
    if (btn) btn.setAttribute('aria-expanded', 'true');
    const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    try { data.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'nearest' }); } catch (e) {}
  } else {
    data.setAttribute('hidden', '');
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }
}

// Resumen en la tarjeta "Consultar datos existentes": cuántos hay.
function ptUpdateDataCount() {
  const el = document.getElementById('ptDataCount');
  if (!el) return;
  const d = ptDashboards.length, u = ptUsers.length;
  el.textContent = `${d} dashboard${d === 1 ? '' : 's'} · ${u} acceso${u === 1 ? '' : 's'}`;
}

function renderPtDashboards() {
  const el = document.getElementById('ptDashList');
  if (!ptDashboards.length) { el.innerHTML = `<div class="pt-empty">Aún no hay dashboards.${ptCanManage() ? ' Crea el primero.' : ''}</div>`; return; }
  const base = portalOrg === 'mvp' ? '/portal-mvp' : '/portal';
  const manage = ptCanManage();
  el.innerHTML = ptDashboards.map(d => `<div class="pt-item">
    <div class="pt-item-main">
      <div class="pt-ico"><i class="fa-solid fa-display"></i></div>
      <div class="pt-item-text">
        <div class="nm">${escapeHtml(d.title)}</div>
        <div class="sub">${base}#${escapeHtml(d.slug)}</div>
      </div>
    </div>
    <div class="acts">
      <button class="pt-act-primary" onclick="ptCopyLink('${base}', '${escapeHtml(d.slug)}', this)"><i class="fa-solid fa-link"></i> Copiar enlace</button>
      <button class="pt-act-ico" title="Previsualizar" aria-label="Previsualizar" onclick="ptDashView(${d.id})"><i class="fa-solid fa-eye"></i></button>
      ${manage ? `<button class="pt-act-ico" title="Editar" aria-label="Editar" onclick="ptDashOpen(${d.id})"><i class="fa-solid fa-pen"></i></button>
      <button class="pt-act-ico danger" title="Eliminar" aria-label="Eliminar" onclick="ptDashDelete(${d.id})"><i class="fa-solid fa-trash"></i></button>` : ''}
    </div>
  </div>`).join('');
}

// Copia el enlace directo de una campaña: el cliente lo abre y, tras iniciar
// sesión, va directo a ese dashboard (ancla #slug, sin pasar por un menú).
function ptCopyLink(base, slug, btn) {
  const url = `${location.origin}${base}#${slug}`;
  const done = () => { if (btn) { const o = btn.innerHTML; btn.innerHTML = '<i class="fa-solid fa-check"></i> Copiado'; setTimeout(() => { btn.innerHTML = o; }, 1600); } };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(done).catch(() => { prompt('Copia el enlace:', url); });
  } else { prompt('Copia el enlace:', url); }
}

// Copia el enlace GENERAL del portal (sin dashboard específico), según la org activa.
function ptCopyPortalLink(btn) {
  const base = portalOrg === 'mvp' ? '/portal-mvp' : '/portal';
  const url = `${location.origin}${base}`;
  const done = () => { if (btn) { const o = btn.innerHTML; btn.innerHTML = '<i class="fa-solid fa-check"></i> Copiado'; setTimeout(() => { btn.innerHTML = o; }, 1600); } };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(done).catch(() => { prompt('Copia el enlace:', url); });
  } else { prompt('Copia el enlace:', url); }
}

function renderPtUsers() {
  const el = document.getElementById('ptUserList');
  if (!ptUsers.length) { el.innerHTML = `<div class="pt-empty">Aún no hay accesos.${ptCanManage() ? ' Crea el primero.' : ''}</div>`; return; }
  const countFor = (uid) => ptAccess.filter(a => a.user_id === uid).length;
  const manage = ptCanManage();
  el.innerHTML = ptUsers.map(u => {
    const n = countFor(u.id);
    return `<div class="pt-item">
      <div class="pt-item-main">
        <div class="pt-ico pt-ico-user"><i class="fa-solid fa-user"></i></div>
        <div class="pt-item-text">
          <div class="nm">${escapeHtml(u.label || u.username)} ${u.active ? '' : '<span class="pt-badge off">inactivo</span>'}</div>
          <div class="sub">usuario: ${escapeHtml(u.username)} · <span class="pt-badge">${n} dashboard${n === 1 ? '' : 's'}</span></div>
        </div>
      </div>
      ${manage ? `<div class="acts">
        <button class="pt-act-ico" title="Editar" aria-label="Editar" onclick="ptUserOpen(${u.id})"><i class="fa-solid fa-pen"></i></button>
        <button class="pt-act-ico danger" title="Eliminar" aria-label="Eliminar" onclick="ptUserDelete(${u.id})"><i class="fa-solid fa-trash"></i></button>
      </div>` : ''}
    </div>`;
  }).join('');
}

/* ═══════════════════════════════════════════════════════════════════════
   FORMULARIOS (admin) — el equipo genera un enlace de registro de cliente.
   Las respuestas le llegan por correo a quien lo generó (api/forms.js).
   ═══════════════════════════════════════════════════════════════════════ */
let formsLinks = [];

async function formsApi(body) {
  const r = await authedFetch('/api/forms', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
  return d;
}

const formUrl = (token) => location.origin + '/form?t=' + encodeURIComponent(token);

// Galería ↔ detalle de un formulario
function formsBackHome() {
  const home = document.getElementById('formsHome'), detail = document.getElementById('formsDetail');
  if (home) home.style.display = 'block';
  if (detail) detail.style.display = 'none';
}
function formsOpen(/* type */) {
  // Hoy solo existe "registro de cliente"; cuando haya más, este parámetro elegirá cuál.
  const home = document.getElementById('formsHome'), detail = document.getElementById('formsDetail');
  if (home) home.style.display = 'none';
  if (detail) detail.style.display = 'block';
  loadForms();
}

async function loadForms() {
  const list = document.getElementById('formsList');
  if (list) list.innerHTML = '<div class="pt-empty"><i class="fa-solid fa-spinner fa-spin"></i> Cargando…</div>';
  try {
    const d = await formsApi({ action: 'list' });
    formsLinks = d.links || [];
    renderForms();
  } catch (err) {
    if (list) list.innerHTML = `<div class="pt-empty">Error: ${escapeHtml(err.message)}</div>`;
  }
}

function renderForms() {
  const el = document.getElementById('formsList');
  if (!el) return;
  if (!formsLinks.length) {
    el.innerHTML = '<div class="pt-empty">Aún no has generado enlaces. Crea el primero arriba y compártelo con tu cliente.</div>';
    return;
  }
  el.innerHTML = formsLinks.map(l => {
    const url = formUrl(l.token);
    const n = l.submissions || 0;
    return `<div class="pt-item">
      <div class="nm">${escapeHtml(l.label || 'Registro de cliente')} <span class="pt-badge">${n} respuesta${n === 1 ? '' : 's'}</span></div>
      <div class="sub">${escapeHtml(url)}</div>
      <div class="acts">
        <button class="cdd-btn" onclick="formsCopy('${escapeHtml(url)}')"><i class="fa-solid fa-copy"></i> Copiar enlace</button>
        <a class="cdd-btn" href="${escapeHtml(url)}" target="_blank" rel="noopener" style="text-decoration:none"><i class="fa-solid fa-up-right-from-square"></i> Abrir</a>
        <button class="cdd-btn camp-btn-danger" onclick="formsDelete(${l.id})"><i class="fa-solid fa-trash"></i> Eliminar</button>
      </div>
    </div>`;
  }).join('');
}

async function formsCreate() {
  const inp = document.getElementById('formsLabel');
  const label = (inp?.value || '').trim();
  try {
    await formsApi({ action: 'create', label });
    if (inp) inp.value = '';
    toast('Enlace generado');
    await loadForms();
  } catch (err) { toast('Error: ' + err.message); }
}

function formsCopy(url) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(url).then(() => toast('Enlace copiado'), () => toast('No se pudo copiar'));
  } else { toast('No se pudo copiar'); }
}

async function formsDelete(id) {
  if (!confirm('¿Eliminar este enlace? Los clientes ya no podrán abrirlo.')) return;
  try {
    await formsApi({ action: 'delete', id });
    toast('Enlace eliminado');
    await loadForms();
  } catch (err) { toast('Error: ' + err.message); }
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
  // Reset del estado de tipo/archivo
  ptPendingFile = null; ptEditFile = null;
  document.getElementById('ptDashFile').value = '';
  document.getElementById('ptFileLabel').textContent = 'Elige un archivo PDF o HTML…';
  const fc = document.getElementById('ptFileCurrent'); fc.style.display = 'none'; fc.textContent = '';
  ptSetKind('file');   // por defecto en nuevos: subir archivo (opción más usada)
  const msg = document.getElementById('ptDashMsg'); msg.textContent = ''; msg.className = 'camp-modal-msg';
  const pw = document.getElementById('ptDashPreviewWrap'); if (pw) pw.style.display = 'none';
  const pb = document.getElementById('ptPrevBtn'); if (pb) pb.innerHTML = '<i class="fa-solid fa-eye"></i> Vista previa';
  document.getElementById('ptDashModal').classList.add('show');
  if (d) {  // trae el contenido actual para editar
    document.getElementById('ptDashHtml').value = 'Cargando…';
    portalApi({ action: 'get_dashboard', id: d.id })
      .then(full => {
        if (full.kind === 'file') {
          ptSetKind('file');
          ptEditFile = { file_path: full.file_path, file_mime: full.file_mime, file_name: full.file_name };
          const fc2 = document.getElementById('ptFileCurrent');
          fc2.style.display = '';
          fc2.innerHTML = `<i class="fa-solid fa-file"></i> Actual: ${escapeHtml(full.file_name || 'archivo')} <span style="color:var(--gray-400)">— sube otro para reemplazar</span>`;
          document.getElementById('ptDashHtml').value = '';
        } else {
          ptSetKind('html');
          document.getElementById('ptDashHtml').value = full.html || '';
          ptDashPreviewLive();
        }
      })
      .catch(() => { document.getElementById('ptDashHtml').value = ''; });
  }
}

// Cambia el tipo de contenido del dashboard (Pegar HTML / Subir archivo).
function ptSetKind(kind) {
  ptDashKind = kind === 'file' ? 'file' : 'html';
  document.querySelectorAll('.pt-kind-btn').forEach(b => b.classList.toggle('active', b.dataset.kind === ptDashKind));
  document.getElementById('ptKindHtml').style.display = ptDashKind === 'html' ? '' : 'none';
  document.getElementById('ptKindFile').style.display = ptDashKind === 'file' ? '' : 'none';
}

// Extensiones aceptadas → MIME confiable (no confiamos en file.type, que a veces
// llega vacío y Supabase entonces lo guarda como text/plain = "sale el código").
const PT_FILE_MIME = { pdf: 'application/pdf', html: 'text/html', htm: 'text/html' };
function ptFileExt(name) { return (name.split('.').pop() || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

// Guarda el archivo elegido (aún sin subir) y muestra su nombre.
function ptFilePicked(input) { ptSetFile(input.files && input.files[0]); }

function ptSetFile(f) {
  const label = document.getElementById('ptFileLabel');
  if (f && !PT_FILE_MIME[ptFileExt(f.name)]) {
    ptPendingFile = null;
    label.textContent = 'Solo se aceptan archivos PDF o HTML.';
    return;
  }
  ptPendingFile = f || null;
  label.textContent = f
    ? `${f.name} · ${(f.size / 1048576).toFixed(1)} MB`
    : 'Arrastra un PDF o HTML aquí, o haz clic para elegirlo';
}

// ── Arrastrar y soltar sobre la zona de archivo ──
function ptFileDragOver(ev) { ev.preventDefault(); document.getElementById('ptFileDrop').classList.add('dragover'); }
function ptFileDragLeave(ev) { ev.preventDefault(); document.getElementById('ptFileDrop').classList.remove('dragover'); }
function ptFileDrop(ev) {
  ev.preventDefault();
  document.getElementById('ptFileDrop').classList.remove('dragover');
  const f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
  if (f) ptSetFile(f);
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
  const msg = document.getElementById('ptDashMsg');
  if (!title) { msg.textContent = 'Pon un título.'; msg.className = 'camp-modal-msg err'; return; }
  if (!slug) slug = ptSlugify(title);

  try {
    const body = { action: 'save_dashboard', slug, title, kind: ptDashKind };
    if (id) body.id = +id;

    if (ptDashKind === 'html') {
      const html = document.getElementById('ptDashHtml').value;
      if (!html.trim() && !id) { msg.textContent = 'Pega el HTML del dashboard.'; msg.className = 'camp-modal-msg err'; return; }
      body.html = html;
    } else if (ptPendingFile && (ptFileExt(ptPendingFile.name) === 'html' || ptFileExt(ptPendingFile.name) === 'htm')) {
      // HTML subido: lo leemos como texto y lo guardamos como HTML (se renderiza vía srcdoc,
      // igual que el HTML pegado). Así nunca "sale el código" por un content-type equivocado.
      if (ptPendingFile.size > 25 * 1048576) { msg.textContent = 'El archivo supera 25 MB.'; msg.className = 'camp-modal-msg err'; return; }
      msg.textContent = 'Leyendo archivo…'; msg.className = 'camp-modal-msg';
      body.kind = 'html';
      body.html = await ptPendingFile.text();
    } else {
      // Tipo archivo (PDF): sube el nuevo a Storage, o conserva el actual si se edita sin cambiarlo.
      if (ptPendingFile) {
        if (ptPendingFile.size > 25 * 1048576) { msg.textContent = 'El archivo supera 25 MB.'; msg.className = 'camp-modal-msg err'; return; }
        msg.textContent = 'Subiendo archivo…'; msg.className = 'camp-modal-msg';
        const ext = ptFileExt(ptPendingFile.name) || 'bin';
        const mime = PT_FILE_MIME[ext] || ptPendingFile.type || 'application/octet-stream';
        const path = `${currentOrg}/${slug || 'dash'}-${Date.now()}.${ext}`;
        const { error: upErr } = await sb.storage.from('portal-files')
          .upload(path, ptPendingFile, { contentType: mime, upsert: false });
        if (upErr) { msg.textContent = 'Error al subir: ' + upErr.message; msg.className = 'camp-modal-msg err'; return; }
        body.file_path = path;
        body.file_mime = mime;
        body.file_name = ptPendingFile.name;
      } else if (id && ptEditFile && ptEditFile.file_path) {
        body.file_path = ptEditFile.file_path;
        body.file_mime = ptEditFile.file_mime || '';
        body.file_name = ptEditFile.file_name || '';
      } else {
        msg.textContent = 'Elige un archivo (PDF o HTML).'; msg.className = 'camp-modal-msg err'; return;
      }
    }

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
  if (f) { f.removeAttribute('src'); f.srcdoc = '<p style="font-family:sans-serif;color:#889;padding:24px">Cargando…</p>'; }
  document.getElementById('ptViewModal').classList.add('show');
  try {
    const full = await portalApi({ action: 'get_dashboard', id });
    if (!f) return;
    if (full.kind === 'file' && full.file_path) {
      // Preview de archivo: firmamos una URL corta con la sesión de admin.
      const { data: signed, error } = await sb.storage.from('portal-files').createSignedUrl(full.file_path, 300);
      if (error || !signed) throw new Error(error?.message || 'No se pudo abrir el archivo');
      f.removeAttribute('srcdoc');
      f.src = signed.signedUrl;
    } else {
      f.removeAttribute('src');
      f.srcdoc = full.html || '<p style="font-family:sans-serif;color:#889;padding:24px">Este dashboard no tiene contenido.</p>';
    }
  } catch (err) {
    f.removeAttribute('src');
    f.srcdoc = `<p style="font-family:sans-serif;color:#c0392b;padding:24px">No se pudo cargar: ${escapeHtml(err.message)}</p>`;
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
    // Neteo de reinversiones 22F→26A QP: el comprometido no debe doblar el capital reciclado.
    let _net = { byInvestor: {}, totalRecycled: 0 };
    try { _net = await loadReinvestNettingMap(); } catch (e) { console.warn('netting map', e); }
    const _netMap = _net.byInvestor || {};
    dbInvestors = investors.map(i => {
      const rawCommit = invMap[i.id]?.commitment || 0;
      const recycled = _netMap[i.id]?.recycledPaidIn || 0;
      return {
        ...i,
        positions: invMap[i.id]?.positions || 0,
        commitmentRaw: rawCommit,
        commitment: rawCommit - recycled,    // paid-in real (sin capital reciclado)
        actual: invMap[i.id]?.actual || 0,
      };
    }).sort((a, b) => b.commitment - a.commitment || a.name.localeCompare(b.name));

    // Agrega por company
    const compMap = {};
    investments.forEach(x => {
      if (!compMap[x.company_id]) compMap[x.company_id] = { positions: 0, investors: new Set(), commitment: 0, actual: 0 };
      compMap[x.company_id].positions++;
      compMap[x.company_id].investors.add(x.investor_id);
      compMap[x.company_id].commitment += +x.commitment || 0;
      compMap[x.company_id].actual += +x.commitment_actual || 0;
    });
    // SpaceX: netea el comprometido por el capital reciclado del 26A QP (todo el reciclado es SpaceX).
    const _s26 = new Set(series.filter(s => SPX_REINV_IS_26AQP(s.name)).map(s => s.id));
    const _spxCompId = (investments.find(x => _s26.has(x.series_id)) || {}).company_id;
    if (_spxCompId != null && compMap[_spxCompId]) compMap[_spxCompId].commitment -= (_net.totalRecycled || 0);
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
    restoreDbDetailFromSession();   // reabre el inversionista/empresa si se recargó dentro de un detalle
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

// El nombre del filtro queda fijo en el botón ("Empresa", "Serie", "Titular");
// aquí solo marcamos activo y mostramos cuántas opciones hay seleccionadas (badge).
function updateCddLabel(cdd) {
  const countEl = cdd.querySelector('.cdd-count');
  const sel = [...cdd.querySelectorAll('.cdd-opt.selected')].filter(o => o.dataset.value);
  cdd.classList.toggle('active', sel.length > 0);
  if (countEl) countEl.textContent = sel.length ? String(sel.length) : '';
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

// Móvil: al dar "Ir/Enter" en un buscador, cierra el teclado (los resultados ya
// filtran en vivo, así que no hay que "enviar" nada — solo quitar el foco baja
// el teclado del sistema). Cubre los buscadores y los filtros con búsqueda.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const t = e.target;
  if (t && t.matches && t.matches('.db-search-inp, .cdd-search input')) {
    e.preventDefault();
    t.blur();
  }
});
// Pista de tecla "Buscar" en el teclado móvil para los buscadores
document.querySelectorAll('.db-search-inp').forEach(i => i.setAttribute('enterkeyhint', 'search'));

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

// Valor seguro dentro de onclick="fn('...')": primero escapa para string JS
// (\, ', saltos) y luego para atributo HTML. Evita que datos como emails con
// comilla rompan el string y ejecuten código (XSS por atributo).
function jsArg(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, ' ')
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ═══════════════════════════════════════════
   EXPORT — PDF / CSV / Excel (respeta filtros y columnas visibles)
═══════════════════════════════════════════ */

// Hashes SRI de las librerías de export (jsdelivr, versiones fijas). Si el CDN
// se comprometiera y sirviera un archivo alterado, el navegador lo rechaza.
const SCRIPT_SRI = {
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js': 'sha384-9nhczxUqK87bcKHh20fSQcTGD4qq5GhayNYSYWqwBkINBhOfQLg/P5HG5lF1urn4',
  'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js': 'sha384-Pqp51FUN2/qzfxZxBCtF0stpc9ONI6MYZpVqmo8m20SoaQCzf+arZvACkLkirlPz',
  'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js': 'sha384-ZZ1pncU3bQe8y31yfZdMFdSpttDoPmOZg2wguVK9almUodir1PghgT0eY7Mrty8H',
  'https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.2/dist/jspdf.plugin.autotable.min.js': 'sha384-fCAW/rDWORTbQXSiB7mOg0QtQ5c+r0f544y6XoKjuVva0nMBlCpNUjiFeG5iMdS3',
  'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js': 'sha384-JcnsjUPPylna1s1fvi1u12X5qjY5OL56iySh75FdtrwhO/SWXgMjoVqcKyIIWOLk',
  'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js': 'sha384-vtjasyidUo0kW94K5MXDXntzOJpQgBKXmE7e2Ga4LG0skTTLeBi97eFAXsqewJjw',
  'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js': 'sha384-+mbV2IY1Zk/X1p/nWllGySJSUN8uMs+gUAN10Or95UBH0fpj6GfKgPmgC5EXieXG',
};

// Carga un <script> externo una sola vez (lazy-load de librerías de export).
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[data-src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.dataset.src = src;
    if (SCRIPT_SRI[src]) { s.integrity = SCRIPT_SRI[src]; s.crossOrigin = 'anonymous'; s.referrerPolicy = 'no-referrer'; }
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
   NETEO DE REINVERSIONES 22F → 26A QP (SpaceX) — fuente única de verdad
   La mitad vendida de la 22F se reinvirtió en la 26A QP (mismo dinero). No es capital
   nuevo (no suma al "comprometido") ni distribución real al LP (no suma al "distribuido").
   Regla por inversionista: R = min(P, Q)
     P = reinversión (distribuciones de la 22F con nota "reinvest")
     Q = commitment del 26A QP (serie VI-26A QP; NO el "Closing 10", que es dinero fresco)
   Cubre: recompra total, parcial (lo no reinvertido SÍ es efectivo), +dinero fresco, o
   tomar efectivo (sin 26A → R=0). Cretum es cruzado entre entidades (119↔615): excepción.
   positions: [{ seriesName, commitment, dists:[{cash_proceeds,value_in_kind,notes}] }]
═══════════════════════════════════════════ */
const SPX_REINV_IS_26AQP = s => /26A\s*QP/i.test(s || '') && !/closing/i.test(s || '');
const SPX_REINV_IS_NOTE = nt => /reinver|reinvest/i.test(nt || '');
// Dado P (reinversión) y Q (commitment 26A QP) de un inversionista → cuánto netear de paid-in y distribuido.
function nettingFromPQ(P, Q, investorIds) {
  const R = Math.min(P, Q);
  let recycledPaidIn = R, reinvestedDist = R;
  const ids = new Set((Array.isArray(investorIds) ? investorIds : [investorIds]).map(Number));
  const CRETUM = 268194.85;   // 119 (22F vendida/reinversión) ↔ 615 (26A QP). Mismo dinero.
  if (ids.has(119) && !ids.has(615)) reinvestedDist += CRETUM;   // 119 solo: su distribución fue reinversión a 615 (no efectivo)
  if (ids.has(615) && !ids.has(119)) recycledPaidIn += CRETUM;   // 615 solo: su 26A QP es reciclado de 119
  return { recycledPaidIn, reinvestedDist };
}
function computeReinvestNetting(positions, investorIds) {
  let P = 0, Q = 0, has26 = false;
  for (const p of (positions || [])) {
    if (SPX_REINV_IS_26AQP(p.seriesName)) { Q += (+p.commitment || 0); has26 = true; }
    for (const d of (p.dists || [])) if (SPX_REINV_IS_NOTE(d.notes)) P += ((+d.cash_proceeds || 0) + (+d.value_in_kind || 0));
  }
  const r = nettingFromPQ(P, Q, investorIds || []);
  const ids = new Set((investorIds || []).map(Number));
  return { ...r, hasReinvestTarget: has26 || ids.has(119) };
}

// Carga (una vez) el neteo de reinversión por inversionista para vistas agregadas (lista DB, snapshot).
// Devuelve { byInvestor:{id:{recycledPaidIn,reinvestedDist}}, totalRecycled, totalReinvested }.
let _reinvestNettingCache = null;
async function loadReinvestNettingMap() {
  if (_reinvestNettingCache) return _reinvestNettingCache;
  const [series, invs, pdistRes] = await Promise.all([
    sbFetchAll('series', 'id,name'),
    sbFetchAll('investments', 'investor_id,series_id,commitment'),
    sb.from('investment_distributions').select('cash_proceeds,value_in_kind,investments(investor_id)').ilike('notes', '%reinvest%'),
  ]);
  if (pdistRes.error) throw pdistRes.error;
  const s26 = new Set(series.filter(s => SPX_REINV_IS_26AQP(s.name)).map(s => s.id));
  const Q = {}, P = {};
  invs.forEach(x => { if (s26.has(x.series_id)) Q[x.investor_id] = (Q[x.investor_id] || 0) + (+x.commitment || 0); });
  (pdistRes.data || []).forEach(d => {
    const iid = d.investments?.investor_id; if (iid == null) return;
    P[iid] = (P[iid] || 0) + ((+d.cash_proceeds || 0) + (+d.value_in_kind || 0));
  });
  const ids = new Set([...Object.keys(Q), ...Object.keys(P)].map(Number));
  ids.add(119); ids.add(615);   // Cretum cruzado: garantizar que ambos entren al cálculo
  const byInvestor = {}; let totalRecycled = 0, totalReinvested = 0;
  ids.forEach(id => {
    const net = nettingFromPQ(P[id] || 0, Q[id] || 0, id);
    if (net.recycledPaidIn || net.reinvestedDist) { byInvestor[id] = net; totalRecycled += net.recycledPaidIn; totalReinvested += net.reinvestedDist; }
  });
  _reinvestNettingCache = { byInvestor, totalRecycled, totalReinvested };
  return _reinvestNettingCache;
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
    let inkind = 0, cash = 0, distShares = 0;
    dists.forEach(x => { inkind += +x.value_in_kind || 0; cash += +x.cash_proceeds || 0; distShares += +x.shares_distributed || 0; });
    // "De qué fue" la distribución: empresas subyacentes repartidas (únicas)
    const unders = [...new Set(dists.map(x => x.underlying_company).filter(Boolean))];
    // Naturaleza de lo distribuido: efectivo, especie, ambos o nada
    const distTipo = (cash > 0 && inkind > 0) ? 'Efectivo + especie' : cash > 0 ? 'Efectivo' : inkind > 0 ? 'Especie' : '—';
    const num = (v) => (v != null && v !== '') ? +v : null;
    const shares = num(p.shares);
    const base = (+p.commitment_actual || +p.commitment || 0);
    return {
      cuenta: p._acct || null,
      dist_cash: cash || null,
      dist_inkind: inkind || null,
      dist_shares: distShares || null,
      dist_en: unders.join(', '),
      dist_tipo: distTipo,
      company: p.companies?.name || '—',
      series: p.series?.name || '—',
      estado: p.distributed_at ? 'Terminada' : 'Activa',
      theme: companyTheme(p.companies?.name),
      reinvSource: !!p.distributed_at && dists.some(x => /reinver|reinvest/i.test(x.notes || '')),
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
      const isReinv = /reinver|reinvest/i.test(x.notes || '');   // reinversión interna (no distribución real al LP)
      letters.push({
        company: p.company, series: p.series,
        fecha: x.distribution_date || '',
        tipo: isReinv ? 'Reinversión' : (x.letter_type === 'distribution_cash' ? 'Efectivo' : 'En especie'),
        _reinvest: isReinv,
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

  // Valor actual estimado por posición: el real (acciones×PPS) o, si no hay acciones (fondos),
  // commitment × MOIC = el valor marcado (= commitment_actual). OJO: usar commitment (costo),
  // NO commitment_actual, porque commitment_actual ya es commitment×MOIC → aplicar MOIC otra vez infla.
  pos.forEach(p => {
    p.valor_estimado = p.valor_actual != null ? p.valor_actual
      : (p.moic != null && p.commitment ? p.commitment * p.moic
        : (p.commitment_actual || p.commitment || null));
  });

  // Neteo de reinversiones 22F→26A QP (ver computeReinvestNetting). R = min(P, Q) por inversionista.
  const investorIds = inv._combined ? (inv._accounts || []).map(a => a.id) : (inv.id != null ? [inv.id] : []);
  const net = computeReinvestNetting(pos.map(p => ({ seriesName: p.series, commitment: p.commitment, dists: p._dists })), investorIds);
  // La mitad vendida del 22F se oculta de la tabla SOLO si realmente se reinvirtió (hay 26A QP / caso 119).
  if (!net.hasReinvestTarget) pos.forEach(p => { p.reinvSource = false; });

  // Totales (vista de flujo real del LP)
  const active = pos.filter(p => p.estado === 'Activa');
  const totCommit = pos.reduce((s, p) => s + p.commitment, 0) - net.recycledPaidIn;  // paid-in real (sin reciclado)
  const totActual = active.reduce((s, p) => s + p.commitment_actual, 0);             // NAV: solo posiciones activas
  const totDist = pos.reduce((s, p) => s + p.distribuido, 0) - net.reinvestedDist;   // distribuido real (sin reinversiones)
  const valorEstimado = active.reduce((s, p) => s + (p.valor_estimado || 0), 0);
  const portMoic = totCommit > 0 ? (totActual + totDist) / totCommit : 0;   // MOIC/TVPI: (valor activo + distribuido) / paid-in real
  const dpi = totCommit > 0 ? totDist / totCommit : 0;          // distribuido real / paid-in real

  const combined = !!inv._combined;
  return { inv, combined, contacts: contacts || [], pos, letters, totals: { totCommit, totActual, totDist, valorEstimado, portMoic, dpi } };
}

// Nombre de archivo seguro a partir del nombre del inversionista (+ etiqueta opcional)
// Sello fecha+hora para nombres de descarga ÚNICOS (evita el "(N)" que agrega el navegador al repetir nombre).
function dlStamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}`;
}
function invExportFilename(inv, extra) {
  const clean = (s) => String(s || '').replace(/[^\w\sáéíóúñÁÉÍÓÚÑ-]/gi, '').trim().replace(/\s+/g, '_').slice(0, 40);
  const parts = ['cretum', clean(inv.name) || 'inversionista'];
  if (extra) { const e = clean(extra); if (e) parts.push(e); }
  return parts.join('_') + '_' + dlStamp().replace(' ', '_');
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
  config.options.devicePixelRatio = 3;   // graficas nitidas en el PDF (antes 2)
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
  const PAL = ['#E8650D', '#8A93A6', '#F4A259', '#4F5866', '#B04F0A', '#C4CBD6', '#FBCE9E', '#2E3440', '#D97E3F', '#6E7787'];
  try {
    // 1) Comprometido vs. valor actual — AGREGADO POR EMPRESA y solo posiciones ACTIVAS
    //    (las terminadas ya se realizaron; evita mostrar la mitad vendida del 22F duplicada con su recompra 26A QP)
    const byCoCmp = {};
    data.pos.filter(p => p.estado === 'Activa').forEach(p => {
      const c = +p.commitment || 0;
      const v = +p.commitment_actual || 0;   // Account Balance (NAV marcado), para cuadrar con el KPI
      if (c <= 0 && v <= 0) return;
      (byCoCmp[p.company] ||= { c: 0, v: 0 });
      byCoCmp[p.company].c += c;
      byCoCmp[p.company].v += v;
    });
    const cmpArr = Object.entries(byCoCmp).sort((a, b) => b[1].v - a[1].v);
    if (cmpArr.length) {
      const labels = cmpArr.map(e => short(e[0]));
      const aportado = cmpArr.map(e => e[1].c);
      const valor = cmpArr.map(e => e[1].v);
      const maxV = Math.max(...aportado, ...valor.map(v => v || 0));
      const fmt = moneyAxisFmt(maxV);
      out.push(await renderChartPng({
        type: 'bar',
        data: { labels, datasets: [
          { label: 'Comprometido', data: aportado, backgroundColor: SLATE, borderRadius: 4, maxBarThickness: 64 },
          { label: 'Account Balance', data: valor, backgroundColor: MVP, borderRadius: 4, maxBarThickness: 64 },
        ] },
        options: {
          plugins: {
            legend: { position: 'top', labels: { font: { size: 13 }, usePointStyle: true, boxWidth: 8 } },
            title: { display: true, text: 'Comprometido vs. Account Balance', font: { size: 16, weight: '600' }, color: '#1a1f2e', padding: { bottom: 12 } },
          },
          scales: {
            y: { beginAtZero: true, ticks: { callback: fmt, font: { size: 12 }, color: '#6b7689' }, grid: { color: '#eef1f6' } },
            x: { ticks: { font: { size: 12 }, color: '#1a1f2e' }, grid: { display: false } },
          },
        },
      }, 640, 460));
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

    // 2) MOIC por posición — barras horizontales (verde >=1x, rojo <1x)
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
      }, 640, 460));
    }

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
      }, 640, 460));
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
      }, 640, 460));
    }
  } catch (e) {
    console.warn('[charts] no se pudo generar gráfica:', e);
  }
  return out;
}

// ════════ Gráficas NATIVAS de Excel (inyección OOXML sobre el .xlsx de ExcelJS) ════════
const CHART_PALETTE = ['E8650D', '8A93A6', 'F4A259', '4F5866', 'B04F0A', 'C4CBD6', 'FBCE9E', '2E3440', 'D97E3F', '6E7787'];
const C_NS = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const RL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const _chEsc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');  // NO escapa ' (refs de hoja)
let _jszipPromise = null;
function loadJSZip() {
  if (window.JSZip) return Promise.resolve();
  if (_jszipPromise) return _jszipPromise;
  _jszipPromise = new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js'; s.onload = res; s.onerror = () => { _jszipPromise = null; rej(new Error('No se pudo cargar JSZip')); }; document.head.appendChild(s); });
  return _jszipPromise;
}
function _chTitle(title) {
  if (!title) return '<c:autoTitleDeleted val="1"/>';
  return `<c:title><c:tx><c:rich><a:bodyPr rot="0" spcFirstLastPara="1" vertOverflow="ellipsis" wrap="square" anchor="ctr" anchorCtr="1"/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1100" b="1"><a:solidFill><a:srgbClr val="1A1F2E"/></a:solidFill><a:latin typeface="Calibri"/></a:defRPr></a:pPr><a:r><a:rPr lang="es-MX" sz="1100" b="1"><a:solidFill><a:srgbClr val="1A1F2E"/></a:solidFill></a:rPr><a:t>${_chEsc(title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>`;
}
function _chSer(s, i, cat, withColor) {
  const fill = withColor ? `<c:spPr><a:solidFill><a:srgbClr val="${s.color || CHART_PALETTE[i % CHART_PALETTE.length]}"/></a:solidFill></c:spPr>` : '';
  const nameRef = s.name ? `<c:tx><c:strRef><c:f>${_chEsc(s.name)}</c:f></c:strRef></c:tx>` : '';
  return `<c:ser><c:idx val="${i}"/><c:order val="${i}"/>${nameRef}${fill}<c:cat><c:strRef><c:f>${_chEsc(cat)}</c:f></c:strRef></c:cat><c:val><c:numRef><c:f>${_chEsc(s.val)}</c:f></c:numRef></c:val></c:ser>`;
}
function _chBar(spec, axA, axB) {
  const dir = spec.type === 'bar' ? 'bar' : 'col';
  const sers = spec.series.map((s, i) => _chSer(s, i, spec.cat, true)).join('');
  const catPos = spec.type === 'bar' ? 'l' : 'b', valPos = spec.type === 'bar' ? 'b' : 'l';
  const valFmt = spec.numFmt || '"$"#,##0';
  return `<c:barChart><c:barDir val="${dir}"/><c:grouping val="clustered"/><c:varyColors val="0"/>${sers}<c:gapWidth val="${spec.type === 'bar' ? 60 : 120}"/><c:axId val="${axA}"/><c:axId val="${axB}"/></c:barChart>` +
    `<c:catAx><c:axId val="${axA}"/><c:scaling><c:orientation val="${spec.type === 'bar' ? 'maxMin' : 'minMax'}"/></c:scaling><c:delete val="0"/><c:axPos val="${catPos}"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="${axB}"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>` +
    `<c:valAx><c:axId val="${axB}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${valPos}"/><c:majorGridlines><c:spPr><a:ln><a:solidFill><a:srgbClr val="EAEEF4"/></a:solidFill></a:ln></c:spPr></c:majorGridlines><c:numFmt formatCode="${_chEsc(valFmt)}" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="${axA}"/></c:valAx>`;
}
function _chPie(spec) {
  const tag = spec.type === 'doughnut' ? 'doughnutChart' : 'pieChart';
  const s = spec.series[0], colors = spec.colors || CHART_PALETTE, n = spec.nPoints || 8;
  let dpts = '';
  for (let i = 0; i < n; i++) dpts += `<c:dPt><c:idx val="${i}"/><c:bubble3D val="0"/><c:spPr><a:solidFill><a:srgbClr val="${colors[i % colors.length]}"/></a:solidFill><a:ln><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:ln></c:spPr></c:dPt>`;
  const dLbls = spec.pctLabels ? `<c:dLbls><c:numFmt formatCode="0%" sourceLinked="0"/><c:spPr><a:noFill/></c:spPr><c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="800" b="1"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:defRPr></a:pPr><a:endParaRPr lang="es-MX"/></a:p></c:txPr><c:showLegendKey val="0"/><c:showVal val="0"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="1"/><c:showBubbleSize val="0"/></c:dLbls>` : '';
  const hole = spec.type === 'doughnut' ? '<c:holeSize val="55"/>' : '';
  return `<c:${tag}><c:varyColors val="1"/><c:ser><c:idx val="0"/><c:order val="0"/>${s.name ? `<c:tx><c:strRef><c:f>${_chEsc(s.name)}</c:f></c:strRef></c:tx>` : ''}${dpts}${dLbls}<c:cat><c:strRef><c:f>${_chEsc(spec.cat)}</c:f></c:strRef></c:cat><c:val><c:numRef><c:f>${_chEsc(s.val)}</c:f></c:numRef></c:val></c:ser><c:firstSliceAng val="0"/>${hole}</c:${tag}>`;
}
function _chChartXml(spec, idx) {
  const axA = 100000000 + idx * 10, axB = 200000000 + idx * 10;
  const plot = (spec.type === 'pie' || spec.type === 'doughnut') ? _chPie(spec) : _chBar(spec, axA, axB);
  const legend = (spec.type === 'pie' || spec.type === 'doughnut') ? '<c:legend><c:legendPos val="r"/><c:overlay val="0"/></c:legend>' : (spec.series.length > 1 ? '<c:legend><c:legendPos val="t"/><c:overlay val="0"/></c:legend>' : '');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<c:chartSpace xmlns:c="${C_NS}" xmlns:a="${A_NS}" xmlns:r="${RL_NS}"><c:roundedCorners val="0"/><c:chart>${_chTitle(spec.title)}<c:plotArea><c:layout/>${plot}</c:plotArea>${legend}<c:plotVisOnly val="0"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>`;
}
function _chEmu(px) { return Math.round(px * 9525); }
function _chDrawingXml(specs) {
  const anchors = specs.map((spec, i) => { const a = spec.anchor; return `<xdr:oneCellAnchor><xdr:from><xdr:col>${a.col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${a.row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="${_chEmu(a.w || 460)}" cy="${_chEmu(a.h || 260)}"/><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${i + 2}" name="Chart ${i + 1}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="${C_NS}"><c:chart xmlns:c="${C_NS}" xmlns:r="${RL_NS}" r:id="rId${i + 1}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:oneCellAnchor>`; }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="${A_NS}">${anchors}</xdr:wsDr>`;
}
async function _chSheetFile(zip, sheetName) {
  const wb = await zip.file('xl/workbook.xml').async('string');
  const rels = await zip.file('xl/_rels/workbook.xml.rels').async('string');
  const m = [...wb.matchAll(/<sheet[^>]*name="([^"]*)"[^>]*r:id="([^"]*)"/g)];
  const target = m.find(x => x[1] === sheetName); if (!target) throw new Error('hoja: ' + sheetName);
  const rid = target[2];
  const rm = rels.match(new RegExp(`<Relationship[^>]*Id="${rid}"[^>]*Target="([^"]*)"`)) || rels.match(new RegExp(`<Relationship[^>]*Target="([^"]*)"[^>]*Id="${rid}"`));
  return 'xl/' + rm[1].replace(/^\/?xl\//, '').replace(/^\//, '');
}
async function injectNativeCharts(arrayBuffer, sheetName, specs) {
  if (!specs || !specs.length) return arrayBuffer;
  const zip = await window.JSZip.loadAsync(arrayBuffer);
  const sheetPath = await _chSheetFile(zip, sheetName);
  const sheetFile = sheetPath.split('/').pop(), drawingName = 'drawing1.xml';
  specs.forEach((spec, i) => zip.file(`xl/charts/chart${i + 1}.xml`, _chChartXml(spec, i)));
  zip.file(`xl/drawings/${drawingName}`, _chDrawingXml(specs));
  zip.file(`xl/drawings/_rels/${drawingName}.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` + specs.map((s, i) => `<Relationship Id="rId${i + 1}" Type="${RL_NS}/chart" Target="../charts/chart${i + 1}.xml"/>`).join('') + `</Relationships>`);
  const sheetRelsPath = `xl/worksheets/_rels/${sheetFile}.rels`; let drawRid;
  const existing = zip.file(sheetRelsPath);
  if (existing) { let xml = await existing.async('string'); const ids = [...xml.matchAll(/Id="rId(\d+)"/g)].map(m => +m[1]); drawRid = 'rId' + ((ids.length ? Math.max(...ids) : 0) + 1); xml = xml.replace('</Relationships>', `<Relationship Id="${drawRid}" Type="${RL_NS}/drawing" Target="../drawings/${drawingName}"/></Relationships>`); zip.file(sheetRelsPath, xml); }
  else { drawRid = 'rId1'; zip.file(sheetRelsPath, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="${drawRid}" Type="${RL_NS}/drawing" Target="../drawings/${drawingName}"/></Relationships>`); }
  let sheetXml = await zip.file(sheetPath).async('string');
  if (!/<drawing /.test(sheetXml)) {
    const dtag = `<drawing r:id="${drawRid}"/>`;             // debe ir ANTES del <extLst> de hoja (orden del schema)
    const li = sheetXml.lastIndexOf('<extLst>');
    if (li >= 0) sheetXml = sheetXml.slice(0, li) + dtag + sheetXml.slice(li);
    else sheetXml = sheetXml.replace('</worksheet>', dtag + '</worksheet>');
    if (!/xmlns:r=/.test(sheetXml)) sheetXml = sheetXml.replace('<worksheet ', `<worksheet xmlns:r="${RL_NS}" `);
    zip.file(sheetPath, sheetXml);
  }
  let ct = await zip.file('[Content_Types].xml').async('string');
  const adds = [`<Override PartName="/xl/drawings/${drawingName}" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`].concat(specs.map((s, i) => `<Override PartName="/xl/charts/chart${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`));
  zip.file('[Content_Types].xml', ct.replace('</Types>', adds.join('') + '</Types>'));
  return zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' });
}

async function exportInvestorXlsx(posId) {
  const lang = await pickExportLang(); if (!lang) return;
  const EN = lang === 'en';
  const T = (es, en) => (EN ? en : es);
  const XLS_EN = { 'Cuenta':'Account','Empresa':'Company','Serie':'Series','Subyacente':'Underlying','Compromiso':'Commitment','Distribuido':'Distributed','Dist. efectivo':'Cash Dist.','Dist. especie':'In-Kind Dist.','Acciones dist.':'Shares Dist.','Distribuido en':'Distributed On','Carry':'Carry','Acciones':'Shares','EV Entrada':'Entry EV','PPS Entrada':'Entry PPS','EV Actual':'Current EV','PPS Actual':'Current PPS','Valor estimado':'Estimated Value','Inicio':'Start','Fin':'End','Duración':'Duration','Última carta':'Latest Letter','Cerrada':'Closed','Fecha':'Date','Tipo':'Type','Efectivo':'Cash','En especie':'In-Kind','Carta':'Letter','Notas':'Notes','Serie vendida':'Series Sold','Vendido':'Sold','Reinvertido':'Reinvested','Efectivo neto':'Net Cash' };
  const TC = (h) => (EN ? (XLS_EN[h] || h) : h);
  const data = buildInvestorExport(posId);
  if (!data) { toast('Abre un inversionista primero'); return; }
  if (posId != null && !data.pos.length) { toast('No encontré esa posición'); return; }
  const single = posId != null;
  const extra = single && data.pos[0] ? data.pos[0].company : '';
  try {
    await loadScript('https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js');
    await loadJSZip();
    const wb = new ExcelJS.Workbook();
    wb.creator = 'MVP Manager';

    const NAVY = 'FF17436B', ORANGE = 'FFE8650D', GREEN = 'FF0F9B5A', GRAY = 'FF8A93A6', INK = 'FF1A1F2E', SLATE = 'FF8A93A6', ZEBRA = 'FFF4F7FC', CARD = 'FFF7F9FC', BORDER = 'FFDDE3EC', WHITE = 'FFFFFFFF';
    const Z = { money: '"$"#,##0', money2: '"$"#,##0.00', pct: '0.0%', moic: '0.00"x"', sh: '#,##0', evb: '"$"#,##0.00"B"', yrs: '0.00" yrs"' };
    const t = data.totals;
    const combined = !!data.combined;
    const thin = { style: 'thin', color: { argb: BORDER } };
    const border = { top: thin, left: thin, bottom: thin, right: thin };
    const cleanSer = s => String(s || '').replace(/MVP Opportunity (Fund VI LLC, )?/i, '').replace(/Series /i, '');
    const colL = n => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; } return s; };

    // ===== RESUMEN (limpio: KPIs + gráficas, como el header del 360) =====
    const R = wb.addWorksheet(T('Resumen', 'Summary'), { views: [{ showGridLines: false }] });
    R.mergeCells('A1:H1'); R.getCell('A1').value = data.inv.name; R.getCell('A1').font = { size: 22, bold: true, color: { argb: ORANGE } }; R.getRow(1).height = 30;
    R.mergeCells('A2:H2');
    const sub = [];
    if (data.inv._accounts) sub.push(data.inv._accounts.map(a => a.name).join(' + '));
    else if (data.inv.titular) sub.push(T('Titular: ', 'Holder: ') + data.inv.titular);
    if (single && data.pos[0]) sub.push(data.pos[0].company + ' · ' + data.pos[0].series);
    else sub.push(data.pos.length + T(' posiciones', ' positions'));
    sub.push(T('Generado ', 'Generated ') + new Date().toLocaleDateString(EN ? 'en-US' : 'es-MX'));
    R.getCell('A2').value = sub.join('   ·   '); R.getCell('A2').font = { size: 10, color: { argb: GRAY } };
    const kbar = [[T('COMPROMISO TOTAL','TOTAL COMMITMENT'), t.totCommit, Z.money, ORANGE], ['ACCOUNT BALANCE', t.totActual, Z.money, INK], ['ACCOUNT BALANCE + DIST.', (+t.totActual || 0) + (+t.totDist || 0), Z.money, GREEN], [T('DISTRIBUIDO','DISTRIBUTED'), t.totDist, Z.money, INK], ['MOIC', t.portMoic, Z.moic, INK], ['DPI', t.dpi, Z.moic, INK]];
    kbar.forEach((k, i) => { const col = i + 1; const lc = R.getCell(4, col); lc.value = k[0]; lc.font = { size: 7.5, bold: true, color: { argb: GRAY } }; lc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CARD } }; lc.border = { top: border.top, left: border.left, right: border.right };
      const vc = R.getCell(5, col); vc.value = k[1]; if (typeof k[1] === 'number') vc.numFmt = k[2]; vc.font = { size: 13, bold: true, color: { argb: k[3] } }; vc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CARD } }; vc.border = { bottom: border.bottom, left: border.left, right: border.right }; R.getColumn(col).width = 17; });
    R.getRow(5).height = 22;

    // ===== DATOS (oculta) — fuente de las gráficas =====
    const DT = wb.addWorksheet('Datos', { state: 'hidden' });
    const active = data.pos.filter(p => p.estado === 'Activa');
    const byCo = {};
    active.forEach(p => { const k = p.company; (byCo[k] || (byCo[k] = { c: 0, a: 0, d: 0 })); byCo[k].c += +p.commitment || 0; byCo[k].a += +p.commitment_actual || 0; });
    data.pos.forEach(p => { const k = p.company; (byCo[k] || (byCo[k] = { c: 0, a: 0, d: 0 })); byCo[k].d += +p.distribuido || 0; });
    const coArr = Object.entries(byCo).sort((a, b) => b[1].a - a[1].a);
    const byTh = {}; active.forEach(p => { let k = p.theme || companyTheme(p.company); if (EN) k = xlateText(k) || k; byTh[k] = (byTh[k] || 0) + (+p.commitment_actual || 0); });
    const thArr = Object.entries(byTh).sort((a, b) => b[1] - a[1]);
    const moicArr = active.filter(p => p.moic != null).sort((a, b) => b.moic - a.moic).slice(0, 8);
    DT.getCell('A1').value = T('Empresa','Company'); DT.getCell('B1').value = T('Comprometido','Committed'); DT.getCell('C1').value = 'Account Balance';
    coArr.forEach(([nm, d], i) => { DT.getCell(2 + i, 1).value = nm; DT.getCell(2 + i, 2).value = d.c; DT.getCell(2 + i, 3).value = d.a; });
    const empN = coArr.length + 1;
    DT.getCell('F1').value = T('Tema','Theme'); DT.getCell('G1').value = 'Account Balance';
    thArr.forEach(([nm, v], i) => { DT.getCell(2 + i, 6).value = nm; DT.getCell(2 + i, 7).value = v; });
    const thN = thArr.length + 1;
    DT.getCell('I1').value = T('Posición','Position'); DT.getCell('J1').value = 'MOIC';
    moicArr.forEach((p, i) => { DT.getCell(2 + i, 9).value = p.company + (p.series ? ' · ' + cleanSer(p.series) : ''); DT.getCell(2 + i, 10).value = p.moic; });
    const moN = moicArr.length + 1;

    const specs = [
      { type: 'col', title: T('Comprometido vs. Account Balance · por empresa','Committed vs. Account Balance · by Company'), anchor: { col: 0, row: 6, w: 480, h: 255 }, cat: `'Datos'!$A$2:$A$${empN}`, series: [{ name: `'Datos'!$B$1`, val: `'Datos'!$B$2:$B$${empN}`, color: '8A93A6' }, { name: `'Datos'!$C$1`, val: `'Datos'!$C$2:$C$${empN}`, color: 'E8650D' }] },
      { type: 'doughnut', title: T('Composición por empresa','Composition by Company'), anchor: { col: 8, row: 6, w: 410, h: 255 }, cat: `'Datos'!$A$2:$A$${empN}`, nPoints: coArr.length, pctLabels: true, series: [{ val: `'Datos'!$C$2:$C$${empN}` }] },
      { type: 'bar', title: T('MOIC por posición','MOIC by Position'), anchor: { col: 0, row: 21, w: 480, h: 250 }, cat: `'Datos'!$I$2:$I$${moN}`, numFmt: '0.0"x"', series: [{ val: `'Datos'!$J$2:$J$${moN}`, color: '0F9B5A' }] },
      { type: 'doughnut', title: T('Exposición por tema','Exposure by Theme'), anchor: { col: 8, row: 21, w: 410, h: 250 }, cat: `'Datos'!$F$2:$F$${thN}`, nPoints: thArr.length, pctLabels: true, series: [{ val: `'Datos'!$G$2:$G$${thN}` }] },
    ];

    // ===== POSICIONES (activas / terminadas — TODAS las columnas del detalle) =====
    const PS = wb.addWorksheet(T('Posiciones','Positions'), { views: [{ showGridLines: false }] });
    const acct = combined; let pr = 1;
    // Alineación por tipo: columnas con formato numérico → derecha; texto/fecha/enlace → izquierda.
    const drawSection = (title, rows, cols, fmts) => {
      const hc = PS.getCell(pr, 1); hc.value = `${title} (${rows.length})`; hc.font = { size: 12, bold: true, color: { argb: NAVY } }; pr++;
      const headerRow = pr;
      cols.forEach((h, i) => { const c = PS.getCell(pr, i + 1); c.value = h; c.font = { bold: true, color: { argb: WHITE }, size: 9.5 }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }; c.alignment = { horizontal: fmts[i] ? 'right' : 'left', vertical: 'middle' }; c.border = border; });
      PS.getRow(pr).height = 17; pr++;
      const start = pr;
      rows.forEach((vals, ri) => { vals.forEach((v, i) => { const c = PS.getCell(pr, i + 1); c.value = (v == null ? null : v); c.font = { size: 9.5, color: { argb: INK } }; c.alignment = { horizontal: fmts[i] ? 'right' : 'left' }; c.border = border; if (ri % 2 === 1) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ZEBRA } }; if (fmts[i]) c.numFmt = fmts[i]; }); pr++; });
      const end = pr - 1; pr += 1;
      return { headerRow, start, end };
    };
    const carta = (p) => p.carta_ca ? { text: 'Ver carta', hyperlink: p.carta_ca } : '—';
    const actCols = (acct ? ['Cuenta'] : []).concat(['Empresa', 'Serie', 'Compromiso', 'Account Balance', 'Distribuido', 'Dist. efectivo', 'Dist. especie', 'Acciones dist.', 'Distribuido en', 'MOIC', 'Carry', 'Acciones', 'EV Entrada', 'PPS Entrada', 'EV Actual', 'PPS Actual', 'Valor estimado', 'Inicio', 'Fin', 'Duración', 'Última carta']);
    const actFmt = (acct ? [null] : []).concat([null, null, Z.money, Z.money, Z.money, Z.money, Z.money, Z.sh, null, Z.moic, Z.pct, Z.sh, Z.evb, Z.money2, Z.evb, Z.money2, Z.money, null, null, Z.yrs, null]);
    const actRows = active.map(p => (acct ? [p.cuenta || '—'] : []).concat([p.company, cleanSer(p.series), +p.commitment || 0, +p.commitment_actual || 0, +p.distribuido || 0, p.dist_cash, p.dist_inkind, p.dist_shares, p.dist_en, p.moic, p.carry, p.shares, p.entry_ev_b, p.entry_pps, p.current_ev_b, p.current_pps, p.valor_estimado, p.inicio || '', p.fin || '', p.duracion, carta(p)]));
    const SA = drawSection(T('POSICIONES ACTIVAS','ACTIVE POSITIONS'), actRows, actCols.map(TC), actFmt);
    const term = data.pos.filter(p => p.estado !== 'Activa');
    const termCols = (acct ? ['Cuenta'] : []).concat(['Empresa', 'Serie', 'Compromiso', 'Distribuido', 'Dist. efectivo', 'Dist. especie', 'Acciones dist.', 'Distribuido en', 'MOIC', 'Carry', 'Acciones', 'Inicio', 'Fin', 'Duración', 'Última carta']);
    const termFmt = (acct ? [null] : []).concat([null, null, Z.money, Z.money, Z.money, Z.money, Z.sh, null, Z.moic, Z.pct, Z.sh, null, null, Z.yrs, null]);
    const termRows = term.map(p => (acct ? [p.cuenta || '—'] : []).concat([p.company, cleanSer(p.series), +p.commitment || 0, +p.distribuido || 0, p.dist_cash, p.dist_inkind, p.dist_shares, p.dist_en, p.moic, p.carry, p.shares, p.inicio || '', p.fin || '', p.duracion, carta(p)]));
    const ST = term.length ? drawSection(T('POSICIONES TERMINADAS','CLOSED POSITIONS'), termRows, termCols.map(TC), termFmt) : null;
    // Formato condicional: índices calculados por nombre de columna (robusto ante cambios de columnas).
    const csRule = { type: 'colorScale', cfvo: [{ type: 'num', value: 0 }, { type: 'num', value: 1 }, { type: 'max' }], color: [{ argb: 'FFF8696B' }, { argb: 'FFFFEB84' }, { argb: 'FF63BE7B' }] };
    const barRule = (argb) => ({ type: 'dataBar', cfvo: [{ type: 'min' }, { type: 'max' }], color: { argb }, gradient: false });
    if (actRows.length) {
      const mI = actCols.indexOf('MOIC') + 1, aI = actCols.indexOf('Account Balance') + 1;
      if (mI) { const mC = colL(mI); PS.addConditionalFormatting({ ref: `${mC}${SA.start}:${mC}${SA.end}`, rules: [csRule] }); }
      if (aI) { const aC = colL(aI); PS.addConditionalFormatting({ ref: `${aC}${SA.start}:${aC}${SA.end}`, rules: [barRule(ORANGE)] }); }
    }
    if (ST) {
      const mI = termCols.indexOf('MOIC') + 1, dI = termCols.indexOf('Distribuido') + 1;
      if (mI) { const mC = colL(mI); PS.addConditionalFormatting({ ref: `${mC}${ST.start}:${mC}${ST.end}`, rules: [csRule] }); }
      if (dI) { const dC = colL(dI); PS.addConditionalFormatting({ ref: `${dC}${ST.start}:${dC}${ST.end}`, rules: [barRule(GREEN)] }); }
    }
    PS.views = [{ state: 'frozen', ySplit: SA.headerRow, showGridLines: false }];
    ((acct ? [20] : []).concat([24, 18, 15, 16, 14, 13, 13, 13, 22, 9, 8, 11, 11, 12, 11, 12, 15, 12, 12, 10, 12])).forEach((w, i) => PS.getColumn(i + 1).width = w);

    // ===== RECOMPRAS =====
    const reps = [];
    data.pos.forEach(p => (p._dists || []).forEach(d => { if (/reinver|reinvest/i.test(d.notes || '')) reps.push({ ...d, _company: p.company, _series: p.series }); }));
    if (reps.length) {
      const ids = combined ? (data.inv._accounts || []).map(a => a.id) : (data.inv.id != null ? [data.inv.id] : []);
      const rnet = computeReinvestNetting(data.pos.map(p => ({ seriesName: p.series, commitment: +p.commitment || 0, dists: p._dists })), ids);
      let remR = rnet.reinvestedDist;
      reps.sort((a, b) => (b.distribution_date || '').localeCompare(a.distribution_date || ''));
      reps.forEach(d => { const g = (+d.cash_proceeds || 0) + (+d.value_in_kind || 0); const rv = Math.min(remR, g); remR -= rv; d._g = g; d._r = rv; d._c = g - rv; });
      const RP = wb.addWorksheet(T('Recompras','Repurchases'), { views: [{ state: 'frozen', ySplit: 1, showGridLines: false }] });
      ['Fecha', 'Empresa', 'Serie vendida', 'Acciones', 'Vendido', 'Reinvertido', 'Efectivo neto'].map(TC).forEach((h, i) => { const c = RP.getCell(1, i + 1); c.value = h; c.font = { bold: true, color: { argb: WHITE }, size: 10 }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }; c.alignment = { horizontal: i < 3 ? 'left' : 'right' }; });
      reps.forEach((d, i) => { const row = RP.getRow(2 + i); [d.distribution_date, d._company, cleanSer(d._series), d.shares_distributed, d._g, d._r, d._c].forEach((v, j) => { const c = row.getCell(j + 1); c.value = v; c.font = { size: 9.5, color: { argb: INK } }; c.alignment = { horizontal: j < 3 ? 'left' : 'right' }; if (j === 3) c.numFmt = Z.sh; if (j >= 4) c.numFmt = Z.money; }); });
      [22, 22, 28, 12, 15, 15, 15].forEach((w, i) => RP.getColumn(i + 1).width = w); RP.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 7 } };
    }

    // ===== DISTRIBUCIONES (todas, con subyacente, especie, carta y notas) =====
    if (data.letters && data.letters.length) {
      const DD = wb.addWorksheet(T('Distribuciones','Distributions'), { views: [{ state: 'frozen', ySplit: 1, showGridLines: false }] });
      const dCols = ['Empresa', 'Serie', 'Subyacente', 'Fecha', 'Tipo', 'Acciones', 'PPS', 'Efectivo', 'En especie', 'Total', 'Carta', 'Notas'].map(TC);
      const dNum = new Set([5, 6, 7, 8, 9]);   // índices (0-based) de columnas numéricas → derecha
      dCols.forEach((h, i) => { const c = DD.getCell(1, i + 1); c.value = h; c.font = { bold: true, color: { argb: WHITE }, size: 10 }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }; c.alignment = { horizontal: dNum.has(i) ? 'right' : 'left' }; });
      data.letters.forEach((x, i) => { const row = DD.getRow(2 + i); [x.company, cleanSer(x.series), x.subyacente || '', x.fecha, x.tipo, x.shares, x.pps, x.cash, x.especie, x.total, (x.carta ? { text: 'Ver carta', hyperlink: x.carta } : '—'), x.notas || ''].forEach((v, j) => { const c = row.getCell(j + 1); c.value = v; c.font = { size: 9.5, color: { argb: INK } }; c.alignment = { horizontal: dNum.has(j) ? 'right' : 'left' }; if (j === 5) c.numFmt = Z.sh; if (j === 6) c.numFmt = Z.money2; if (j >= 7 && j <= 9) c.numFmt = Z.money; }); });
      [22, 16, 18, 12, 12, 11, 11, 14, 14, 14, 10, 30].forEach((w, i) => DD.getColumn(i + 1).width = w); DD.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: dCols.length } };
    }

    // ===== CONTACTOS =====
    if (data.contacts && data.contacts.length) {
      const CT = wb.addWorksheet('Contactos', { views: [{ state: 'frozen', ySplit: 1, showGridLines: false }] });
      ['Nombre', 'Email'].forEach((h, i) => { const c = CT.getCell(1, i + 1); c.value = h; c.font = { bold: true, color: { argb: WHITE }, size: 10 }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }; c.alignment = { horizontal: 'left' }; });
      data.contacts.forEach((ct, i) => { const row = CT.getRow(2 + i); [ct.name || '—', ct.email || '—'].forEach((v, j) => { const c = row.getCell(j + 1); c.value = v; c.font = { size: 10, color: { argb: INK } }; if (i % 2 === 1) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ZEBRA } }; }); });
      [32, 36].forEach((w, i) => CT.getColumn(i + 1).width = w);
    }

    const buf = await wb.xlsx.writeBuffer();
    const out = await injectNativeCharts(buf, 'Resumen', specs);
    downloadBlob(new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), invExportFilename(data.inv, extra) + '.xlsx');
    toast(single ? `Excel: ${extra}` : `Excel: ${data.pos.length} posiciones · ${data.letters.length} cartas`);
  } catch (e) {
    console.error('[export inv xlsx]', e);
    toast('Error al exportar: ' + e.message);
  }
}

// ── Reporte premium: HTML→PDF con el propio Chrome del navegador (window.print) ──
// Privado (nada sale del navegador), $0, sin infra. Output = el prototipo aprobado.
const REPORT_FONT_FACES = [
  ['Outfit', 400, 'Outfit-Regular.ttf'], ['Outfit', 700, 'Outfit-Bold.ttf'],
  ['Instrument', 400, 'InstrumentSans-Regular.ttf'], ['Instrument', 700, 'InstrumentSans-Bold.ttf'],
  ['Geist', 400, 'GeistMono-Regular.ttf'],
].map(([f, w, file]) => `@font-face{font-family:'${f}';font-weight:${w};src:url('/fonts/${file}') format('truetype');}`).join('\n');

function buildReportHtmlClient(payload, lang) {
  const EN = lang === 'en';
  const T = (es, en) => (EN ? en : es);
  const TH = (t) => (EN ? (xlateText(t) || t) : t);
  const { meta, totals, pos, dists = [] } = payload;
  const PAL = ['#E8650D', '#8A93A6', '#F4A259', '#4F5866', '#B04F0A', '#C4CBD6', '#FBCE9E', '#2E3440', '#D97E3F', '#6E7787'];
  const E = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const N = (v) => { const x = Number(v); return Number.isFinite(x) ? x : null; };
  const M = (v) => { if (v == null || !Number.isFinite(+v)) return '—'; v = +v; const a = Math.abs(v); return a >= 1e6 ? '$' + (v / 1e6).toFixed(2) + 'M' : a >= 1e3 ? '$' + (v / 1e3).toFixed(1) + 'K' : '$' + v.toFixed(0); };
  const PP = (v) => { const x = N(v); return x == null ? '—' : '$' + x.toFixed(2); };
  const SS = (s) => String(s || '').replace('MVP Opportunity Fund VI LLC, ', '').replace('MVP Opportunity Series ', 'Serie ').replace('MVP ', '');
  const donut = (items, size = 132, stroke = 25) => {
    const tot = items.reduce((s, [, v]) => s + v, 0) || 1, r = (size - stroke) / 2, c = size / 2, C = 2 * Math.PI * r;
    let off = 0, segs = '';
    items.forEach(([, v], i) => { const seg = v / tot * C; segs += `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${PAL[i % PAL.length]}" stroke-width="${stroke}" stroke-dasharray="${seg.toFixed(2)} ${(C - seg).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 ${c} ${c})"/>`; off += seg; });
    const leg = items.map(([l, v], i) => `<div class="lg"><span class="dot" style="background:${PAL[i % PAL.length]}"></span>${E(l)} <b>${(v / tot * 100).toFixed(0)}%</b></div>`).join('');
    return `<div class="donutwrap"><svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${segs}</svg><div class="legend">${leg}</div></div>`;
  };
  const active = pos.filter(p => p.estado === 'Activa');
  const aggBy = (k) => { const d = {}; active.forEach(p => { const v = +p.commitment_actual || 0; if (v > 0) d[p[k]] = (d[p[k]] || 0) + v; }); return Object.entries(d).sort((a, b) => b[1] - a[1]); };
  let byco = aggBy('company'); if (byco.length > 7) byco = byco.slice(0, 6).concat([[T('Otros', 'Other'), byco.slice(6).reduce((s, [, v]) => s + v, 0)]]);
  const bytheme = aggBy('theme').map(([l, v]) => [TH(l), v]);
  const moicp = active.filter(p => N(p.moic) != null).sort((a, b) => b.moic - a.moic).slice(0, 8);
  const mxM = Math.max(1, ...moicp.map(p => +p.moic));
  const moicbars = moicp.map(p => { const m = +p.moic, col = m >= 1 ? '#E8650D' : '#b08968'; return `<div class="barrow"><span class="bn">${E(p.company)}</span><span class="bt"><span class="bf" style="width:${(m / mxM * 100).toFixed(0)}%;background:${col}"></span></span><span class="bv">${m.toFixed(2)}x</span></div>`; }).join('');
  const cv = {}; active.forEach(p => { const d = cv[p.company] || (cv[p.company] = { c: 0, v: 0 }); d.c += +p.commitment || 0; d.v += +p.commitment_actual || 0; });
  const cvl = Object.entries(cv).sort((a, b) => b[1].v - a[1].v).slice(0, 7);
  const mxCv = Math.max(1, ...cvl.map(([, d]) => Math.max(d.c, d.v)));
  const cvbars = cvl.map(([co, d]) => `<div class="cvrow"><span class="bn">${E(co)}</span><span class="cvbars"><span class="cvb"><span class="cvf gray" style="width:${(d.c / mxCv * 100).toFixed(0)}%"></span></span><span class="cvb"><span class="cvf orange" style="width:${(d.v / mxCv * 100).toFixed(0)}%"></span></span></span><span class="bv">${M(d.v)}</span></div>`).join('');
  const kpis = [[T('Compromiso total','Total Commitment'), M(totals.compromiso), 'accent'], ['Account Balance', M(totals.nav), ''], ['Account Balance + Dist.', M((+totals.nav || 0) + (+totals.distribuido || 0)), 'pos'], [T('Distribuido','Distributed'), M(totals.distribuido), ''], ['MOIC', (+totals.moic).toFixed(2) + 'x', ''], ['DPI', (+totals.dpi).toFixed(2) + 'x', '']];
  const kpihtml = kpis.map(([l, v, c]) => `<div class="kpi ${c}"><div class="kl">${E(l)}</div><div class="kv">${E(v)}</div></div>`).join('');
  const showAcct = !!meta.combined;
  const rows = pos.filter(p => !p.reinvSource).slice().sort((a, b) => (+b.commitment || 0) - (+a.commitment || 0));
  const posrows = rows.map(p => { const on = p.estado === 'Activa'; return `<tr>${showAcct ? `<td class="acct" title="${E(p.acct)}">${E(p.acct)}</td>` : ''}<td class="co">${E(p.company)}</td><td class="ser">${E(SS(p.series))}</td><td><span class="badge ${on ? 'on' : 'off'}">${E(EN ? (on ? 'Active' : 'Closed') : p.estado)}</span></td><td class="n">${p.shares != null ? Number(p.shares).toLocaleString('en-US') : '—'}</td><td class="n">${PP(p.entry_pps)}</td><td class="n">${PP(p.current_pps)}</td><td class="n">${M(p.commitment)}</td><td class="n">${M(p.commitment_actual)}</td><td class="n">${p.distribuido ? M(p.distribuido) : '—'}</td><td class="n">${N(p.moic) != null ? (+p.moic).toFixed(2) + 'x' : '—'}</td></tr>`; }).join('');
  const acctHead = showAcct ? '<th>Cuenta</th>' : '';
  // Sección de distribuciones (todas): fecha, subyacente, tipo (efectivo/especie), montos
  const distSection = dists.length ? `<div class="sec">Distribuciones</div>
<table><thead><tr><th>Fecha</th><th>Empresa</th><th>Subyacente</th><th>Tipo</th><th class="n">Acciones</th><th class="n">PPS</th><th class="n">Efectivo</th><th class="n">En especie</th><th class="n">Total</th></tr></thead><tbody>${dists.map(d => `<tr><td>${E(d.fecha || '—')}</td><td class="co">${E(d.company)}</td><td class="ser">${E(d.subyacente || '—')}</td><td>${E(d.tipo)}</td><td class="n">${d.shares != null ? Number(d.shares).toLocaleString('en-US') : '—'}</td><td class="n">${PP(d.pps)}</td><td class="n">${d.cash != null ? M(d.cash) : '—'}</td><td class="n">${d.especie != null ? M(d.especie) : '—'}</td><td class="n">${M(d.total)}</td></tr>`).join('')}</tbody></table>` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@page{size:Letter;margin:0}
${REPORT_FONT_FACES}
*{margin:0;padding:0;box-sizing:border-box}
html,body{background:#fff}
body{font-family:'Instrument',sans-serif;color:#241f1b;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.page{width:816px;padding:0 0 20px}
.topbar{height:5px;background:#E8650D}
.hero{background:#f5f3f0;padding:20px 40px 15px;border-bottom:1px solid #e8e3dd}
.eyebrow{font-family:'Geist',monospace;font-size:9.5px;letter-spacing:3px;color:#E8650D;text-transform:uppercase}
.htitle{font-family:'Outfit',sans-serif;font-weight:700;font-size:30px;color:#2a2521;margin:6px 0 4px;letter-spacing:-.5px}
.hsub{font-size:11.5px;color:#6e655d}.hsub b{color:#2a2521;font-weight:700}
.accentbar{height:3px;width:92px;background:#E8650D;margin-top:11px;border-radius:2px}
.body{padding:15px 40px 0}
.kpis{display:grid;grid-template-columns:repeat(6,1fr);gap:9px;margin-bottom:13px}
.kpi{background:#fff;border:1px solid #e8e3dd;border-radius:11px;padding:11px 12px}
.kpi.accent{border-top:3px solid #E8650D}
.kl{font-family:'Geist',monospace;font-size:7.5px;letter-spacing:.8px;text-transform:uppercase;color:#9a8f84}
.kv{font-family:'Outfit',sans-serif;font-weight:700;font-size:17px;margin-top:5px;letter-spacing:-.5px;color:#2a2521}
.kpi.accent .kv{color:#E8650D}.kpi.pos .kv{color:#3d8a52}.kpi.neg .kv{color:#b8472c}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:12px}
.card{background:#fff;border:1px solid #e8e3dd;border-radius:14px;padding:15px 17px}
.ctitle{font-family:'Outfit',sans-serif;font-weight:700;font-size:12.5px;margin-bottom:11px;display:flex;align-items:center;gap:7px;color:#2a2521}
.ctitle::before{content:'';width:8px;height:8px;border-radius:2px;background:#E8650D}
.donutwrap{display:flex;align-items:center;gap:12px}
.legend{font-size:10px;line-height:1.65;color:#4a423b}.lg{white-space:nowrap}
.dot{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:5px;vertical-align:middle}.lg b{color:#241f1b}
.barrow{display:flex;align-items:center;gap:9px;margin-bottom:7px;font-size:10px}
.bn{width:96px;color:#4a423b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt{flex:1;height:8px;background:#efeae4;border-radius:5px;overflow:hidden}
.bf{display:block;height:100%;border-radius:5px}
.bv{width:54px;text-align:right;font-family:'Geist',monospace;font-size:9.5px;color:#241f1b}
.cvrow{display:flex;align-items:center;gap:9px;margin-bottom:7px;font-size:10px}
.cvbars{flex:1;display:flex;flex-direction:column;gap:2px}
.cvb{height:6px;background:#efeae4;border-radius:4px;overflow:hidden}
.cvf{display:block;height:100%;border-radius:4px}
.cvf.gray{background:#c3b8ab}.cvf.orange{background:#E8650D}
.leg2{font-size:8px;color:#9a8f84;font-family:'Geist',monospace;margin-bottom:8px}
.sec{font-family:'Outfit',sans-serif;font-weight:700;font-size:13px;margin:2px 0 8px;display:flex;align-items:center;gap:8px;color:#2a2521}
.sec::before{content:'';width:4px;height:14px;background:#E8650D;border-radius:2px}
table{width:100%;border-collapse:collapse;font-size:9.5px}
thead{display:table-header-group}
tbody tr{break-inside:avoid}
thead th{background:#3f3a36;color:#fff;font-family:'Geist',monospace;font-weight:400;font-size:8px;letter-spacing:.4px;text-transform:uppercase;padding:7px 8px;text-align:left}
thead th.n{text-align:right}
tbody td{padding:6px 8px;border-bottom:1px solid #efeae4;color:#473f38}
tbody tr:nth-child(even){background:#faf8f5}
td.n{text-align:right;font-family:'Geist',monospace;font-size:9px;color:#241f1b}
td.co{font-weight:700;color:#241f1b}td.acct{color:#9a8f84;font-size:8.5px;max-width:120px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}td.ser{color:#6e655d;font-size:8.5px}
.badge{font-size:8px;font-weight:700;padding:2px 7px;border-radius:20px}
.badge.on{background:#e9f3ec;color:#3d8a52}.badge.off{background:#efeae4;color:#9a8f84}
.foot{margin:12px 40px 0;padding-top:9px;border-top:1px solid #efeae4;font-family:'Geist',monospace;font-size:8px;color:#a89e93;letter-spacing:.4px}
</style></head><body><div class="page">
<div class="topbar"></div>
<div class="hero"><div class="eyebrow">MVP · ${meta.single ? T('Reporte de oportunidad','Opportunity Report') : T('Reporte de portafolio','Portfolio Report')}</div>
<div class="htitle">${E(TH(meta.title))}</div>
<div class="hsub">${meta.accountsLine ? E(meta.accountsLine) + ' · ' : ''}${meta.count} ${T('posiciones','positions')} · ${T('Generado','Generated')} ${E(meta.dateStr)}</div>
<div class="accentbar"></div></div>
<div class="body">
<div class="kpis">${kpihtml}</div>
<div class="grid2">
<div class="card"><div class="ctitle">${T('Composición por empresa','Composition by Company')}</div>${donut(byco)}</div>
<div class="card"><div class="ctitle">${T('Exposición por tema','Exposure by Theme')}</div>${donut(bytheme)}</div>
</div>
<div class="grid2">
<div class="card"><div class="ctitle">${T('MOIC por posición','MOIC by Position')}</div>${moicbars}</div>
<div class="card"><div class="ctitle">${T('Comprometido vs. Account Balance · por empresa','Committed vs. Account Balance · by Company')}</div><div class="leg2">${T('▮ gris = comprometido · ▮ naranja = Account Balance','▮ gray = committed · ▮ orange = Account Balance')}</div>${cvbars}</div>
</div>
<div class="sec">${T('Posiciones','Positions')}</div>
<table><thead><tr>${acctHead}<th>${T('Empresa','Company')}</th><th>${T('Serie','Series')}</th><th>${T('Estado','Status')}</th><th class="n">${T('Acciones','Shares')}</th><th class="n">${T('PPS Entrada','Entry PPS')}</th><th class="n">${T('PPS Actual','Current PPS')}</th><th class="n">${T('Compromiso','Commitment')}</th><th class="n">Account Balance</th><th class="n">${T('Distribuido','Distributed')}</th><th class="n">MOIC</th></tr></thead><tbody>${posrows}</tbody></table>
${distSection}
</div>
<div class="foot">MVP MANAGER · ${T('DOCUMENTO INTERNO','INTERNAL DOCUMENT')} · ${E(meta.dateStr)}</div>
</div></body></html>`;
}

// Renderiza el HTML en un iframe fuera de pantalla, lo captura y genera el PDF como
// DESCARGA REAL (aparece en la barra de descargas, con nombre propio). Diseño idéntico.
async function renderReportPdf(html, fileName) {
  const old = document.getElementById('reportPrintFrame');
  if (old) old.remove();
  const iframe = document.createElement('iframe');
  iframe.id = 'reportPrintFrame';
  iframe.style.cssText = 'position:absolute;left:-10000px;top:0;width:816px;height:1120px;border:0;background:#fff';
  document.body.appendChild(iframe);
  try {
    const doc = iframe.contentWindow.document;
    doc.open(); doc.write(html); doc.close();
    await new Promise(r => setTimeout(r, 80));
    try { if (doc.fonts && doc.fonts.ready) await doc.fonts.ready; } catch (e) { /* noop */ }
    await new Promise(r => setTimeout(r, 180));
    const el = doc.querySelector('.page') || doc.body;
    const h = Math.ceil(el.getBoundingClientRect().height) + 4;
    iframe.style.height = (h + 30) + 'px';
    // html2canvas renderiza en el documento principal → asegurar las fuentes también aquí
    if (!document.getElementById('reportFontFaces')) {
      const st = document.createElement('style'); st.id = 'reportFontFaces'; st.textContent = REPORT_FONT_FACES; document.head.appendChild(st);
    }
    try { await document.fonts.ready; } catch (e) { /* noop */ }
    await loadScript('https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js');
    await loadScript('https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js');
    const SCALE = 4;   // ~400 DPI: texto nitido incluso con zoom (antes 2.5)
    const canvas = await window.html2canvas(el, { scale: SCALE, backgroundColor: '#ffffff', width: 816, height: h, windowWidth: 816, useCORS: true, logging: false });
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
    const pageW = pdf.internal.pageSize.getWidth(), pageH = pdf.internal.pageSize.getHeight();
    const ptPerPx = pageW / canvas.width;          // px de canvas → pt
    const pageHpx = pageH / ptPerPx;               // altura de una página en px de canvas
    if (canvas.height <= pageHpx + 2) {
      // Cabe en una sola página
      pdf.addImage(canvas.toDataURL('image/jpeg', 0.93), 'JPEG', 0, 0, pageW, canvas.height * ptPerPx);
    } else {
      // Cortes "seguros": el fondo (bottom) de cada fila y bloque, para NO partir una fila a la mitad.
      // Solo tbody tr (no thead): cortar justo tras el encabezado dejaría un header huérfano al pie.
      const pageTop = el.getBoundingClientRect().top;
      const safe = [];
      el.querySelectorAll('tbody tr, .kpis, .grid2, .hero, .sec, .card').forEach(n => {
        const b = (n.getBoundingClientRect().bottom - pageTop) * SCALE;
        if (b > 1 && b < canvas.height) safe.push(b);
      });
      safe.push(canvas.height);
      safe.sort((a, b) => a - b);
      let y0 = 0, first = true;
      while (y0 < canvas.height - 1) {
        const target = y0 + pageHpx;
        let y1;
        if (target >= canvas.height) y1 = canvas.height;
        else {
          const cand = safe.filter(s => s > y0 + 20 && s <= target);
          y1 = cand.length ? cand[cand.length - 1] : target;   // bloque más alto que una página → corte forzado
        }
        const sliceH = Math.max(1, Math.round(y1 - y0));
        const tmp = document.createElement('canvas');
        tmp.width = canvas.width; tmp.height = sliceH;
        const ctx = tmp.getContext('2d');
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, tmp.width, tmp.height);
        ctx.drawImage(canvas, 0, y0, canvas.width, sliceH, 0, 0, canvas.width, sliceH);
        if (!first) pdf.addPage();
        pdf.addImage(tmp.toDataURL('image/jpeg', 0.93), 'JPEG', 0, 0, pageW, sliceH * ptPerPx);
        first = false;
        y0 = y1;
      }
    }
    pdf.save(fileName + '.pdf');
  } finally {
    setTimeout(() => iframe.remove(), 500);
  }
}

// Arma el payload del reporte premium (compartido por los botones PDF y HTML).
// Devuelve null si no hay inversionista abierto o no se encontró la posición.
function buildInvestorReportPayload(posId) {
  const data = buildInvestorExport(posId);
  if (!data) { toast('Abre un inversionista primero'); return null; }
  if (posId != null && !data.pos.length) { toast('No encontré esa posición'); return null; }
  const single = posId != null;
  const t = data.totals;
  const shown = data.pos.filter(p => !p.reinvSource);
  const dateStr = new Date().toLocaleDateString('es-MX');
  const accountsLine = data.combined && data.inv._accounts
    ? data.inv._accounts.map(a => a.name).join(' + ')
    : (data.inv.titular ? 'Titular: ' + data.inv.titular : '');
  const payload = {
    meta: {
      title: data.inv.name,
      accountsLine,
      combined: !!data.combined,
      single,
      count: shown.length,
      dateStr,
      filename: invExportFilename(data.inv, single && data.pos[0] ? data.pos[0].company : ''),
    },
    totals: { compromiso: t.totCommit, nav: t.totActual, valor: t.valorEstimado, distribuido: t.totDist, moic: t.portMoic, dpi: t.dpi },
    pos: data.pos.map(p => ({
      acct: p.cuenta || '', company: p.company, series: p.series, estado: p.estado,
      entry_pps: p.entry_pps, current_pps: p.current_pps, commitment: p.commitment,
      commitment_actual: p.commitment_actual, valor: p.valor_estimado, moic: p.moic,
      shares: p.shares, theme: p.theme, reinvSource: !!p.reinvSource,
      distribuido: p.distribuido,
    })),
    dists: (data.letters || []).map(x => ({
      fecha: x.fecha, company: x.company, subyacente: x.subyacente, tipo: x.tipo,
      shares: x.shares, pps: x.pps, cash: x.cash, especie: x.especie, total: x.total,
    })),
  };
  const nameBase = (data.combined && data.inv._accounts)
    ? data.inv._accounts.map(a => a.name).join(' + ')
    : data.inv.name;
  const fileName = ((nameBase + ' Portfolio Snapshot').replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim()) + ' · ' + dlStamp();
  return { payload, fileName };
}

// Botón PDF: genera el reporte premium con el Chrome del navegador (Guardar como PDF). Fallback jsPDF.
async function exportInvestorPdf(posId) {
  const lang = await pickExportLang(); if (!lang) return;
  const built = buildInvestorReportPayload(posId);
  if (!built) return;
  try {
    toast(lang === 'en' ? 'Generating PDF…' : 'Generando PDF…');
    const html = buildReportHtmlClient(built.payload, lang);
    await renderReportPdf(html, built.fileName);
    toast('PDF descargado');
    return;
  } catch (e) {
    console.warn('[report] render falló, uso jsPDF:', e);
    return exportInvestorPdfJsPDF(posId);
  }
}

// Botón HTML: descarga el perfil del inversionista TAL COMO SE VE EN EL PORTAL como
// archivo .html standalone e interactivo (tablas ordenables, popups de info, imprimir).
// Clona el DOM ya renderizado (mismo estilo y contenido, siempre en sync con el portal),
// quita los controles de edición y embebe el CSS del portal + un script propio.
// Las columnas de posiciones respetan el picker "Columnas": lo que ocultes ahí no sale en el archivo.
// ════════ IDIOMA DE DESCARGABLES (ES/EN) ════════
// Selector compartido: cualquier botón de export pregunta el idioma (recuerda el último).
function pickExportLang() {
  return new Promise((resolve) => {
    const last = localStorage.getItem('exportLang') || 'es';
    const ov = document.createElement('div');
    ov.className = 'xlang-ov';
    ov.innerHTML = `
      <div class="xlang-card">
        <div class="xlang-h">Idioma del documento · Document language</div>
        <div class="xlang-opts">
          <button class="xlang-opt${last === 'es' ? ' sel' : ''}" data-l="es"><span class="xlang-big">Español</span><span class="xlang-sub">Documento en español</span></button>
          <button class="xlang-opt${last === 'en' ? ' sel' : ''}" data-l="en"><span class="xlang-big">English</span><span class="xlang-sub">Document in English</span></button>
        </div>
      </div>`;
    const done = (l) => { ov.remove(); if (l) localStorage.setItem('exportLang', l); resolve(l); };
    ov.addEventListener('click', (e) => {
      const b = e.target.closest('.xlang-opt');
      if (b) return done(b.dataset.l);
      if (e.target === ov) done(null);
    });
    document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { document.removeEventListener('keydown', esc); done(null); } });
    document.body.appendChild(ov);
  });
}

// Diccionario ES -> EN de los descargables (exactos + patrones). Lo no mapeado queda igual.
const XLATE_EXACT = {
  'Exposición del portafolio': 'Portfolio Exposure', 'Exposición del portafolio · histórico': 'Portfolio Exposure · historical',
  'Sus empresas': 'Your Companies', 'Lock-up SpaceX · liquidez estimada': 'SpaceX Lock-up · Estimated Liquidity',
  'Por empresa / fondo · NAV activo': 'By company / fund · active NAV', 'Por tema': 'By theme',
  'MOIC': 'MOIC', 'Distribuido a la fecha': 'Distributed to Date', 'DPI': 'DPI',
  'Posiciones activas': 'Active Positions', 'Posiciones': 'Positions', 'Posiciones terminadas': 'Closed Positions',
  'Commitment total': 'Total Commitment', 'Commitment actual': 'Current Commitment',
  'INVERSIONISTA': 'INVESTOR', 'Inversionista': 'Investor', 'TITULAR': 'HOLDER', 'Titular': 'Holder',
  'Empresa': 'Company', 'Series': 'Series', 'Serie': 'Series', 'Estado': 'Status', 'Compromiso': 'Commitment',
  'Account Balance': 'Account Balance', 'Distribuido': 'Distributed', 'Acciones': 'Shares',
  'PPS Entrada': 'Entry PPS', 'PPS Actual': 'Current PPS', 'Carry': 'Carry', 'Inicio': 'Start', 'Fin': 'End',
  'Duración': 'Duration', 'Última carta (CA)': 'Latest Statement (CAS)', 'Welcome Letter': 'Welcome Letter',
  'Fecha': 'Date', 'Tipo': 'Type', 'Cash': 'Cash', 'In-Kind': 'In-Kind', 'PPS': 'PPS', 'Carta': 'Letter',
  'Serie vendida': 'Series Sold', 'Vendido': 'Sold', 'Reinvertido': 'Reinvested', 'Efectivo neto': 'Net Cash',
  'DPI / MOIC': 'DPI / MOIC', '# Cartas': '# Letters', 'Cerrada': 'Closed', 'Cuenta': 'Account',
  'Fecha est.': 'Est. Date', 'Evento': 'Event', 'Valor estimado': 'Estimated Value', 'Total por liberar': 'Total to be released',
  'No disponible': 'Not available', 'TOTAL': 'TOTAL', 'Activa': 'Active', 'Terminada': 'Closed',
  'Información detallada de distribución': 'Detailed distribution information',
  'Recompras y reinversiones': 'Repurchases & Reinvestments',
  'Espacio & Satélites': 'Space & Satellites', 'Fondos All-Star': 'All-Star Funds', 'IA & Robótica': 'AI & Robotics',
  'Energía': 'Energy', 'Defensa': 'Defense', 'Fintech & Cripto': 'Fintech & Crypto',
  'Movilidad & Logística': 'Mobility & Logistics', 'Software & Consumo': 'Software & Consumer', 'Otros': 'Other',
  '1er cliff (tras Q2 2026)': '1st cliff (after Q2 2026)', '2º cliff (tras Q3 2026)': '2nd cliff (after Q3 2026)',
  'Día 70': 'Day 70', 'Día 90': 'Day 90', 'Día 105': 'Day 105', 'Día 120': 'Day 120', 'Día 135': 'Day 135',
  'Día 180 — expiración total': 'Day 180 — full expiration', 'Lock-up extendido (tras Q4 2026)': 'Extended lock-up (after Q4 2026)',
  'Día 280': 'Day 280', 'Tras Q1 2027': 'After Q1 2027', 'Día 340': 'Day 340', 'Día 366': 'Day 366',
  'Tras Q2 2027 — liberación final': 'After Q2 2027 — final release', 'Remanente': 'Remainder',
  'Lock-up escalonado de 180 días': '180-day staggered lock-up', 'Liberación en dos mitades (hasta ~14 meses)': 'Release in two halves (up to ~14 months)',
  'Primera mitad (~50%) — lock-up de 180 días': 'First half (~50%) — 180-day lock-up',
  'Segunda mitad (~50%) — lock-up extendido (patrón 20/10/20/10/20/20)': 'Second half (~50%) — extended lock-up (20/10/20/10/20/20 pattern)',
  'Bono por desempeño': 'Performance bonus', 'Bono por desempeño — condicional (+10%)': 'Performance bonus — conditional (+10%)', '~ago 2026': '~Aug 2026', 'Cada 15-20 días': 'Every 15-20 days', 'Tras resultados Q3': 'After Q3 results',
  'Hito': 'Milestone', 'Detalle': 'Detail', '% liberado': '% released',
  'Fund V': 'Fund V', 'Fund IV': 'Fund IV', 'Portafolio combinado': 'Combined Portfolio',
};
const XLATE_PATTERNS = [
  [/^Posiciones activas \((\d+)\)$/, 'Active Positions ($1)'],
  [/^Posiciones terminadas \((\d+)\)$/, 'Closed Positions ($1)'],
  [/^Recompras y reinversiones \((\d+)\)$/, 'Repurchases & Reinvestments ($1)'],
  [/^Distribuciones · Oportunidades en directo \(SPVs\) \((\d+)\)$/, 'Distributions · Direct Opportunities (SPVs) ($1)'],
  [/^Distribuciones · Fondos MVP \((\d+)\)$/, 'Distributions · MVP Funds ($1)'],
  [/^Próximas liberaciones — calendario estimado$/, 'Upcoming releases — estimated schedule'],
  [/^Próxima liberación estimada:$/, 'Next estimated release:'],
  [/^(\d+%) de la posición$/, '$1 of the position'],
  [/^Serie ([\w-]+)$/, 'Series $1'],
  [/^(\d+) cuentas combinadas$/, '$1 combined accounts'],
  [/^Acumulado: (.+)$/, 'Cumulative: $1'],
  [/^Día (\d+) \((.+)\)$/, 'Day $1 ($2)'],
  [/^1er cliff.*earnings Q2.*$/, '1st cliff — 2 days after Q2 earnings (~Aug 17, 2026, est.)'],
  [/^2 días tras (Q\d) (\d{4})(.*)$/, '2 days after $1 $2$3'],
  [/^Su portafolio de (.+) comprometidos vale hoy (.+)$/, 'Your portfolio of $1 committed is worth $2 today'],

];
const XLATE_HTML = [
  ['Liberación escalonada y ligada a desempeño dentro de la ventana estándar de <b>180 días</b>. Expira por completo ~9 de diciembre de 2026.',
   'Staggered, performance-linked release within the standard <b>180-day</b> window. Fully expires ~December 9, 2026.'],
  ['La posición se libera en <b>dos mitades</b>. La primera (~50%) durante los primeros ~6 meses (lock-up de 180 días); la segunda (~50%) en un <b>lock-up extendido</b> que se estira hasta ~14 meses post-IPO (liberación final ~ agosto 2027).',
   'The position is released in <b>two halves</b>. The first (~50%) over the first ~6 months (180-day lock-up); the second (~50%) under an <b>extended lock-up</b> stretching to ~14 months post-IPO (final release ~August 2027).'],
];
const XLATE_LONG = [
  ['Número total de posiciones del inversionista: activas (sin distribuir) + terminadas (ya distribuidas o liquidadas).',
   "Total number of the investor's positions: active (not yet distributed) + closed (already distributed or liquidated)."],
  ['Capital comprometido real (paid-in): suma del compromiso de todas las posiciones, neto de reinversiones SpaceX. La mitad de la Serie 22F que se vendió y se reinvirtió en la 26A QP se cuenta una sola vez (no se dobla el capital reciclado).',
   'Actual committed capital (paid-in): sum of all position commitments, net of SpaceX reinvestments. The half of Series 22F that was sold and reinvested into 26A QP is counted once (recycled capital is not doubled).'],
  ['Valor actual estimado (NAV) de las posiciones activas, a precio de mercado (mark-to-market, sincronizado con el último precio). No incluye posiciones ya distribuidas.',
   'Estimated current value (NAV) of active positions, marked to market (synced to the latest price). Excludes positions already distributed.'],
  ['Múltiplo total sobre el capital (TVPI): (valor actual de las posiciones activas + distribuido real) ÷ comprometido real. Sí incluye lo ya distribuido. Neto de reinversiones SpaceX.',
   'Total multiple on capital (TVPI): (current value of active positions + actual distributions) ÷ actual committed. Includes amounts already distributed. Net of SpaceX reinvestments.'],
  ['Efectivo y acciones devueltos al inversionista a la fecha, incluyendo distribuciones de fondos aplicadas a llamadas de capital. Excluye recompras/reinversiones.',
   'Cash and shares returned to the investor to date, including fund distributions applied to capital calls. Excludes repurchases/reinvestments.'],
  ['Distribuciones sobre capital (DPI): distribuido real ÷ comprometido real. Cuánto se ha devuelto en efectivo/acciones por cada dólar comprometido.',
   'Distributions to paid-in (DPI): actual distributions ÷ actual committed. How much has been returned in cash/shares per dollar committed.'],
  ['Posiciones que siguen vivas (aún sin distribuir ni liquidar).',
   'Positions still live (not yet distributed or liquidated).'],
  ['Liberación escalonada y ligada a desempeño dentro de la ventana de 180 días. Expira por completo ~9 dic 2026.',
   'Staggered, performance-linked release within the 180-day window. Fully expires ~Dec 9, 2026.'],
  ['Una porción sigue un lock-up extendido (en parcialidades) hasta ~14 meses post-IPO; liberación final ~ago 2027.',
   'A portion follows an extended lock-up (in installments) up to ~14 months post-IPO; final release ~Aug 2027.'],
  ['Estructura del S-1 de SpaceX (IPO 12-jun-2026); primer earnings aún no oficial — 1er cliff estimado: 17 ago 2026. El prospecto final es la autoridad.',
   'Structure from the SpaceX S-1 (IPO Jun 12, 2026); first earnings not yet official — 1st cliff estimated: Aug 17, 2026. The final prospectus governs.'],
  ['Calendario del S-1 de SpaceX; las fechas ligadas a earnings son estimadas y el prospecto definitivo es la autoridad. El bono por desempeño (+10%) es condicional y, de cumplirse, adelanta esas acciones del remanente del día 180 — no son acciones adicionales, por eso no suma al total.',
   'Schedule from the SpaceX S-1; earnings-linked dates are estimates and the definitive prospectus governs. The performance bonus (+10%) is conditional and, if met, brings those shares forward from the day-180 remainder — they are not additional shares, so they do not add to the total.'],
  ['Posiciones que el fondo subyacente liquidó y cuyo importe se reinvirtió en un vehículo directo de SpaceX (Serie 26A QP). La parte reinvertida no es efectivo devuelto al inversionista; el resto (si lo hay) sí se entregó en efectivo.',
   'Positions liquidated by the underlying fund whose proceeds were reinvested into a direct SpaceX vehicle (Series 26A QP). The reinvested portion is not cash returned to the investor; the remainder (if any) was paid in cash.'],
];
function xlateText(t) {
  const raw = (t || '').trim();
  if (!raw) return null;
  if (XLATE_EXACT[raw] !== undefined) return XLATE_EXACT[raw];
  for (const [re, rep] of XLATE_PATTERNS) { if (re.test(raw)) return raw.replace(re, rep); }
  for (const [es, en] of XLATE_LONG) { if (raw === es) return en; }
  return null;
}
// Traduce nodos de texto del DOM exportado (exactos/patrones; lo demás no se toca).
function translateExportDom(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  nodes.forEach(n => { const r = xlateText(n.nodeValue); if (r !== null) n.nodeValue = n.nodeValue.replace(n.nodeValue.trim(), r); });
  // pase por elementos con markup interno (summaries con <b>)
  root.querySelectorAll('*').forEach(el => {
    if (el.children.length > 1) return;
    const h = (el.innerHTML || '').trim();
    for (const [es, en] of XLATE_HTML) { if (h === es) { el.innerHTML = en; break; } }
  });
  // fechas es-MX "15 nov 2026" -> "Nov 15, 2026" en celdas de tablas
  const M = { ene: 'Jan', feb: 'Feb', mar: 'Mar', abr: 'Apr', may: 'May', jun: 'Jun', jul: 'Jul', ago: 'Aug', sep: 'Sep', oct: 'Oct', nov: 'Nov', dic: 'Dec' };
  nodes.forEach(n => {
    const m = (n.nodeValue || '').trim().match(/^(~?\s*)(\d{1,2}) (ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic) (\d{4})$/);
    if (m) n.nodeValue = n.nodeValue.replace(/(\d{1,2}) (\w{3}) (\d{4})/, (s0, d, mo, y) => `${M[mo] || mo} ${d}, ${y}`);
  });
}

// Catálogo propio de fichas por empresa (fallback del companyInfo de los trackers) — garantiza
// que TODA posición en directo lleve card con logo en el export. domain = logo (Google favicons).
const XP_CO_FICHAS = {
  'Space X':          { domain: 'spacex.com',           category: 'Espacio · Satélites', stage: 'Pública (SPCX)', tagline: 'Líder mundial en lanzamientos reutilizables e internet satelital Starlink.' , en: { category: 'Space · Satellites', stage: 'Public (SPCX)', tagline: 'Global leader in reusable launch vehicles and the Starlink satellite internet constellation.' } },
  'Anthropic':        { domain: 'anthropic.com',        category: 'Inteligencia Artificial', stage: 'Etapa tardía', tagline: 'Laboratorio de IA creador de Claude, enfocado en modelos seguros para empresas.' , en: { category: 'Artificial Intelligence', stage: 'Late stage', tagline: 'AI lab behind Claude, focused on safe, enterprise-grade models.' } },
  'Base Power':       { domain: 'basepowercompany.com', category: 'Energía residencial', stage: 'Crecimiento', tagline: 'Baterías de respaldo en hogares operadas como una "central eléctrica virtual".' , en: { category: 'Residential energy', stage: 'Growth', tagline: 'Home backup batteries operated together as a \'virtual power plant\'.' } },
  'Diamond Foundry':  { domain: 'diamondfoundry.com',   category: 'Materiales avanzados', stage: 'Crecimiento', tagline: 'Diamantes cultivados de grado gema y obleas de diamante para semiconductores de potencia.' , en: { category: 'Advanced materials', stage: 'Growth', tagline: 'Lab-grown gem-grade diamonds and diamond wafers for power semiconductors.' } },
  'Agility Robotics': { domain: 'agilityrobotics.com',  category: 'Robótica humanoide', stage: 'Crecimiento', tagline: 'Fabrica Digit, robot humanoide para logística y almacenes.' , en: { category: 'Humanoid robotics', stage: 'Growth', tagline: 'Maker of Digit, a humanoid robot for logistics and warehouses.' } },
  'Groq':             { domain: 'groq.com',             category: 'Semiconductores · IA', stage: 'Crecimiento', tagline: 'Chips de inferencia de IA (LPU) ultrarrápidos para servir modelos a gran escala.' , en: { category: 'Semiconductors · AI', stage: 'Growth', tagline: 'Ultra-fast AI inference chips (LPU) for serving models at scale.' } },
  'Epic Games':       { domain: 'epicgames.com',        category: 'Gaming · 3D', stage: 'Etapa tardía', tagline: 'Creadora de Fortnite y de Unreal Engine, el motor 3D que impulsa juegos, cine y simulación.' , en: { category: 'Gaming · 3D', stage: 'Late stage', tagline: 'Creator of Fortnite and Unreal Engine, the 3D engine powering games, film and simulation.' } },
  'Rappi':            { domain: 'rappi.com',            category: 'Súper-app · LatAm', stage: 'Etapa tardía', tagline: 'La súper-app líder de delivery y servicios financieros en América Latina.' , en: { category: 'Super-app · LatAm', stage: 'Late stage', tagline: 'Latin America\'s leading delivery and financial services super-app.' } },
  'Lime':             { domain: 'li.me',                category: 'Micromovilidad', stage: 'Etapa tardía', tagline: 'Red de scooters y bicicletas eléctricas compartidas en cientos de ciudades.' , en: { category: 'Micromobility', stage: 'Late stage', tagline: 'Shared electric scooters and bikes across hundreds of cities.' } },
  'Cohere':           { domain: 'cohere.com',           category: 'IA empresarial', stage: 'Crecimiento', tagline: 'Modelos de lenguaje para empresas, fundada por coautores del paper del Transformer.' , en: { category: 'Enterprise AI', stage: 'Growth', tagline: 'Enterprise language models, founded by co-authors of the Transformer paper.' } },
  'Revolut':          { domain: 'revolut.com',          category: 'Fintech · Neobanco', stage: 'Etapa tardía', tagline: 'Neobanco global con decenas de millones de clientes y licencia bancaria en Europa.' , en: { category: 'Fintech · Neobank', stage: 'Late stage', tagline: 'Global neobank with tens of millions of customers and a European banking license.' } },
  'Kraken':           { domain: 'kraken.com',           category: 'Cripto · Exchange', stage: 'Etapa tardía', tagline: 'Uno de los exchanges de criptomonedas más grandes y antiguos del mundo.' , en: { category: 'Crypto · Exchange', stage: 'Late stage', tagline: 'One of the world\'s largest and longest-running cryptocurrency exchanges.' } },
  'Bolt':             { domain: 'bolt.com',             category: 'Fintech · E-commerce', stage: 'Crecimiento', tagline: 'Checkout de un clic y red de identidad para comercio electrónico.' , en: { category: 'Fintech · E-commerce', stage: 'Growth', tagline: 'One-click checkout and identity network for e-commerce.' } },
  'Patreon':          { domain: 'patreon.com',          category: 'Economía de creadores', stage: 'Crecimiento', tagline: 'La plataforma de membresías que conecta a creadores con sus fans.' , en: { category: 'Creator economy', stage: 'Growth', tagline: 'The membership platform connecting creators with their fans.' } },
  'Automattic Inc.':  { domain: 'automattic.com',       category: 'Software · Web', stage: 'Etapa tardía', tagline: 'La empresa detrás de WordPress.com, WooCommerce y Tumblr.' , en: { category: 'Software · Web', stage: 'Late stage', tagline: 'The company behind WordPress.com, WooCommerce and Tumblr.' } },
  'Cohesity':         { domain: 'cohesity.com',         category: 'Datos · Ciberseguridad', stage: 'Etapa tardía', tagline: 'Gestión y seguridad de datos empresariales; fusionada con Veritas.' , en: { category: 'Data · Cybersecurity', stage: 'Late stage', tagline: 'Enterprise data management and security; merged with Veritas.' } },
  'Trusted':          { domain: 'trustedhealth.com',    category: 'Salud · Talento', stage: 'Crecimiento', tagline: 'Plataforma de staffing clínico que conecta personal de enfermería con hospitales.' , en: { category: 'Healthcare · Talent', stage: 'Growth', tagline: 'Clinical staffing platform connecting nurses with hospitals.' } },
  'Mach Industries':  { domain: 'machindustries.com',   category: 'Defensa', stage: 'Etapa temprana', tagline: 'Sistemas de defensa de nueva generación con manufactura descentralizada.' , en: { category: 'Defense', stage: 'Early stage', tagline: 'Next-generation defense systems with decentralized manufacturing.' } },
  'Figure AI':        { domain: 'figure.ai',            category: 'Robótica humanoide', stage: 'Crecimiento', tagline: 'Robots humanoides de propósito general impulsados por IA.' , en: { category: 'Humanoid robotics', stage: 'Growth', tagline: 'General-purpose humanoid robots powered by AI.' } },
  'Aumni':            { domain: 'aumni.fund',           category: 'Fintech · Datos VC', stage: 'Adquirida (J.P. Morgan)', tagline: 'Analítica de datos legales de inversiones de venture capital; adquirida por J.P. Morgan.' , en: { category: 'Fintech · VC data', stage: 'Acquired (J.P. Morgan)', tagline: 'Legal data analytics for venture investments; acquired by J.P. Morgan.' } },
};

async function exportInvestorHtml() {
  if (!lastInvestorDetail) { toast('Abre un inversionista primero'); return; }
  const lang = await pickExportLang(); if (!lang) return;
  const EN = lang === 'en';
  const LOC = EN ? 'en-US' : 'es-MX';
  const { inv } = lastInvestorDetail;
  const clone = document.getElementById('dbDetailContent').cloneNode(true);
  try {
    // 1) Fuera controles internos (export, picker de columnas, edición)
    clone.querySelectorAll('.db-detail-export, .db-pos-toolbar, .db-contact-del, .cdd, button').forEach(el => el.remove());
    // Fuera la sección de Contactos (dato interno, no aporta al inversionista)
    clone.querySelectorAll('.db-section').forEach(sec => {
      const h = sec.querySelector('.db-section-h');
      if (h && h.textContent.trim() === 'Contactos') sec.remove();
    });

    // 2) Inputs de edición (titular / contactos) → texto plano
    clone.querySelectorAll('input').forEach(inp => {
      const el = document.createElement(inp.classList.contains('db-titular-inp') ? 'span' : 'div');
      el.className = inp.classList.contains('db-titular-inp') ? 'db-titular-val'
        : (inp.classList.contains('ml') ? 'db-contact-mail' : 'db-contact-name');
      el.textContent = (inp.value || '').trim() || '—';
      inp.replaceWith(el);
    });

    // 3) Donut por tema: canvas (Chart.js) → SVG estático con la MISMA data y paleta
    const cv = clone.querySelector('#lpThemeChart');
    if (cv) {
      let svg = '';
      if (_lp360 && _lp360.themeExp && _lp360.themeExp.length) {
        const items = _lp360.themeExp;
        const colors = lpChartPalette();
        const tot = items.reduce((s, [, v]) => s + v, 0) || 1;
        const size = 220, stroke = 42, r = (size - stroke) / 2, c = size / 2, C = 2 * Math.PI * r;
        let off = 0, segs = '';
        items.forEach(([, v], i) => {
          const seg = v / tot * C;
          segs += `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${colors[i % colors.length]}" stroke-width="${stroke}" stroke-dasharray="${seg.toFixed(2)} ${(C - seg).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 ${c} ${c})"/>`;
          off += seg;
        });
        const leg = items.map(([l, v], i) =>
          `<span class="xp-leg"><span class="xp-dot" style="background:${colors[i % colors.length]}"></span>${escapeHtml(l)} <b>${(v / tot * 100).toFixed(0)}%</b></span>`).join('');
        svg = `<svg class="xp-donut-svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${segs}</svg><div class="xp-legend">${leg}</div>`;
      }
      const wrap = document.createElement('div');
      wrap.className = 'xp-donut';
      wrap.innerHTML = svg;
      cv.replaceWith(wrap);
    }

    // 3.5) VALOR AGREGADO — hero ejecutivo, cards de empresas y liquidez con montos.
    //      Todo condicional al perfil (aplica a CUALQUIER inversionista, sin secciones vacías).
    try {
      const positions = lastInvestorDetail.positions || [];
      const _xids = inv._combined ? (inv._accounts || []).map(a => a.id) : (inv.id != null ? [inv.id] : []);
      const lp = buildLp360(positions, _xids);
      const activeP = positions.filter(p => !p.distributed_at);

      // — Hero ejecutivo (reemplaza el encabezado simple: el nombre vive aquí, sin duplicarse) —
      const heroLine = lp.committedNet > 0
        ? (EN
          ? `Your portfolio of <b>${fmtUsdShort(lp.committedNet)}</b> committed is worth <b>${fmtUsdShort(lp.navActive)}</b> today${lp.distrib > 500 ? ` and has received <b>${fmtUsdShort(lp.distrib)}</b> in distributions` : ''} — a <b>${lp.moic.toFixed(2)}x</b> multiple on your capital.`
          : `Su portafolio de <b>${fmtUsdShort(lp.committedNet)}</b> comprometidos vale hoy <b>${fmtUsdShort(lp.navActive)}</b>${lp.distrib > 500 ? ` y ha recibido <b>${fmtUsdShort(lp.distrib)}</b> en distribuciones` : ''} — un múltiplo de <b>${lp.moic.toFixed(2)}x</b> sobre su capital.`)
        : '';
      const hero = document.createElement('div');
      hero.className = 'xp-hero';
      hero.innerHTML = `
        <div class="xp-hero-name">${escapeHtml(inv.name)}</div>
        ${heroLine ? `<div class="xp-hero-line">${heroLine}</div>` : ''}
        <div class="xp-hero-meta">${EN ? 'Figures as of' : 'Cifras al'} ${escapeHtml(new Date().toLocaleDateString(LOC, { day: 'numeric', month: 'long', year: 'numeric' }))} · ${EN ? 'Valuations at latest market prices' : 'Valuaciones a precios de mercado más recientes'} · ${lp.nActive} ${EN ? (lp.nActive === 1 ? 'active position' : 'active positions') : (lp.nActive === 1 ? 'posición activa' : 'posiciones activas')}</div>`;
      clone.querySelector('.db-detail-name')?.remove();
      clone.querySelector('.db-detail-sub')?.remove();
      clone.prepend(hero);

      // — Cards "Sus empresas": TODA posición en directo lleva ficha + logo.
      //   Fuente: companyInfo/logos de los trackers; fallback XP_CO_FICHAS (catálogo propio).
      const infoDicts = Object.values(FUND_TRACKERS || {}).map(t => t && t.companyInfo).filter(Boolean);
      const logoDicts = Object.values(FUND_TRACKERS || {}).map(t => t && t.logos).filter(Boolean);
      const normCo = s => String(s || '').toLowerCase().replace(/\b(inc|corp|corporation|llc|pbc|ltd|technologies|company|sab de cv|sapi de cv)\b/g, '').replace(/[^a-z0-9]/g, '');
      const ALIAS = { 'spacex': 'spaceexploration' };
      const matchKey = (dict, n) => Object.keys(dict).find(k => { const kn = normCo(k); return kn.includes(n) || n.includes(kn); });
      const findInfo = (name) => {
        let n = normCo(name); n = ALIAS[n] || n;
        if (!n) return null;
        for (const d of infoDicts) { const k = matchKey(d, n); if (k) return { ...d[k] }; }
        const fk = matchKey(XP_CO_FICHAS, n);
        return fk ? { ...XP_CO_FICHAS[fk] } : null;
      };
      const findDomain = (name) => {
        let n = normCo(name); n = ALIAS[n] || n;
        if (!n) return null;
        for (const d of logoDicts) { const k = matchKey(d, n); if (k) return d[k]; }
        const fk = matchKey(XP_CO_FICHAS, n);
        return fk ? XP_CO_FICHAS[fk].domain : null;
      };
      const seenCo = new Set(); const cardData = [];
      activeP.forEach(p => {
        const nm = p.companies?.name;
        if (!nm || p.companies?.id === 10 || seenCo.has(nm)) return;
        seenCo.add(nm);
        let cinfo = findInfo(nm) || { category: companyTheme(nm), tagline: '' };
        if (EN) {
          const fk = Object.keys(XP_CO_FICHAS).find(k => { const kn = normCo(k), n2 = normCo(nm); return kn.includes(n2) || n2.includes(kn); });
          if (fk && XP_CO_FICHAS[fk].en) cinfo = { ...XP_CO_FICHAS[fk].en };
        }
        cardData.push({ nm, info: cinfo, dom: findDomain(nm) });
      });
      // logos INCRUSTADOS como data URI (el HTML debe verse sin red ni JS, ej. visor del teléfono)
      const logoUri = {};
      await Promise.all([...new Set(cardData.map(c => c.dom).filter(Boolean))].map(async dom => {
        try {
          const g = 'https://www.google.com/s2/favicons?sz=128&domain=' + dom;
          const r = await fetch('/api/logo?u=' + encodeURIComponent(g));
          if (!r.ok) return;
          const b = await r.blob();
          if (b.size < 120) return;   // favicon vacío/placeholder
          logoUri[dom] = await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => res(null); fr.readAsDataURL(b); });
        } catch (e) {}
      }));
      const cards = cardData.map(({ nm, info, dom }) => {
        const logo = (dom && logoUri[dom]) ? `<img class="xp-co-logo" src="${logoUri[dom]}" alt="">` : '';
        return `<div class="xp-co"><div class="xp-co-head"><span class="xp-co-id">${logo}<span class="xp-co-name">${escapeHtml(nm)}</span></span><span class="xp-co-chip">${escapeHtml(info.category || '')}${info.stage ? ' · ' + escapeHtml(info.stage) : ''}</span></div>${info.tagline ? `<div class="xp-co-tag">${escapeHtml(info.tagline)}</div>` : ''}${info.thesis ? `<div class="xp-co-thesis">${escapeHtml(info.thesis)}</div>` : ''}</div>`;
      });
      if (cards.length) {
        const sec = document.createElement('div');
        sec.className = 'db-section';
        sec.innerHTML = `<div class="db-section-h">Sus empresas</div><div class="xp-cos">${cards.join('')}</div>`;
        const anchor = [...clone.querySelectorAll('.db-section')].find(s => (s.querySelector('.db-section-h')?.textContent || '').startsWith('Exposición'));
        if (anchor) anchor.insertAdjacentElement('afterend', sec);
        else clone.appendChild(sec);
      }

      // — Liquidez estimada con MONTOS (solo si tiene SpaceX directo con acciones) —
      const co27 = activeP.filter(p => p.companies?.id === 27 && +p.shares > 0);
      if (co27.length) {
        const price = Math.max(...co27.map(p => +p.current_ev_pps || 0));
        let sA = 0, sB = 0;
        co27.forEach(p => spxTranches(p.series?.name || '').forEach(t => { if (t.structure === 'A') sA += (+p.shares) * t.portion; else sB += (+p.shares) * t.portion; }));
        const today = new Date().toISOString().slice(0, 10);
        const pctNum = s => s === 'Remanente' ? 17 : (parseFloat(s) || 0);
        const ev = [];
        SPX_LOCKUP_B.forEach(e => { if (e.date >= today) ev.push({ ...e, sh: (pctNum(e.pct) / 100) * (sB + sA / 2) }); });
        SPX_LOCKUP_A_EXT.forEach(e => { if (e.date >= today) ev.push({ ...e, sh: (pctNum(e.pct) / 100) * (sA / 2) }); });
        // Solo hitos que le liberan acciones a ESTE inversionista (sin filas en $0 del calendario que no le aplica)
        const evReal = ev.filter(e => e.sh >= 0.5);
        ev.length = 0; ev.push(...evReal);
        // Bono por desempeño (+10%): condicional; de cumplirse ADELANTA parte del remanente del día 180
        // (no son acciones adicionales) — por eso la fila no suma al total. Ventana: ~10 días tras earnings Q2.
        const bonusSh = 0.10 * (sB + sA / 2);
        if (bonusSh >= 0.5 && today <= '2026-08-31') ev.push({ date: '2026-08-18', dlbl: '~ago 2026', label: 'Bono por desempeño — condicional (+10%)', sh: bonusSh, bonus: true });
        ev.sort((a, b) => a.date.localeCompare(b.date));
        if (ev.length && price > 0) {
          const F = d => new Date(d + 'T12:00:00').toLocaleDateString(LOC, { day: 'numeric', month: 'short', year: 'numeric' });
          const rows = ev.map(e => `<tr${e.bonus ? ' class="xp-liq-bono"' : ''}><td>${e.dlbl ? escapeHtml(e.dlbl) : F(e.date)}</td><td>${escapeHtml(e.label)}</td><td class="num">${e.bonus ? '+' : ''}${Math.round(e.sh).toLocaleString('en-US')}</td></tr>`).join('');
          const tot = ev.reduce((s, e) => s + (e.bonus ? 0 : e.sh), 0);
          const tbl = document.createElement('div');
          tbl.className = 'xp-liq';
          tbl.innerHTML = `<div class="xp-liq-h">Próximas liberaciones — calendario estimado</div>
            <table class="db-table"><thead><tr><th>Fecha est.</th><th>Evento</th><th class="num">Acciones</th></tr></thead>
            <tbody>${rows}<tr class="xp-liq-tot"><td colspan="2">Total por liberar</td><td class="num">${Math.round(tot).toLocaleString('en-US')}</td></tr></tbody></table>
            <div class="xp-liq-note">Calendario del S-1 de SpaceX; las fechas ligadas a earnings son estimadas y el prospecto definitivo es la autoridad. El bono por desempeño (+10%) es condicional y, de cumplirse, adelanta esas acciones del remanente del día 180 — no son acciones adicionales, por eso no suma al total.</div>`;
          const lock = [...clone.querySelectorAll('.db-section')].find(s => (s.querySelector('.db-section-h')?.textContent || '').startsWith('Lock-up'));
          if (lock) lock.appendChild(tbl);
        }
      }

      // — El bloque de lock-up SpaceX va HASTA ABAJO (después de Distribuciones) —
      const lockSec = [...clone.querySelectorAll('.db-section')].find(s => (s.querySelector('.db-section-h')?.textContent || '').startsWith('Lock-up'));
      if (lockSec) clone.appendChild(lockSec);

      if (EN) translateExportDom(clone);
    } catch (e) { console.warn('[export html] valor agregado', e); }

    // 4) Sin handlers inline del portal (el archivo trae su propio script)
    clone.querySelectorAll('*').forEach(el => {
      [...el.attributes].forEach(a => { if (a.name.startsWith('on')) el.removeAttribute(a.name); });
      el.removeAttribute('contenteditable');
    });

    // 5) CSS del portal (mismo estilo, siempre en sync) + links de fuentes/iconos
    let css = '';
    for (const sheet of document.styleSheets) {
      try { for (const r of sheet.cssRules) css += r.cssText + '\n'; } catch (e) { /* cross-origin: va por <link> */ }
    }
    const extLinks = [...document.querySelectorAll('link[rel="stylesheet"]')]
      .map(l => l.href).filter(h => /^https?:\/\//.test(h))
      .map(h => `<link rel="stylesheet" href="${h}">`).join('\n');

    const dateStr = new Date().toLocaleDateString(LOC, { day: 'numeric', month: 'long', year: 'numeric' });
    const title = `${inv.name} — ${EN ? 'Investor Profile' : 'Perfil del inversionista'}`;
    const exportCss = `
body.xport{overflow:auto!important;display:block!important;margin:0!important;padding:0!important;background:var(--gray-50,#f7f8fb)!important}
body.xport>.xp-top{position:sticky;top:0;z-index:60;display:flex;align-items:center;gap:14px;background:linear-gradient(90deg,#e8650d,#ef8a3c);color:#fff;padding:12px 24px;font-family:inherit}
.xp-top .xp-brand{font-weight:700;font-size:15px;letter-spacing:.2px}
.xp-top .xp-date{font-size:12px;opacity:.9}
.xp-top .xp-print{margin-left:auto;border:1.5px solid rgba(255,255,255,.55);background:rgba(255,255,255,.14);color:#fff;border-radius:9px;padding:7px 15px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit}
.xp-top .xp-print:hover{background:rgba(255,255,255,.26)}
body.xport .xp-wrap{max-width:1180px;margin:0 auto;padding:24px 26px 10px}
body.xport #dbDetail,body.xport #dbDetailContent{display:block!important;position:static!important;width:auto!important;max-width:none!important;height:auto!important;overflow:visible!important;border:none!important;box-shadow:none!important;background:transparent!important}
.xp-donut{display:flex;flex-direction:column;align-items:center;gap:12px;padding-top:6px}
.xp-legend{display:flex;flex-wrap:wrap;gap:7px 16px;justify-content:center;font-size:11.5px;max-width:280px}
.xp-dot{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:5px;vertical-align:-1px}
body.xport .db-table thead th{cursor:pointer;user-select:none}
body.xport .db-table thead th:hover{color:var(--orange,#e8650d)}
body.xport .db-table thead th .xp-arrow{font-size:9px;margin-left:4px;opacity:.7}
.xp-foot{max-width:1180px;margin:6px auto 34px;padding:0 26px;font-size:10.5px;letter-spacing:.4px;color:#9aa1ad;line-height:1.7}
.xp-foot .xp-foot-tag{text-transform:uppercase;letter-spacing:1.2px;display:block;margin-bottom:4px}
::selection{background:rgba(237,120,36,.22);color:#171c28}
body.xport{scroll-behavior:smooth}
body.xport::-webkit-scrollbar{width:10px}
body.xport::-webkit-scrollbar-thumb{background:#d8dde6;border-radius:6px;border:2px solid #f7f8fb}
body.xport::-webkit-scrollbar-track{background:transparent}
#xpProg{position:fixed;top:0;left:0;height:2.5px;width:0;background:linear-gradient(90deg,var(--navy,#ED7824),#f6a55c);z-index:99;transition:width .15s linear}
.xp-grain{position:fixed;inset:0;pointer-events:none;z-index:1;opacity:.028;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)'/%3E%3C/svg%3E")}
.xp-hero{position:relative;overflow:hidden;background:linear-gradient(135deg,#fff 62%,#fdf6ef 100%);border:1px solid var(--gray-200,#e3e7ee);border-radius:16px;padding:34px 38px 30px;margin-bottom:20px;box-shadow:0 2px 14px rgba(20,25,40,.06)}
.xp-hero::before{content:"";position:absolute;left:0;top:0;bottom:0;width:4px;background:linear-gradient(180deg,var(--navy,#ED7824),#f6a55c)}
.xp-hero::after{content:"";position:absolute;right:-70px;top:-70px;width:260px;height:260px;border-radius:50%;background:radial-gradient(circle,rgba(237,120,36,.09),transparent 65%)}
.xp-hero-eyebrow{font-family:var(--mono,'DM Mono',monospace);font-size:10.5px;font-weight:500;letter-spacing:2.2px;text-transform:uppercase;color:#a3742f;margin-bottom:10px}
.xp-hero-name{font-family:'Fraunces',Georgia,serif;font-size:clamp(28px,4.2vw,42px);font-weight:560;letter-spacing:-.018em;color:#171c28;line-height:1.08;margin-bottom:12px}
.xp-hero-line{font-size:15.5px;color:#3a4152;line-height:1.6;max-width:780px}
body.xanim .xp-hero-eyebrow{opacity:0;animation:xpUp .7s cubic-bezier(.16,1,.3,1) .1s forwards}
body.xanim .xp-hero-name{opacity:0;clip-path:inset(0 0 100% 0);animation:xpName .9s cubic-bezier(.16,1,.3,1) .25s forwards}
body.xanim .xp-hero-line{opacity:0;animation:xpUp .8s cubic-bezier(.16,1,.3,1) .55s forwards}
.xp-hero-line b{color:var(--navy,#ED7824);font-weight:700}
.xp-hero-meta{margin-top:14px;font-family:var(--mono,'DM Mono',monospace);font-size:10.5px;color:#9aa1ad;letter-spacing:.6px}
body.xanim .xp-hero-meta{opacity:0;animation:xpUp .8s cubic-bezier(.16,1,.3,1) .8s forwards}
@keyframes xpUp{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
@keyframes xpName{from{opacity:0;clip-path:inset(0 0 100% 0);transform:translateY(10px)}to{opacity:1;clip-path:inset(0 0 -8% 0);transform:none}}
body.xanim .xr{opacity:0;transform:translateY(22px);transition:opacity .85s cubic-bezier(.16,1,.3,1),transform .85s cubic-bezier(.16,1,.3,1);transition-delay:var(--d,0s)}
body.xanim .xr.xin{opacity:1;transform:none}
body.xport .lp-bar-fill,body.xport .home-top-fill{transition:width 1.1s cubic-bezier(.16,1,.3,1)}
.xp-donut-svg.xpre{opacity:0;transform:rotate(-16deg) scale(.94);transition:opacity .9s cubic-bezier(.16,1,.3,1),transform 1.1s cubic-bezier(.16,1,.3,1)}
.xp-donut-svg.xpre.xdon{opacity:1;transform:none}
@media print{.xp-donut-svg{opacity:1!important;transform:none!important}}
@media (prefers-reduced-motion:reduce){.xp-hero-eyebrow,.xp-hero-name,.xp-hero-line,.xp-hero-meta{animation:none;opacity:1;clip-path:none}.xr{opacity:1;transform:none;transition:none}}
@media print{.xp-hero-eyebrow,.xp-hero-name,.xp-hero-line,.xp-hero-meta{animation:none!important;opacity:1!important;clip-path:none!important}.xr{opacity:1!important;transform:none!important}#xpProg,.xp-grain{display:none}}
.xp-cos{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:12px}
.xp-co{background:#fff;border:1px solid var(--gray-200,#e3e7ee);border-radius:12px;padding:14px 16px}
.xp-co-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px;flex-wrap:wrap}
.xp-co-id{display:flex;align-items:center;gap:9px;min-width:0}
.xp-co-logo{width:26px;height:26px;border-radius:7px;object-fit:contain;background:#fff;border:1px solid var(--gray-200,#e3e7ee);padding:2px;flex:none}
.xp-co-name{font-weight:600;font-size:14px;color:#171c28}
.xp-co-chip{font-size:10px;font-weight:600;letter-spacing:.4px;text-transform:uppercase;color:var(--navy,#ED7824);background:var(--navy-pale,rgba(237,120,36,.12));border-radius:20px;padding:3px 9px;white-space:nowrap}
.xp-co-tag{font-size:12.5px;color:#3a4152;line-height:1.5;margin-bottom:5px}
.xp-co-thesis{font-size:11.5px;color:#6b7280;line-height:1.5}
.xp-liq{margin-top:14px}
.xp-liq-h{font-size:11px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:#3a4152;margin-bottom:8px}
.xp-liq tr.xp-liq-tot td{background:var(--gray-50,#f7f8fb);font-weight:700;border-top:1.5px solid var(--gray-200,#e3e7ee)}
.xp-liq tr.xp-liq-bono td{color:#8a93a6;font-style:italic}
.xp-liq-note{margin-top:7px;font-size:10.5px;color:#9aa1ad;line-height:1.5;max-width:820px}
@media print{body.xport>.xp-top{position:static}.xp-top .xp-print{display:none}}
`;
    const script = `
document.addEventListener('click', function(e){
  var ic = e.target.closest('.info-ic');
  document.querySelectorAll('.info-ic.open').forEach(function(el){ if (el !== ic) el.classList.remove('open'); });
  if (ic) ic.classList.toggle('open');
});
function xpVal(td){
  var t = (td && td.textContent || '').trim();
  if (t === '\\u2014' || t === '-' || t === '') return null;
  var n = t.replace(/[$,\\s]/g,'').replace(/[x%]$/i,'');
  var m = n.match(/^-?\\d+(\\.\\d+)?([KMB])?$/i);
  if (m) return parseFloat(n) * ({K:1e3,M:1e6,B:1e9}[(m[2]||'').toUpperCase()] || 1);
  var d = Date.parse(t);
  if (!isNaN(d) && /\\d{4}/.test(t)) return d;
  return t.toLowerCase();
}
// logos: ocultar los que no carguen (el favicon service no tiene todas)
document.querySelectorAll('.xp-co-logo').forEach(function(img){
  img.addEventListener('error', function(){ img.style.display = 'none'; });
  if (img.complete && img.naturalWidth < 2) img.style.display = 'none';
});
// ── Coreografía premium (sobria): progress, reveals, count-up, barras y dona ──
(function(){
  if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  document.body.classList.add('xanim');
  var pr = document.getElementById('xpProg');
  addEventListener('scroll', function(){
    var h = document.documentElement;
    var p = h.scrollTop / ((h.scrollHeight - h.clientHeight) || 1);
    if (pr) pr.style.width = (p * 100) + '%';
  }, { passive: true });
  var els = [].slice.call(document.querySelectorAll('.db-section, .xp-co, .lp-kpi, .db-stat'));
  els.forEach(function(el, i){ el.classList.add('xr'); el.style.setProperty('--d', ((i % 6) * 0.07) + 's'); });
  var io = new IntersectionObserver(function(es){
    es.forEach(function(e){ if (e.isIntersecting) { e.target.classList.add('xin'); io.unobserve(e.target); } });
  }, { threshold: 0.1 });
  els.forEach(function(el){ io.observe(el); });
  function cnt(el){
    var t = (el.textContent || '').trim();
    var m = t.match(/^([$]?)([\\d,]+\\.?\\d*)([KMBx%]?)$/); if (!m) return;
    var target = parseFloat(m[2].replace(/,/g, '')); if (!isFinite(target) || target === 0) return;
    var dec = (m[2].split('.')[1] || '').length, t0 = null;
    function step(ts){
      if (!t0) t0 = ts;
      var k = Math.min(1, (ts - t0) / 950); k = 1 - Math.pow(1 - k, 3);
      var v = dec ? (target * k).toFixed(dec) : Math.round(target * k).toLocaleString('en-US');
      el.textContent = m[1] + v + m[3];
      if (k < 1) requestAnimationFrame(step); else el.textContent = t;
    }
    requestAnimationFrame(step);
  }
  document.querySelectorAll('.xp-hero-line b, .db-stat-v, .lp-kpi-v').forEach(cnt);
  document.querySelectorAll('.lp-bar-fill').forEach(function(b){
    var w = b.style.width; b.style.width = '0%';
    setTimeout(function(){ b.style.width = w; }, 380);
  });
  document.querySelectorAll('.xp-donut-svg').forEach(function(sv){
    sv.classList.add('xpre');
    void sv.getBoundingClientRect();
    setTimeout(function(){ sv.classList.add('xdon'); }, 400);
  });
})();
document.querySelectorAll('table.db-table').forEach(function(tb){
  tb.querySelectorAll('thead th').forEach(function(th, i){
    th.title = 'Ordenar por esta columna';
    th.addEventListener('click', function(){
      var tbody = tb.querySelector('tbody'); if (!tbody) return;
      var dir = th._d = -(th._d || -1);
      tb.querySelectorAll('thead th .xp-arrow').forEach(function(a){ a.remove(); });
      var ar = document.createElement('span'); ar.className = 'xp-arrow'; ar.textContent = dir > 0 ? '\\u25B2' : '\\u25BC'; th.appendChild(ar);
      Array.prototype.slice.call(tbody.rows).map(function(r){ return [xpVal(r.cells[i]), r]; })
        .sort(function(a, b){
          if (a[0] === null) return 1; if (b[0] === null) return -1;
          return a[0] < b[0] ? -dir : a[0] > b[0] ? dir : 0;
        })
        .forEach(function(p){ tbody.appendChild(p[1]); });
    });
  });
});
`;
    const orgAttr = document.documentElement.getAttribute('data-org');   // hereda el tema (MVP = naranja) en el export; sin data-theme (siempre claro)
    const html = `<!doctype html><html lang="es"${orgAttr ? ` data-org="${escapeHtml(orgAttr)}"` : ''}><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
${extLinks}
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,480;9..144,560;9..144,640&display=swap">
<style>${css}</style>
<style>${exportCss}</style>
</head><body class="xport">
<div id="xpProg"></div><div class="xp-grain"></div>
<div class="xp-top"><span class="xp-brand"><i class="fa-solid fa-chart-pie"></i> MVP · ${EN ? 'Investor Profile' : 'Perfil del inversionista'}</span><span class="xp-date">${EN ? 'Generated' : 'Generado'} ${escapeHtml(dateStr)}</span><button class="xp-print" onclick="window.print()"><i class="fa-solid fa-print"></i> ${EN ? 'Print / PDF' : 'Imprimir / PDF'}</button></div>
<div class="xp-wrap"><div class="db-detail" id="dbDetail"><div class="db-detail-content" id="dbDetailContent">${clone.innerHTML}</div></div></div>
<div class="xp-foot"><span class="xp-foot-tag">MVP Manager · ${EN ? 'Confidential document' : 'Documento confidencial'} · ${escapeHtml(dateStr)}</span>${EN
  ? `Prepared exclusively for ${escapeHtml(inv.name)}. Figures based on the funds' official records and market prices at the most recent close. Valuations of unrealized positions are estimates and may change. This document is for information purposes only and does not constitute an offer or investment advice.`
  : `Preparado exclusivamente para ${escapeHtml(inv.name)}. Cifras basadas en los registros oficiales de los fondos y precios de mercado al cierre más reciente. Las valuaciones de posiciones no realizadas son estimadas y pueden variar. Este documento es informativo y no constituye una oferta ni asesoría de inversión.`}</div>
<script>${script}<\/script>
</body></html>`;

    const fileName = ((inv.name + (EN ? ' Investor Profile' : ' Perfil Inversionista')).replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim()) + ' · ' + dlStamp();
    downloadBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), fileName + '.html');
    toast('HTML descargado');
  } catch (e) {
    console.warn('[report] export HTML falló:', e);
    toast('Error al generar HTML: ' + e.message);
  }
}

async function exportInvestorPdfJsPDF(posId) {
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
    else sub.push(data.pos.length + T(' posiciones', ' positions'));
    sub.push(T('Generado ', 'Generated ') + new Date().toLocaleDateString(EN ? 'en-US' : 'es-MX'));
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
      { l: 'ACCOUNT BALANCE', v: fmtMoney(t.totActual), accent: ink },
      { l: 'ACCOUNT BALANCE + DIST.', v: fmtMoney((+t.totActual || 0) + (+t.totDist || 0)), accent: green },
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

// ── Recordar el detalle abierto (por pestaña) para restaurarlo al recargar ──
const DB_DETAIL_KEY = 'dbOpenDetail';
function rememberDbDetail(obj) { try { sessionStorage.setItem(DB_DETAIL_KEY, JSON.stringify(obj)); } catch {} }
function forgetDbDetail() { try { sessionStorage.removeItem(DB_DETAIL_KEY); } catch {} }
function restoreDbDetailFromSession() {
  let obj = null;
  try { obj = JSON.parse(sessionStorage.getItem(DB_DETAIL_KEY) || 'null'); } catch { obj = null; }
  if (!obj) return;
  if (obj.t === 'inv' && obj.id != null) openInvestor(obj.id);
  else if (obj.t === 'grp' && Array.isArray(obj.ids) && obj.ids.length) openInvestorGroup(obj.ids);
  else if (obj.t === 'co' && obj.id != null) openCompany(obj.id);
}

async function openInvestor(id) {
  const inv = dbInvestors.find(x => x.id === id);
  if (!inv) return;
  rememberDbDetail({ t: 'inv', id });
  showDetailLoading();
  try {
    const [{ data: contacts }, { data: positions }] = await Promise.all([
      sb.from('contacts').select('id, name, email').eq('investor_id', id).order('id'),
      sb.from('investments')
        .select(`id, entry_ev_b, entry_pps, current_ev_b, current_ev_pps, shares,
                 commitment, capital_sent, capital_sent_flag, commitment_actual, dpi_moic, carry_pct,
                 start_date, end_date, duration_years, distributed_at, last_ca_letter, welcome_letter, spacex_indirect,
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
  rememberDbDetail({ t: 'grp', ids });
  showDetailLoading();
  try {
    const [{ data: contacts }, { data: positions }] = await Promise.all([
      sb.from('contacts').select('id, name, email, investor_id').in('investor_id', ids).order('id'),
      sb.from('investments')
        .select(`id, investor_id, entry_ev_b, entry_pps, current_ev_b, current_ev_pps, shares,
                 commitment, capital_sent, capital_sent_flag, commitment_actual, dpi_moic, carry_pct,
                 start_date, end_date, duration_years, distributed_at, last_ca_letter, welcome_letter, spacex_indirect,
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
  rememberDbDetail({ t: 'co', id });
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
  forgetDbDetail();
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
  { key: 'capital_sent',      label: 'Capital Enviado',             default: true  },
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
  { key: 'welcome_letter',    label: 'Welcome Letter',              default: true  },
];
let dbPosVisibleCols = loadPosVisibleCols();
let lastInvestorDetail = null;   // caché para re-render al toggle (evita re-fetch)

function loadPosVisibleCols() {
  let set = null;
  try {
    const raw = localStorage.getItem('dbPosVisibleCols');
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) set = new Set(arr);
    }
  } catch {}
  if (!set) set = new Set(POSITION_COLUMNS.filter(c => c.default).map(c => c.key));
  // Migración una-sola-vez: asegurar que la columna nueva "Welcome Letter" aparezca aunque haya preferencias guardadas.
  try {
    if (!localStorage.getItem('dbPosCols_welcome_v1')) {
      set.add('welcome_letter');
      localStorage.setItem('dbPosVisibleCols', JSON.stringify([...set]));
      localStorage.setItem('dbPosCols_welcome_v1', '1');
    }
    if (!localStorage.getItem('dbPosCols_capsent_v1')) {
      set.add('capital_sent');
      localStorage.setItem('dbPosVisibleCols', JSON.stringify([...set]));
      localStorage.setItem('dbPosCols_capsent_v1', '1');
    }
  } catch {}
  return set;
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
  const numericKeys = new Set(['commitment','capital_sent','commitment_actual','dpi_moic','carry_pct','shares','entry_ev_b','entry_pps','current_ev_b','current_ev_pps','duration_years']);

  const cellFor = (p, key) => {
    switch (key) {
      case 'company':           return `<td class="col-name">${escapeHtml(p.companies?.name || '—')}</td>`;
      case 'series':            return `<td>${escapeHtml(p.series?.name || '—')}</td>`;
      case 'commitment':        return `<td class="num">${fmt.money(p.commitment)}</td>`;
      case 'capital_sent':      return `<td class="num">${p.capital_sent_flag ? `<span style="color:#c62828;font-weight:600" title="${escapeHtml(p.capital_sent_flag)}"><i class="fa-solid fa-triangle-exclamation"></i> ${escapeHtml(p.capital_sent_flag)}</span>` : (p.capital_sent != null ? fmt.money(p.capital_sent) : '<span style="color:var(--gray-400)" title="Pendiente de verificación manual">—</span>')}</td>`;
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
      case 'welcome_letter':    return `<td>${p.welcome_letter ? `<a href="${escapeHtml(p.welcome_letter)}" target="_blank" rel="noopener"><i class="fa-solid fa-file-pdf"></i> PDF</a>` : '<span style="color:var(--gray-400)">No disponible</span>'}</td>`;
      default: return '<td></td>';
    }
  };

  const isActive = /activ/i.test(title);   // en activas, "Comp. ejec." se muestra como "Account Balance"
  const colLabel = (c) => (isActive && c.key === 'commitment_actual') ? 'Account Balance' : c.label;
  const visible = POSITION_COLUMNS.filter(c => isPosColVisible(c.key));
  const acctHead = showAcct ? '<th>Cuenta</th>' : '';
  const headers = acctHead + visible.map(c => `<th class="${numericKeys.has(c.key) ? 'num' : ''}">${escapeHtml(colLabel(c))}</th>`).join('');
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

// Recompras: posiciones vendidas por el fondo subyacente cuyo importe se reinvirtió (no es efectivo al LP).
function renderRepurchasesBlock(title, rows) {
  if (!rows.length) return '';
  const tot = rows.reduce((a, d) => ({ g: a.g + (d._gross || 0), r: a.r + (d._reinv || 0), c: a.c + (d._cash || 0) }), { g: 0, r: 0, c: 0 });
  return `
    <div class="db-section">
      <div class="db-section-h">${escapeHtml(title)} (${rows.length})</div>
      <div class="db-section-note">Posiciones que el fondo subyacente liquidó y cuyo importe se reinvirtió en un vehículo directo de SpaceX (Serie 26A QP). La parte reinvertida no es efectivo devuelto al inversionista; el resto (si lo hay) sí se entregó en efectivo.</div>
      <table class="db-table">
        <thead>
          <tr>
            <th>Fecha</th>
            <th>Empresa</th>
            <th class="hide-mobile">Serie vendida</th>
            <th class="num hide-mobile">Acciones</th>
            <th class="num">Vendido</th>
            <th class="num">Reinvertido</th>
            <th class="num">Efectivo neto</th>
            <th class="hide-mobile">Carta</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(d => `
            <tr>
              <td>${escapeHtml(d.distribution_date || '—')}</td>
              <td>${escapeHtml(d.underlying_company || d._company)}</td>
              <td class="hide-mobile">${escapeHtml(d._series)}</td>
              <td class="num hide-mobile">${d.shares_distributed != null ? Number(d.shares_distributed).toLocaleString('en-US') : '—'}</td>
              <td class="num">${fmtMoney(d._gross || 0)}</td>
              <td class="num">${d._reinv ? fmtMoney(d._reinv) : '—'}</td>
              <td class="num">${d._cash ? fmtMoney(d._cash) : '—'}</td>
              <td class="hide-mobile">${d.letter_url ? `<a href="${escapeHtml(d.letter_url)}" target="_blank" rel="noopener"><i class="fa-solid fa-file-pdf"></i> PDF</a>` : '—'}</td>
            </tr>`).join('')}
          <tr class="db-total-row">
            <td colspan="4">TOTAL</td>
            <td class="num">${fmtMoney(tot.g)}</td>
            <td class="num">${tot.r ? fmtMoney(tot.r) : '—'}</td>
            <td class="num">${tot.c ? fmtMoney(tot.c) : '—'}</td>
            <td class="hide-mobile"></td>
          </tr>
        </tbody>
      </table>
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
// Calendario anclado al earnings Q2 de SpaceX — fecha AÚN NO oficial; mejor estimación:
// 1er cliff 17 ago 2026 (2 días hábiles tras earnings). Bloques 7% cada ~15 días tras el cliff.
// El día 180 (9 dic 2026) es fijo desde el IPO (12 jun 2026), igual que los días 280/340/366
// del extendido. Earnings Q3/Q4/2027: estimados con la misma cadencia (~45 días tras el cierre
// del trimestre). Re-ajustar cuando SpaceX publique cada fecha oficial.
const SPX_LOCKUP_B = [
  { date: '2026-08-17', pct: '20%', label: '1er cliff (2 días tras earnings Q2, est. — fecha aún no oficial)' },
  { date: '2026-09-01', pct: '7%',  label: 'Bloque 1 (~15 días tras el cliff)' },
  { date: '2026-09-16', pct: '7%',  label: 'Bloque 2' },
  { date: '2026-10-01', pct: '7%',  label: 'Bloque 3' },
  { date: '2026-10-16', pct: '7%',  label: 'Bloque 4' },
  { date: '2026-11-02', pct: '7%',  label: 'Bloque 5' },
  { date: '2026-11-17', pct: '28%', label: '2º cliff (tras earnings Q3 2026, est.)' },
  { date: '2026-12-09', pct: 'Remanente', label: 'Día 180 — expiración total' },
];
const SPX_LOCKUP_A_EXT = [
  { date: '2027-02-16', pct: '20%', label: 'Lock-up extendido (tras earnings Q4 2026, est.)' },
  { date: '2027-03-19', pct: '10%', label: 'Día 280' },
  { date: '2027-05-18', pct: '20%', label: 'Tras earnings Q1 2027 (est.)' },
  { date: '2027-05-18', pct: '10%', label: 'Día 340' },
  { date: '2027-06-13', pct: '20%', label: 'Día 366' },
  { date: '2027-08-17', pct: '20%', label: 'Tras earnings Q2 2027 (est.) — liberación final' },
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
      { hito: '1er cliff — 2 días tras earnings Q2 (~17 ago 2026, est.)', pct: '20%', detalle: 'Fecha del earnings Q2 aún no oficial; 17 ago 2026 es la mejor estimación. Acumulado: 20%.' },
      { hito: 'Bono por desempeño', pct: '+10%', detalle: 'Si la acción cotiza ≥30% arriba del IPO en 5 de 10 días consecutivos (pre-earnings Q2). Acumulado: 30%.' },
      { hito: 'Bloque 1 (~1 sep 2026)', pct: '7%', detalle: 'Acumulado: 37%.' },
      { hito: 'Bloque 2 (~16 sep 2026)', pct: '7%', detalle: 'Acumulado: 44%.' },
      { hito: 'Bloque 3 (~1 oct 2026)', pct: '7%', detalle: 'Acumulado: 51%.' },
      { hito: 'Bloque 4 (~16 oct 2026)', pct: '7%', detalle: 'Acumulado: 58%.' },
      { hito: 'Bloque 5 (~2 nov 2026)', pct: '7%', detalle: 'Acumulado: 65%.' },
      { hito: '2º cliff — tras earnings Q3 2026 (~17 nov 2026, est.)', pct: '28%', detalle: 'Acumulado: 93%.' },
      { hito: 'Día 180 (9 dic 2026)', pct: 'Remanente', detalle: 'Expiración total. Acumulado: 100%.' },
    ],
    nota: 'Estructura y porcentajes del S-1 de SpaceX (mayo 2026). La fecha del primer earnings aún no es oficial: el 1er cliff (~17 ago 2026) es la mejor estimación disponible; hitos posteriores estimados con la misma cadencia. El prospecto final es la autoridad.',
  },
  A: {
    label: 'Liberación en dos mitades (hasta ~14 meses)',
    summary: 'La posición se libera en <b>dos mitades</b>. La primera (~50%) durante los primeros ~6 meses (lock-up de 180 días); la segunda (~50%) en un <b>lock-up extendido</b> que se estira hasta ~14 meses post-IPO (liberación final ~ agosto 2027).',
    groups: [
      { label: 'Primera mitad (~50%) — lock-up de 180 días', phases: [
        { hito: '2 días tras earnings Q2 (~17 ago 2026, est.)', pct: '20%', detalle: 'Primer cliff de esta mitad. Fecha del earnings Q2 aún no oficial; mejor estimación.' },
        { hito: '~mismo período', pct: '+10% bonus', detalle: 'Solo si el precio cierra ≥30% arriba del precio de oferta en 5 de los 10 días siguientes al earnings Q2.' },
        { hito: 'Cada ~15 días', pct: '7% por bloque', detalle: 'Bloques sucesivos (~sep–nov 2026).' },
        { hito: 'Tras earnings Q3', pct: '28%', detalle: '~noviembre 2026 (est.).' },
        { hito: 'Día 180 (9 dic 2026)', pct: 'Remanente', detalle: 'Cierre de la primera mitad.' },
      ] },
      { label: 'Segunda mitad (~50%) — lock-up extendido (patrón 20/10/20/10/20/20)', phases: [
        { hito: '2 días tras earnings Q4 2026 (~feb 2027, est.)', pct: '20%', detalle: 'Inicio del lock-up extendido.' },
        { hito: 'Día 280 (~19 mar 2027)', pct: '10%', detalle: '' },
        { hito: '2 días tras earnings Q1 2027 (~may 2027, est.)', pct: '20%', detalle: '' },
        { hito: 'Día 340 (~18 may 2027)', pct: '10%', detalle: '' },
        { hito: 'Día 366 (~13 jun 2027)', pct: '20%', detalle: '' },
        { hito: '2 días tras earnings Q2 2027 (~ago 2027, est.)', pct: '20%', detalle: 'Remanente — liberación final.' },
      ] },
    ],
    nota: 'Estructura y porcentajes del S-1 de SpaceX (mayo 2026). La fecha del primer earnings aún no es oficial: el 1er cliff (~17 ago 2026) es la mejor estimación disponible; hitos posteriores estimados con la misma cadencia. El prospecto final es la autoridad. Liquidez total ~ agosto 2027 (~14 meses post-IPO).',
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
function buildLp360(positions, investorIds) {
  const num = v => (Number(v) || 0);
  const active = positions.filter(p => !p.distributed_at);
  const navActive = active.reduce((a, p) => a + (num(p.commitment_actual) || num(p.commitment)), 0);
  // Neteo de reinversiones 22F→26A QP (paid-in y distribuido). Misma regla que el reporte.
  const net = computeReinvestNetting(positions.map(p => ({ seriesName: p.series?.name, commitment: num(p.commitment), dists: p.investment_distributions })), investorIds || []);
  const committedNet = positions.reduce((a, p) => a + num(p.commitment), 0) - net.recycledPaidIn;   // paid-in real
  let distrib = 0;
  positions.forEach(p => (p.investment_distributions || []).forEach(d => { distrib += num(d.value_in_kind) + num(d.cash_proceeds); }));
  distrib -= net.reinvestedDist;                                                                     // distribuido real
  const committedActive = committedNet;
  const moic = committedNet ? (navActive + distrib) / committedNet : 0;   // MOIC/TVPI: (valor activo + distribuido) / paid-in real
  const committedTotal = committedNet;
  const dpi = committedNet ? distrib / committedNet : 0;
  const byCo = {}, byTheme = {};
  active.forEach(p => {
    const isFund = p.companies?.id === 10;
    const val = num(p.commitment_actual) || num(p.commitment);
    const label = isFund ? (p.series?.name || 'Fondo').replace('MVP ', '') : (p.companies?.name || '—');
    byCo[label] = (byCo[label] || 0) + val;
    const theme = isFund ? 'Fondos All-Star' : companyTheme(p.companies?.name);
    byTheme[theme] = (byTheme[theme] || 0) + val;
  });
  let companyExp = Object.entries(byCo).sort((a, b) => b[1] - a[1]);
  let themeExp = Object.entries(byTheme).sort((a, b) => b[1] - a[1]);
  // Si el portafolio está totalmente distribuido (sin posiciones activas), la
  // exposición por NAV queda vacía → las gráficas no cargarían. Caemos a la
  // composición histórica por compromiso para que siempre haya algo que mostrar.
  let expoBasis = 'nav';
  if (!companyExp.length && positions.length) {
    const byCoH = {}, byThH = {};
    positions.forEach(p => {
      const val = num(p.commitment);
      if (!val) return;
      const isFund = p.companies?.id === 10;
      const label = isFund ? (p.series?.name || 'Fondo').replace('MVP ', '') : (p.companies?.name || '—');
      byCoH[label] = (byCoH[label] || 0) + val;
      const theme = isFund ? 'Fondos All-Star' : companyTheme(p.companies?.name);
      byThH[theme] = (byThH[theme] || 0) + val;
    });
    // Mismo neteo que loadDb: el capital reciclado 22F→26A QP es SpaceX;
    // restarlo de su bucket para no contar dos veces el mismo dinero.
    if (net.recycledPaidIn > 0) {
      const spx = positions.find(p => p.companies?.id === 27);
      if (spx) {
        const lbl = spx.companies?.name || '—', th = companyTheme(lbl);
        if (byCoH[lbl]) { byCoH[lbl] -= net.recycledPaidIn; if (byCoH[lbl] <= 0) delete byCoH[lbl]; }
        if (byThH[th])  { byThH[th]  -= net.recycledPaidIn; if (byThH[th]  <= 0) delete byThH[th]; }
      }
    }
    companyExp = Object.entries(byCoH).sort((a, b) => b[1] - a[1]);
    themeExp = Object.entries(byThH).sort((a, b) => b[1] - a[1]);
    expoBasis = 'commitment';
  }
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
    if (by.A.length) blocks.push({ scope: by.A.join(' · '), summary: 'Una porción sigue un lock-up extendido (en parcialidades) hasta ~14 meses post-IPO; liberación final ~ago 2027.' });
    lockup = { blocks, next: nextB || null, detail: spxLockupDetail(spxPos) };
  }
  _lp360 = { companyExp, themeExp };
  return { moic, distrib, dpi, nActive: active.length, committedNet, navActive, companyExp, themeExp, expoBasis, lockup, hasSpx: spxPos.length > 0 };
}
// Paleta de gráficas del 360/export: en MVP sin azules (identidad naranja); Cretum conserva navy.
function lpChartPalette() {
  return currentOrg === 'mvp'
    ? ['#E8650D', '#8A93A6', '#F4A259', '#4F5866', '#B04F0A', '#C4CBD6', '#FBCE9E', '#2E3440', '#D97E3F', '#6E7787']
    : ['#e8650d', '#1a3a6b', '#0f9b5a', '#9b59b6', '#e1b12c', '#3b65b0', '#c0392b', '#16a085'];
}
async function draw360Theme() {
  const cv = document.getElementById('lpThemeChart');
  if (!cv || !_lp360 || !_lp360.themeExp.length) return;
  try { await loadScript('https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js'); } catch (e) { return; }
  const labels = _lp360.themeExp.map(t => t[0]);
  const data = _lp360.themeExp.map(t => t[1]);
  const colors = lpChartPalette();
  if (cv._chart) cv._chart.destroy();
  cv._chart = new Chart(cv.getContext('2d'), {
    type: 'doughnut',
    data: { labels, datasets: [{ data, backgroundColor: colors.slice(0, labels.length), borderWidth: 2, borderColor: '#fff' }] },
    options: { responsive: false, plugins: { legend: { position: 'bottom', labels: { font: { size: 11 }, boxWidth: 10, usePointStyle: true } } }, cutout: '60%' }
  });
}

// Ícono de info (i) con popup explicativo al hacer clic. `right`=ancla el popup a la derecha (cards del borde).
function infoIc(text, right) {
  return `<span class="info-ic${right ? ' info-ic--right' : ''}" onclick="event.stopPropagation();toggleInfoPop(this)" title="¿Cómo se calcula?"><i class="fa-solid fa-circle-info"></i><span class="info-pop">${escapeHtml(text)}</span></span>`;
}
function toggleInfoPop(el) {
  const open = el.classList.contains('open');
  document.querySelectorAll('.info-ic.open').forEach(e => e.classList.remove('open'));
  if (!open) el.classList.add('open');
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('.info-ic')) document.querySelectorAll('.info-ic.open').forEach(el => el.classList.remove('open'));
});
// Textos de ayuda de los KPIs del LP 360.
const LP_KPI_INFO = {
  posiciones: 'Número total de posiciones del inversionista: activas (sin distribuir) + terminadas (ya distribuidas o liquidadas).',
  commitTotal: 'Capital comprometido real (paid-in): suma del compromiso de todas las posiciones, neto de reinversiones SpaceX. La mitad de la Serie 22F que se vendió y se reinvirtió en la 26A QP se cuenta una sola vez (no se dobla el capital reciclado).',
  commitActual: 'Valor actual estimado (NAV) de las posiciones activas, a precio de mercado (mark-to-market, sincronizado con el último precio). No incluye posiciones ya distribuidas.',
  moic: 'Múltiplo total sobre el capital (TVPI): (valor actual de las posiciones activas + distribuido real) ÷ comprometido real. Sí incluye lo ya distribuido. Neto de reinversiones SpaceX.',
  distribuido: 'Efectivo y acciones devueltos al inversionista a la fecha, incluyendo distribuciones de fondos aplicadas a llamadas de capital. Excluye recompras/reinversiones.',
  dpi: 'Distribuciones sobre capital (DPI): distribuido real ÷ comprometido real. Cuánto se ha devuelto en efectivo/acciones por cada dólar comprometido.',
  posActivas: 'Posiciones que siguen vivas (aún sin distribuir ni liquidar).',
};

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
  const repurchases = [];   // vendidas pero reinvertidas (recompra): se separan de distribuciones reales
  positions.forEach(p => {
    const isFund = p.companies?.id === DIVERSIFIED_FUND_ID;
    (p.investment_distributions || []).forEach(d => {
      const row = {
        ...d,
        _company: p.companies?.name || '—',
        _series: p.series?.name || '—',
      };
      if (/reinver|reinvest/i.test(d.notes || '')) repurchases.push(row);
      else (isFund ? distrosFund : distrosSpv).push(row);
    });
  });
  const sortDesc = (a, b) => (b.distribution_date || '').localeCompare(a.distribution_date || '');
  distrosSpv.sort(sortDesc);
  distrosFund.sort(sortDesc);
  repurchases.sort(sortDesc);
  const _lpIds = combined ? (inv._accounts || []).map(a => a.id) : (inv.id != null ? [inv.id] : []);
  // Reparte el monto reinvertido (R) entre las recompras para mostrar reinvertido vs efectivo por fila.
  if (repurchases.length) {
    const _rnet = computeReinvestNetting(positions.map(p => ({ seriesName: p.series?.name, commitment: +p.commitment || 0, dists: p.investment_distributions })), _lpIds);
    let _remR = _rnet.reinvestedDist;
    repurchases.forEach(d => {
      const gross = (+d.cash_proceeds || 0) + (+d.value_in_kind || 0);
      const reinv = Math.min(_remR, gross);
      _remR -= reinv;
      d._gross = gross; d._reinv = reinv; d._cash = gross - reinv;
    });
  }
  const _lp = buildLp360(positions, _lpIds);
  const _lpkpi = (l, v, c, info, right) => `<div class="lp-kpi"><div class="lp-kpi-l">${l}${info ? infoIc(info, right) : ''}</div><div class="lp-kpi-v ${c || ''}">${v}</div></div>`;
  const lpKpis = `<div class="lp-kpis">
    ${_lpkpi('MOIC', _lp.moic.toFixed(2) + 'x', moicClass(_lp.moic), LP_KPI_INFO.moic)}
    ${_lpkpi('Distribuido a la fecha', fmtUsdShort(_lp.distrib), '', LP_KPI_INFO.distribuido)}
    ${_lpkpi('DPI', _lp.dpi.toFixed(2) + 'x', '', LP_KPI_INFO.dpi)}
    ${_lpkpi('Posiciones activas', String(_lp.nActive), '', LP_KPI_INFO.posActivas, true)}
  </div>`;
  const _maxCo = _lp.companyExp.length ? _lp.companyExp[0][1] : 1;
  const _expoNav = _lp.expoBasis !== 'commitment';   // false = portafolio totalmente distribuido (histórico)
  const exposicion = _lp.companyExp.length ? `<div class="db-section">
    <div class="db-section-h">Exposición del portafolio${_expoNav ? '' : ' · histórico'}</div>
    <div class="lp-expo">
      <div class="lp-expo-bars">
        <div class="lp-expo-sub">Por empresa / fondo · ${_expoNav ? 'NAV activo' : 'por compromiso'}</div>
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
    <div class="lp-events-note">Estructura del S-1 de SpaceX (IPO 12-jun-2026); primer earnings aún no oficial — 1er cliff estimado: 17 ago 2026. El prospecto final es la autoridad.</div>
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
          ${positions.some(p => (p.companies?.name) === 'Space X' || (p.spacex_indirect && +p.spacex_indirect.shares > 0 && !p.distributed_at)) ? `<button class="dbx-btn spx" onclick="exportSpacexReport()" title="Reporte SpaceX — posición, calendario de liberación y cartas del IPO"><i class="fa-solid fa-rocket"></i> Reporte SpaceX</button>` : ''}
          <button class="dbx-btn" onclick="exportInvestorXlsx()" title="Exportar todo su detalle a Excel"><i class="fa-solid fa-file-excel"></i> Excel</button>
          <button class="dbx-btn pdf" onclick="exportInvestorPdf()" title="Exportar todo su detalle a PDF"><i class="fa-solid fa-file-pdf"></i> PDF</button>
          <button class="dbx-btn html" onclick="exportInvestorHtml()" title="Descargar el perfil como reporte HTML para compartir"><i class="fa-solid fa-file-code"></i> HTML</button>
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
        <div class="db-stat"><div class="db-stat-l">Posiciones${infoIc(LP_KPI_INFO.posiciones)}</div><div class="db-stat-v">${inv.positions}</div></div>
        <div class="db-stat"><div class="db-stat-l">Commitment total${infoIc(LP_KPI_INFO.commitTotal)}</div><div class="db-stat-v">${fmtMoney(_lp.committedNet)}</div></div>
        <div class="db-stat"><div class="db-stat-l">Commitment actual${infoIc(LP_KPI_INFO.commitActual, true)}</div><div class="db-stat-v">${fmtMoney(_lp.navActive)}</div></div>
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

    ${exposicion}
    ${eventos}
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
    ${renderPositionsBlock('Posiciones activas', activePositions, combined)}
    ${renderPositionsBlock('Posiciones terminadas', terminatedPositions, combined)}

    ${renderRepurchasesBlock('Recompras y reinversiones', repurchases)}
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
      { company: 'Neutron Holdings, Inc., DBA Lime',            invested: 765039,   pct: 0.006, mtm: 3021661,  moic: 3.9497, corpVal: 4.061,  pps: 67.20,   entry: 20.16,   shares: 45100.5,  fdso: 60.61},
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
    overallTotal:     { invested: 161119217, mtm: 315109202, moic: 1.9558 },
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
      { company: 'Decart.AI, Inc.', invested: 25749946, pct: 0.160, mtm: 25749946, moic: 1.0000, corpVal: 3.914, pps: 197.78, entry: 197.78, shares: 130197, fdso: 19.8 },
      { company: 'Saronic Technologies', invested: 20000000, pct: 0.124, mtm: 20000000, moic: 1.0000, corpVal: 9.25, pps: 27.45, entry: 27.45, shares: 728730, fdso: 337 },
      { company: 'Anthropic PBC', invested: 18587304, pct: 0.115, mtm: 62330216, moic: 3.3534, corpVal: 965, pps: 589.01, entry: 175.65, shares: 105822, fdso: 1638.34 },
      { company: 'X.AI Corp. (SpaceX)',    invested: 15000870, pct: 0.099, mtm: 53228475,   moic: 3.5484,  corpVal: 1770,   pps: 135,    entry: 38.05,  shares: 394285,    fdso: 11869  },
      { company: 'Mach Industries', invested: 9999998, pct: 0.062, mtm: 9999998, moic: 1.0000, corpVal: 1.8, pps: 3.62, entry: 3.62, shares: 2762430, fdso: 497.2 },
      { company: 'CHAOS Industries', invested: 9999962, pct: 0.062, mtm: 9999962, moic: 1.0000, corpVal: 4.441, pps: 138.94, entry: 138.94, shares: 71975, fdso: 32 },
      { company: 'Base Power, Inc.', invested: 9280871, pct: 0.058, mtm: 24917972, moic: 2.6849, corpVal: 12, pps: 32.47, entry: 12.09, shares: 767510, fdso: 369.6 },
      { company: 'Second Front Systems', invested: 7500000, pct: 0.047, mtm: 7500000, moic: 1.0000, corpVal: 1.1, pps: 1, entry: 1, shares: 7500000, fdso: 1100 },
      { company: 'Payward (Kraken)', invested: 6375000, pct: 0.040, mtm: 8557300, moic: 1.3423, corpVal: 20.55, pps: 61.47, entry: 45.79, shares: 139211, fdso: 334.3 },
      { company: 'Agility Robotics', invested: 5211514, pct: 0.032, mtm: 11453569, moic: 2.1977, corpVal: 4.187, pps: 145.37, entry: 66.15, shares: 78789, fdso: 28.8 },
      { company: 'Kodiak Robotics', invested: 5000000, pct: 0.031, mtm: 11089848, moic: 2.2180, corpVal: 1.109, pps: 5.08, entry: 2.29, shares: 2183041, fdso: 218.3 },
      { company: 'Epirus, Inc.', invested: 4999998, pct: 0.031, mtm: 4999998, moic: 1.0000, corpVal: 1.011, pps: 2.77, entry: 2.77, shares: 1801996, fdso: 365.0 },
      { company: 'Radiant Industries', invested: 4999989, pct: 0.031, mtm: 4999989, moic: 1.0000, corpVal: 1.88, pps: 42.32, entry: 42.32, shares: 118155, fdso: 44.4 },
      { company: 'Cohere Inc.', invested: 4999771, pct: 0.031, mtm: 12097760, moic: 2.4197, corpVal: 20.5, pps: 558.25, entry: 230.71, shares: 21671, fdso: 36.7 },
      { company: 'Mythic Inc.', invested: 2000000, pct: 0.012, mtm: 2000000, moic: 1.0000, corpVal: 0.159, pps: 0.0024, entry: 0.0024, shares: 827061450, fdso: 66250 },
      { company: 'Epic Games, Inc.', invested: 1833323, pct: 0.011, mtm: 2269200, moic: 1.2378, corpVal: 26.16, pps: 600.0, entry: 484.75, shares: 3782, fdso: 43.6 },
      { company: 'Figure AI Inc.', invested: 1300007, pct: 0.008, mtm: 18592184, moic: 14.3016, corpVal: 39.0, pps: 194.93, entry: 13.63, shares: 95378, fdso: 200.1 },
      { company: 'Groq, Inc.', invested: 462047, pct: 0.003, mtm: 1475476, moic: 3.1933, corpVal: 15.087, pps: 73.0, entry: 22.86, shares: 20212, fdso: 206.7 }
    ],
    activeTotal:      { invested: 153300600, mtm: 291261893, moic: 1.8999 },
    pendingTitle: 'Pending Positions (Q2 2026)',
    pending: [],
    pendingTotal:     { invested: 0, mtm: 0, moic: 0 },
    distributed: [
      { company: 'Groq, Inc. (Distributed)', invested: 7381979, pct: 0.046, mtm: 23573233, moic: 3.1933, corpVal: 15.087, pps: 73.0, entry: 22.86, shares: 322921, fdso: 206.7 },
      { company: 'Klarna Holding AB', invested: 436638, pct: 0.003, mtm: 274076, moic: 0.6277, corpVal: 5.595, pps: 13.38, entry: 21.32, shares: 20484, fdso: 418.2 }
    ],
    overallLabel:     'Total — Overall (Invested)',
    overallTotal:     { invested: 151119219, mtm: 297699128, moic: 1.9700 },
    overallTotal2:    { label: 'Total — Overall (Commitment)', invested: 293000000, mtm: 446989985, moic: 1.5256 },
    // Dominio para el logo (Clearbit). Fallback a monograma si no carga.
    logos: {
      'Decart.AI, Inc.':          'decart.ai',
      'Mach Industries':          'machindustries.com',
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
// Empresas públicas cuyo mark vive en la DB (cron Finnhub) y se aplica LIVE a los fund trackers.
// displayMult: por si una fila del tracker quedara en otra base que la DB (hoy todas en base de mercado).
// (Lime: re-baseada a POST-split 672:1 el 2026-07-11 — DB y fila del tracker ya en base de mercado;
// shares por carta "Lime IPO" jul-2026, el cron escribe el precio LIME directo.)
const LIVE_TRACKER_COMPANIES = [
  { dbId: 27, rowRe: /space exploration|spacex/i, name: 'SpaceX', label: 'SPCX', displayMult: 1 },
  { dbId: 18, rowRe: /neutron|lime/i,             name: 'Lime',   label: 'LIME', displayMult: 1 },
  // Sin posiciones SPV en la DB → su mark vivo viene de la tabla live_marks (cron Finnhub).
  { ticker: 'HAWK', rowRe: /hawkeye/i, name: 'HawkEye 360', label: 'HAWK', displayMult: 1 },
];
const _liveMarks = {};        // dbId -> { pps, evB } (en la base de la DB/tracker)
let _spcxFetchStarted = false;
let _spcxCurrentFund = null;
const SPCX_ROW_RE = /space exploration|spacex/i;

function fetchSpacexLiveMark() {
  if (_spcxFetchStarted || !sb) return;
  _spcxFetchStarted = true;
  const arrived = (key, pps, evB) => {
    if (!pps) return;
    _liveMarks[key] = { pps, evB };
    applySpacexLiveToTrackers();
    const det = document.getElementById('ftDetail');
    if (det && det.classList.contains('show') && _spcxCurrentFund) {
      renderFundTrackerDetail(_spcxCurrentFund);
    }
  };
  LIVE_TRACKER_COMPANIES.forEach(cfg => {
    if (cfg.dbId) {
      sb.from('investments')
        .select('current_ev_pps,current_ev_b')
        .eq('company_id', cfg.dbId)
        .is('distributed_at', null)
        .limit(1)
        .then(({ data, error }) => {
          if (error || !data || !data.length) return;
          arrived(cfg.dbId, data[0].current_ev_pps, data[0].current_ev_b);
        });
    } else if (cfg.ticker) {
      sb.from('live_marks')
        .select('pps,ev_b')
        .eq('ticker', cfg.ticker)
        .limit(1)
        .then(({ data, error }) => {
          if (error || !data || !data.length) return;
          arrived(cfg.ticker, data[0].pps, data[0].ev_b);
        });
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
  if (!Object.keys(_liveMarks).length) return;
  for (const f of [FUND_TRACKERS.fundIV, FUND_TRACKERS.fundV]) {
    if (!f || f.placeholder || !f.active) continue;
    const notes = [];
    for (const cfg of LIVE_TRACKER_COMPANIES) {
      const mk = _liveMarks[cfg.dbId || cfg.ticker];
      if (!mk) continue;
      let hit = false;
      for (const row of f.active) {
        if (!cfg.rowRe.test(row.company) || !row.shares) continue;
        row.pps = mk.pps;
        if (mk.evB) row.corpVal = mk.evB;
        row.mtm = Math.round(row.shares * mk.pps);
        if (row.invested) row.moic = row.mtm / row.invested;
        hit = true;
      }
      if (hit) notes.push(cfg.name + ' @ mercado (' + cfg.label + ' $' +
        (mk.pps * cfg.displayMult).toLocaleString('en-US', { maximumFractionDigits: 2 }) + ')');
    }
    if (!notes.length) continue;
    computeFundTotals(f); // los totales se recalculan desde las filas (incluye marks live)
    f._spcxLiveNote = notes.join(' · ');
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
          <button class="ft-export-btn ft-export-btn-alt" data-ftexp="overview" onclick="exportFundTrackerHtml('${f.id}', this)"><i class="fa-solid fa-file-code"></i> Descargar HTML</button>
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
// Fichas de empresas en INGLÉS (para exports de Empresas en EN). Mismo key que companyInfo.
const FT_CO_EN = {
  'RapidSOS, Inc.': { category:'Emergency data', tagline:'Emergency data platform connecting devices, apps and sensors to 911 centers.', pname:'RapidSOS', pdesc:'Routes location and critical data to emergency services in real time.', thesis:'Network-effect infrastructure across carriers, device makers and first responders.' },
  'BlueVoyant, Inc.': { category:'Cybersecurity', tagline:'Managed cybersecurity: detection and response (MDR) plus supply-chain defense.', pname:'MDR + Supply Chain Defense', pdesc:'24/7 monitoring and third-party risk management for enterprises and government.', thesis:'Structural demand for managed cyber defense amid growing threats.' },
  'Job and Talent Holding, Ltd': { category:'Staffing · marketplace', tagline:'On-demand jobs marketplace connecting temporary workers with companies.', pname:'Jobandtalent', pdesc:'Hiring and management of temporary staff at scale.', thesis:'Digitizes a huge, fragmented temporary labor market.' },
  'Epic Games, Inc.': { category:'Gaming · software', tagline:'Creator of Fortnite and Unreal Engine, the industry-standard 3D engine.', pname:'Fortnite · Unreal Engine', pdesc:'Gaming ecosystem, 3D engine, store and metaverse vision.', thesis:'Iconic brand with massive revenue; its antitrust litigation could open up app store markets.' },
  'Space Exploration Technologies Corp. (X)': { category:'Space · satellites', tagline:'SpaceX: world leader in reusable launch and Starlink satellite internet.', pname:'Falcon/Starship · Starlink', pdesc:'Reusable rockets and the largest satellite internet constellation.', thesis:'Trading since Jun-2026 (SPCX); valuation marked to market. High-conviction position.' },
  'Platform Science, Inc.': { category:'Telematics · trucking', tagline:'Telematics and connected-vehicle software platform for freight fleets.', pname:'Connected Vehicle Platform', pdesc:'On-board apps and data to optimize fleets and compliance.', thesis:'Digitizes fleet operations; partnerships with major truck manufacturers.' },
  'Patreon, Inc.': { category:'Creator economy', tagline:'Membership platform for creators to earn recurring subscriptions from fans.', pname:'Patreon', pdesc:'Subscriptions, exclusive content and community for creators.', thesis:'Recurring revenue for creators; entered at a high valuation, since marked down.' },
  'Wefox Holding AG': { category:'Insurtech', tagline:'European insurtech: digital insurance distribution through agents and platform.', pname:'Insurance platform', pdesc:'Connects insurers, agents and customers in a digital model.', thesis:'Digitizes insurance distribution; execution and profitability under scrutiny.' },
  'Cohere': { category:'Enterprise AI', tagline:'Language models (Command) and search (Rerank) focused 100% on enterprises.', pname:'Command / Rerank', pdesc:'LLMs and search with privacy and on-premise deployment.', thesis:'Neutral alternative for corporations that do not want to depend on OpenAI or Anthropic.' },
  'Hawkeye 360, Inc.': { category:'Geospatial · RF', tagline:'Radio-frequency geospatial analytics: detects and geolocates signals from satellites.', pname:'RF Analytics', pdesc:'Signals intelligence for defense, maritime security and monitoring.', thesis:'Unique RF data from space, with growing defense and security demand.' },
  'Cohesity Global, Inc.': { category:'Data management', tagline:'Enterprise data management, backup and recovery; merged with Veritas.', pname:'Data Cloud', pdesc:'Backup, recovery and data security against ransomware.', thesis:'Consolidated leader in data protection after the Veritas merger; heading to IPO.' },
  'Trusted, Inc.': { category:'Healthtech · staffing', tagline:'Healthcare staffing marketplace connecting nurses with hospitals.', pname:'Trusted Health', pdesc:'Digital hiring and management of (travel) nursing staff.', thesis:'Digitizes healthcare staffing amid a chronic personnel shortage.' },
  'Forto Logistics GmbH & Co': { category:'Digital logistics', tagline:'Digital freight forwarding: manages international cargo shipments end to end.', pname:'Freight platform', pdesc:'Quoting, booking and shipment visibility in a single platform.', thesis:'Digitizes traditional forwarding; sensitive to the global trade cycle.' },
  'Revolut Ltd': { category:'Fintech · neobank', tagline:'Financial super-app: accounts, cards, FX, crypto and investments for tens of millions.', pname:'Revolut', pdesc:'Banking, payments, FX, crypto and trading in one app.', thesis:'Global decacorn (~$75B); one of the largest fintechs in the world, heading to IPO.' },
  'Quantstamp, Inc.': { category:'Crypto · security', tagline:'Blockchain security: smart-contract and Web3 protocol audits.', pname:'Web3 audits', pdesc:'Review and assurance of smart contracts.', thesis:'Trust layer for Web3; demand tied to crypto activity.' },
  'Groq, Inc.': { category:'Semiconductors · AI', tagline:'Designs the LPU, an AI inference chip with ultra-low latency and leading speed.', pname:'LPU / GroqCloud', pdesc:'Ultra-fast AI inference; large-scale agreements (incl. Nvidia).', thesis:'Attacks the inference bottleneck — the dominant cost of AI in production.' },
  'Transfix, Inc.': { category:'Logistics · freight', tagline:'Digital freight marketplace connecting shippers with carriers.', pname:'Transfix', pdesc:'Truckload matching and freight management platform.', thesis:'Efficiency in a fragmented freight market; sensitive to the freight cycle.' },
  'Loft Holdings, Ltd': { category:'Proptech', tagline:'Brazilian proptech: marketplace to buy, sell and rent homes online.', pname:'Loft', pdesc:'Residential real-estate transaction platform in Brazil.', thesis:'Digitizes LatAm real estate; hit by rates and down-rounds.' },
  'Automattic, Inc.': { category:'Software · web', tagline:'The company behind WordPress.com, WooCommerce, Tumblr and Jetpack.', pname:'WordPress.com · WooCommerce', pdesc:'Web publishing and e-commerce for a huge share of the web.', thesis:'Powers an enormous fraction of the world\\u2019s websites; dominant brand and distribution.' },
  'Figure AI Inc.': { category:'Humanoid robotics', tagline:'General-purpose humanoid robots (Figure 02/03) with a proprietary AI stack.', pname:'Figure 02 / 03', pdesc:'Humanoids with in-house AI; integrate language models for tasks.', thesis:'The fund\\u2019s highest-multiple position; industrial pilots (e.g. with BMW).' },
  'Neutron Holdings, Inc., DBA Lime': { category:'Micromobility', tagline:'Lime: shared electric scooters and bikes across hundreds of cities.', pname:'Lime', pdesc:'Shared fleet of e-scooters and e-bikes via app.', thesis:'Micromobility leader, profitable and heading to IPO.' },
  'Payward Inc., DBA Kraken': { category:'Crypto · exchange', tagline:'Operates Kraken, one of the oldest and most regulated crypto exchanges in the world.', pname:'Kraken', pdesc:'Crypto trading, staking, custody and institutional services.', thesis:'Beneficiary of the crypto cycle and clearer regulation; IPO candidate.' },
  'Turo, Inc.': { category:'Marketplace · mobility', tagline:'Peer-to-peer car rental marketplace ("the Airbnb of cars").', pname:'Turo', pdesc:'P2P platform to rent out and book cars.', thesis:'P2P car-sharing leader in a large market; IPO candidate.' },
  'Klarna Holding AB': { category:'Fintech · payments', tagline:'Swedish "buy now, pay later" (BNPL) fintech with tens of millions of users.', pname:'Klarna', pdesc:'Deferred payments, banking, card and AI-assisted shopping.', thesis:'Global BNPL leader; already publicly traded.' },
  'Bolt Financial, Inc.': { category:'Fintech · payments', tagline:'One-click checkout enabling fast, frictionless payments in e-commerce.', pname:'Bolt Checkout', pdesc:'Identity network and one-click payment for online merchants.', thesis:'Bet on frictionless checkout; entered high and was marked down sharply.' },
  'Instacart': { category:'E-commerce · delivery', tagline:'On-demand grocery delivery platform in North America (public: CART).', pname:'Instacart', pdesc:'Grocery delivery and advertising for retailers.', thesis:'Grocery delivery leader with a profitable advertising business; trades as CART.' },
  'Udemy': { category:'Edtech', tagline:'Global online course marketplace for consumers and enterprises (public: UDMY).', pname:'Udemy / Udemy Business', pdesc:'On-demand courses and corporate training.', thesis:'Learning marketplace with a growing enterprise arm (Udemy Business).' },
  'Anthropic PBC': { category:'Artificial Intelligence', tagline:'AI lab behind Claude, focused on safe, enterprise-grade models.', pname:'Claude', pdesc:'Frontier language models for enterprises and developers.', thesis:'One of the leading frontier AI labs; enterprise adoption accelerating.' },
};
const FT_STAGE_EN = { 'Crecimiento':'Growth','Tardía':'Late stage','Etapa tardía':'Late stage','Temprana':'Early stage','Etapa temprana':'Early stage','Pública':'Public','Pública (SPCX)':'Public (SPCX)','Adquirida':'Acquired','Pública (CART)':'Public (CART)','Pública (UDMY)':'Public (UDMY)','Pública (KLAR)':'Public (KLAR)' };
const FT_MKT_EN = { 'Lanzamientos':'Launch','Internet satelital':'Satellite internet','Defensa':'Defense','Gobierno':'Government','Energía':'Energy','Residencial':'Residential','Red eléctrica':'Power grid','Seguridad':'Security','Salud':'Healthcare','Hospitales':'Hospitals','Educación':'Education','Empresas':'Enterprise','Consumo':'Consumer','Comercio':'Commerce','Pagos':'Payments','Banca':'Banking','Movilidad':'Mobility','Ciudades':'Cities','Logística':'Logistics','Carga':'Freight','Bienes raíces':'Real estate','Seguros':'Insurance','Juegos':'Gaming','Creadores':'Creators','Música':'Music','Video':'Video','Emergencias':'Emergency' };

function ftCompanyCards(f, opts) {
  opts = opts || {};
  const _seenCo = new Set();
  const allCos = [...f.active, ...(f.distributed || [])].filter(r => {
    const base = (r.company || '').replace(/\s*\((?:Distributed|X)\)\s*$/i, '').trim();
    if (_seenCo.has(base)) return false;
    _seenCo.add(base); return true;
  });
  // Íconos SVG inline (Feather, MIT) — el HTML descargable no depende de FontAwesome (CDN falla offline / en el visor del teléfono).
  const SVG_ICONS = {
    cube: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
    globe: '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
    trend: '<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>',
    info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>'
  };
  const svgIco = (name, size) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle">${SVG_ICONS[name] || ''}</svg>`;
  const sec = (icon, title, body) =>
    `<div class="ft-co-sec"><div class="ft-co-sec-ico">${svgIco(icon, 16)}</div>` +
    `<div class="ft-co-sec-body"><div class="ft-co-sec-h">${escapeHtml(title)}</div>${body}</div></div>`;
  return allCos.map(r => {
    const cur = r.corpVal;
    const moic = (r.moic && r.moic > 0) ? r.moic : 1;
    const entry = cur / moic;
    const EN = opts.lang === 'en';
    let info = (f.companyInfo || {})[r.company] || {};
    if (EN) {
      const en = FT_CO_EN[r.company];
      info = { ...info,
        category: (en && en.category) || info.category,
        stage: FT_STAGE_EN[info.stage] || info.stage,
        tagline: (en && en.tagline) || info.tagline,
        product: info.product ? { name: (en && en.pname) || info.product.name, desc: (en && en.pdesc) || info.product.desc } : info.product,
        markets: info.markets ? info.markets.map(m => FT_MKT_EN[m] || m) : info.markets,
        thesis: (en && en.thesis) || info.thesis };
    }
    let valNote;
    if (Math.abs(moic - 1) < 0.02) valNote = EN ? 'No change: entered at the most recent round — a fresh mark, not stagnation.' : 'Sin cambio: entrada en la ronda más reciente — marca fresca, no estancamiento.';
    else if (moic > 1) valNote = EN ? `${moic.toFixed(2)}x appreciation since entry.` : `Apreciación de ${moic.toFixed(2)}x desde la entrada.`;
    else valNote = EN ? `Marked down vs. entry (down-round · ${moic.toFixed(2)}x).` : `Marca a la baja respecto a la entrada (down-round · ${moic.toFixed(2)}x).`;
    const ov0 = (f.logoOverrides || {})[r.company];
    const override = ov0 ? (/^https?:/i.test(ov0) ? ov0 : (location.origin + ov0)) : null;
    const domain = (f.logos || {})[r.company];
    const dn = info.displayName || r.company;
    const mono = `<span class="ft-co-mono">${escapeHtml(coInitials(dn))}</span>`;
    const embedded = (opts.embeddedLogos || {})[r.company];
    let logoHtml;
    if (embedded) {
      // Logo embebido como data URI (para HTML descargable — se ve offline / en el teléfono).
      logoHtml = `<div class="ft-co-logo">${mono}<img class="ft-co-logo-img" alt="" src="${embedded}" onerror="this.remove()"></div>`;
    } else if (override) {
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
          <div class="ft-co-valbox"><span class="ft-co-vl">${EN ? 'Entry' : 'Entrada'}</span><span class="ft-co-vv">${fmtBil(entry)}</span></div>
          <div class="ft-co-valbox"><span class="ft-co-vl">${EN ? 'Current valuation' : 'Valuación actual'}</span><span class="ft-co-vv ft-co-vv-now">${fmtBil(cur)}</span></div>
        </div>
        <div class="ft-co-vnote">${svgIco('info', 14)} ${escapeHtml(valNote)}</div>
        ${hasDetail ? `<hr class="ft-co-div">` : ''}
        ${info.product ? sec('cube', (EN ? 'Product · ' : 'Producto · ') + info.product.name, `<div class="ft-co-sec-t">${escapeHtml(info.product.desc)}</div>`) : ''}
        ${info.markets ? sec('globe', EN ? 'Target market' : 'Mercado objetivo', `<div class="ft-co-chips">${info.markets.map(m => `<span class="ft-co-chip">${escapeHtml(m)}</span>`).join('')}</div>`) : ''}
        ${info.thesis ? sec('trend', EN ? 'Investment thesis' : 'Tesis de inversión', `<div class="ft-co-sec-t">${escapeHtml(info.thesis)}</div>`) : ''}
      </div>`;
  }).join('');
}

// Documento HTML standalone (para descargar como HTML o imprimir a PDF)
function ftCompaniesDocHtml(f, lang, logos) {
  const EN = lang === 'en';
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
.ft-co-vnote svg{flex:none;margin-top:2px;color:#9aa3b5}
.ft-co-sec-ico svg{color:#e8650d}
.ft-co-div{border:none;border-top:1px solid #eef0f5;margin:14px 0}
.ft-co-sec{display:flex;gap:12px;margin-bottom:14px}
.ft-co-sec-ico{flex:0 0 auto;width:22px;text-align:center;color:#e8650d;font-size:15px;padding-top:1px}
.ft-co-sec-body{min-width:0}
.ft-co-sec-h{font-size:14px;font-weight:700;color:#1a1f2e;margin-bottom:4px}
.ft-co-sec-t{font-size:13px;color:#3d4559;line-height:1.5}
.ft-co-chips{display:flex;flex-wrap:wrap;gap:7px;margin-top:2px}
.ft-co-chip{font-size:12px;font-weight:500;color:#3d4559;background:#eef0f5;padding:4px 11px;border-radius:999px}
@media (max-width:640px){.doc{padding:16px}.ft-co-grid{grid-template-columns:1fr;gap:14px}.ft-co-card{padding:16px 17px}.doc-title{font-size:19px}.ft-co-vv{font-size:19px}.ft-co-name{font-size:15px}}
@media print{.doc{padding:0;max-width:none}.ft-co-grid{gap:12px}}
@page{margin:13mm}`;
  return `<!doctype html><html lang="${EN ? 'en' : 'es'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(f.name)} — ${EN ? 'Companies' : 'Empresas'}</title>` +
    `<style>${css}</style></head>` +
    `<body><div class="doc"><div class="doc-head"><div class="doc-title">${escapeHtml(f.name)} — ${EN ? 'Companies' : 'Empresas'}</div>` +
    `<div class="doc-sub">${escapeHtml(f.status)} · ${escapeHtml(f.confidentiality)} · Cutoff ${escapeHtml(cutoffPretty)}</div>` +
    `<div class="doc-note">${EN ? 'Corporate valuation. Entry is derived from PPS appreciation (current valuation ÷ MOIC).' : 'Valuación corporativa. La de entrada se deriva de la apreciación del PPS (valuación actual ÷ MOIC).'}</div></div>` +
    `<div class="ft-co-grid">${ftCompanyCards(f, { lang, embeddedLogos: logos || {} })}</div></div></body></html>`;
}

// ── Export HTML del tracker (Valuation Overview) — auto-contenido, logos embebidos ──
async function exportFundTrackerHtml(fundId, btn) {
  const f = FUND_TRACKERS[fundId];
  if (!f || f.placeholder) { toast('Tracker no disponible'); return; }
  const lang = await pickExportLang(); if (!lang) return;
  const orig = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Generando…'; }
  try {
    computeFundTotals(f);
    const logos = {};
    await Promise.all(Object.entries(f.logos || {}).map(async ([name, dom]) => {
      try {
        const g = 'https://www.google.com/s2/favicons?sz=128&domain=' + dom;
        const r = await fetch('/api/logo?u=' + encodeURIComponent(g));
        if (!r.ok) return;
        const b = await r.blob(); if (b.size < 120) return;
        logos[name] = await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => res(null); fr.readAsDataURL(b); });
      } catch (e) {}
    }));
    const blob = new Blob([ftTrackerDocHtml(f, logos, lang)], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${f.name.replace(/[^a-z0-9]+/gi, '_')}_Tracker · ${dlStamp()}.html`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    toast('HTML del tracker descargado');
  } catch (e) { console.error('[ft html]', e); toast('Error: ' + e.message); }
  finally { if (btn) { btn.disabled = false; btn.innerHTML = orig; } }
}

function ftTrackerDocHtml(f, logos, lang) {
  const EN = lang === 'en';
  const T = (es, en) => (EN ? en : es);
  const COL_ES = { 'Company':'Empresa','Investment Amount':'Monto invertido','% of Invested Capital':'% del capital invertido','Mark-to-Market Valuation':'Valuación mark-to-market','MTM MOIC (x)':'MOIC MTM (x)','Corp. Valuation ($B)':'Valuación corp. ($B)','Current Mark (PPS)':'Mark actual (PPS)','Entry Price (PPS)':'Precio de entrada (PPS)','Shares':'Acciones','FDSO (M)':'FDSO (M)' };
  const CL = (l) => (EN ? l : (COL_ES[l] || l));
  const LOC = EN ? 'en-US' : 'es-MX';
  const E = escapeHtml;
  const cutoffPretty = new Date(f.cutoff + 'T00:00:00').toLocaleDateString(LOC, { year: 'numeric', month: 'long', day: 'numeric' });
  const genPretty = new Date().toLocaleDateString(LOC, { day: 'numeric', month: 'long', year: 'numeric' });
  const ov = f.overallTotal2 || f.overallTotal || f.activeTotal;
  const cell = (row, c) => {
    const v = row[c.key];
    if (c.key === 'company') {
      const lg = logos[row.company] ? `<img class="tlogo" src="${logos[row.company]}" alt="">` : '';
      return `<td class="co">${lg}<span>${E(row.company)}</span></td>`;
    }
    const cls = c.key === 'moic' ? (' ' + moicClass(v)) : '';
    return `<td class="num${cls}">${E(fmtTrackerCell(v, c.type))}</td>`;
  };
  const totRow = (label, t) => `<tr class="tot">` + f.columns.map(c => {
    if (c.key === 'company')  return `<td class="co"><span>${E(label)}</span></td>`;
    if (c.key === 'invested') return `<td class="num">${fmtTrackerCell(t.invested, 'money')}</td>`;
    if (c.key === 'mtm')      return `<td class="num">${fmtTrackerCell(t.mtm, 'money')}</td>`;
    if (c.key === 'moic')     return `<td class="num ${moicClass(t.moic)}">${fmtTrackerCell(t.moic, 'moic')}</td>`;
    return '<td></td>';
  }).join('') + `</tr>`;
  const head = `<tr>` + f.columns.map(c => `<th class="${c.key === 'company' ? '' : 'num'}">${E(CL(c.label))}</th>`).join('') + `</tr>`;
  const table = (title, rows, tots) => `
    <div class="sec xr"><div class="sec-h">${E(title)}</div><div class="twrap"><table><thead>${head}</thead><tbody>
      ${rows.map(r => `<tr>${f.columns.map(c => cell(r, c)).join('')}</tr>`).join('')}${tots}
    </tbody></table></div></div>`;
  const secs =
    table(T('Posiciones activas', 'Active Positions'), f.active, totRow(T('Total — Activas', 'Total — Active'), f.activeTotal)) +
    ((f.pending && f.pending.length) ? table(EN ? (f.pendingTitle || 'Pending Positions') : 'Posiciones pendientes', f.pending, totRow(T('Total — Pendientes', 'Total — Pending'), f.pendingTotal)) : '') +
    table(T('Posiciones distribuidas', 'Distributed Positions'), f.distributed, totRow(f.overallLabel || 'Total — Overall', f.overallTotal) + (f.overallTotal2 ? totRow(f.overallTotal2.label, f.overallTotal2) : ''));
  return `<!doctype html><html lang="es" data-org="mvp"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${E(f.name)} — Tracker</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;700&family=DM+Mono:wght@400;500&family=Fraunces:opsz,wght@9..144,480;9..144,560;9..144,640&display=swap">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'DM Sans',sans-serif;background:#f7f8fb;color:#1a1f2e;font-size:14px}
::selection{background:rgba(237,120,36,.22)}
#prog{position:fixed;top:0;left:0;height:2.5px;width:0;background:linear-gradient(90deg,#e8650d,#f6a55c);z-index:99;transition:width .15s linear}
.grain{position:fixed;inset:0;pointer-events:none;z-index:1;opacity:.028;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)'/%3E%3C/svg%3E")}
.top{position:sticky;top:0;z-index:60;display:flex;align-items:center;gap:14px;background:linear-gradient(90deg,#e8650d,#ef8a3c);color:#fff;padding:12px 24px}
.top .b{font-weight:700;font-size:15px}.top .d{font-size:12px;opacity:.9}
.top button{margin-left:auto;border:1.5px solid rgba(255,255,255,.55);background:rgba(255,255,255,.14);color:#fff;border-radius:9px;padding:7px 15px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit}
.wrap{max-width:1180px;margin:0 auto;padding:24px 26px 10px}
.hero{position:relative;overflow:hidden;background:linear-gradient(135deg,#fff 62%,#fdf6ef 100%);border:1px solid #e3e7ee;border-left:4px solid #ED7824;border-radius:16px;padding:34px 38px 30px;margin-bottom:20px;box-shadow:0 2px 14px rgba(20,25,40,.06)}
.hero::after{content:"";position:absolute;right:-70px;top:-70px;width:260px;height:260px;border-radius:50%;background:radial-gradient(circle,rgba(237,120,36,.09),transparent 65%)}
.hero .nm{font-family:'Fraunces',Georgia,serif;font-size:clamp(26px,4vw,40px);font-weight:560;letter-spacing:-.018em;line-height:1.08;margin-bottom:8px}
.hero .sb{font-size:14px;color:#3a4152}
.hero .mt{margin-top:10px;font-family:'DM Mono',monospace;font-size:10.5px;color:#9aa1ad;letter-spacing:.6px}
body.anim .hero .nm{opacity:0;clip-path:inset(0 0 100% 0);animation:nm .9s cubic-bezier(.16,1,.3,1) .15s forwards}
body.anim .hero .sb{opacity:0;animation:up .8s cubic-bezier(.16,1,.3,1) .45s forwards}
body.anim .hero .mt{opacity:0;animation:up .8s cubic-bezier(.16,1,.3,1) .65s forwards}
@keyframes up{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
@keyframes nm{from{opacity:0;clip-path:inset(0 0 100% 0);transform:translateY(10px)}to{opacity:1;clip-path:inset(0 0 -8% 0);transform:none}}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:20px}
.kpi{background:#fff;border:1px solid #e3e7ee;border-radius:14px;padding:16px 18px}
.kpi .l{font-size:10.5px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:#8a93a6;margin-bottom:6px}
.kpi .v{font-size:22px;font-weight:700;font-variant-numeric:tabular-nums}
.kpi .v.or{color:#E8650D}.kpi .v.gr{color:#0f9b5a}
.sec{margin-bottom:22px}
.sec-h{font-size:11px;font-weight:700;color:#8a93a6;text-transform:uppercase;letter-spacing:.8px;margin-bottom:10px}
.twrap{overflow-x:auto;background:#fff;border:1px solid #e3e7ee;border-radius:12px}
table{width:100%;border-collapse:collapse;font-size:12.5px;min-width:760px}
th{background:#f4f6f9;font-weight:600;color:#5b6472;font-size:10.5px;text-transform:uppercase;letter-spacing:.4px;padding:10px 12px;text-align:left;border-bottom:1px solid #e3e7ee}
th.num{text-align:right}
td{padding:9px 12px;border-bottom:1px solid #f0f2f6}
td.num{text-align:right;font-variant-numeric:tabular-nums}
td.co{display:flex;align-items:center;gap:8px;font-weight:500}
.tlogo{width:20px;height:20px;border-radius:5px;object-fit:contain;background:#fff;border:1px solid #e3e7ee;padding:1px;flex:none}
tr.tot td{background:#f9fafc;font-weight:700;border-top:1.5px solid #e3e7ee}
.moic-pos,.pos{color:#0f9b5a}.moic-neg,.neg{color:#c0392b}
body.anim .xr{opacity:0;transform:translateY(22px);transition:opacity .85s cubic-bezier(.16,1,.3,1),transform .85s cubic-bezier(.16,1,.3,1)}
body.anim .xr.xin{opacity:1;transform:none}
.foot{max-width:1180px;margin:6px auto 34px;padding:0 26px;font-size:10.5px;letter-spacing:.4px;color:#9aa1ad;line-height:1.7}
.foot .t{text-transform:uppercase;letter-spacing:1.2px;display:block;margin-bottom:4px}
@media (prefers-reduced-motion:reduce){.hero .nm,.hero .sb,.hero .mt{animation:none;opacity:1;clip-path:none}.xr{opacity:1;transform:none}}
@media print{.hero .nm,.hero .sb,.hero .mt{animation:none!important;opacity:1!important;clip-path:none!important}.xr{opacity:1!important;transform:none!important}#prog,.grain{display:none}.top button{display:none}}
</style></head><body>
<div id="prog"></div><div class="grain"></div>
<div class="top"><span class="b">MVP · Fund Tracker</span><span class="d">${T('Generado','Generated')} ${E(genPretty)}</span><button onclick="window.print()">${T('Imprimir / PDF','Print / PDF')}</button></div>
<div class="wrap">
  <div class="hero">
    <div class="nm">${E(f.name)}</div>
    <div class="sb">${E(f.subtitle || 'Valuation Overview')} · ${E(f.status || '')}</div>
    <div class="mt">${T('Corte','As of')}: ${E(cutoffPretty)} · ${E(f.confidentiality || 'CONFIDENTIAL')} · ${T('SpaceX marcado al precio vivo de SPCX','SpaceX marked at live SPCX price')}</div>
  </div>
  <div class="kpis xr">
    <div class="kpi"><div class="l">${T('Capital invertido','Invested Capital')}</div><div class="v or">${fmtTrackerCell(ov.invested, 'money')}</div></div>
    <div class="kpi"><div class="l">${T('Valor (MtM)','Value (MtM)')}</div><div class="v">${fmtTrackerCell(ov.mtm, 'money')}</div></div>
    <div class="kpi"><div class="l">MOIC</div><div class="v gr">${fmtTrackerCell(ov.moic, 'moic')}</div></div>
    <div class="kpi"><div class="l">${T('Posiciones activas','Active Positions')}</div><div class="v">${f.active.length}</div></div>
  </div>
  ${secs}
</div>
<div class="foot"><span class="t">MVP Manager · ${T('Documento confidencial','Confidential document')} · ${E(genPretty)}</span>${E(f.name)} — ${E(f.subtitle || 'Valuation Overview')}. ${T('Cifras al corte indicado; SpaceX a precio de mercado vivo. Valuaciones preliminares y no auditadas. Este documento es informativo y no constituye una oferta ni asesoría de inversión.','Figures as of the stated cutoff; SpaceX at live market price. Valuations are preliminary and unaudited. This document is for information purposes only and does not constitute an offer or investment advice.')}</div>
<script>
(function(){
  if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  document.body.classList.add('anim');
  var pr=document.getElementById('prog');
  addEventListener('scroll',function(){var h=document.documentElement;var p=h.scrollTop/((h.scrollHeight-h.clientHeight)||1);if(pr)pr.style.width=(p*100)+'%';},{passive:true});
  var els=[].slice.call(document.querySelectorAll('.xr'));
  var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){e.target.classList.add('xin');io.unobserve(e.target);}});},{threshold:.08});
  els.forEach(function(el){io.observe(el);});
  function cnt(el){
    var t=(el.textContent||'').trim();
    var m=t.match(/^([$]?)([\\d,]+\\.?\\d*)(x?)$/); if(!m) return;
    var target=parseFloat(m[2].replace(/,/g,'')); if(!isFinite(target)||!target) return;
    var dec=(m[2].split('.')[1]||'').length,t0=null;
    function st(ts){if(!t0)t0=ts;var k=Math.min(1,(ts-t0)/950);k=1-Math.pow(1-k,3);
      var v=dec?(target*k).toFixed(dec):Math.round(target*k).toLocaleString('en-US');
      el.textContent=m[1]+v+m[3]; if(k<1)requestAnimationFrame(st); else el.textContent=t;}
    requestAnimationFrame(st);
  }
  document.querySelectorAll('.kpi .v').forEach(cnt);
})();
</script>
</body></html>`;
}

// Baja los logos y los devuelve como data URIs {empresa: "data:image/..."} para embeberlos
// en el HTML descargable (así se ven offline / en el teléfono, sin depender de URLs externas).
async function ftEmbedLogos(f) {
  const out = {};
  const toDataUri = async (src) => {
    try {
      const r = await fetch(src); if (!r.ok) return null;
      const b = await r.blob(); if (b.size < 60) return null;
      return await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => res(null); fr.readAsDataURL(b); });
    } catch (e) { return null; }
  };
  const jobs = [];
  const done = new Set();
  // Overrides tienen prioridad (logo local o URL específica).
  Object.entries(f.logoOverrides || {}).forEach(([name, ov]) => {
    done.add(name);
    const src = /^https?:/i.test(ov) ? ('/api/logo?u=' + encodeURIComponent(ov)) : ov; // local = mismo origen
    jobs.push(toDataUri(src).then(d => { if (d) out[name] = d; }));
  });
  // Resto: favicon del dominio vía proxy same-origin.
  Object.entries(f.logos || {}).forEach(([name, dom]) => {
    if (done.has(name)) return;
    const g = 'https://www.google.com/s2/favicons?sz=128&domain=' + dom;
    jobs.push(toDataUri('/api/logo?u=' + encodeURIComponent(g)).then(d => { if (d) out[name] = d; }));
  });
  await Promise.all(jobs);
  return out;
}

async function exportCompaniesHTML(fundId, btn) {
  const f = FUND_TRACKERS[fundId]; if (!f || !f.companyInfo) return;
  const lang = await pickExportLang(); if (!lang) return;
  const orig = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Generando…'; }
  try {
    const logos = await ftEmbedLogos(f);
    const blob = new Blob([ftCompaniesDocHtml(f, lang, logos)], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${f.name.replace(/[^a-z0-9]+/gi, '_')}_${lang === 'en' ? 'Companies' : 'Empresas'} · ${dlStamp()}.html`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    toast(EN_TOAST(lang, 'Companies HTML downloaded', 'HTML de empresas descargado'));
  } catch (e) { console.error('[companies html]', e); toast('Error: ' + e.message); }
  finally { if (btn) { btn.disabled = false; btn.innerHTML = orig; } }
}
function EN_TOAST(lang, en, es) { return lang === 'en' ? en : es; }

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
  const f0 = FUND_TRACKERS[fundId]; if (!f0 || !f0.companyInfo) return;
  const lang = await pickExportLang(); if (!lang) return;
  const EN = lang === 'en';
  // vista EN del tracker: fichas traducidas (FT_CO_EN) sin mutar el original
  const f = !EN ? f0 : { ...f0, companyInfo: Object.fromEntries(Object.entries(f0.companyInfo).map(([k, v]) => {
    const en = FT_CO_EN[k] || {};
    return [k, { ...v,
      category: en.category || v.category,
      stage: FT_STAGE_EN[v.stage] || v.stage,
      tagline: en.tagline || v.tagline,
      product: v.product ? { name: en.pname || v.product.name, desc: en.pdesc || v.product.desc } : v.product,
      markets: v.markets ? v.markets.map(m => FT_MKT_EN[m] || m) : v.markets,
      thesis: en.thesis || v.thesis }];
  })) };
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
      if (Math.abs(moic - 1) < 0.02) note = EN ? 'No change: entered at the most recent round, a fresh mark.' : 'Sin cambio: entrada en la ronda mas reciente, marca fresca.';
      else if (moic > 1) note = EN ? (moic.toFixed(2) + 'x appreciation since entry.') : ('Apreciacion de ' + moic.toFixed(2) + 'x desde la entrada.');
      else note = EN ? ('Marked down vs. entry (down-round, ' + moic.toFixed(2) + 'x).') : ('Marca a la baja respecto a la entrada (down-round, ' + moic.toFixed(2) + 'x).');
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
        [[EN ? 'Entry' : 'Entrada', fmtBil(entry), NAVY, ix], [EN ? 'Current valuation' : 'Valuacion actual', fmtBil(cur), ORANGE, ix + bw + gap]].forEach(b => {
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
      if (info.product) drawSec((EN ? 'Product - ' : 'Producto - ') + info.product.name, false, info.product.desc);
      if (info.markets) drawSec(EN ? 'Target market' : 'Mercado objetivo', true, info.markets);
      if (info.thesis)  drawSec(EN ? 'Investment thesis' : 'Tesis de inversion', false, info.thesis);

      cy += pad - 2;
      return cy - yTop;
    }

    let y = M;
    doc.setFont('helvetica','bold'); doc.setFontSize(16); doc.setTextColor.apply(doc, ORANGE);
    T(f.name + (EN ? ' - Companies' : ' - Empresas'), M, y + 3); y += 8;
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
    doc.save(f.name.replace(/[^a-z0-9]+/gi, '_') + (EN ? '_Companies' : '_Empresas') + ' · ' + dlStamp() + '.pdf');
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
  const lang = await pickExportLang(); if (!lang) return;
  const EN = lang === 'en';
  const COL_ES = { 'Company':'Empresa','Investment Amount':'Monto invertido','% of Invested Capital':'% del capital invertido','Mark-to-Market Valuation':'Valuación mark-to-market','MTM MOIC (x)':'MOIC MTM (x)','Corp. Valuation ($B)':'Valuación corp. ($B)','Current Mark (PPS)':'Mark actual (PPS)','Entry Price (PPS)':'Precio de entrada (PPS)','Shares':'Acciones','FDSO (M)':'FDSO (M)' };
  const CL = (l) => (EN ? l : (COL_ES[l] || l));
  const TSEC = (en, es) => (EN ? en : es);
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
    titleRow(`${EN ? 'Cutoff' : 'Corte'}: ${f.cutoff}`, { size: 10 });
    titleRow(f.confidentiality, { bold: true, size: 10, color: 'FFC0392B' });
    r++;

    const headerRow = () => {
      f.columns.forEach((c, i) => {
        const cell = ws.getCell(r, i + 1);
        cell.value = CL(c.label);
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

    section(TSEC('Active Positions','Posiciones activas'), f.active, TSEC('Total - Active','Total - Activas'), f.activeTotal);
    if (f.pending && f.pending.length) {
      section(EN ? (f.pendingTitle || 'Pending Positions') : 'Posiciones pendientes', f.pending, TSEC('Total - Pending','Total - Pendientes'), f.pendingTotal);
    }
    section(TSEC('Distributed Positions','Posiciones distribuidas'), f.distributed, null, null);
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
          <button class="camp-row-act" title="Editar contacto" onclick="campEditContactOpen('${jsArg(c.email)}')"><i class="fa-solid fa-pen"></i></button>
          <button class="camp-row-act" title="${c.cancelado ? 'Reactivar (quitar cancelado)' : 'Marcar como cancelado'}" onclick="campToggleCancel('${jsArg(c.email)}')"><i class="fa-solid ${c.cancelado ? 'fa-rotate-left' : 'fa-ban'}"></i></button>
          <button class="camp-row-act camp-row-del" title="Borrar contacto" onclick="campDeleteContact('${jsArg(c.email)}')"><i class="fa-solid fa-xmark"></i></button>
        </span>
        <div class="camp-name-main" onclick="campLpOpenEmail('${jsArg(c.email)}')" title="Ver detalle de interacción">${nombre}${c.cancelado ? ' <span class="camp-cancel-badge">CANCELÓ</span>' : ''}</div>
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
    <button class="camp-row-act camp-row-del" title="Quitar de la lista" onclick="aperturaRemove('${jsArg(c.email)}')"><i class="fa-solid fa-xmark"></i></button>
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

/* ═══════════════════════════════════════════════════════════════════════════
   REPORTE SPACEX (template v2) — descargable por inversionista, 100% client-side.
   Réplica del template oficial data/templates/spacex_position_template.yaml de
   cretum_reports (referencia: reporte de Cecilia González Rubio):
     cover + 4 KPIs → ¿Qué pasó? → Detalle por vehículo → ¿Cómo y cuándo se liberan?
     → Calendario combinado → Notas → Anexo 1 (180d) → Anexo 2 (extendido)
     → Anexo 3 (cartas del IPO, PÁGINA VECTORIAL con links clicables).
   Datos SIEMPRE en vivo de Supabase (precio = current_ev_pps co 27 al momento del clic).
   Calendarios/estructuras: SPX_LOCKUP_B, SPX_LOCKUP_A_EXT, SPX_STRUCTURES (espejo del
   catálogo spacex_lockups.yaml — actualizar ahí y aquí juntos).
   Fase 1: posiciones DIRECTAS (co Space X). Fase 2 (pendiente): indirectas vía fondos.
═══════════════════════════════════════════════════════════════════════════ */

const SPXR_NAVY = '#0f2849', SPXR_BLUE = '#1c4e80', SPXR_GREY = '#8a93a3';
const SPXR_FONT_FACES = [
  ['Outfit', 400, 'Outfit-Regular.ttf'], ['Outfit', 700, 'Outfit-Bold.ttf'],
  ['Instrument', 400, 'InstrumentSans-Regular.ttf'], ['Instrument', 700, 'InstrumentSans-Bold.ttf'],
  ['Geist', 400, 'GeistMono-Regular.ttf'],
].map(([f, w, file]) => `@font-face{font-family:'${f}';font-weight:${w};src:url('/fonts/${file}') format('truetype');}`).join('\n');

const SPXR_IS_SPACEX = p => (p.companies?.name || '') === 'Space X';
// Estructura por serie DIRECTA: A (Calendario 1) = 22K / 22J / TODAS las 26B; B = resto (22F, 26A, SX-1...)
const SPXR_STRUCT_OF = s => (/22K|22J|26B/i.test(s || '') ? 'A' : 'B');
const SPXR_SHORT = s => String(s || '')
  .replace('MVP Opportunity Fund VI LLC, ', '').replace('MVP Opportunity Fund IV LLC, ', '')
  .replace('MVP Opportunity Series ', '').replace(' (SpaceX)', '')
  .replace(/^Series /, 'Serie ').trim();
const SPXR_N = v => (v == null || v === '' || !Number.isFinite(+v)) ? null : +v;
const SPXR_MONEY = v => '$' + Math.round(v).toLocaleString('en-US');
const SPXR_P2 = v => '$' + (+v).toFixed(2);
const SPXR_X = v => (+v).toFixed(2) + 'x';
const SPXR_INT = v => Math.round(v).toLocaleString('en-US');
const SPXR_SH = v => (Math.abs(v - Math.round(v)) < 1e-9 ? Math.round(v).toLocaleString('en-US') : (+v).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
const SPXR_FIXED_DATES = new Set(['2026-12-09', '2027-03-19', '2027-05-18', '2027-06-13']);
function spxrDate(iso) {
  const d = new Date(iso + 'T12:00:00');
  const t = d.toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' }).replace(/\./g, '').replace(/ de /g, ' ');
  return (SPXR_FIXED_DATES.has(iso) ? '' : '~ ') + t;
}

// Precio EN VIVO de SpaceX (co 27) al momento del clic — nunca hardcodeado.
async function spxrLivePrice() {
  const { data, error } = await sb.from('investments')
    .select('current_ev_pps,current_ev_b')
    .eq('company_id', 27).is('distributed_at', null)
    .not('current_ev_pps', 'is', null).limit(1);
  if (error || !data || !data.length) throw new Error('Sin precio vivo de SpaceX en la DB');
  return { P: +data[0].current_ev_pps, EVB: SPXR_N(data[0].current_ev_b) };
}

// ── ES→EN de etiquetas derivadas del catálogo (calendario, fases, fechas, scopes) ──
const SPXR_MON_EN = { ene: 'Jan', feb: 'Feb', mar: 'Mar', abr: 'Apr', may: 'May', jun: 'Jun', jul: 'Jul', ago: 'Aug', sep: 'Sep', oct: 'Oct', nov: 'Nov', dic: 'Dec' };
function spxrEn(s) {
  if (s == null) return s;
  let t = String(s);
  const R = [
    // ── frases completas del catálogo (ANTES que los patrones genéricos) ──
    [/Estructura y porcentajes del S-1 de SpaceX \(mayo 2026\)\. La fecha del primer earnings aún no es oficial: el 1er cliff \(~17 ago 2026\) es la mejor estimación disponible; hitos posteriores estimados con la misma cadencia\. El prospecto final es la autoridad\.( Liquidez total ~ agosto 2027 \(~14 meses post-IPO\)\.)?/g,
     (m, tail) => "Structure and percentages from SpaceX's S-1 (May 2026). The date of the first earnings report is not yet official: the 1st cliff (~Aug 17, 2026) is the best available estimate; later milestones estimated with the same cadence. The final prospectus is the controlling authority." + (tail ? ' Full liquidity ~ August 2027 (~14 months post-IPO).' : '')],
    [/La posición se libera en <b>dos mitades<\/b>\. La primera \(~50%\) durante los primeros ~6 meses \(lock-up de 180 días\); la segunda \(~50%\) en un <b>lock-up extendido<\/b> que se estira hasta ~14 meses post-IPO \(liberación final ~ agosto 2027\)\./g,
     'The position is released in <b>two halves</b>. The first (~50%) during the first ~6 months (180-day lock-up); the second (~50%) under an <b>extended lock-up</b> stretching to ~14 months post-IPO (final release ~ August 2027).'],
    [/Liberación escalonada y ligada a desempeño dentro de la ventana estándar de <b>180 días<\/b>\. Expira por completo ~9 de diciembre de 2026\./g,
     'Staggered, performance-linked release within the standard <b>180-day</b> window. Fully expires ~December 9, 2026.'],
    [/Fecha del earnings Q2 aún no oficial; 17 ago 2026 es la mejor estimación\. Acumulado: 20%\./g,
     'Q2 earnings date not yet official; Aug 17, 2026 is the best estimate. Cumulative: 20%.'],
    [/Si la acción cotiza ≥30% arriba del IPO en 5 de 10 días consecutivos \(pre-earnings Q2\)\. Acumulado: 30%\./g,
     'If the stock trades ≥30% above the IPO price on 5 of 10 consecutive days (pre-Q2 earnings). Cumulative: 30%.'],
    [/Solo si el precio cierra ≥30% arriba del precio de oferta en 5 de los 10 días siguientes al earnings Q2\./g,
     'Only if the price closes ≥30% above the offering price on 5 of the 10 days following Q2 earnings.'],
    [/Solo si SpaceX cotiza >=30% sobre el IPO; adelanta parte del remanente/g,
     'Only if SpaceX trades >=30% above the IPO price; brings forward part of the remainder'],
    [/Bono condicional adelantaría parte del remanente/g, 'A conditional bonus would bring forward part of the remainder'],
    [/Primer cliff de esta mitad\. Fecha del earnings Q2 aún no oficial; mejor estimación\./g,
     'First cliff of this half. Q2 earnings date not yet official; best estimate.'],
    [/Expiración total\. Acumulado: 100%\./g, 'Full expiration. Cumulative: 100%.'],
    [/Inicio del lock-up extendido\./g, 'Start of the extended lock-up.'],
    [/Remanente — liberación final\./g, 'Remainder — final release.'],
    [/Liberación en dos mitades \(hasta ~14 meses\)/g, 'Release in two halves (up to ~14 months)'],
    [/Lock-up escalonado de 180 días/g, 'Staggered 180-day lock-up'],
    [/Primera mitad \(~50%\) — lock-up de 180 días/g, 'First half (~50%) — 180-day lock-up'],
    [/Segunda mitad \(~50%\) — lock-up extendido \(patrón 20\/10\/20\/10\/20\/20\)/g, 'Second half (~50%) — extended lock-up (20/10/20/10/20/20 pattern)'],
    // ── hitos / etiquetas ──
    [/1er cliff — 2 días tras earnings Q2 \(~/g, '1st cliff — 2 days after Q2 earnings (~'],
    [/2º cliff — tras earnings Q3 2026 \(~/g, '2nd cliff — after Q3 2026 earnings (~'],
    [/2 días tras earnings (Q\d)( \d{4})? \(~/g, (m, q, y) => `2 days after ${q}${y || ''} earnings (~`],
    [/Tras earnings (Q\d)( \d{4})? \(~/g, (m, q, y) => `After ${q}${y || ''} earnings (~`],
    [/Tras earnings Q2 2027 \(est\.\) — liberación final/g, 'After Q2 2027 earnings (est.) — final release'],
    [/Lock-up extendido \(tras earnings Q4 2026, est\.\)/g, 'Extended lock-up (after Q4 2026 earnings, est.)'],
    [/Bloque (\d) \(~15 días tras el cliff\)/g, 'Block $1 (~15 days after the cliff)'],
    [/Bloque (\d)/g, 'Block $1'],
    [/Bono por desempeño — condicional/g, 'Performance bonus — conditional'],
    [/Bono por desempeño/g, 'Performance bonus'],
    [/Día 180 — expiración total/g, 'Day 180 — full lock-up expiration'],
    [/Día (\d+)/g, 'Day $1'],
    [/Cada ~15 días/g, 'Every ~15 days'],
    [/~mismo período/g, '~same period'],
    [/Cal\. 2 \+ 1ª mitad Cal\. 1/g, 'Cal. 2 + 1st half Cal. 1'],
    [/1ª mitad Cal\. 1/g, '1st half Cal. 1'],
    [/2ª mitad del Cal\. 1( \(completa\))?/g, (m, c) => '2nd half of Cal. 1' + (c ? ' (completes)' : '')],
    [/Calendario de 180 días/g, '180-day schedule'],
    [/Acumulado: (\d+(?:\.\d+)?)%\./g, 'Cumulative: $1%.'],
    [/Remanente/g, 'Remainder'],
    [/1er cliff/g, '1st cliff'], [/2º cliff/g, '2nd cliff'],
    [/2 días tras earnings/g, '2 days after earnings'],
    [/tras earnings/g, 'after earnings'],
    [/fecha aún no oficial/g, 'date not yet official'],
    [/mejor estimación/g, 'best estimate'],
    // ── fechas (AL FINAL, para no romper las frases largas) ──
    [/~ ?(\d{1,2}) (ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic) (\d{4})/g, (m, d, mo, y) => `~ ${SPXR_MON_EN[mo]} ${d}, ${y}`],
    [/(^|[\s(])(\d{1,2}) (ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic) (\d{4})/g, (m, p, d, mo, y) => `${p}${SPXR_MON_EN[mo]} ${d}, ${y}`],
    [/~ ?(ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic) (\d{4})/g, (m, mo, y) => `~ ${SPXR_MON_EN[mo]} ${y}`],
  ];
  R.forEach(([re, rep]) => { t = t.replace(re, rep); });
  return t;
}

// ── Clasifica las posiciones SpaceX del detalle abierto y arma el modelo del reporte ──
function spxrBuildData(d, live) {
  const inv = d.inv;
  const combined = !!inv._accounts;
  const rows = (d.positions || []).filter(SPXR_IS_SPACEX);
  // Exposición INDIRECTA vía fondos All-Star (acciones de la carta SpaceX IPO del fondo,
  // guardadas en investments.spacex_indirect = {shares, pps, letter_url}).
  const indFund = s => (/All-Star Fund IV/i.test(s || '') ? 'IV' : (/All-Star Fund V/i.test(s || '') ? 'V' : null));
  const indirect = (d.positions || []).filter(p => !p.distributed_at && indFund(p.series?.name)
    && p.spacex_indirect && +p.spacex_indirect.shares > 0).map(p => {
      const si = p.spacex_indirect, f = indFund(p.series?.name);
      const sh = +si.shares, pps = SPXR_N(si.pps);
      return { acct: p._acct || null, serie: p.series?.name, short: `All-Star Fund ${f} (indirecta)`,
               shares: sh, commitment: pps ? sh * pps : 0, sold: false, soldDate: null,
               carta: si.letter_url || null, isReinvTarget: false, struct: null, indirect: true, fund: f, dists: [] };
    });
  if (!rows.length && !indirect.length) return null;
  const P = live.P;

  const mk = (p) => {
    const dists = p.investment_distributions || [];
    const serieName = p.series?.name || '';
    return {
      acct: p._acct || null, serie: serieName, short: SPXR_SHORT(serieName),
      shares: SPXR_N(p.shares) || 0, commitment: SPXR_N(p.commitment) || 0,
      sold: !!p.distributed_at, soldDate: p.distributed_at || null,
      carta: p.last_ca_letter || null,
      isReinvTarget: SPX_REINV_IS_26AQP(serieName),
      struct: SPXR_STRUCT_OF(serieName),
      dists,
    };
  };
  const act = rows.filter(p => !p.distributed_at).map(mk).concat(indirect).sort((a, b) => b.commitment - a.commitment);
  const sold = rows.filter(p => p.distributed_at).map(mk);

  // Venta/reinversión desde las cartas de distribución de las filas vendidas
  let cashOut = 0, reinvP = 0, soldShares = 0, soldCost = 0, soldPps = null, soldDate = null;
  sold.forEach(s => {
    soldShares += s.shares; soldCost += s.commitment;
    if (s.soldDate && (!soldDate || s.soldDate > soldDate)) soldDate = s.soldDate;
    s.dists.forEach(x => {
      const val = (SPXR_N(x.cash_proceeds) || 0) + (SPXR_N(x.value_in_kind) || 0);
      if (SPX_REINV_IS_NOTE(x.notes)) reinvP += val; else cashOut += val;
      if (SPXR_N(x.price_per_share) != null) soldPps = +x.price_per_share;
    });
  });
  const reinvRows = act.filter(a => a.isReinvTarget);
  // Neteo 22F→26A QP (invariante R = min(P, Q)): lo reinvertido no puede exceder el capital
  // que entró al vehículo destino; el excedente de la venta se entregó en efectivo, aunque la
  // nota de la carta mencione "reinvestment" para todo el producto.
  // Caso cruzado Cretum 119↔615: la 22F vendida de 119 se reinvirtió en la 26A QP de 615
  // (mismo caso especial que nettingFromPQ). Si el reporte es solo de 119, esa porción
  // NO es efectivo aunque la fila 26A QP no aparezca aquí.
  const ids = new Set((inv._accounts ? inv._accounts.map(a => +a.id) : [+inv.id]).filter(x => x));
  const crossReinv = (ids.has(119) && !ids.has(615)) ? 268194.85 : 0;
  const qReinv = reinvRows.reduce((s, a) => s + a.commitment, 0) + crossReinv;
  let cashFracNoted = 0;
  if (reinvP > qReinv + 0.01) {
    cashFracNoted = (reinvP - qReinv) / reinvP;
    cashOut += reinvP - qReinv;
    reinvP = qReinv;
  }
  const hasReinv = reinvP > 0 && (reinvRows.length > 0 || crossReinv > 0);
  // Capital ADICIONAL aportado a la 26A QP por encima de lo reinvertido (casos David/Eduardo/Pla)
  const addReinv = hasReinv ? Math.max(0, reinvRows.reduce((s, a) => s + a.commitment, 0) - reinvP) : 0;

  // Totales de la posición activa
  const totSh = act.reduce((s, a) => s + a.shares, 0);
  const totCost = act.reduce((s, a) => s + a.commitment, 0);
  const totVal = totSh * P;
  // Capital ORIGINAL = activas (sin lo reciclado en 26A QP si fue reinversión) + mitades vendidas
  const reinvCost = hasReinv ? reinvRows.reduce((s, a) => s + a.commitment, 0) : 0;
  const original = totCost - Math.min(reinvCost, reinvP) + soldCost;
  const totalGenerado = totVal + cashOut;

  // Calendario combinado (solo acciones ACTIVAS): A = dos mitades, B = 180 días.
  // Directas: por serie. Indirectas: Fund IV = 20% A + 80% B; Fund V = 100% B.
  let shA = 0;
  act.forEach(a => {
    if (a.indirect) { if (a.fund === 'IV') shA += 0.2 * a.shares; }
    else if (a.struct === 'A') shA += a.shares;
  });
  const shB = totSh - shA;

  return {
    inv, combined, live, act, sold, hasSold: sold.length > 0,
    hasReinv, reinvP, reinvRows, crossReinv, addReinv, cashOut, cashFracNoted, soldShares, soldCost, soldPps, soldDate,
    totSh, totCost, totVal, original, totalGenerado, shA, shB,
    calendar: spxrCalendar(shA, shB),
  };
}

// ── Calendario combinado con redondeo que SIEMPRE suma exacto (lección Turanzas) ──
function spxrCalendar(shA, shB) {
  const TOT = shA + shB;
  if (TOT <= 0) return { rows: [], TOT: 0 };
  const pool = shB + shA / 2, ext = shA / 2;
  const rows = [];
  let counted = 0, acum = 0;
  const pctNumL = s => { const m = String(s).match(/(\d+(?:\.\d+)?)/); return m ? +m[1] / 100 : null; };

  // Fase 180 días (todo B + 1ª mitad de A)
  const scope180 = (shA > 0 && shB > 0) ? 'Cal. 2 + 1ª mitad Cal. 1' : (shA > 0 ? '1ª mitad Cal. 1' : 'Calendario de 180 días');
  const b = SPX_LOCKUP_B;
  const numericB = b.filter(e => pctNumL(e.pct) != null);
  let sum180 = 0;
  numericB.forEach(e => { sum180 += Math.round(pool * pctNumL(e.pct)); });
  const rem180 = Math.round(pool) - sum180;
  b.forEach((e, i) => {
    const isRem = pctNumL(e.pct) == null;
    const sh = isRem ? rem180 : Math.round(pool * pctNumL(e.pct));
    counted += sh; acum = counted;
    rows.push({ date: spxrDate(e.date), label: e.label, sh, pct: (sh / TOT * 100), acum: (acum / TOT * 100), scope: scope180 });
    if (i === 0) {   // bono condicional tras el cliff — fila aparte, NO suma al acumulado
      rows.push({ date: '~ ago 2026', label: 'Bono por desempeño — condicional', sh: Math.round(pool * 0.10), pct: (pool * 0.10 / TOT * 100), acum: null, scope: 'Solo si SpaceX cotiza >=30% sobre el IPO; adelanta parte del remanente', bonus: true });
    }
  });

  // Lock-up extendido (2ª mitad de A)
  if (ext > 0) {
    const e2 = SPX_LOCKUP_A_EXT.map(e => ({ ...e, shr: Math.round(ext * pctNumL(e.pct)) }));
    const sumExt = e2.reduce((s, e) => s + e.shr, 0);
    e2[e2.length - 1].shr += (Math.round(TOT) - counted - sumExt);   // ajusta la última fila → total exacto
    e2.forEach(e => {
      counted += e.shr; acum = counted;
      rows.push({ date: spxrDate(e.date), label: e.label, sh: e.shr, pct: (e.shr / TOT * 100), acum: (acum / TOT * 100), scope: '2ª mitad del Cal. 1' });
    });
  } else {
    // sin extendido: asegurar que lo contado == TOT (ajusta la última fila contada)
    const fix = Math.round(TOT) - counted;
    if (fix !== 0) { const last = [...rows].reverse().find(r => !r.bonus); last.sh += fix; last.acum = 100; }
  }
  // normaliza acumulado final a 100.0 exacto
  const lastCounted = [...rows].reverse().find(r => !r.bonus);
  if (lastCounted) lastCounted.acum = 100;
  return { rows, TOT: Math.round(TOT), pool: Math.round(pool), ext: Math.round(ext) };
}

// ── Narrativa "¿Qué pasó con la posición?" por caso (ES/EN) ──
function spxrNarrative(D, EN) {
  const T = (es, en) => (EN ? en : es);
  const ps = [];
  const dirV = D.act.filter(a => !a.indirect && (!a.isReinvTarget || !D.hasReinv)).map(a => `<b>${a.short}</b> (${SPXR_MONEY(a.commitment)})`);
  const indV = D.act.filter(a => a.indirect);
  const join = arr => arr.join(', ').replace(/, ([^,]*)$/, T(' y $1', ' and $1'));
  let p1;
  if (dirV.length && indV.length) {
    p1 = T(`<b>1. La posición.</b> El inversionista tiene exposición directa a SpaceX a través de ${join(dirV)}, y exposición <b>indirecta</b> como parte de ${join(indV.map(a => `<b>${a.short.replace(' (indirecta)', '')}</b> (${SPXR_SH(a.shares)} acc)`))}${D.hasSold ? ' (más las porciones ya liquidadas que se describen abajo)' : ''}. Capital original: <b>${SPXR_MONEY(D.original)}</b>. Reflejando el <b>split 5:1</b>, la tenencia activa total es de <b>${SPXR_SH(D.totSh)} acciones post-split</b>.`,
           `<b>1. The position.</b> The investor holds direct SpaceX exposure through ${join(dirV)}, and <b>indirect</b> exposure as part of ${join(indV.map(a => `<b>${a.short.replace(' (indirecta)', '')}</b> (${SPXR_SH(a.shares)} sh)`))}${D.hasSold ? ' (plus the portions already liquidated, described below)' : ''}. Original capital: <b>${SPXR_MONEY(D.original)}</b>. Reflecting the <b>5:1 split</b>, the total active holding is <b>${SPXR_SH(D.totSh)} post-split shares</b>.`);
  } else if (indV.length) {
    p1 = T(`<b>1. Exposición a SpaceX.</b> El inversionista <b>no</b> tiene un vehículo directo (SPV) de SpaceX. Su exposición proviene de SpaceX como una de las empresas dentro de ${indV.length === 1 ? 'un fondo diversificado de MVP: el' : 'los fondos diversificados'} ${join(indV.map(a => `<b>${a.short.replace(' (indirecta)', '')}</b>`))}. Reflejando el <b>split 5:1</b>, la tenencia indirecta es de <b>${SPXR_SH(D.totSh)} acciones post-split</b>, a un costo promedio del fondo de ${join(indV.map(a => `<b>${SPXR_P2(a.commitment / a.shares)}</b>/acción`))}. Estas cifras no reflejan retenciones por gastos ni carried interest.`,
           `<b>1. SpaceX exposure.</b> The investor does <b>not</b> hold a direct SpaceX vehicle (SPV). Their exposure comes from SpaceX as one of the companies within ${indV.length === 1 ? 'an MVP diversified fund:' : 'the diversified funds'} ${join(indV.map(a => `<b>${a.short.replace(' (indirecta)', '')}</b>`))}. Reflecting the <b>5:1 split</b>, the indirect holding is <b>${SPXR_SH(D.totSh)} post-split shares</b>, at an average fund cost of ${join(indV.map(a => `<b>${SPXR_P2(a.commitment / a.shares)}</b>/share`))}. These figures do not reflect withholding for expenses or carried interest.`);
  } else {
    p1 = T(`<b>1. La posición.</b> El inversionista tiene exposición directa a SpaceX a través de ${D.act.length === 1 ? 'el vehículo' : 'los vehículos'} ${join(dirV)}${D.hasSold ? ' (más las porciones ya liquidadas que se describen abajo)' : ''}. Capital original: <b>${SPXR_MONEY(D.original)}</b>. Reflejando el <b>split 5:1</b>, la tenencia activa es de <b>${SPXR_SH(D.totSh)} acciones post-split</b>.`,
           `<b>1. The position.</b> The investor holds direct SpaceX exposure through ${D.act.length === 1 ? 'the vehicle' : 'the vehicles'} ${join(dirV)}${D.hasSold ? ' (plus the portions already liquidated, described below)' : ''}. Original capital: <b>${SPXR_MONEY(D.original)}</b>. Reflecting the <b>5:1 split</b>, the active holding is <b>${SPXR_SH(D.totSh)} post-split shares</b>.`);
  }
  ps.push(p1);
  if (D.hasSold) {
    const pps = D.soldPps ? T(` a un precio bruto de ${SPXR_P2(D.soldPps * 5)}/acción (${SPXR_P2(D.soldPps)} post-split)`, ` at a gross price of ${SPXR_P2(D.soldPps * 5)}/share (${SPXR_P2(D.soldPps)} post-split)`) : '';
    const fecha = D.soldDate ? new Date(D.soldDate.slice(0, 10) + 'T12:00:00').toLocaleDateString(EN ? 'en-US' : 'es-MX', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
    if (D.hasReinv && D.cashOut <= 0.01) {
      const crossTxt = (D.crossReinv > 0 && !D.reinvRows.length) ? T(' (posición mantenida en Cretum Partners GVV Fund, LP)', ' (position held in Cretum Partners GVV Fund, LP)') : '';
      const addTxt = D.addReinv > 0.01 ? T(` Adicionalmente, el inversionista aportó <b>${SPXR_MONEY(D.addReinv)}</b> de capital nuevo a la Serie VI-26A QP.`, ` Additionally, the investor contributed <b>${SPXR_MONEY(D.addReinv)}</b> of new capital to Series VI-26A QP.`) : '';
      ps.push(T(`<b>2. Liquidación parcial y reinversión (${fecha}).</b> Un fondo institucional subyacente vendió <b>${SPXR_SH(D.soldShares)} acciones</b>${pps}. La totalidad de los <b>${SPXR_MONEY(D.reinvP)}</b> recibidos se reinvirtió en el vehículo directo <b>Serie VI-26A QP</b>${crossTxt} — es capital reciclado, no efectivo entregado.${addTxt}`,
                `<b>2. Partial liquidation and reinvestment (${fecha}).</b> An underlying institutional fund sold <b>${SPXR_SH(D.soldShares)} shares</b>${pps}. The entire <b>${SPXR_MONEY(D.reinvP)}</b> received was reinvested into the direct vehicle <b>Series VI-26A QP</b>${crossTxt} — it is recycled capital, not cash delivered.${addTxt}`));
    } else if (D.hasReinv) {
      const addTxt2 = D.addReinv > 0.01 ? T(` Adicionalmente, el inversionista aportó <b>${SPXR_MONEY(D.addReinv)}</b> de capital nuevo a la Serie VI-26A QP.`, ` Additionally, the investor contributed <b>${SPXR_MONEY(D.addReinv)}</b> of new capital to Series VI-26A QP.`) : '';
      ps.push(T(`<b>2. Liquidación parcial (${fecha}).</b> Un fondo institucional subyacente vendió <b>${SPXR_SH(D.soldShares)} acciones</b>${pps}. Del producto, <b>${SPXR_MONEY(D.reinvP)}</b> se reinvirtió en la <b>Serie VI-26A QP</b> y <b>${SPXR_MONEY(D.cashOut)}</b> se entregó en efectivo.${addTxt2}`,
                `<b>2. Partial liquidation (${fecha}).</b> An underlying institutional fund sold <b>${SPXR_SH(D.soldShares)} shares</b>${pps}. Of the proceeds, <b>${SPXR_MONEY(D.reinvP)}</b> was reinvested into <b>Series VI-26A QP</b> and <b>${SPXR_MONEY(D.cashOut)}</b> was delivered in cash.${addTxt2}`));
    } else {
      ps.push(T(`<b>2. Liquidación parcial (${fecha}).</b> Un fondo institucional subyacente vendió <b>${SPXR_SH(D.soldShares)} acciones</b>${pps}. El inversionista recibió <b>${SPXR_MONEY(D.cashOut)} en efectivo</b> — un múltiplo de <b>${SPXR_X(D.cashOut / D.soldCost)}</b> sobre el costo de esa porción (${SPXR_MONEY(D.soldCost)}). Este efectivo ya fue entregado; no está sujeto al lock-up.`,
                `<b>2. Partial liquidation (${fecha}).</b> An underlying institutional fund sold <b>${SPXR_SH(D.soldShares)} shares</b>${pps}. The investor received <b>${SPXR_MONEY(D.cashOut)} in cash</b> — a <b>${SPXR_X(D.cashOut / D.soldCost)}</b> multiple on that portion's cost (${SPXR_MONEY(D.soldCost)}). This cash has already been delivered; it is not subject to the lock-up.`));
    }
  }
  ps.push(T(`<b>${D.hasSold ? '3' : '2'}. Valuación actual.</b> Al precio de cierre de hoy de <b>${SPXR_P2(D.live.P)}</b> por acción${D.live.EVB ? ` (valuación de SpaceX ~ $${SPXR_INT(D.live.EVB)} mmd)` : ''}, las <b>${SPXR_SH(D.totSh)} acciones activas</b> valen <b>${SPXR_MONEY(D.totVal)}</b>, un múltiplo de <b>${SPXR_X(D.totVal / D.totCost)}</b> sobre su costo (${SPXR_MONEY(D.totCost)}).`,
            `<b>${D.hasSold ? '3' : '2'}. Current valuation.</b> At today's closing price of <b>${SPXR_P2(D.live.P)}</b> per share${D.live.EVB ? ` (SpaceX valuation ~ $${SPXR_INT(D.live.EVB)}bn)` : ''}, the <b>${SPXR_SH(D.totSh)} active shares</b> are worth <b>${SPXR_MONEY(D.totVal)}</b>, a <b>${SPXR_X(D.totVal / D.totCost)}</b> multiple on their cost (${SPXR_MONEY(D.totCost)}).`));
  ps.push(T(`<b>${D.hasSold ? '4' : '3'}. Distribución (en proceso).</b> Aún no se ha distribuido ni liquidado la posición activa. Las acciones están sujetas a un lock-up con liberación escalonada (ver detalle abajo). El inversionista deberá elegir entre <b>acciones (in-kind)</b> o <b>efectivo</b> mediante el formulario de Trident.`,
            `<b>${D.hasSold ? '4' : '3'}. Distribution (in progress).</b> The active position has not yet been distributed or liquidated. The shares are subject to a staggered-release lock-up (see detail below). The investor will need to choose between <b>shares (in-kind)</b> or <b>cash</b> via the Trident election form.`));
  return ps;
}

// ── HTML del reporte — sistema visual del reporte de portafolio MVP (naranja/Outfit) ──
function spxrHtml(D, EN) {
  const T = (es, en) => (EN ? en : es);
  const XL = s => (EN ? spxrEn(s) : s);
  const E = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const name = (D.combined && D.inv._accounts && D.inv._accounts.length <= 3)
    ? D.inv._accounts.map(a => a.name).join(' + ') : D.inv.name;
  const P = D.live.P;
  const hoy = new Date().toLocaleDateString(EN ? 'en-US' : 'es-MX', { day: 'numeric', month: 'long', year: 'numeric' });

  const kpi = (label, value, cls) => `<div class="kpi ${cls || ''}"><div class="kl">${label}</div><div class="kv">${value}</div></div>`;
  const sec = t => `<div class="sec">${t}</div>`;

  // Tabla detalle por vehículo (solo ACTIVAS — regla del template)
  const vrows = D.act.map(a => {
    const entry = a.shares ? a.commitment / a.shares : null;
    const val = a.shares * P;
    const tag = a.isReinvTarget && D.hasReinv ? T(' — <b>reinversión</b>', ' — <b>reinvestment</b>') : T(' (activa)', ' (active)');
    const cta = (D.combined && a.acct) ? `<span class="acct">${E(a.acct)}</span> · ` : '';
    return `<tr><td>${cta}${E(EN ? a.short.replace(' (indirecta)', ' (indirect)') : a.short)}${tag}</td><td class="n">${SPXR_SH(a.shares)}</td><td class="n">${entry ? SPXR_P2(entry) : '—'}</td><td class="n">${SPXR_P2(P)}</td><td class="n">${SPXR_MONEY(a.commitment)}</td><td class="n b">${SPXR_MONEY(val)}</td><td class="n b">${entry ? SPXR_X(P / entry) : '—'}</td></tr>`;
  });
  const totRow = D.hasReinv
    ? `<tr class="tot"><td>${T('Total posición actual SpaceX', 'Total current SpaceX position')}</td><td class="n">${SPXR_SH(D.totSh)}</td><td></td><td class="n">${SPXR_P2(P)}</td><td class="n">${SPXR_MONEY(D.original)}*</td><td class="n">${SPXR_MONEY(D.totVal)}</td><td class="n">${SPXR_X(D.totVal / D.original)}*</td></tr>`
    : `<tr class="tot"><td>${T('Total SpaceX', 'SpaceX Total')}</td><td class="n">${SPXR_SH(D.totSh)}</td><td></td><td class="n">${SPXR_P2(P)}</td><td class="n">${SPXR_MONEY(D.totCost)}</td><td class="n">${SPXR_MONEY(D.totVal)}</td><td class="n">${SPXR_X(D.totVal / D.totCost)}</td></tr>`;
  const reinvFn = !D.hasReinv ? T(' MOIC = valor actual / costo.', ' MOIC = current value / cost.')
    : (D.reinvRows.length
      ? (D.addReinv > 0.01
        ? T(` * Múltiplo sobre el capital original de ${SPXR_MONEY(D.original)}. El capital de la Serie VI-26A QP se compone de ${SPXR_MONEY(D.reinvP)} reinvertidos de la liquidación parcial más ${SPXR_MONEY(D.addReinv)} de capital adicional aportado.`, ` * Multiple on original capital of ${SPXR_MONEY(D.original)}. The Series VI-26A QP capital consists of ${SPXR_MONEY(D.reinvP)} reinvested from the partial liquidation plus ${SPXR_MONEY(D.addReinv)} of additional contributed capital.`)
        : T(` * Múltiplo sobre el capital original de ${SPXR_MONEY(D.original)}. El capital de la Serie VI-26A QP (${SPXR_MONEY(D.reinvP)}) proviene de la liquidación parcial reinvertida — no es capital adicional aportado.`, ` * Multiple on original capital of ${SPXR_MONEY(D.original)}. The Series VI-26A QP capital (${SPXR_MONEY(D.reinvP)}) comes from the reinvested partial liquidation — it is not additional contributed capital.`))
      : T(` * Múltiplo sobre el capital original de ${SPXR_MONEY(D.original)}. La reinversión (${SPXR_MONEY(D.reinvP)}, Serie VI-26A QP) se mantiene en Cretum Partners GVV Fund, LP y no aparece en esta tabla.`, ` * Multiple on original capital of ${SPXR_MONEY(D.original)}. The reinvestment (${SPXR_MONEY(D.reinvP)}, Series VI-26A QP) is held in Cretum Partners GVV Fund, LP and does not appear in this table.`));
  const tableFn = T(`Acciones y costo/acción: cartas del IPO de SpaceX de cada vehículo (Altareturn). Base post-split 5:1. Valor actual = acciones × ${SPXR_P2(P)} (precio de cierre de hoy).`, `Shares and cost/share: SpaceX IPO letters for each vehicle (Altareturn). Post-split 5:1 basis. Current value = shares × ${SPXR_P2(P)} (today\'s closing price).`) + reinvFn;

  // Distribuciones recibidas (solo venta en EFECTIVO)
  let distSec = '';
  if (D.cashOut > 0.01) {
    const dRows = [];
    D.sold.forEach(s => s.dists.forEach(x => {
      const isNote = SPX_REINV_IS_NOTE(x.notes);
      if (isNote && !(D.cashFracNoted > 0)) return;
      let val = (SPXR_N(x.cash_proceeds) || 0) + (SPXR_N(x.value_in_kind) || 0);
      if (val <= 0) return;
      // Venta con nota de reinversión pero solo parcialmente reinvertida: aquí va la porción en efectivo
      const partial = isNote;
      if (partial) val = val * D.cashFracNoted;
      const f = x.distribution_date ? new Date(x.distribution_date.slice(0, 10) + 'T12:00:00').toLocaleDateString(EN ? 'en-US' : 'es-MX', { day: 'numeric', month: 'short', year: 'numeric' }).replace(/\./g, '') : '—';
      dRows.push(`<tr><td>${f}</td><td>${E(s.short)} — ${partial ? T('liquidación parcial (porción en efectivo)', 'partial liquidation (cash portion)') : T('liquidación parcial', 'partial liquidation')}</td><td>${x.value_in_kind ? T('Especie', 'In-kind') : T('Efectivo', 'Cash')}</td><td class="n">${partial ? '—' : (x.shares_distributed ? SPXR_SH(+x.shares_distributed) : '—')}</td><td class="n">${partial ? '—' : (SPXR_N(x.price_per_share) != null ? SPXR_P2(+x.price_per_share) : '—')}</td><td class="n b">${SPXR_MONEY(val)}</td></tr>`);
    }));
    if (dRows.length) {
      distSec = `${sec(T('Distribuciones recibidas', 'Distributions received'))}
  <table><thead><tr><th>${T('Fecha', 'Date')}</th><th>${T('Vehículo', 'Vehicle')}</th><th>${T('Tipo', 'Type')}</th><th class="n">${T('Acciones', 'Shares')}</th><th class="n">PPS</th><th class="n">${T('Valor', 'Value')}</th></tr></thead>
  <tbody>${dRows.join('')}</tbody></table>
  <div class="fn">${T('Efectivo ya entregado; no está sujeto al lock-up ni forma parte del MOIC de la posición activa. PPS = precio bruto de venta en base post-split.', 'Cash already delivered; it is not subject to the lock-up and is not part of the active position\'s MOIC. PPS = gross sale price on a post-split basis.')}${D.cashFracNoted > 0 ? ' ' + T(`Del producto total de la venta, ${SPXR_MONEY(D.reinvP)} se reinvirtió en la Serie VI-26A QP (ver tabla de vehículos) y el resto se entregó en efectivo.`, `Of the total sale proceeds, ${SPXR_MONEY(D.reinvP)} was reinvested into Series VI-26A QP (see vehicle table) and the remainder was delivered in cash.`) : ''}</div>`;
    }
  }

  // ¿Cómo y cuándo?
  const como = [];
  como.push(T(`Las <b>${SPXR_SH(D.totSh)} acciones activas</b> se liberan según ${D.shA > 0 && D.shB > 0 ? '<b>dos calendarios</b>. La tabla de abajo los <b>combina</b>: cada fila es una fecha y la columna <b>Acciones</b> es el total que se distribuye ese día.' : 'el calendario de abajo.'}`, `The <b>${SPXR_SH(D.totSh)} active shares</b> are released according to ${D.shA > 0 && D.shB > 0 ? '<b>two schedules</b>. The table below <b>combines</b> them: each row is a date and the <b>Shares</b> column is the total distributed that day.' : 'the schedule below.'}`));
  const aList = D.act.filter(a => !a.indirect && a.struct === 'A').map(a => a.short)
    .concat(D.act.filter(a => a.indirect && a.fund === 'IV').map(() => T('20% del Fund IV', '20% of Fund IV')));
  const bList = D.act.filter(a => !a.indirect && a.struct === 'B').map(a => a.short)
    .concat(D.act.filter(a => a.indirect && a.fund === 'IV').map(() => T('80% del Fund IV', '80% of Fund IV')))
    .concat(D.act.filter(a => a.indirect && a.fund === 'V').map(() => 'Fund V'));
  if (D.shA > 0) como.push(T(`<b>Calendario 1 — Liberación en dos mitades (~${SPXR_INT(D.shA)} acciones: ${aList.join(', ')}).</b> La 1ª mitad (~${SPXR_INT(D.shA / 2)}) se libera en los primeros ~6 meses; la 2ª mitad en un lock-up extendido que corre hasta ~agosto 2027.`, `<b>Schedule 1 — Release in two halves (~${SPXR_INT(D.shA)} shares: ${aList.join(', ')}).</b> The 1st half (~${SPXR_INT(D.shA / 2)}) is released within the first ~6 months; the 2nd half under an extended lock-up running until ~August 2027.`));
  if (D.shB > 0) como.push(T(`<b>Calendario ${D.shA > 0 ? '2' : 'único'} — Escalonado de 180 días (~${SPXR_INT(D.shB)} acciones: ${bList.join(', ')}).</b> Se libera completo dentro de los primeros 180 días; expira el 9 de diciembre de 2026.`, `<b>Schedule ${D.shA > 0 ? '2' : '(single)'} — Staggered over 180 days (~${SPXR_INT(D.shB)} shares: ${bList.join(', ')}).</b> Fully released within the first 180 days; expires December 9, 2026.`));
  como.push(T(`La fecha del primer earnings de SpaceX aún no es oficial; el primer tramo (20%) se libera ~2 días hábiles después del reporte — la mejor estimación disponible es el <b>~17 de agosto de 2026</b>.`, `The date of SpaceX's first earnings report is not yet official; the first tranche (20%) is released ~2 business days after the report — the best available estimate is <b>~August 17, 2026</b>.`));

  const calRows = D.calendar.rows.map(r => `<tr${r.bonus ? ' class="bono"' : ''}><td>${E(XL(r.date))}</td><td>${E(XL(r.label))}</td><td class="n b">${r.bonus ? '+' : ''}${SPXR_INT(r.sh)}</td><td class="n">${r.pct.toFixed(1)}%</td><td class="n">${r.acum == null ? '—' : r.acum.toFixed(1) + '%'}</td><td class="det">${E(XL(r.scope))}</td></tr>`).join('');
  const anexo1 = SPX_STRUCTURES.B.phases.map(f => `<tr><td>${E(XL(f.hito))}</td><td class="n">${E(f.pct)}</td><td class="det">${E(XL(f.detalle))}</td></tr>`).join('');
  const anexo2 = D.shA > 0 ? (SPX_STRUCTURES.A.groups[1].phases.map(f => `<tr><td>${E(XL(f.hito))}</td><td class="n">${E(f.pct)}</td><td class="det">${E(XL(f.detalle || ''))}</td></tr>`).join('')) : null;
  const paras = spxrNarrative(D, EN).map(p => `<p class="para">${p}</p>`).join('');

  return `<!doctype html><html><head><meta charset="utf-8"><style>
${SPXR_FONT_FACES}
*{margin:0;padding:0;box-sizing:border-box}
html,body{background:#fff}
body{font-family:'Instrument',sans-serif;color:#241f1b;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.page{width:816px;padding:0 0 26px;background:#fff}
.topbar{height:5px;background:#E8650D}
.hero{background:#f5f3f0;padding:20px 40px 15px;border-bottom:1px solid #e8e3dd}
.eyebrow{font-family:'Geist',monospace;font-size:9.5px;letter-spacing:3px;color:#E8650D;text-transform:uppercase}
.htitle{font-family:'Outfit',sans-serif;font-weight:700;font-size:28px;color:#2a2521;margin:6px 0 4px;letter-spacing:-.5px}
.hsub{font-size:11.5px;color:#6e655d}.hsub b{color:#2a2521;font-weight:700}
.accentbar{height:3px;width:92px;background:#E8650D;margin-top:11px;border-radius:2px}
.rbody{padding:16px 40px 0}
.rbody > *{margin-bottom:10px}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:9px;margin-bottom:13px}
.kpi{background:#fff;border:1px solid #e8e3dd;border-radius:11px;padding:11px 12px}
.kpi.accent{border-top:3px solid #E8650D}
.kl{font-family:'Geist',monospace;font-size:7.5px;letter-spacing:.8px;text-transform:uppercase;color:#9a8f84}
.kv{font-family:'Outfit',sans-serif;font-weight:700;font-size:17px;margin-top:5px;letter-spacing:-.5px;color:#2a2521}
.kpi.accent .kv{color:#E8650D}.kpi.pos .kv{color:#3d8a52}
.sec{font-family:'Outfit',sans-serif;font-weight:700;font-size:13px;margin:8px 0 8px;display:flex;align-items:center;gap:8px;color:#2a2521}
.sec::before{content:'';width:4px;height:14px;background:#E8650D;border-radius:2px}
.para{font-size:10.5px;line-height:1.55;color:#473f38;text-align:justify;margin-bottom:7px}
.para b{color:#241f1b}
table{width:100%;border-collapse:collapse;font-size:9.5px}
thead th{background:#3f3a36;color:#fff;font-family:'Geist',monospace;font-weight:400;font-size:8px;letter-spacing:.4px;text-transform:uppercase;padding:7px 8px;text-align:left}
thead th.n{text-align:right}
tbody td{padding:6px 8px;border-bottom:1px solid #efeae4;color:#473f38;vertical-align:top}
tbody tr:nth-child(even){background:#faf8f5}
td.n{text-align:right;font-family:'Geist',monospace;font-size:9px;color:#241f1b;white-space:nowrap}
td.b{font-weight:700}
td.det{color:#8a8177;font-size:8.6px}
td .acct{color:#9a8f84;font-size:8.6px}
tr.tot td{background:#f5f3f0;font-weight:700;border-top:2px solid #E8650D;color:#241f1b}
tr.bono td{background:#fdf6ec;color:#9a6c1f}
.fn{font-family:'Geist',monospace;font-size:7.8px;color:#9a8f84;line-height:1.5;margin-top:5px}
.note{background:#faf8f5;border-left:3px solid #E8650D;border-radius:0 8px 8px 0;padding:10px 13px;font-size:9.8px;line-height:1.55;color:#473f38}
.note b{color:#241f1b}
</style></head><body><div class="page">
  <div class="topbar"></div>
  <div class="hero">
    <div class="eyebrow">MVP · ${T('Reporte SpaceX', 'SpaceX Report')}</div>
    <div class="htitle">Space Exploration Technologies</div>
    <div class="hsub"><b>${E(name)}</b>${D.combined ? ` · ${T('posición consolidada', 'consolidated position')} (${D.inv._accounts.length} ${T('cuentas', 'accounts')})` : ''} · ${D.act.length} ${T('vehículo' + (D.act.length === 1 ? '' : 's') + ' activo' + (D.act.length === 1 ? '' : 's'), 'active vehicle' + (D.act.length === 1 ? '' : 's'))} · ${T('Generado', 'Generated')} ${hoy}</div>
    <div class="hsub">${T('IPO 12-jun-2026 · base <b>post-split 5:1</b> · Precio de cierre de hoy: ', 'IPO Jun 12, 2026 · <b>post-split 5:1</b> basis · Today\'s closing price: ')}<b>${SPXR_P2(P)} USD${T('/acción', '/share')}</b>${D.live.EVB ? ` · ${T('Valuación', 'Valuation')} ~ $${SPXR_INT(D.live.EVB)} ${T('mmd', 'bn')}` : ''}</div>
    <div class="accentbar"></div>
  </div>
  <div class="rbody">
  <div class="kpis">
    ${kpi(T('Acciones SpaceX', 'SpaceX Shares'), SPXR_SH(D.totSh), 'accent')}
    ${D.hasReinv ? kpi(T('Capital original', 'Original Capital'), SPXR_MONEY(D.original), '') : kpi(T('Costo (entrada)', 'Cost (entry)'), SPXR_MONEY(D.totCost), '')}
    ${kpi(T('Valor actual', 'Current Value'), SPXR_MONEY(D.totVal), 'pos')}
    ${D.hasReinv ? kpi(T('Múltiplo s/ original', 'Multiple on Original'), SPXR_X(D.totVal / D.original), '') : kpi(T('Múltiplo', 'Multiple'), SPXR_X(D.totVal / D.totCost), '')}
  </div>
  ${sec(T('¿Qué pasó con la posición?', 'What happened with the position?'))}
  ${paras}
  ${sec(T('Detalle por vehículo', 'Detail by vehicle'))}
  <table><thead><tr><th>${D.combined ? T('Cuenta · Vehículo / Estatus', 'Account · Vehicle / Status') : T('Vehículo / Estatus', 'Vehicle / Status')}</th><th class="n">${T('Acciones', 'Shares')}</th><th class="n">${T('PPS Entrada', 'Entry PPS')}</th><th class="n">${T('PPS Actual', 'Current PPS')}</th><th class="n">${T('Inversión', 'Investment')}</th><th class="n">${T('Valor actual', 'Current value')}</th><th class="n">MOIC</th></tr></thead>
  <tbody>${vrows.join('')}${totRow}</tbody></table>
  <div class="fn">${tableFn}</div>
  ${distSec}
  ${sec(T('¿Cómo y cuándo se liberan las acciones?', 'How and when are the shares released?'))}
  ${como.map(p => `<p class="para">${p}</p>`).join('')}
  ${sec(T('Calendario combinado de distribuciones', 'Combined distribution schedule'))}
  <table><thead><tr><th>${T('Fecha', 'Date')}</th><th>${T('Evento', 'Event')}</th><th class="n">${T('Acciones', 'Shares')}</th><th class="n">% total</th><th class="n">${T('Acum. %', 'Cum. %')}</th><th>${T('Detalle', 'Detail')}</th></tr></thead>
  <tbody>${calRows}<tr class="tot"><td colspan="2">${T('Total liberado', 'Total released')}</td><td class="n">${SPXR_INT(D.calendar.TOT)}</td><td class="n">100%</td><td></td><td class="det">${T('Bono condicional adelantaría parte del remanente', 'A conditional bonus would bring forward part of the remainder')}</td></tr></tbody></table>
  <div class="fn">${T('Acciones por fecha = suma de lo que libera cada calendario ese día (redondeadas). La fecha del earnings Q2 2026 aún no es oficial (~17 ago 2026 es la mejor estimación); hitos posteriores estimados con la misma cadencia. El prospecto final es la autoridad. El bono +10% es condicional y no se incluye en el acumulado base.', 'Shares per date = sum of what each schedule releases that day (rounded). The Q2 2026 earnings date is not yet official (~Aug 17, 2026 is the best estimate); later milestones estimated with the same cadence. The final prospectus is the controlling authority. The +10% bonus is conditional and is not included in the base cumulative.')}</div>
  <div class="note">${T(`<b>Split 5:1:</b> todas las acciones están en base post-split. <b>Precio:</b> el valor de ${SPXR_MONEY(D.totVal)} usa el precio de cierre de hoy de ${SPXR_P2(P)}/acción y se mueve con el precio público de SpaceX. <b>Cifras no realizadas:</b> el monto final dependerá del precio al liberarse cada tramo y de la elección cash/in-kind; las cifras no reflejan retenciones por gastos ni carried interest.${D.hasSold && D.cashOut > 0.01 ? ` <b>Venta previa:</b> el efectivo de la liquidación parcial (${SPXR_MONEY(D.cashOut)}) ya fue entregado y no está sujeto al lock-up.` : ''}`, `<b>5:1 split:</b> all shares are on a post-split basis. <b>Price:</b> the ${SPXR_MONEY(D.totVal)} value uses today's closing price of ${SPXR_P2(P)}/share and moves with SpaceX's public price. <b>Unrealized figures:</b> the final amount will depend on the price when each tranche is released and on the cash/in-kind election; figures do not reflect withholding for expenses or carried interest.${D.hasSold && D.cashOut > 0.01 ? ` <b>Prior sale:</b> the cash from the partial liquidation (${SPXR_MONEY(D.cashOut)}) has already been delivered and is not subject to the lock-up.` : ''}`)}</div>
  ${sec(T('Anexo 1 — Distribución de los primeros 180 días', 'Annex 1 — First 180 days release'))}
  <p class="para">${T(`Mecanismo de las acciones que se liberan en los primeros ~6 meses${D.shA > 0 && D.shB > 0 ? ` (todo el Calendario 2 + la 1ª mitad del Calendario 1: ${SPXR_INT(D.calendar.pool)} acciones)` : ` (${SPXR_INT(D.calendar.pool)} acciones)`}. Liberación escalonada ligada a desempeño; expira el 9 de diciembre de 2026. Porcentajes sobre las acciones sujetas a este calendario.`, `Mechanics of the shares released within the first ~6 months${D.shA > 0 && D.shB > 0 ? ` (all of Schedule 2 + the 1st half of Schedule 1: ${SPXR_INT(D.calendar.pool)} shares)` : ` (${SPXR_INT(D.calendar.pool)} shares)`}. Staggered release tied to performance; expires December 9, 2026. Percentages are over the shares subject to this schedule.`)}</p>
  <table><thead><tr><th>${T('Hito / Fecha', 'Milestone / Date')}</th><th class="n">${T('% liberado', '% released')}</th><th>${T('Detalle', 'Detail')}</th></tr></thead><tbody>${anexo1}</tbody></table>
  <div class="fn">${E(XL(SPX_STRUCTURES.B.nota))}</div>
  ${anexo2 ? `${sec(T('Anexo 2 — Segunda parte del Calendario 1 (lock-up extendido)', 'Annex 2 — Second half of Schedule 1 (extended lock-up)'))}
  <p class="para">${T(`La 2ª mitad del Calendario 1 (~${SPXR_INT(D.calendar.ext)} acciones) NO se libera en los primeros 180 días, sino en un lock-up extendido entre ~febrero y agosto de 2027. Porcentajes sobre las acciones de esta segunda mitad.`, `The 2nd half of Schedule 1 (~${SPXR_INT(D.calendar.ext)} shares) is NOT released within the first 180 days, but under an extended lock-up between ~February and August 2027. Percentages are over the shares of this second half.`)}</p>
  <table><thead><tr><th>${T('Hito / Fecha', 'Milestone / Date')}</th><th class="n">${T('% liberado', '% released')}</th><th>${T('Detalle', 'Detail')}</th></tr></thead><tbody>${anexo2}</tbody></table>
  <div class="fn">${T('Fechas estimadas; el prospecto final es la autoridad controladora. Liquidez total de esta mitad ~ agosto 2027.', 'Estimated dates; the final prospectus is the controlling authority. Full liquidity of this half ~ August 2027.')}</div>` : ''}
  </div>
</div></body></html>`;
}

// ── Paginación inteligente: empaquetado por SECCIONES con fallback a bloques/filas.
// 1) El contenido se agrupa en unidades: [portada+KPIs] y luego cada sección (.sec hasta la
//    siguiente .sec). Si una unidad completa cabe en una página, JAMÁS se parte: se empuja
//    entera a la página siguiente (temas coherentes, sin tablas cortadas).
// 2) Solo si una unidad sola es más alta que una página, se parte por dentro en fronteras
//    seguras: inicio de párrafo o fila de tabla (nunca a media línea; nunca entre thead y la
//    1ª fila; la última fila/total viaja pegada; un .sec nunca queda huérfano; un .fn nunca
//    se separa de su tabla).
function spxrPageCuts(pageEl, capacityCss) {
  const pageTop = pageEl.getBoundingClientRect().top;
  const relTop = el => Math.round(el.getBoundingClientRect().top - pageTop);
  const relBot = el => Math.round(el.getBoundingClientRect().bottom - pageTop);
  const kids = [];
  Array.from(pageEl.children).forEach(ch => {
    if (ch.classList.contains('rbody')) kids.push(...ch.children); else kids.push(ch);
  });
  // candidatos finos (para unidades más altas que una página)
  const cands = new Set(), banned = new Set();
  let prevWasSec = false;
  kids.forEach(el => {
    const y = relTop(el);
    if (prevWasSec || el.classList.contains('fn')) banned.add(y); else cands.add(y);
    prevWasSec = el.classList.contains('sec');
    if (el.tagName === 'TABLE') {
      const trs = Array.from(el.querySelectorAll('tbody tr'));
      trs.forEach((tr, i) => {
        const yy = relTop(tr);
        if (i === 0 || i === trs.length - 1) banned.add(yy); else cands.add(yy);
      });
    }
  });
  banned.forEach(y => cands.delete(y));
  const fine = [...cands].sort((a, b) => a - b);
  // unidades: [inicio..antes de la 1ª .sec], luego una por sección
  const units = [];
  let cur = null;
  kids.forEach(el => {
    if (el.classList.contains('sec')) { if (cur) units.push(cur); cur = { top: relTop(el), bottom: relBot(el) }; }
    else if (cur) cur.bottom = Math.max(cur.bottom, relBot(el));
    else { if (!units.length) units.push({ top: 0, bottom: relBot(el) }); else units[0].bottom = Math.max(units[0].bottom, relBot(el)); }
  });
  if (cur) units.push(cur);
  const total = Math.ceil(pageEl.getBoundingClientRect().height);
  // unidades CONTIGUAS: el margen entre secciones pertenece a la unidad anterior
  for (let i = 0; i < units.length - 1; i++) units[i].bottom = units[i + 1].top;
  if (units.length) units[units.length - 1].bottom = total;
  const cuts = [];
  let y = 0;
  while (total - y > capacityCss) {
    const limit = y + capacityCss;
    const u = units.find(un => un.top < limit && un.bottom > limit);
    let c = null;
    if (u && u.top > y + 80 && (u.bottom - u.top) <= capacityCss) {
      c = u.top;                    // la sección cabe completa en una página → se empuja entera
    } else {
      for (const v of fine) { if (v > y + 120 && v <= limit) c = v; }   // partir por dentro
    }
    if (c == null || c <= y + 80) c = limit;   // bloque gigante sin frontera: corte duro
    cuts.push(c); y = c;
  }
  return { cuts, total };
}

// ── PDF: páginas imagen (mecanismo estándar) + Anexo 3 VECTORIAL con links clicables ──
async function spxrRenderPdf(html, fileName, anexo3, EN) {
  const T = (es, en) => (EN ? en : es);
  const old = document.getElementById('reportPrintFrame');
  if (old) old.remove();
  const iframe = document.createElement('iframe');
  iframe.id = 'reportPrintFrame';
  iframe.style.cssText = 'position:absolute;left:-10000px;top:0;width:816px;height:1120px;border:0;background:#fff';
  document.body.appendChild(iframe);
  try {
    const doc = iframe.contentWindow.document;
    doc.open(); doc.write(html); doc.close();
    await new Promise(r => setTimeout(r, 80));
    try { if (doc.fonts && doc.fonts.ready) await doc.fonts.ready; } catch (e) { /* noop */ }
    await new Promise(r => setTimeout(r, 180));
    const el = doc.querySelector('.page') || doc.body;
    const h = Math.ceil(el.getBoundingClientRect().height) + 4;
    iframe.style.height = (h + 30) + 'px';
    if (!document.getElementById('spxrFontFaces')) {
      const st = document.createElement('style'); st.id = 'spxrFontFaces'; st.textContent = SPXR_FONT_FACES; document.head.appendChild(st);
    }
    try { await document.fonts.ready; } catch (e) { /* noop */ }
    await loadScript('https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js');
    await loadScript('https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js');
    const SCALE = 4;   // ~400 DPI: texto nitido incluso con zoom
    const canvas = await window.html2canvas(el, { scale: SCALE, backgroundColor: '#ffffff', width: 816, height: h, windowWidth: 816, useCORS: true, logging: false });
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
    const pageW = pdf.internal.pageSize.getWidth(), pageH = pdf.internal.pageSize.getHeight();
    const ptPerPx = pageW / canvas.width;
    const pageHpx = pageH / ptPerPx;
    if (canvas.height <= pageHpx + 2) {
      pdf.addImage(canvas.toDataURL('image/jpeg', 0.93), 'JPEG', 0, 0, pageW, canvas.height * ptPerPx);
    } else {
      // cortes seguros medidos en el DOM (px CSS): margen superior 26pt en páginas 2+,
      // capacidad = página menos márgenes, convertida de pt -> px CSS
      const topPadPt = 26, botPadPt = 12;
      const capacityCss = Math.floor(((pageH - topPadPt - botPadPt) / ptPerPx) / SCALE);
      const { cuts, total } = spxrPageCuts(el, capacityCss);
      const bounds = [0, ...cuts, total];
      for (let i = 0; i < bounds.length - 1; i++) {
        const y0 = Math.floor(bounds[i] * SCALE);
        const y1 = Math.min(Math.ceil(bounds[i + 1] * SCALE), canvas.height);
        const sliceH = y1 - y0;
        if (sliceH <= 4) continue;
        const c2 = document.createElement('canvas');
        c2.width = canvas.width; c2.height = sliceH;
        c2.getContext('2d').drawImage(canvas, 0, y0, canvas.width, sliceH, 0, 0, canvas.width, sliceH);
        if (i) pdf.addPage();
        pdf.addImage(c2.toDataURL('image/jpeg', 0.93), 'JPEG', 0, i === 0 ? 0 : topPadPt, pageW, sliceH * ptPerPx);
      }
    }
    // ── Anexo 3 (vectorial): links reales, clicables ──
    if (anexo3 && anexo3.items.length) {
      pdf.addPage();
      const L = 56, top = 64;
      pdf.setFillColor(232, 101, 13); pdf.rect(L, top - 11, 4, 14, 'F');
      pdf.setTextColor(42, 37, 33);
      pdf.setFont('helvetica', 'bold'); pdf.setFontSize(11);
      pdf.text(T('Anexo 3 — Cartas del IPO (descarga)', 'Annex 3 — IPO Letters (download)'), L + 10, top);
      pdf.setDrawColor(232, 227, 221); pdf.setLineWidth(0.8); pdf.line(L, top + 8, pageW - L, top + 8);
      pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9.5); pdf.setTextColor(110, 101, 93);
      pdf.text(T('Liga directa a la carta oficial del IPO de SpaceX de cada vehículo (incluye el número de acciones post-split).', 'Direct link to the official SpaceX IPO letter for each vehicle (includes the post-split share count).'), L, top + 26);
      let yy = top + 50;
      anexo3.items.forEach(it => {
        pdf.setFont('helvetica', 'bold'); pdf.setFontSize(10); pdf.setTextColor(36, 31, 27);
        pdf.text(`${it.cuenta} · ${it.serie}`, L, yy);
        const w = pdf.getTextWidth(`${it.cuenta} · ${it.serie}`);
        if (it.url) {
          pdf.setFont('helvetica', 'normal'); pdf.setTextColor(232, 101, 13);
          const dlTxt = T('Descargar carta del IPO', 'Download IPO letter');
          pdf.textWithLink(dlTxt, L + w + 14, yy, { url: it.url });
          const lw = pdf.getTextWidth(dlTxt);
          pdf.setDrawColor(232, 101, 13); pdf.setLineWidth(0.6); pdf.line(L + w + 14, yy + 2, L + w + 14 + lw, yy + 2);
        } else {
          pdf.setFont('helvetica', 'italic'); pdf.setTextColor(154, 143, 132);
          pdf.text(T('Aun no disponible (carta del IPO pendiente de emision)', 'Not yet available (IPO letter pending issuance)'), L + w + 14, yy);
        }
        yy += 22;
      });
      pdf.setFont('helvetica', 'italic'); pdf.setFontSize(8); pdf.setTextColor(154, 143, 132);
      pdf.text(T('Los enlaces abren la carta en el navegador. Documento informativo; el prospecto final y las cartas oficiales son la autoridad.', 'Links open the letter in the browser. Informational document; the final prospectus and official letters are the controlling authority.'), L, yy + 10);
    }
    pdf.save(fileName);
  } finally {
    iframe.remove();
  }
}

/* ═══════════════════════════════════════════
   FUND RISING TRACKER — levantamiento de capital por oportunidad.
   Tablas: fr_opportunities, fr_prospects, fr_log (RLS: solo authenticated).
   Etapas = probabilidad de cierre: 1 Confirmado, 2 En proceso, 3 Pipeline,
   4 Frío (ya no creemos), 5 Pass (confirmó que no). Bitácora automática.
═══════════════════════════════════════════ */

const FR_STAGES = {
  1: { label: 'Confirmado', desc: 'Firmado / fondeado',            prob: 1.00, cls: 'fr-s1' },
  2: { label: 'En proceso', desc: 'Negociación activa',            prob: 0.75, cls: 'fr-s2' },
  3: { label: 'Pipeline',   desc: 'Contactado, etapa temprana',    prob: 0.40, cls: 'fr-s3' },
  4: { label: 'Frío',       desc: 'Ya no creemos que cierre',      prob: 0.10, cls: 'fr-s4' },
  5: { label: 'Pass',       desc: 'Confirmó que no invertirá',     prob: 0.00, cls: 'fr-s5' },
};
// Todas las oportunidades de MVP viven en un SPV (estructura legal); la clasificación
// útil es Fondo vs Directo, y si el directo es co-inversión (solo LPs Fund V) o abierta.
const FR_TYPES = { fondo: 'Fondo', 'directo-coinv': 'Directo · Co-inversión', directo: 'Directo · Abierta', spv: 'Directo' };

let frLoaded = false;
let frOpps = [];
let frProspects = [];        // todos; se filtran por oportunidad
let frInvestorNames = [];    // autocomplete contra la DB de inversionistas
let frCurrentOppId = null;
let frEditingProspectId = null;
let frEditingOppId = null;

const frMoney = v => (v == null || v === '' ? '—' : '$' + Math.round(+v).toLocaleString('en-US'));
const frDate = v => (v ? new Date(v + (v.length === 10 ? 'T12:00:00' : '')).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' }).replace(/\./g, '') : '—');
const frUser = () => (currentProfile && currentProfile.full_name) || 'equipo';
const frFees = (u, c) => (u == null && c == null ? '—' : `${u ?? '—'}/${c ?? '—'}`);

async function frLog(action, detail, oppId, prospectId) {
  try {
    await sb.from('fr_log').insert({ opportunity_id: oppId || null, prospect_id: prospectId || null, usuario: frUser(), action, detail: detail || null });
  } catch (e) { /* la bitácora nunca bloquea */ }
}

async function loadFr(force) {
  if (frLoaded && !force) { renderFrHome(); return; }
  const [o, p] = await Promise.all([
    sb.from('fr_opportunities').select('*').order('opened_at', { ascending: false }),
    sb.from('fr_prospects').select('*').order('commitment', { ascending: false, nullsFirst: false }),
  ]);
  if (o.error || p.error) { toast('No se pudo cargar Fund Rising: ' + (o.error || p.error).message); return; }
  frOpps = o.data || [];
  frProspects = p.data || [];
  frLoaded = true;
  if (!frInvestorNames.length) {
    sb.from('investors').select('id,name').order('name').limit(3000).then(({ data }) => {
      frInvestorNames = data || [];
      const dl = document.getElementById('frInvestorsList');
      if (dl) dl.innerHTML = frInvestorNames.map(i => `<option value="${escapeHtml(i.name)}">`).join('');
    });
  }
  if (frCurrentOppId && document.getElementById('frDetail').style.display !== 'none') renderFrDetail();
  else renderFrHome();
}

function frProspectsOf(oppId) { return frProspects.filter(x => x.opportunity_id === oppId); }

function frStats(oppId) {
  const rows = frProspectsOf(oppId);
  const s = { confirmed: 0, weighted: 0, total: 0, counts: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, n: rows.length };
  rows.forEach(r => {
    const c = +r.commitment || 0;
    s.counts[r.stage] = (s.counts[r.stage] || 0) + 1;
    if (r.stage === 1) s.confirmed += c;
    s.weighted += c * (FR_STAGES[r.stage]?.prob || 0);
    if (r.stage <= 4) s.total += c;
  });
  return s;
}

/* ── HOME ── */
function renderFrHome() {
  document.getElementById('frHome').style.display = '';
  document.getElementById('frDetail').style.display = 'none';
  frCurrentOppId = null;
  const act = frOpps.filter(o => o.status === 'active');
  const closed = frOpps.filter(o => o.status === 'closed');

  // KPIs globales (solo levantamientos activos)
  let conf = 0, weighted = 0, nPros = 0, overdue = 0;
  const hoy = new Date().toISOString().slice(0, 10);
  act.forEach(o => {
    const s = frStats(o.id);
    conf += s.confirmed; weighted += s.weighted;
    nPros += s.n - s.counts[5];
  });
  frProspects.forEach(r => {
    const opp = frOpps.find(o => o.id === r.opportunity_id);
    if (opp && opp.status === 'active' && r.stage >= 2 && r.stage <= 4 && r.next_step_date && r.next_step_date < hoy) overdue++;
  });
  document.getElementById('frKpis').innerHTML = `
    <div class="fr-kpi"><div class="fr-kpi-v">${frMoney(conf)}</div><div class="fr-kpi-l">Confirmado (etapa 1)</div></div>
    <div class="fr-kpi"><div class="fr-kpi-v">${frMoney(weighted)}</div><div class="fr-kpi-l">Pipeline ponderado</div></div>
    <div class="fr-kpi"><div class="fr-kpi-v">${nPros}</div><div class="fr-kpi-l">Prospectos activos</div></div>
    <div class="fr-kpi ${overdue ? 'fr-kpi-warn' : ''}"><div class="fr-kpi-v">${overdue}</div><div class="fr-kpi-l">Seguimientos vencidos</div></div>`;

  const card = (o) => {
    const s = frStats(o.id);
    const target = +o.target_amount || 0;
    const pct = target ? Math.min(100, s.confirmed / target * 100) : null;
    const dl = o.deadline ? Math.ceil((new Date(o.deadline + 'T12:00:00') - Date.now()) / 86400000) : null;
    const dlBadge = o.status === 'closed' ? '' : (dl == null ? '' :
      `<span class="fr-deadline ${dl < 0 ? 'fr-dl-over' : (dl <= 15 ? 'fr-dl-soon' : '')}">${dl < 0 ? 'venció ' + frDate(o.deadline) : dl + ' días · cierra ' + frDate(o.deadline)}</span>`);
    const chips = [1, 2, 3, 4, 5].filter(k => s.counts[k]).map(k =>
      `<span class="fr-chip ${FR_STAGES[k].cls}" title="${FR_STAGES[k].label}">${s.counts[k]}</span>`).join('');
    const closedSum = o.status === 'closed'
      ? `<div class="fr-card-closed">Levantado: <b>${frMoney((o.closing_summary || {}).confirmed ?? s.confirmed)}</b> · ${(o.closing_summary || {}).n_confirmados ?? s.counts[1]} inversionistas · cerró ${frDate((o.closed_at || '').slice(0, 10))}</div>`
      : '';
    return `
    <div class="ft-card fr-card" onclick="openFrOpp(${o.id})">
      <div class="fr-card-top">
        <span class="fr-type">${FR_TYPES[o.vehicle_type] || o.vehicle_type}</span>
        ${dlBadge}
      </div>
      <div class="ft-card-title">${escapeHtml(o.name)}</div>
      ${o.company ? `<div class="ft-card-sub">${escapeHtml(o.company)}</div>` : ''}
      ${o.status === 'active' ? `
      <div class="fr-progress"><div class="fr-progress-bar" style="width:${pct == null ? 0 : pct.toFixed(0)}%"></div></div>
      <div class="fr-card-nums"><b>${frMoney(s.confirmed)}</b>${target ? ` / ${frMoney(target)} (${pct.toFixed(0)}%)` : ' confirmado'}</div>` : closedSum}
      <div class="fr-card-chips">${chips || '<span class="fr-chip-empty">sin prospectos</span>'}</div>
    </div>`;
  };

  document.getElementById('frActiveCards').innerHTML = act.length ? act.map(card).join('') :
    '<div class="fr-empty-line">No hay levantamientos activos. Crea el primero con "+ Nueva oportunidad".</div>';
  document.getElementById('frClosedCount').textContent = closed.length;
  document.getElementById('frClosedCards').innerHTML = closed.length ? closed.map(card).join('') :
    '<div class="fr-empty-line">Todavía no hay levantamientos cerrados.</div>';
}

function frToggleClosed() {
  const el = document.getElementById('frClosedCards');
  const ch = document.getElementById('frClosedChev');
  const open = el.style.display === 'none';
  el.style.display = open ? '' : 'none';
  ch.style.transform = open ? 'rotate(180deg)' : '';
}

/* ── DETALLE ── */
function openFrOpp(id) {
  frCurrentOppId = id;
  document.getElementById('frHome').style.display = 'none';
  document.getElementById('frDetail').style.display = '';
  renderFrDetail();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function frBackHome() { renderFrHome(); }

function renderFrDetail() {
  const o = frOpps.find(x => x.id === frCurrentOppId);
  const host = document.getElementById('frDetailContent');
  if (!o || !host) return;
  const ro = o.status === 'closed';   // solo lectura
  const s = frStats(o.id);
  const target = +o.target_amount || 0;
  const pct = target ? Math.min(100, s.confirmed / target * 100) : null;
  const hoy = new Date().toISOString().slice(0, 10);
  const rows = frProspectsOf(o.id);

  const stageBlock = (k) => {
    const st = FR_STAGES[k];
    const list = rows.filter(r => r.stage === k);
    if (!list.length) return '';
    const sub = list.reduce((a, r) => a + (+r.commitment || 0), 0);
    const tr = list.map(r => {
      const late = !ro && r.stage >= 2 && r.stage <= 4 && r.next_step_date && r.next_step_date < hoy;
      return `<tr>
        <td class="fr-td-name">${escapeHtml(r.investor_name)}${r.is_lp_fund_v ? ' <span class="fr-lp" title="LP actual del Fund V">LP</span>' : ''}</td>
        <td class="n">${frMoney(r.commitment)}</td>
        <td>${escapeHtml(r.responsables || '—')}</td>
        <td class="n">${frFees(r.fees_upfront, r.fees_carry)}</td>
        <td>${frDate(r.last_contact)}</td>
        <td class="${late ? 'fr-late' : ''}" title="${escapeHtml(r.next_step || '')}">${r.next_step ? escapeHtml(r.next_step.slice(0, 34)) + (r.next_step.length > 34 ? '…' : '') : '—'}${r.next_step_date ? ' <small>(' + frDate(r.next_step_date) + ')</small>' : ''}</td>
        <td class="fr-td-notes" title="${escapeHtml(r.notes || '')}">${r.notes ? escapeHtml(r.notes.slice(0, 40)) + (r.notes.length > 40 ? '…' : '') : ''}</td>
        <td class="fr-td-act">${ro ? '' : `
          <select class="fr-stage-sel" onchange="frQuickStage(${r.id}, this.value)" onclick="event.stopPropagation()">
            ${[1, 2, 3, 4, 5].map(n => `<option value="${n}" ${n === r.stage ? 'selected' : ''}>${n} · ${FR_STAGES[n].label}</option>`).join('')}
          </select>
          <button class="fr-ico-btn" title="Editar" onclick="frOpenProspect(${r.id})"><i class="fa-solid fa-pen"></i></button>
          <button class="fr-ico-btn fr-ico-del" title="Eliminar" onclick="frDeleteProspect(${r.id})"><i class="fa-solid fa-trash"></i></button>`}
        </td></tr>`;
    }).join('');
    return `
    <div class="fr-stage-block">
      <div class="fr-stage-head ${st.cls}">
        <span class="fr-stage-num">${k}</span><b>${st.label}</b><span class="fr-stage-desc">${st.desc}</span>
        <span class="fr-stage-sub">${list.length} · ${frMoney(sub)}</span>
      </div>
      <table class="fr-table"><thead><tr>
        <th>Inversionista</th><th class="n">Commitment</th><th>Responsable</th><th class="n">Fees</th><th>Últ. contacto</th><th>Próximo paso</th><th>Notas</th><th></th>
      </tr></thead><tbody>${tr}</tbody></table>
    </div>`;
  };

  host.innerHTML = `
    <div class="fr-det-head">
      <div>
        <span class="fr-type">${FR_TYPES[o.vehicle_type] || o.vehicle_type}</span>
        ${ro ? '<span class="fr-closed-badge">LEVANTAMIENTO TERMINADO</span>' : ''}
        <div class="ft-hero-title" style="margin-top:6px">${escapeHtml(o.name)}</div>
        <div class="ft-hero-sub">${escapeHtml(o.company || '')}${o.deadline ? ' · cierra ' + frDate(o.deadline) : ''}${(o.fees_upfront != null || o.fees_carry != null) ? ' · fees LP ' + frFees(o.fees_upfront, o.fees_carry) : ''}${(o.fees_upfront_nolp != null || o.fees_carry_nolp != null) ? ' · no LP ' + frFees(o.fees_upfront_nolp, o.fees_carry_nolp) : ''}</div>
        ${o.notes ? `<div class="fr-opp-notes">${escapeHtml(o.notes)}</div>` : ''}
      </div>
      <div class="fr-det-actions">
        ${ro ? `<button class="dbx-btn" onclick="frReopenOpp()"><i class="fa-solid fa-rotate-left"></i> Reabrir</button>`
             : `<button class="dbx-btn primary" onclick="frOpenProspect()"><i class="fa-solid fa-plus"></i> Prospecto</button>
                <button class="dbx-btn" onclick="frOpenOppModal(${o.id})"><i class="fa-solid fa-pen"></i> Editar</button>
                <button class="dbx-btn" onclick="frCloseOpp()"><i class="fa-solid fa-flag-checkered"></i> Cerrar levantamiento</button>`}
        <button class="dbx-btn" onclick="frExportXlsx()"><i class="fa-solid fa-file-excel"></i> Excel</button>
        <button class="dbx-btn" onclick="frToggleLog()"><i class="fa-solid fa-clock-rotate-left"></i> Bitácora</button>
      </div>
    </div>
    <div class="fr-det-kpis">
      <div class="fr-kpi"><div class="fr-kpi-v">${frMoney(s.confirmed)}</div><div class="fr-kpi-l">Confirmado${target ? ` · ${pct.toFixed(0)}% de ${frMoney(target)}` : ''}</div>
        ${target ? `<div class="fr-progress"><div class="fr-progress-bar" style="width:${pct.toFixed(0)}%"></div></div>` : ''}</div>
      <div class="fr-kpi"><div class="fr-kpi-v">${frMoney(s.weighted)}</div><div class="fr-kpi-l">Pipeline ponderado</div></div>
      <div class="fr-kpi"><div class="fr-kpi-v">${s.n}</div><div class="fr-kpi-l">Prospectos (${s.counts[1]} confirmados)</div></div>
    </div>
    <div id="frLogPanel" class="fr-log" style="display:none"></div>
    ${[1, 2, 3, 4, 5].map(stageBlock).join('') || '<div class="fr-empty-line">Sin prospectos todavía. Agrega el primero.</div>'}`;
}

async function frQuickStage(pid, val) {
  const r = frProspects.find(x => x.id === pid);
  const stage = +val;
  if (!r || r.stage === stage) return;
  const old = r.stage;
  const { error } = await sb.from('fr_prospects').update({ stage, updated_at: new Date().toISOString() }).eq('id', pid);
  if (error) { toast('Error: ' + error.message); return; }
  r.stage = stage;
  frLog('etapa', `${r.investor_name}: ${old} → ${stage} (${FR_STAGES[stage].label})`, r.opportunity_id, pid);
  renderFrDetail();
}

/* ── modal OPORTUNIDAD ── */
function frOpenOppModal(id) {
  frEditingOppId = id || null;
  const o = id ? frOpps.find(x => x.id === id) : null;
  document.getElementById('frOppTitle').textContent = o ? 'Editar oportunidad' : 'Nueva oportunidad';
  document.getElementById('frOppName').value = o?.name || '';
  document.getElementById('frOppType').value = o?.vehicle_type || 'directo';
  document.getElementById('frOppCompany').value = o?.company || '';
  document.getElementById('frOppTarget').value = o?.target_amount || '';
  document.getElementById('frOppDeadline').value = o?.deadline || '';
  document.getElementById('frOppFeeU').value = o?.fees_upfront ?? '';
  document.getElementById('frOppFeeC').value = o?.fees_carry ?? '';
  document.getElementById('frOppFeeUN').value = o?.fees_upfront_nolp ?? '';
  document.getElementById('frOppFeeCN').value = o?.fees_carry_nolp ?? '';
  document.getElementById('frOppNotes').value = o?.notes || '';
  document.getElementById('frOppModal').classList.add('show');
  document.getElementById('frOppName').focus();
}
function frCloseOppModal() { document.getElementById('frOppModal').classList.remove('show'); }

async function frSaveOpp() {
  const name = document.getElementById('frOppName').value.trim();
  if (!name) { toast('Ponle nombre a la oportunidad'); return; }
  const num = id => { const v = document.getElementById(id).value; return v === '' ? null : +v; };
  const payload = {
    name,
    vehicle_type: document.getElementById('frOppType').value,
    company: document.getElementById('frOppCompany').value.trim() || null,
    target_amount: num('frOppTarget'),
    deadline: document.getElementById('frOppDeadline').value || null,
    fees_upfront: num('frOppFeeU'),
    fees_carry: num('frOppFeeC'),
    fees_upfront_nolp: num('frOppFeeUN'),
    fees_carry_nolp: num('frOppFeeCN'),
    notes: document.getElementById('frOppNotes').value.trim() || null,
  };
  let err;
  if (frEditingOppId) {
    ({ error: err } = await sb.from('fr_opportunities').update(payload).eq('id', frEditingOppId));
    if (!err) frLog('oportunidad editada', name, frEditingOppId, null);
  } else {
    payload.created_by = frUser();
    let data;
    ({ data, error: err } = await sb.from('fr_opportunities').insert(payload).select().single());
    if (!err) frLog('oportunidad creada', name, data.id, null);
  }
  if (err) { toast('Error: ' + err.message); return; }
  frCloseOppModal();
  await loadFr(true);
  toast(frEditingOppId ? 'Oportunidad actualizada' : 'Oportunidad creada');
}

/* ── modal PROSPECTO ── */
function frOpenProspect(pid) {
  frEditingProspectId = pid || null;
  const r = pid ? frProspects.find(x => x.id === pid) : null;
  const o = frOpps.find(x => x.id === frCurrentOppId);
  document.getElementById('frProTitle').textContent = r ? 'Editar prospecto' : 'Nuevo prospecto';
  document.getElementById('frProName').value = r?.investor_name || '';
  document.getElementById('frProStage').value = r?.stage || 3;
  document.getElementById('frProCommit').value = r?.commitment ?? '';
  document.getElementById('frProLp').checked = !!r?.is_lp_fund_v;
  frRenderRespPills(r?.responsables || '');
  const defU = (lp) => lp ? (o?.fees_upfront ?? '') : (o?.fees_upfront_nolp ?? o?.fees_upfront ?? '');
  const defC = (lp) => lp ? (o?.fees_carry ?? '') : (o?.fees_carry_nolp ?? o?.fees_carry ?? '');
  document.getElementById('frProFeeU').value = r ? (r.fees_upfront ?? '') : defU(false);
  document.getElementById('frProFeeC').value = r ? (r.fees_carry ?? '') : defC(false);
  window._frDefFees = { defU, defC };
  document.getElementById('frProLast').value = r?.last_contact || '';
  document.getElementById('frProNext').value = r?.next_step || '';
  document.getElementById('frProNextDate').value = r?.next_step_date || '';
  document.getElementById('frProNotes').value = r?.notes || '';
  document.getElementById('frProspectModal').classList.add('show');
  document.getElementById('frProName').focus();
}
function frRenderRespPills(current) {
  const wrap = document.getElementById('frProRespPills');
  if (!wrap) return;
  const sel = new Set(String(current || '').split('/').map(s => s.trim()).filter(Boolean));
  const people = Object.entries(USERS).filter(([, v]) => !v.hidden);
  // yo primero (también seleccionable), luego el resto
  people.sort(([a], [b]) => (a === currentUser ? -1 : (b === currentUser ? 1 : 0)));
  wrap.innerHTML = people.map(([uid, v]) => `
    <button type="button" class="multi-pill${sel.has(v.name) || sel.has(v.nameRaw) ? ' on' : ''}" data-name="${escapeHtml(v.nameRaw || v.name)}" onclick="toggleAssignee(this)">
      <span class="multi-pill-av">${v.initials}</span>
      <span class="multi-pill-name">${escapeHtml(v.name)}${uid === currentUser ? ' (yo)' : ''}</span>
    </button>`).join('');
}

function frSelectedResp() {
  return [...document.querySelectorAll('#frProRespPills .multi-pill.on')]
    .map(b => b.dataset.name).join(' / ');
}

function frLpToggleFees(cb) {
  // En alta nueva, si el usuario no ha personalizado los fees, cambia a los defaults del grupo (LP / no LP)
  if (frEditingProspectId || !window._frDefFees) return;
  document.getElementById('frProFeeU').value = window._frDefFees.defU(cb.checked);
  document.getElementById('frProFeeC').value = window._frDefFees.defC(cb.checked);
}

function frCloseProspectModal() { document.getElementById('frProspectModal').classList.remove('show'); }

async function frSaveProspect() {
  const name = document.getElementById('frProName').value.trim();
  if (!name) { toast('Falta el nombre del inversionista'); return; }
  const num = id => { const v = document.getElementById(id).value; return v === '' ? null : +v; };
  const match = frInvestorNames.find(i => i.name.toLowerCase() === name.toLowerCase());
  const payload = {
    investor_name: name,
    investor_id: match ? match.id : null,
    stage: +document.getElementById('frProStage').value,
    commitment: num('frProCommit'),
    is_lp_fund_v: document.getElementById('frProLp').checked,
    responsables: frSelectedResp() || null,
    fees_upfront: num('frProFeeU'),
    fees_carry: num('frProFeeC'),
    last_contact: document.getElementById('frProLast').value || null,
    next_step: document.getElementById('frProNext').value.trim() || null,
    next_step_date: document.getElementById('frProNextDate').value || null,
    notes: document.getElementById('frProNotes').value.trim() || null,
    updated_at: new Date().toISOString(),
  };
  let err;
  if (frEditingProspectId) {
    ({ error: err } = await sb.from('fr_prospects').update(payload).eq('id', frEditingProspectId));
    if (!err) frLog('prospecto editado', `${name} (${frMoney(payload.commitment)}, etapa ${payload.stage})`, frCurrentOppId, frEditingProspectId);
  } else {
    payload.opportunity_id = frCurrentOppId;
    payload.created_by = frUser();
    let data;
    ({ data, error: err } = await sb.from('fr_prospects').insert(payload).select().single());
    if (!err) frLog('prospecto creado', `${name} (${frMoney(payload.commitment)}, etapa ${payload.stage})`, frCurrentOppId, data.id);
  }
  if (err) { toast('Error: ' + err.message); return; }
  frCloseProspectModal();
  await loadFr(true);
  toast('Guardado');
}

async function frDeleteProspect(pid) {
  const r = frProspects.find(x => x.id === pid);
  if (!r) return;
  const ok = await showConfirm('¿Eliminar prospecto?', `${r.investor_name} (${frMoney(r.commitment)}) se eliminará de esta oportunidad. Quedará registrado en la bitácora.`);
  if (!ok) return;
  const { error } = await sb.from('fr_prospects').delete().eq('id', pid);
  if (error) { toast('Error: ' + error.message); return; }
  frLog('prospecto eliminado', `${r.investor_name} (${frMoney(r.commitment)}, etapa ${r.stage})`, frCurrentOppId, pid);
  await loadFr(true);
  toast('Prospecto eliminado');
}

/* ── cerrar / reabrir ── */
async function frCloseOpp() {
  const o = frOpps.find(x => x.id === frCurrentOppId);
  const s = frStats(o.id);
  const ok = await showConfirm('¿Cerrar levantamiento?',
    `${o.name} se congelará con ${frMoney(s.confirmed)} confirmados de ${s.counts[1]} inversionistas y pasará a "Levantamiento terminado". Podrás reabrirlo si hace falta.`);
  if (!ok) return;
  const summary = { confirmed: s.confirmed, weighted: Math.round(s.weighted), n_confirmados: s.counts[1], counts: s.counts, total_prospects: s.n };
  const { error } = await sb.from('fr_opportunities').update({ status: 'closed', closed_at: new Date().toISOString(), closing_summary: summary }).eq('id', o.id);
  if (error) { toast('Error: ' + error.message); return; }
  frLog('levantamiento cerrado', `${o.name}: ${frMoney(s.confirmed)} de ${s.counts[1]} inversionistas`, o.id, null);
  await loadFr(true);
  toast('Levantamiento cerrado');
}

async function frReopenOpp() {
  const o = frOpps.find(x => x.id === frCurrentOppId);
  const ok = await showConfirm('¿Reabrir levantamiento?', `${o.name} volverá a "En levantamiento" y se podrá editar de nuevo.`);
  if (!ok) return;
  const { error } = await sb.from('fr_opportunities').update({ status: 'active', closed_at: null }).eq('id', o.id);
  if (error) { toast('Error: ' + error.message); return; }
  frLog('levantamiento reabierto', o.name, o.id, null);
  await loadFr(true);
}

/* ── bitácora ── */
async function frToggleLog() {
  const panel = document.getElementById('frLogPanel');
  if (panel.style.display !== 'none') { panel.style.display = 'none'; return; }
  panel.style.display = '';
  panel.innerHTML = '<div class="fr-empty-line">Cargando bitácora…</div>';
  const { data, error } = await sb.from('fr_log').select('*').eq('opportunity_id', frCurrentOppId).order('ts', { ascending: false }).limit(100);
  if (error) { panel.innerHTML = '<div class="fr-empty-line">Error al cargar.</div>'; return; }
  panel.innerHTML = (data && data.length) ? data.map(l => `
    <div class="fr-log-row">
      <span class="fr-log-ts">${new Date(l.ts).toLocaleString('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
      <b>${escapeHtml(l.usuario || '')}</b> · ${escapeHtml(l.action)}${l.detail ? ': ' + escapeHtml(l.detail) : ''}
    </div>`).join('') : '<div class="fr-empty-line">Sin movimientos registrados.</div>';
}

/* ── export Excel ── */
async function frExportXlsx() {
  const o = frOpps.find(x => x.id === frCurrentOppId);
  const rows = frProspectsOf(o.id).slice().sort((a, b) => a.stage - b.stage || (+b.commitment || 0) - (+a.commitment || 0));
  toast('Generando Excel…');
  await loadScript('https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'MVP Manager';
  const ORANGE = 'FFE8650D', INK = 'FF1A1F2E', GRAY = 'FF8A93A6', CARD = 'FFF7F9FC', BORDER = 'FFDDE3EC', WHITE = 'FFFFFFFF';
  const STAGE_FILL = { 1: 'FFDDF0E4', 2: 'FFFBF0D3', 3: 'FFDCE8F8', 4: 'FFFBE3D0', 5: 'FFF6DBD8' };
  const thin = { style: 'thin', color: { argb: BORDER } };
  const border = { top: thin, left: thin, bottom: thin, right: thin };
  const ws = wb.addWorksheet('Fund Rising', { views: [{ showGridLines: false }] });
  const s = frStats(o.id);

  ws.mergeCells('A1:J1');
  ws.getCell('A1').value = o.name;
  ws.getCell('A1').font = { size: 20, bold: true, color: { argb: ORANGE } };
  ws.getRow(1).height = 28;
  ws.mergeCells('A2:J2');
  const meta = [FR_TYPES[o.vehicle_type] || o.vehicle_type];
  if (o.company) meta.push(o.company);
  if (o.deadline) meta.push('cierra ' + frDate(o.deadline));
  meta.push('generado ' + new Date().toLocaleDateString('es-MX'));
  ws.getCell('A2').value = meta.join('   ·   ');
  ws.getCell('A2').font = { size: 10, color: { argb: GRAY } };

  const kpis = [
    ['CONFIRMADO (ETAPA 1)', s.confirmed, '"$"#,##0'],
    ['PIPELINE PONDERADO', Math.round(s.weighted), '"$"#,##0'],
    ['META', +o.target_amount || null, '"$"#,##0'],
    ['PROSPECTOS', s.n, '#,##0'],
  ];
  kpis.forEach((k, i) => {
    const col = 1 + i * 2;
    ws.mergeCells(4, col, 4, col + 1); ws.mergeCells(5, col, 5, col + 1);
    const lc = ws.getCell(4, col); lc.value = k[0];
    lc.font = { size: 7.5, bold: true, color: { argb: GRAY } };
    lc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CARD } };
    const vc = ws.getCell(5, col); vc.value = k[1] ?? '—';
    if (typeof k[1] === 'number') vc.numFmt = k[2];
    vc.font = { size: 13, bold: true, color: { argb: i === 0 ? ORANGE : INK } };
    vc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CARD } };
  });

  const HEAD = ['Etapa', 'Inversionista', 'Commitment USD', 'LP Fund V', 'Responsable(s)', 'Fee %', 'Carry %', 'Últ. contacto', 'Próximo paso', 'Notas'];
  const WIDTHS = [14, 32, 16, 10, 30, 8, 8, 13, 30, 40];
  let r = 7;
  for (let st = 1; st <= 5; st++) {
    const list = rows.filter(x => x.stage === st);
    if (!list.length) continue;
    const sub = list.reduce((a, x) => a + (+x.commitment || 0), 0);
    ws.mergeCells(r, 1, r, 8);
    const hc = ws.getCell(r, 1);
    hc.value = `${st} · ${FR_STAGES[st].label} — ${FR_STAGES[st].desc}`;
    hc.font = { bold: true, size: 11, color: { argb: INK } };
    hc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: STAGE_FILL[st] } };
    ws.mergeCells(r, 9, r, 10);
    const sc = ws.getCell(r, 9);
    sc.value = `${list.length} · $${Math.round(sub).toLocaleString('en-US')}`;
    sc.font = { bold: true, size: 11, color: { argb: INK } };
    sc.alignment = { horizontal: 'right' };
    sc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: STAGE_FILL[st] } };
    ws.getRow(r).height = 20;
    r++;
    HEAD.forEach((h, i) => {
      const c = ws.getCell(r, i + 1);
      c.value = h;
      c.font = { size: 8, bold: true, color: { argb: WHITE } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3F3A36' } };
      c.border = border;
    });
    r++;
    list.forEach((x, idx) => {
      const vals = [x.stage, x.investor_name, +x.commitment || null, x.is_lp_fund_v == null ? '' : (x.is_lp_fund_v ? 'LP' : 'NO'),
                    x.responsables || '', x.fees_upfront ?? '', x.fees_carry ?? '', x.last_contact ? frDate(x.last_contact) : '',
                    (x.next_step || '') + (x.next_step_date ? ` (${frDate(x.next_step_date)})` : ''), x.notes || ''];
      vals.forEach((v, i) => {
        const c = ws.getCell(r, i + 1);
        c.value = v;
        if (i === 2 && v != null) c.numFmt = '"$"#,##0';
        c.font = { size: 10, color: { argb: INK } };
        c.border = border;
        if (idx % 2) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4F7FC' } };
      });
      ws.getCell(r, 2).font = { size: 10, bold: true, color: { argb: INK } };
      r++;
    });
    r++;  // renglón de aire entre etapas
  }
  WIDTHS.forEach((w, i) => { ws.getColumn(i + 1).width = w; });

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `FundRising_${o.name.replace(/[^a-zA-Z0-9]+/g, '_')}.xlsx`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ── Orquestador del botón ──
async function exportSpacexReport() {
  const d = lastInvestorDetail;
  if (!d || !d.inv) return toast('Abre primero el detalle del inversionista');
  const lang = await pickExportLang();
  if (!lang) return;
  const EN = lang === 'en';
  try {
    toast(EN ? 'Generating SpaceX Report…' : 'Generando Reporte SpaceX…');
    const live = await spxrLivePrice();
    const D = spxrBuildData(d, live);
    if (!D) return toast('Este inversionista no tiene posiciones directas de SpaceX');
    const html = spxrHtml(D, EN);
    const anexo3 = {
      items: D.act.map(a => ({
        cuenta: (D.combined && a.acct) ? a.acct : D.inv.name,
        serie: a.short,
        url: a.carta || null,
      })),
    };
    const slugBase = (D.combined && D.inv._accounts && D.inv._accounts.length <= 3) ? D.inv._accounts.map(a => a.name).join('_') : D.inv.name;
    const slug = String(slugBase).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    await spxrRenderPdf(html, `${EN ? 'SpaceX_Report' : 'Reporte_SpaceX'}_${slug}.pdf`, anexo3, EN);
    toast(EN ? 'SpaceX Report downloaded' : 'Reporte SpaceX descargado');
  } catch (e) {
    console.error('[spacex-report]', e);
    toast('No se pudo generar el reporte: ' + (e.message || e));
  }
}

/* ═══════════════════════════════════════════
   INSTALAR COMO APP (PWA / pantalla de inicio)
   — beforeinstallprompt se captura temprano en index.html (window.__deferredInstall).
   — En iOS no hay API: mostramos una guía con los pasos de Safari.
═══════════════════════════════════════════ */
function isStandalone() {
  return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
}
function isIOS() { return /iphone|ipad|ipod/i.test(navigator.userAgent); }

async function installApp() {
  if (isStandalone()) { toast(t('La app ya está instalada')); return; }
  const dp = window.__deferredInstall;
  if (dp) {                              // Android / Chrome / escritorio: instalador nativo real
    try { dp.prompt(); await dp.userChoice; } catch (e) {}
    window.__deferredInstall = null;
    return;
  }
  showInstallHelp();                     // iOS Safari (y navegadores sin API): guía manual
}

function showInstallHelp() {
  const ios = isIOS();
  const steps = ios
    ? [t('Abre esta página en Safari (no en Chrome).'),
       t('Toca el botón Compartir de Safari.'),
       t('Elige "Agregar a inicio".'),
       t('Confirma con "Agregar".')]
    : [t('Abre el menú de tu navegador.'),
       t('Elige "Instalar app" o "Agregar a pantalla de inicio".')];
  const ol = steps.map(s => `<li style="margin:0 0 10px;line-height:1.5">${s}</li>`).join('');
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(10,15,25,.55);display:flex;align-items:center;justify-content:center;padding:20px';
  wrap.onclick = (e) => { if (e.target === wrap) wrap.remove(); };
  wrap.innerHTML = `<div style="background:var(--white);color:var(--gray-900);max-width:360px;width:100%;border-radius:16px;padding:24px;box-shadow:0 20px 60px rgba(0,0,0,.4);font-family:var(--font)">
    <div style="font-size:17px;font-weight:600;margin-bottom:14px">${t('Instalar Cretum Desk')}</div>
    <ol style="padding-left:20px;margin:0 0 18px;font-size:14px;color:var(--gray-700)">${ol}</ol>
    <button style="width:100%;padding:11px;border:0;border-radius:10px;background:var(--navy);color:#fff;font-size:14px;font-weight:500;cursor:pointer;font-family:var(--font)">${t('Entendido')}</button>
  </div>`;
  wrap.querySelector('button').onclick = () => wrap.remove();
  document.body.appendChild(wrap);
}
