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

// Boot: init Supabase y revisa si hay sesión activa
window.addEventListener('DOMContentLoaded', async () => {
  try {
    await initSupabase();
    const { data } = await sb.auth.getSession();
    if (data?.session?.user) {
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
      iconClass: 'home-ico-reports' },
    { view: 'reports', icon: 'fa-chart-pie', title: 'Reportes',
      desc: 'Reportes personalizados por LP — Altareturn + Salesforce',
      iconClass: 'home-ico-reports', disabled: true },
  ],
  mvp: [
    { view: 'db', icon: 'fa-database', title: 'Base de Datos',
      desc: 'Datos del proyecto MVP',
      iconClass: 'home-ico-mvp' },
    { view: 'fundTrackers', icon: 'fa-chart-column', title: 'MVP Fund Trackers',
      desc: 'Valuación de fondos por empresa subyacente',
      iconClass: 'home-ico-trackers' },
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
  ],
  mvp: [
    { view: 'home',         icon: 'fa-house',         label: 'Inicio' },
    { view: 'db',           icon: 'fa-database',      label: 'Base de Datos' },
    { view: 'fundTrackers', icon: 'fa-chart-column',  label: 'Fund Trackers' },
  ],
};

const ORG_SOON = {
  cretum: [
    { icon: 'fa-solid fa-calendar-days', label: 'Calendario' },
  ],
  mvp: [
    { icon: 'fa-solid fa-chart-pie',     label: 'Reportes' },
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
  const mods = (ORG_MODULES[currentOrg] || []).filter(m => !m.adminOnly || isAdmin);
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
  const items = (currentOrg ? ORG_NAV[currentOrg] : []).filter(it => !it.adminOnly || isAdmin);
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

/* "Regresar a Menú" desde header: sub-vista → home; home → selector (cambiar empresa). */
function headerBackToMenu() {
  if (currentView === 'home') {
    switchView('selector');
  } else if (currentView !== 'selector') {
    switchView('home');
  }
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

async function loadDb() {
  const list = document.getElementById('dbList');
  list.innerHTML = '<div class="db-loading"><i class="fa-solid fa-spinner fa-spin"></i> Cargando datos…</div>';
  try {
    // Inversionistas + agregados
    const [{ data: investors, error: e1 },
           { data: investments, error: e2 },
           { data: companies, error: e3 },
           { data: series, error: e4 }] = await Promise.all([
      sb.from('investors').select('id, name'),
      sb.from('investments').select('investor_id, company_id, series_id, commitment, commitment_actual'),
      sb.from('companies').select('id, name, is_public'),
      sb.from('series').select('id, name'),
    ]);
    if (e1) throw e1; if (e2) throw e2; if (e3) throw e3; if (e4) throw e4;

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
  const buildPanel = (panelId, allLabel, items) => {
    const panel = document.getElementById(panelId);
    if (!panel) return;
    panel.innerHTML = `<div class="cdd-opt selected" data-value="">${allLabel}</div>` +
      items.map(it => `<div class="cdd-opt" data-value="${it.id}">${escapeHtml(it.name)}</div>`).join('');
  };
  buildPanel('ddCompanyPanel', 'Todas las empresas',
    [...dbCompanies].sort((a, b) => a.name.localeCompare(b.name)));
  buildPanel('ddSeriesPanel', 'Todas las series', dbSeries);
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
  if (q) filtered = filtered.filter(r => r.name.toLowerCase().includes(q));
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
                 start_date, end_date, duration_years, distributed_at,
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
    overallTotal:     { invested: 128568084, mtm: 196438047, moic: 1.5279 }
  },
  fundV: {
    id: 'fundV',
    name: 'MVP All-Star Fund V',
    subtitle: 'En desarrollo',
    placeholder: true
  }
};

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
           <span><strong>${f.distributed.length}</strong> distribuidas</span>
           <span class="${moicClass(f.overallTotal.moic)}"><strong>${f.overallTotal.moic.toFixed(2)}x</strong> MOIC overall</span>
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
  const overallRow = renderTotalRow('Total — Overall', f.overallTotal);

  host.innerHTML = `
    <div class="ft-header">
      <div class="ft-name">${escapeHtml(f.name)} — ${escapeHtml(f.subtitle)}</div>
      <div class="ft-sub">${escapeHtml(f.status)} · ${escapeHtml(f.confidentiality)} · Cutoff ${escapeHtml(cutoffPretty)}</div>
      <div class="ft-stats">
        <div>
          <div class="ft-stat-l">Invested (overall)</div>
          <div class="ft-stat-v">${fmtTrackerCell(f.overallTotal.invested, 'money')}</div>
        </div>
        <div>
          <div class="ft-stat-l">MTM Valuation</div>
          <div class="ft-stat-v">${fmtTrackerCell(f.overallTotal.mtm, 'money')}</div>
        </div>
        <div>
          <div class="ft-stat-l">MOIC overall</div>
          <div class="ft-stat-v ${moicClass(f.overallTotal.moic)}">${fmtTrackerCell(f.overallTotal.moic, 'moic')}</div>
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

window.openFundTracker = openFundTracker;
window.closeFundTracker = closeFundTracker;

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
  return out;
}

/* ── Carga de datos ── */
let campTab = null;
let campLatestPeriodo = null;   // último mes con datos (para "Último visto")

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
    const sel = document.getElementById('campMonth');
    if (sel && !sel.value) sel.value = new Date().toISOString().slice(0, 7);
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
    return `<div class="camp-rank-row${topCls}">
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
    const { data, error } = await sb.from('campaign_current').select('html, mes, updated_at').eq('id', 1).maybeSingle();
    if (error) throw error;
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
    (c.nombre_completo || '').toLowerCase().includes(q) ||
    (c.email || '').toLowerCase().includes(q) ||
    (c.responsable || '').toLowerCase().includes(q));

  document.getElementById('campCount').textContent =
    `${contacts.length} LP${contacts.length === 1 ? '' : 's'} · ${periods.length} mes${periods.length === 1 ? '' : 'es'}`;

  if (!campContacts.length) {
    matrix.innerHTML = `<div class="camp-empty">
      <i class="fa-solid fa-inbox"></i>
      <p>Aún no hay LPs cargados. Pídeme la carga inicial del histórico, o sube tu primer CSV de Yesware arriba.</p>
    </div>`;
    return;
  }

  // Header fila 1: cada mes agrupa 3 sub-columnas; bandas alternadas por mes
  const grpCells = periods.map((p, i) =>
    `<th class="camp-mth-grp camp-g${i % 2}" colspan="3" title="${periodoLabel(p)}">${MESES_ES[(+p.slice(5, 7)) - 1]} '${p.slice(2, 4)}</th>`
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
          <button class="camp-row-act" title="${c.cancelado ? 'Reactivar (quitar cancelado)' : 'Marcar como cancelado'}" onclick="campToggleCancel('${c.email}')"><i class="fa-solid ${c.cancelado ? 'fa-rotate-left' : 'fa-ban'}"></i></button>
          <button class="camp-row-act camp-row-del" title="Borrar contacto" onclick="campDeleteContact('${c.email}')"><i class="fa-solid fa-xmark"></i></button>
        </span>
        <div class="camp-name-main">${nombre}${c.cancelado ? ' <span class="camp-cancel-badge">CANCELÓ</span>' : ''}</div>
        <div class="camp-name-sub">${escapeHtml(c.email)}${c.responsable ? ' · ' + escapeHtml(c.responsable) : ''}</div>
      </td>
      ${cells}
      <td class="camp-total">${vistos}</td>
    </tr>`;
  }).join('');

  matrix.innerHTML = `<div class="camp-table-scroll">
    <table class="camp-table">
      <thead>
        <tr>
          <th class="camp-name camp-name-h" rowspan="2">LP</th>
          ${grpCells}
          <th class="camp-total camp-total-h" rowspan="2" title="Meses con interacción">Vistos</th>
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

/* ── Añadir contacto (mini-modal) ── */
function campAddContactOpen() {
  ['campCNombre', 'campCFull', 'campCEmail', 'campCResp'].forEach(id => { document.getElementById(id).value = ''; });
  const msg = document.getElementById('campCMsg'); msg.textContent = ''; msg.className = 'camp-modal-msg';
  document.getElementById('campContactModal').classList.add('show');
  setTimeout(() => document.getElementById('campCNombre').focus(), 60);
}
function campAddContactClose() { document.getElementById('campContactModal').classList.remove('show'); }

async function campAddContactSave() {
  const nombre = document.getElementById('campCNombre').value.trim();
  const full   = document.getElementById('campCFull').value.trim();
  const email  = document.getElementById('campCEmail').value.trim().toLowerCase();
  const resp   = document.getElementById('campCResp').value.trim();
  const msg    = document.getElementById('campCMsg');
  const fail = (t) => { msg.textContent = t; msg.className = 'camp-modal-msg err'; };
  if (!nombre || !email) return fail('Nombre y email son obligatorios.');
  if (!email.includes('@')) return fail('El email no parece válido.');
  const dup = campContacts.find(c => c.email === email);
  if (dup) return fail(`Ya existe: ${dup.nombre_completo || dup.nombre || email}.`);
  const { error } = await sb.from('lp_contacts').insert({
    email, nombre, nombre_completo: full || nombre, responsable: resp || null, comentarios: null,
  });
  if (error) return fail('Error al guardar: ' + error.message);
  toast(`Contacto añadido: ${nombre}`);
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
  const lines = ['email,first_name'];
  list.forEach(c => lines.push(esc(c.email) + ',' + esc(c.nombre || '')));
  const csv = '﻿' + lines.join('\r\n');
  downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), `yesware_contactos_${new Date().toISOString().slice(0, 10)}.csv`);
  toast(`Exportados ${list.length} contactos${excluidos ? ` (${excluidos} cancelado${excluidos === 1 ? '' : 's'} excluido${excluidos === 1 ? '' : 's'})` : ''}`);
}

/* ── Borrar los datos de un mes (el seleccionado en "Mes del reporte") ── */
async function campDeleteMonth() {
  const month = document.getElementById('campMonth').value;
  if (!month) { toast('Elige primero el mes a borrar en "Mes del reporte"'); return; }
  const periodo = month + '-01';
  const n = campEngagement.filter(e => periodoKey(e.periodo) === month).length;
  if (!n) { toast(`No hay datos cargados para ${periodoLabel(periodo)}`); return; }
  if (!confirm(`¿Borrar los ${n} registros de ${periodoLabel(periodo)}?\nEsta acción no se puede deshacer (los contactos NO se borran, solo el engagement de ese mes).`)) return;
  const { error } = await sb.from('campaign_engagement').delete().eq('periodo', periodo);
  if (error) { toast('Error al borrar: ' + error.message); return; }
  toast(`Borrado ${periodoLabel(periodo)} — ${n} registros`);
  campaignsLoaded = false;
  await loadCampaigns();
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
    sel.value = String(new Date().getMonth());
  }
  document.getElementById('campTplModal').classList.add('show');
  campTemplateRender();
}
function campTemplateClose() { campSaveCurrent(); document.getElementById('campTplModal').classList.remove('show'); }

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
  const mes  = MESES_ES[+document.getElementById('campTplMes').value] || '';
  const anio = document.getElementById('campTplAnio').value.trim();
  try {
    await sb.from('campaign_current').upsert(
      { id: 1, html: campTemplateHtml(), mes: `${mes} ${anio}`.trim(), updated_at: new Date().toISOString() },
      { onConflict: 'id' });
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
