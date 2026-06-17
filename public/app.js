/* ═══════════════════════════════════════════
   STATE
═══════════════════════════════════════════ */
let sb = null;                   // Supabase JS client
let currentUser = null;          // UUID de auth.users
let currentProfile = null;       // { full_name, initials, role }
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
    // Asegurar que el editor de nombre vuelva a estado cerrado al abrir el menú
    cancelEditName();
  }
  pop.classList.toggle('show');
  btn?.classList.toggle('open');
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
  if (view === 'portal') loadPortalAdmin();

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
const dbInvestorCompanies = {};  // investor_id → Set<company_id>
const dbInvestorSeries = {};     // investor_id → Set<series_id>

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
  if (nn.includes(qn)) return true;                 // substring siempre coincide
  if (qn.length < 4) return false;                  // queries cortas: solo substring
  const th = threshold != null ? threshold : 0.7;
  if (repSim(qn, nn) >= th) return true;            // nombre completo parecido
  return nn.split(' ').some(tok =>                  // o una palabra parecida (longitud similar)
    Math.abs(tok.length - qn.length) <= 3 && repSim(qn, tok) >= th);
}

/* ═══════════════════════════════════════════════════════════════════════
   PORTAL DE CLIENTES (admin) — gestiona dashboards externos y usuarios
   Todo vía /api/portal (service role server-side). Solo admin llega aquí.
   ═══════════════════════════════════════════════════════════════════════ */
let ptDashboards = [], ptUsers = [], ptAccess = [];

async function portalApi(body) {
  const r = await authedFetch('/api/portal', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
  return d;
}

async function loadPortalAdmin() {
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
  el.innerHTML = ptDashboards.map(d => `<div class="pt-item">
    <div class="nm">${escapeHtml(d.title)}</div>
    <div class="sub">/portal · ${escapeHtml(d.slug)}</div>
    <div class="acts">
      <button class="cdd-btn" onclick="ptDashOpen(${d.id})"><i class="fa-solid fa-pen"></i> Editar</button>
      <button class="cdd-btn camp-btn-danger" onclick="ptDashDelete(${d.id})"><i class="fa-solid fa-trash"></i></button>
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
  document.getElementById('ptDashModal').classList.add('show');
  if (d) {  // trae el HTML actual para editar
    document.getElementById('ptDashHtml').value = 'Cargando…';
    portalApi({ action: 'get_dashboard', id: d.id })
      .then(full => { document.getElementById('ptDashHtml').value = full.html || ''; })
      .catch(() => { document.getElementById('ptDashHtml').value = ''; });
  }
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
      sbFetchAll('investors', 'id, name'),
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

function populateFilters() {
  const buildPanel = (panelId, allLabel, items, ph) => {
    const panel = document.getElementById(panelId);
    if (!panel) return;
    panel.innerHTML =
      `<div class="cdd-search"><i class="fa-solid fa-magnifying-glass"></i>` +
      `<input type="text" placeholder="${ph}" autocomplete="off" oninput="cddFilterOpts('${panelId}', this.value)"></div>` +
      `<div class="cdd-opt selected" data-value="">${allLabel}</div>` +
      items.map(it => `<div class="cdd-opt" data-value="${it.id}">${escapeHtml(it.name)}</div>`).join('') +
      `<div class="cdd-noopt" data-noopt style="display:none">Sin coincidencias</div>`;
  };
  buildPanel('ddCompanyPanel', 'Todas las empresas',
    [...dbCompanies].sort((a, b) => a.name.localeCompare(b.name)), 'Buscar empresa…');
  buildPanel('ddSeriesPanel', 'Todas las series', dbSeries, 'Buscar serie…');
}

// Filtra (difuso) las opciones visibles de un panel de desplegable
function cddFilterOpts(panelId, q) {
  const panel = document.getElementById(panelId);
  if (!panel) return;
  let visibles = 0;
  panel.querySelectorAll('.cdd-opt').forEach(opt => {
    if (!opt.dataset.value) { opt.style.display = ''; return; }  // "Todas…" siempre
    const ok = fuzzyMatch(q, opt.textContent);
    opt.style.display = ok ? '' : 'none';
    if (ok) visibles++;
  });
  const noopt = panel.querySelector('[data-noopt]');
  if (noopt) noopt.style.display = (q && !visibles) ? '' : 'none';
}

// Delegación: click en una opción o fuera del dropdown
document.addEventListener('click', (e) => {
  const opt = e.target.closest('.cdd-opt');
  if (opt) {
    const cdd = opt.closest('.cdd');
    if (cdd) cddPick(cdd.id, opt.dataset.value || '', opt.textContent.trim());
    return;
  }
  if (!e.target.closest('.cdd')) {
    document.querySelectorAll('.cdd.open').forEach(el => el.classList.remove('open'));
  }
});

function clearFilters() {
  document.getElementById('dbSearch').value = '';
  cddPick('ddCompany', '', 'Todas las empresas');
  cddPick('ddSeries', '', 'Todas las series');
  renderDbList();
}

function investorSeriesLabel(invId, filterSeriesId) {
  const ids = [...(dbInvestorSeries[invId] || [])];
  if (!ids.length) return '—';
  if (filterSeriesId) {
    const s = dbSeries.find(x => x.id === +filterSeriesId);
    return s ? s.name : '—';
  }
  const names = ids.map(id => dbSeries.find(s => s.id === id)?.name).filter(Boolean);
  if (names.length <= 2) return names.join(', ');
  return `${names[0]}, ${names[1]} +${names.length - 2}`;
}

function investorCompanyLabel(invId, filterCompanyId) {
  const ids = [...(dbInvestorCompanies[invId] || [])];
  if (!ids.length) return '—';
  if (filterCompanyId) {
    const c = dbCompanies.find(x => x.id === +filterCompanyId);
    return c ? c.name : '—';
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
    companyId: document.getElementById('ddCompany')?.dataset.value || '',
    seriesId: document.getElementById('ddSeries')?.dataset.value || '',
  };
}

function getFilteredInvestors() {
  const { q, companyId, seriesId } = getDbFilters();
  let filtered = dbInvestors;
  if (q) filtered = filtered.filter(r => fuzzyMatch(q, r.name));
  if (companyId) filtered = filtered.filter(r => dbInvestorCompanies[r.id]?.has(+companyId));
  if (seriesId)  filtered = filtered.filter(r => dbInvestorSeries[r.id]?.has(+seriesId));
  return filtered;
}

function renderDbList() {
  const { q, companyId, seriesId } = getDbFilters();
  const list = document.getElementById('dbList');
  list.style.display = '';
  document.getElementById('dbDetail').classList.remove('show');

  const anyFilter = !!(q || companyId || seriesId);
  document.getElementById('dbClear').style.display = anyFilter ? '' : 'none';

  const filtered = getFilteredInvestors();
  document.getElementById('dbCount').textContent = filtered.length + (filtered.length === 1 ? ' resultado' : ' resultados');

  if (!filtered.length) {
    list.innerHTML = '<div class="db-list-wrap"><div class="db-list-empty">Sin resultados</div></div>';
    return;
  }

  // Headers de la tabla
  const headers = ['<th class="col-name">Nombre</th>'];
  if (isColVisible('series'))    headers.push('<th>Serie</th>');
  if (isColVisible('company'))   headers.push('<th>Empresa</th>');
  if (isColVisible('positions')) headers.push('<th class="num">Posiciones</th>');
  if (isColVisible('actual'))    headers.push('<th class="num">Compromiso ejecutado</th>');
  if (isColVisible('amount'))    headers.push('<th class="num">Compromiso</th>');
  headers.push('<th class="col-arrow"></th>');

  // Filas
  const rows = filtered.map(i => {
    const cells = [`<td class="col-name">${escapeHtml(i.name)}</td>`];
    if (isColVisible('series')) {
      const lbl = investorSeriesLabel(i.id, seriesId);
      cells.push(`<td>${lbl === '—' ? '<span class="db-cell-empty">—</span>' : `<span class="db-cell-pill">${escapeHtml(lbl)}</span>`}</td>`);
    }
    if (isColVisible('company')) {
      const lbl = investorCompanyLabel(i.id, companyId);
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
  const { companyId, seriesId } = getDbFilters();
  const cols = [{ key: 'name', label: 'Nombre', type: 'text' }];
  if (isColVisible('series'))    cols.push({ key: 'series',    label: 'Serie',                type: 'text'  });
  if (isColVisible('company'))   cols.push({ key: 'company',   label: 'Empresa',              type: 'text'  });
  if (isColVisible('positions')) cols.push({ key: 'positions', label: 'Posiciones',           type: 'num'   });
  if (isColVisible('actual'))    cols.push({ key: 'actual',    label: 'Compromiso ejecutado', type: 'money' });
  if (isColVisible('amount'))    cols.push({ key: 'amount',    label: 'Compromiso',           type: 'money' });

  const rows = getFilteredInvestors().map(i => cols.map(c => {
    switch (c.key) {
      case 'name':      return i.name;
      case 'series':    return investorSeriesLabel(i.id, seriesId);
      case 'company':   return investorCompanyLabel(i.id, companyId);
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

async function openInvestor(id) {
  const inv = dbInvestors.find(x => x.id === id);
  if (!inv) return;
  showDetailLoading();
  try {
    const [{ data: contacts }, { data: positions }] = await Promise.all([
      sb.from('contacts').select('name, email').eq('investor_id', id).order('id'),
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
  document.getElementById('dbDetailContent').innerHTML = '<div class="db-loading"><i class="fa-solid fa-spinner fa-spin"></i> Cargando…</div>';
}

function closeDetail() {
  document.getElementById('dbDetail').classList.remove('show');
  document.getElementById('dbList').style.display = '';
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

function renderPositionsBlock(title, rows) {
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
  const headers = visible.map(c => `<th class="${numericKeys.has(c.key) ? 'num' : ''}">${escapeHtml(c.label)}</th>`).join('');
  const body = rows.map(p => `<tr>${visible.map(c => cellFor(p, c.key)).join('')}</tr>`).join('');

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

function renderInvestorDetail(inv, contacts, positions) {
  lastInvestorDetail = { inv, contacts, positions };
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
  const html = `
    <div class="db-detail-head">
      <div class="db-detail-name">${escapeHtml(inv.name)}</div>
      <div class="db-detail-sub">Inversionista</div>
      <div class="db-detail-stats">
        <div class="db-stat"><div class="db-stat-l">Posiciones</div><div class="db-stat-v">${inv.positions}</div></div>
        <div class="db-stat"><div class="db-stat-l">Commitment total</div><div class="db-stat-v">${fmtMoney(inv.commitment)}</div></div>
        <div class="db-stat"><div class="db-stat-l">Commitment actual</div><div class="db-stat-v">${fmtMoney(inv.actual)}</div></div>
      </div>
    </div>

    ${contacts.length ? `
      <div class="db-section">
        <div class="db-section-h">Contactos</div>
        ${contacts.map(c => `
          <div class="db-contact">
            <div class="db-contact-av">${(c.name || '?').slice(0,2).toUpperCase()}</div>
            <div class="db-contact-name">${escapeHtml(c.name)}</div>
            <div class="db-contact-mail">${escapeHtml(c.email || '')}</div>
          </div>`).join('')}
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

    ${renderPositionsBlock('Posiciones activas', activePositions)}
    ${renderPositionsBlock('Posiciones terminadas', terminatedPositions)}

    ${renderDistrosBlock('Distribuciones · Oportunidades en directo (SPVs)', distrosSpv)}
    ${renderDistrosBlock('Distribuciones · Fondos MVP', distrosFund)}`;
  document.getElementById('dbDetailContent').innerHTML = html;
  renderPosColumnPicker();   // pobla el panel después de que el DOM existe
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
    overallTotal2:    { label: 'Total — Overall (Commitment)', invested: 154000000, mtm: 196438047, moic: 1.2756 }
  },
  fundV: {
    id: 'fundV',
    name: 'MVP All-Star Fund V',
    subtitle: 'Valuation Overview',
    cutoff: '2026-06-30',
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
      { company: 'Decart.AI, Inc.',        invested: 25749946, pct: 0.170, mtm: 25749946,   moic: 1.0000,  corpVal: 3.916,  pps: 197.78, entry: 197.78, shares: 130197,    fdso: 19.8   },
      { company: 'Saronic Technologies',   invested: 20000000, pct: 0.132, mtm: 20000000,   moic: 1.0000,  corpVal: 9.249,  pps: 27.45,  entry: 27.45,  shares: 728730,    fdso: 337    },
      { company: 'Anthropic PBC',          invested: 18587304, pct: 0.123, mtm: 62330216,   moic: 3.3534,  corpVal: 965,    pps: 589.01, entry: 175.65, shares: 105822,    fdso: 1638.34},
      { company: 'X.AI Corp. (SpaceX)',    invested: 15000870, pct: 0.099, mtm: 53228475,   moic: 3.5484,  corpVal: 1770,   pps: 135,    entry: 38.05,  shares: 394285,    fdso: 11869  },
      { company: 'CHAOS Industries',       invested: 9999962,  pct: 0.066, mtm: 9999962,    moic: 1.0000,  corpVal: 4.446,  pps: 138.94, entry: 138.94, shares: 71975,     fdso: 32     },
      { company: 'Base Power, Inc.',       invested: 9280871,  pct: 0.061, mtm: 9280871,    moic: 1.0000,  corpVal: 4.111,  pps: 120.92, entry: 120.92, shares: 76751,     fdso: 34     },
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
    activeTotal:      { invested: 145202039, mtm: 263154825, moic: 1.8123 },
    pendingTitle: 'Pending Positions (Q2 2026)',
    pending: [],
    pendingTotal:     { invested: 0, mtm: 0, moic: 0 },
    distributed: [
      { company: 'Groq, Inc. (Distributed)', invested: 5480542, pct: 0.036, mtm: 16470384, moic: 3.0052, corpVal: 14.2,   pps: 68.7, entry: 22.86, shares: 239744, fdso: 206.7 },
      { company: 'Klarna Holding AB',        invested: 436638,  pct: 0.003, mtm: 266292,   moic: 0.6099, corpVal: 5.435,  pps: 13,   entry: 21.32, shares: 20484,  fdso: 418.1 }
    ],
    overallLabel:     'Total — Overall (Invested)',
    overallTotal:     { invested: 151119219, mtm: 279891501, moic: 1.8521 },
    overallTotal2:    { label: 'Total — Overall (Commitment)', invested: 293000000, mtm: 421772282, moic: 1.4395 }
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

function applySpacexLiveToTrackers() {
  if (!_spcxLive) return;
  for (const f of [FUND_TRACKERS.fundIV, FUND_TRACKERS.fundV]) {
    if (!f || f.placeholder || !f.active) continue;
    let delta = 0;
    for (const row of f.active) {
      if (!SPCX_ROW_RE.test(row.company) || !row.shares) continue;
      const newMtm = Math.round(row.shares * _spcxLive.pps);
      delta += newMtm - row.mtm;
      row.pps = _spcxLive.pps;
      if (_spcxLive.evB) row.corpVal = _spcxLive.evB;
      row.mtm = newMtm;
      if (row.invested) row.moic = newMtm / row.invested;
    }
    if (!delta) continue;
    for (const t of [f.activeTotal, f.overallTotal, f.overallTotal2]) {
      if (!t || t.mtm == null) continue;
      t.mtm += delta;
      if (t.invested) t.moic = t.mtm / t.invested;
    }
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

  host.innerHTML = `
    <div class="ft-header">
      <div class="ft-header-top">
        <div>
          <div class="ft-name">${escapeHtml(f.name)} — ${escapeHtml(f.subtitle)}</div>
          <div class="ft-sub">${escapeHtml(f.status)} · ${escapeHtml(f.confidentiality)} · Cutoff ${escapeHtml(cutoffPretty)}${f._spcxLiveNote ? ' · ' + escapeHtml(f._spcxLiveNote) : ''}</div>
        </div>
        <button class="ft-export-btn" onclick="exportFundTrackerExcel('${f.id}', this)">
          <i class="fa-solid fa-file-excel"></i> Descargar Excel
        </button>
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
}

async function loadCampaigns() {
  const isAdmin = currentProfile?.role === 'admin';
  // La pestaña Gestión solo existe para admin
  const gTab = document.querySelector('#pageCampaigns .camp-tab-admin');
  if (gTab) gTab.style.display = isAdmin ? '' : 'none';
  // Pestaña por defecto la primera vez
  if (!campTab) campSetTab('ranking');
  else if (campTab === 'gestion' && !isAdmin) campSetTab('ranking');

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

  // Filtro de búsqueda
  const q = (document.getElementById('campSearch')?.value || '').trim().toLowerCase();
  let contacts = campContacts.slice().sort((a, b) =>
    (a.nombre_completo || a.email).localeCompare(b.nombre_completo || b.email, 'es'));
  if (q) contacts = contacts.filter(c =>
    fuzzyMatch(q, c.nombre_completo || '') ||
    (c.email || '').toLowerCase().includes(q) ||   // email: literal (la similitud no aplica bien)
    fuzzyMatch(q, c.responsable || ''));

  document.getElementById('campCount').textContent =
    `${contacts.length} LP${contacts.length === 1 ? '' : 's'} · ${periods.length} mes${periods.length === 1 ? '' : 'es'}`;

  if (!campContacts.length) {
    matrix.innerHTML = `<div class="camp-empty">
      <i class="fa-solid fa-inbox"></i>
      <p>Aún no hay LPs cargados. Pídeme la carga inicial del histórico, o sube tu primer CSV de Yesware arriba.</p>
    </div>`;
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
