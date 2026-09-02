/* ══════════════════════════════════════════════════════════════════════════
   mobile.js — Rediseño móvil de CretumDesk (Fase 1: cascarón)
   ADITIVO: inyecta barra inferior, toggle de marca en header, tira de
   portafolio, riel de noticias y feed "tipo TikTok". Se engancha a la
   navegación/datos existentes (switchView, selectOrg, authedFetch, /api/news,
   /api/gvv-live, toggleSettings, fabAction). No modifica la lógica de la app.
   Los colores los pone mobile.css vía data-org / data-theme.
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var MQ = '(max-width:768px)';
  function isMob() { return window.matchMedia(MQ).matches; }
  function org() { return document.documentElement.getAttribute('data-org') || 'cretum'; }
  function lang() { try { return (window.currentLang && window.currentLang()) || 'es'; } catch (e) { return 'es'; } }
  function tr(s) { try { return (window.t && window.t(s)) || s; } catch (e) { return s; } }   // traduce strings inyectados (placeholders, texto transformado)
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  var ICON = {
    home:    'M3.5 10.8 12 3.6l8.5 7.2M6 9.8V20.4h12V9.8',
    notes:   'M6.5 4h10a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1M9 8.5h6M9 12h6M9 15.5h3.5',
    news:    'M4.5 5.5h13v13h-13zM20 8.5v8a2 2 0 0 1-2.5 2M7.5 9.5h7M7.5 12.5h7M7.5 15.5h4',
    profile: 'M4.5 20v-1.2A4.8 4.8 0 0 1 9.3 14h5.4a4.8 4.8 0 0 1 4.8 4.8V20M12 4.2a3.9 3.9 0 1 1 0 7.8 3.9 3.9 0 0 1 0-7.8',
    plus:    'M12 5v14M5 12h14',
    x:       'M6 6l12 12M18 6 6 18'
  };
  function svg(path) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
      'stroke-linecap="round" stroke-linejoin="round"><path d="' + path + '"></path></svg>';
  }

  // Vista actual desde el hash (#org/view, o #/ en el selector)
  function curView() {
    var h = (location.hash || '').replace(/^#\/?/, '');
    if (!h) return 'selector';
    var p = h.split('/');
    return ((p.length > 1 ? p[1] : p[0]) || 'selector').toLowerCase();
  }

  // Tiempo relativo en español ("3 h", "2 d", "Ahora")
  function ago(iso) {
    if (!iso) return '';
    var t = Date.parse(iso); if (isNaN(t)) return '';
    var m = Math.max(0, Math.floor((Date.now() - t) / 60000));
    if (m < 60) return m <= 1 ? 'Ahora' : m + ' min';
    var h = Math.floor(m / 60); if (h < 24) return h + ' h';
    var d = Math.floor(h / 24); return d + ' d';
  }

  /* ── Barra inferior ── */
  function tab(key, label, handler) {
    return '<button class="mob-tab" data-tab="' + key + '" onclick="' + handler + '">' +
      '<span class="mi">' + svg(ICON[key]) + '</span><span>' + label + '</span></button>';
  }
  function buildBar() {
    if (document.getElementById('mobTabbar')) return;
    if (!document.getElementById('app')) return;
    var nav = document.createElement('nav');
    nav.className = 'mob-tabbar'; nav.id = 'mobTabbar';
    nav.setAttribute('role', 'navigation');
    nav.setAttribute('aria-label', 'Navegación inferior');
    nav.innerHTML =
      tab('home', 'Inicio', 'mobGo(\'home\')') +
      tab('notes', 'Notas', 'mobGo(\'tasks\')') +   /* abre To Do por default; el segmentado pasa a Notas */
      '<div class="mob-fab-slot"><button class="mob-fab" id="mobFab" aria-label="Crear" ' +
      'onclick="mobCreate()">' + svg(ICON.plus) + '</button></div>' +
      tab('news', 'Noticias', 'mobOpenFeed()') +
      tab('profile', 'Perfil', 'mobProfile(event)');
    nav.style.display = 'none';   // oculto hasta que mobSyncNav confirme sesión (evita verlo en login)
    // Va en <body> (no en #app) para que su z-index gane a los overlays de perfil/feed.
    document.body.appendChild(nav);
  }
  /* ── Hoja "Crear rápido" del + central: Contacto / Nota / Tarea / Evento-Aviso ── */
  function sheetBtn(key, label, icon) {
    return '<button class="mob-sheet-opt" onclick="mobSheetPick(\'' + key + '\')">' +
      '<span class="ic">' + svg(icon) + '</span><span class="lb">' + label + '</span></button>';
  }
  function buildSheet() {
    if (document.getElementById('mobSheet')) return;
    var el = document.createElement('div');
    el.id = 'mobSheet'; el.className = 'mob-sheet';
    el.innerHTML =
      '<div class="mob-sheet-back" onclick="mobCloseSheet()"></div>' +
      '<div class="mob-sheet-panel">' +
        '<div class="mob-sheet-grab"></div>' +
        '<div class="mob-sheet-h">Crear</div>' +
        '<div class="mob-sheet-grid">' +
          sheetBtn('task', 'Tarea', 'M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9') +
          sheetBtn('note', 'Nota', 'M6.5 4h10a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1M9 8.5h6M9 12h6M9 15.5h3.5') +
          sheetBtn('contact', 'Contacto', 'M16 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2M9.5 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7M19 8v6M22 11h-6') +
          sheetBtn('remind', 'Recordatorio', 'M12 8v4.5l3 1.8M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17') +
        '</div>' +
      '</div>';
    document.body.appendChild(el);
  }
  window.mobCreate = function () {
    buildSheet();
    var el = document.getElementById('mobSheet'); if (!el) return;
    el.classList.add('open');
  };
  window.mobCloseSheet = function () {
    var el = document.getElementById('mobSheet');
    if (!el || !el.classList.contains('open')) return;
    el.classList.remove('open');
  };
  window.mobSheetPick = function (key) {
    window.mobCloseSheet();
    setTimeout(function () {
      if (key === 'task') { if (window.openTaskModal) window.openTaskModal(); }
      else if (key === 'note') {
        if (window.switchView) window.switchView('notes');
        setTimeout(function () { if (window.ntNewNote) window.ntNewNote(); }, 150);
      } else if (key === 'contact') {
        if (window.qcOpen) window.qcOpen();
        else if (window.ccAddOpen) window.ccAddOpen();
      } else if (key === 'remind') {
        if (window.openTaskModal) window.openTaskModal();
        setTimeout(function () { var d = document.getElementById('fDue'); if (d) d.focus(); }, 90);
      }
    }, 60);
  };

  /* ── Pantalla de Perfil (como el design; usa las funciones reales de la app) ── */
  function isDark() { return document.documentElement.getAttribute('data-theme') === 'dark'; }
  function cbOn(id) { var e = document.getElementById(id); return !!(e && e.checked); }
  function isAdmin() { var e = document.getElementById('usersBtn'); return !!(e && e.style.display !== 'none'); }
  function prof() { return window.currentProfile || {}; }
  function initials() { var e = document.getElementById('headerAv'); return (e && e.textContent.trim()) || '·'; }
  function uname() { var p = prof(); if (p.full_name) return p.full_name; var e = document.getElementById('headerUser'); return (e && e.textContent.trim()) || 'Mi cuenta'; }
  function urole() { return (prof().role || '').toString(); }
  function prefOrg() { try { return localStorage.getItem('mob_pref_org') || org(); } catch (e) { return org(); } }

  function prow(key, label, hint, on) {
    return '<button class="mob-prow" onclick="mobPref(\'' + key + '\')">' +
      '<div class="tx"><div class="l">' + label + '</div><div class="h">' + hint + '</div></div>' +
      '<span class="sw' + (on ? ' on' : '') + '"><span class="kn"></span></span></button>';
  }
  function arow(label, hint, act) {
    return '<button class="mob-arow" onclick="mobAct(\'' + act + '\')">' +
      '<div class="tx"><div class="l">' + label + '</div>' + (hint ? '<div class="h">' + hint + '</div>' : '') + '</div>' +
      '<span class="chev">' + svg('m9 6 6 6-6 6') + '</span></button>';
  }

  function renderProfile() {
    var host = document.querySelector('#mobProf .mob-prof-scroll'); if (!host) return;
    var admin = isAdmin();
    var html =
      '<div class="mob-prof-head"><div class="av">' + esc(initials()) + '</div>' +
        '<div><div class="nm">' + esc(uname()) + '</div><div class="rl">' + esc(tr(urole() || 'Cuenta').toUpperCase()) + '</div></div></div>' +
      '<div class="mob-prof-sec-h">Preferencias</div>' +
      prow('dark', 'Modo oscuro', 'Tema oscuro con mejor contraste de noche', isDark()) +
      prow('reminder', 'Resumen semanal por email', 'Se envía los viernes por la mañana', cbOn('reminderToggle')) +
      (document.getElementById('betaToggle') ? prow('beta', 'Funciones Beta', 'Prueba lo nuevo antes que nadie', cbOn('betaToggle')) : '') +
      '<div class="mob-prof-sec-h">Idioma</div>' +
      '<div class="mob-seg mob-lang">' +
        '<button class="' + (lang() === 'es' ? 'on' : '') + '" onclick="mobAct(\'lang:es\')">Español</button>' +
        '<button class="' + (lang() === 'en' ? 'on' : '') + '" onclick="mobAct(\'lang:en\')">English</button></div>' +
      '<div class="mob-prof-sec-h">Empresa principal</div>' +
      '<div class="mob-seg mob-orgpref">' +
        '<button class="' + (prefOrg() === 'cretum' ? 'on' : '') + '" onclick="mobAct(\'prg:cretum\')">Cretum</button>' +
        '<button class="' + (prefOrg() === 'mvp' ? 'on' : '') + '" onclick="mobAct(\'prg:mvp\')">MVP</button></div>' +
      '<p class="mob-prof-note" style="margin:8px 4px 0">Es la que se abre al iniciar la app.</p>' +
      '<div class="mob-prof-sec-h">Acciones</div>' +
      arow('Verificación en dos pasos (2FA)', 'Protege tu cuenta al iniciar sesión', 'mfa') +
      arow('Enviar resumen ahora', 'Recibe el resumen semanal al instante', 'send') +
      (admin ? arow('Usuarios', 'Gestiona el equipo y sus roles', 'users') : '') +
      (window.installApp ? arow('Instalar app', 'Añádela a tu pantalla de inicio', 'install') : '');
    if (admin) {
      var cur = (window.rolePreview || urole() || 'admin');
      var roles = [['admin', 'Admin'], ['editor', 'Editor'], ['colaborador', 'Colaborador'], ['viewer', 'Viewer']];
      html += '<div class="mob-prof-sec-h">Ver como (prueba)</div><div class="mob-seg mob-roles">' +
        roles.map(function (r) { return '<button class="' + (cur === r[0] ? 'on' : '') + '" onclick="mobAct(\'role:' + r[0] + '\')">' + r[1] + '</button>'; }).join('') +
        '</div><p class="mob-prof-note">Cambia solo lo que TÚ ves, para probar. No toca la base; refresca para volver a tu rol real.</p>';
    }
    html += '<button class="mob-logout" onclick="mobAct(\'logout\')">Cerrar sesión</button>';
    host.innerHTML = html;
  }

  window.mobPref = function (key) {
    try {
      if (key === 'dark') { if (window.setDarkMode) window.setDarkMode(!isDark()); }
      // Click al checkbox real: actualiza su estado SINCRÓNICAMENTE y dispara su handler
      // (setReminderEnabled/setBetaOptin). Así el re-render inmediato ya lee el valor nuevo.
      else if (key === 'reminder') { var r = document.getElementById('reminderToggle'); if (r) r.click(); }
      else if (key === 'beta') { var b = document.getElementById('betaToggle'); if (b) b.click(); }
    } catch (e) {}
    renderProfile();
  };
  window.mobAct = function (a) {
    try {
      if (a === 'mfa' && window.mfaOpen) window.mfaOpen();
      else if (a === 'send' && window.sendReminderNow) window.sendReminderNow();
      else if (a === 'users' && window.openUsersFromMenu) window.openUsersFromMenu();
      else if (a === 'install' && window.installApp) window.installApp();
      else if (a === 'logout' && window.doLogout) window.doLogout();
      else if (a.indexOf('lang:') === 0) { if (window.setLang) window.setLang(a.slice(5)); setTimeout(renderProfile, 80); }
      else if (a.indexOf('role:') === 0) { if (window.setRolePreview) window.setRolePreview(a.slice(5)); setTimeout(renderProfile, 140); }
      else if (a.indexOf('prg:') === 0) {
        var o = a.slice(4);
        try { localStorage.setItem('mob_pref_org', o); } catch (e) {}
        if (window.toast) window.toast('Empresa principal: ' + (o === 'mvp' ? 'MVP' : 'Cretum'));
        setTimeout(renderProfile, 60);
      }
    } catch (e) {}
  };

  // Navegar a una vista cerrando primero cualquier capa móvil (feed/perfil).
  window.mobGo = function (v) {
    window.mobCloseFeed();
    window.mobCloseProfile();
    if (window.switchView) window.switchView(v);
  };
  window.mobProfile = function () {
    var open = document.getElementById('mobProf');
    if (open && open.classList.contains('open')) { return; } // ya abierto: no cerrar
    window.mobCloseFeed();
    if (!document.getElementById('mobProf')) {
      var el = document.createElement('div'); el.id = 'mobProf'; el.className = 'mob-prof-ov';
      el.innerHTML = '<div class="mob-prof-scroll"></div>';
      document.body.appendChild(el);
    }
    renderProfile();
    document.getElementById('mobProf').classList.add('open');
    window.mobSyncNav();
  };
  window.mobCloseProfile = function () {
    var el = document.getElementById('mobProf');
    if (!el || !el.classList.contains('open')) return;
    el.classList.remove('open');
    window.mobSyncNav();
  };

  /* ── Toggle de marca Cretum/MVP en el header (reemplaza el selector) ── */
  function buildOrgToggle() {
    if (document.getElementById('mobOrgToggle')) return;
    var header = document.querySelector('.header'); if (!header) return;
    var w = document.createElement('div');
    w.id = 'mobOrgToggle'; w.className = 'mob-orgtoggle';
    w.innerHTML =
      '<button data-o="cretum" onclick="mobSetOrg(\'cretum\')">Cretum</button>' +
      '<button data-o="mvp" onclick="mobSetOrg(\'mvp\')">MVP</button>';
    header.insertBefore(w, header.firstChild);
  }
  window.mobSetOrg = function (o) {
    try { localStorage.setItem('mob_org', o); } catch (e) {}
    if (o === org() || !window.selectOrg) { if (window.selectOrg) window.selectOrg(o); return; }
    // Transición de marca a pantalla completa (recolorea bajo un overlay con el gradiente destino).
    var reduce = false;
    try { reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
    if (reduce) { window.selectOrg(o); return; }
    var ov = document.getElementById('mobOrgFx');
    if (!ov) { ov = document.createElement('div'); ov.id = 'mobOrgFx'; document.body.appendChild(ov); }
    ov.className = 'mob-orgfx org-' + o;
    ov.innerHTML = '<img class="mob-orgfx-logo" alt="' + (o === 'mvp' ? 'MVP' : 'Cretum') + '" src="' +
      (o === 'mvp' ? '/logo-mvp-cream.png' : '/logo-cretum-dark.png') + '">';
    requestAnimationFrame(function () {
      ov.classList.add('show');
      setTimeout(function () {
        window.selectOrg(o);                                   // recolorea la app (oculto por el overlay)
        setTimeout(function () { ov.classList.remove('show'); }, 80);
      }, 230);
    });
  };
  function syncOrgToggle() {
    var w = document.getElementById('mobOrgToggle'); if (!w) return;
    var cur = org();
    var bs = w.querySelectorAll('button');
    for (var i = 0; i < bs.length; i++) bs[i].classList.toggle('on', bs[i].getAttribute('data-o') === cur);
  }

  /* ── Tira "Estado del portafolio" (snapshot /api/gvv-live) — con CACHE (fetch solo si >2 min) ── */
  var _pf = { pos: null, at: 0, busy: false };
  function renderPf(pos) {
    var host = document.getElementById('mobPf'); if (!host) return;
    var movers = pos.filter(function (p) { return p.ac !== 'Cash' && p.day_chg_pct != null; })
      .sort(function (a, b) { return Math.abs(b.day_chg_pct) - Math.abs(a.day_chg_pct); })
      .slice(0, 10);
    if (!movers.length) { host.style.display = 'none'; return; }
    host.querySelector('.rail').innerHTML = movers.map(function (p) {
      var up = p.day_chg_pct >= 0;
      var pct = (up ? '+' : '−') + Math.abs(p.day_chg_pct).toFixed(1) + '%';
      return '<div class="mob-pf-card ' + (up ? 'up' : 'dn') + '">' +
        '<div class="mob-pf-tk">' + esc(p.ticker || p.company || '') + '</div>' +
        '<div class="mob-pf-pct">' + pct + '</div></div>';
    }).join('');
    host.style.display = '';
  }
  function loadPortfolio() {
    var host = document.getElementById('mobPf'); if (!host) return;
    if (!window.authedFetch) { host.style.display = 'none'; return; }
    if (_pf.pos) { renderPf(_pf.pos); if (Date.now() - _pf.at < 120000) return; }  // cache 2 min
    if (_pf.busy) return;
    _pf.busy = true;
    window.authedFetch('/api/gvv-live').then(function (r) { return r.json(); }).then(function (s) {
      _pf.pos = (s && s.positions) || []; _pf.at = Date.now(); _pf.busy = false;
      renderPf(_pf.pos);
    }).catch(function () { _pf.busy = false; if (!_pf.pos) host.style.display = 'none'; });
  }

  /* ── Noticias (/api/news?org=) — riel horizontal + feed tipo TikTok ── */
  var newsCache = {};
  function loadNews(cb) {
    var o = org();
    if (newsCache[o]) { cb(newsCache[o]); return; }
    fetch('/api/news?org=' + o, { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) {
      newsCache[o] = (d && d.items) || []; cb(newsCache[o]);
    }).catch(function () { cb([]); });
  }
  function nTitle(it) { return (lang() === 'es' && it.title_es) ? it.title_es : (it.title || it.title_es || ''); }
  function favicon(it) {
    var d = it.domain || '';
    if (!d && it.url) { try { d = new URL(it.url).hostname; } catch (e) {} }
    return d ? 'https://www.google.com/s2/favicons?domain=' + encodeURIComponent(d) + '&sz=128' : '';
  }
  function favImg(it, cls) {
    var f = favicon(it);
    return f ? '<img class="' + cls + '" src="' + esc(f) + '" alt="" loading="lazy" onerror="this.style.display=\'none\'">' : '';
  }

  function renderNewsRail() {
    var host = document.getElementById('mobNews'); if (!host) return;
    loadNews(function (items) {
      if (!items.length) { host.style.display = 'none'; return; }
      host.querySelector('.rail').innerHTML = items.slice(0, 12).map(function (it) {
        var img = it.image;
        return '<button class="mob-news-card' + (img ? ' hasimg' : '') + '" onclick="mobOpenFeed()">' +
          (img ? '<div class="mob-news-img" style="background-image:url(\'' + esc(img) + '\')"></div>' : '') +
          '<div class="mob-news-body">' +
          '<div class="mob-news-top">' + favImg(it, 'mob-fav') + '<span class="chip">' + esc(it.company || it.source || '') + '</span>' +
          '<span class="t">' + ago(it.published) + '</span></div>' +
          '<div class="mob-news-h">' + esc(nTitle(it)) + '</div>' +
          '<div class="mob-news-src">' + esc(it.source || it.domain || '') + '</div></div></button>';
      }).join('');
      host.style.display = '';
    });
  }

  function buildFeed(items) {
    var f = document.getElementById('mobFeed');
    if (!f) { f = document.createElement('div'); f.id = 'mobFeed'; f.className = 'mob-feed'; document.body.appendChild(f); }
    var cards = items.slice(0, 20).map(function (it, i) {
      var img = it.image;
      var st = img ? ' style="background-image:linear-gradient(180deg,rgba(12,20,38,.10) 0%,rgba(12,20,38,.52) 52%,rgba(12,20,38,.88) 100%),url(\'' + esc(img) + '\')"' : '';
      var logo = img ? '' : ('<div class="mob-feed-logo">' + favImg(it, 'mob-feed-logo-img') + '</div>');
      return '<article class="mob-feed-card' + (i === 0 ? ' lead' : '') + (img ? ' hasimg' : ' logo') + '"' + st + '>' + logo +
        '<div class="mob-feed-meta">' + favImg(it, 'mob-fav lg') + '<span class="chip">' + esc(it.company || '') + '</span>' +
        '<span class="t">' + esc(ago(it.published)) + '</span></div>' +
        '<h2 class="mob-feed-title">' + esc(nTitle(it)) + '</h2>' +
        '<div class="mob-feed-foot"><span class="src">' + esc(it.source || it.domain || '') + '</span>' +
        (it.url ? '<a class="mob-feed-read" href="' + esc(it.url) + '" target="_blank" rel="noopener">Leer</a>' : '') +
        '</div></article>';
    }).join('');
    f.innerHTML =
      '<div class="mob-feed-bar"><button class="mob-feed-x" onclick="mobCloseFeed()" aria-label="Cerrar">' + svg(ICON.x) + '</button>' +
      '<span class="mob-feed-ttl">Noticias</span></div>' +
      '<div class="mob-feed-scroll">' + (cards || '<div class="mob-feed-empty">Sin noticias por ahora.</div>') + '</div>';
  }
  window.mobOpenFeed = function () {
    var open = document.getElementById('mobFeed');
    if (open && open.classList.contains('open')) { window.mobSyncNav(); return; } // ya abierto: no cerrar
    window.mobCloseProfile();
    loadNews(function (items) {
      buildFeed(items);
      var f = document.getElementById('mobFeed'); if (!f) return;
      f.classList.add('open');
      window.mobSyncNav(); // marca "Noticias" activo, nav queda encima
    });
  };
  window.mobCloseFeed = function () {
    var f = document.getElementById('mobFeed');
    if (!f || !f.classList.contains('open')) return;
    f.classList.remove('open'); document.body.style.overflow = '';
  };

  /* ── Segmentado To Do / Notas (inyectado arriba de ambas vistas) ── */
  function ensureSeg() {
    ['pageTasks', 'pageNotes'].forEach(function (pid) {
      var pg = document.getElementById(pid); if (!pg) return;
      if (pg.querySelector('.mob-seg-nav')) return;
      var seg = document.createElement('div');
      seg.className = 'mob-seg mob-seg-nav';
      seg.innerHTML =
        '<button data-v="tasks" onclick="mobSeg(\'tasks\')">To Do</button>' +
        '<button data-v="notes" onclick="mobSeg(\'notes\')">Notas</button>';
      pg.insertBefore(seg, pg.firstChild);
    });
  }
  var lastSegV = null;
  function syncSeg(v) {
    var bs = document.querySelectorAll('.mob-seg-nav button');
    for (var i = 0; i < bs.length; i++) bs[i].classList.toggle('on', bs[i].getAttribute('data-v') === v);
  }
  // Cambio To Do ↔ Notas: feedback INMEDIATO (mueve la pastilla ya) y difiere el
  // switchView pesado un frame → el toque se siente instantáneo, sin bloquear el paint.
  window.mobSeg = function (v) {
    var cur = curView();
    if (v === cur) return;
    var seg = document.querySelector('#page' + (cur === 'notes' ? 'Notes' : 'Tasks') + ' .mob-seg-nav');
    if (seg) {
      var bs = seg.querySelectorAll('button');
      for (var i = 0; i < bs.length; i++) bs[i].classList.toggle('on', bs[i].getAttribute('data-v') === v);
      slidePill(seg);
      lastSegV = v;   // la vista destino coloca la pastilla estática (no re-anima)
    }
    requestAnimationFrame(function () { if (window.switchView) window.switchView(v); });
  };
  function ensurePill(cont) {
    var pill = cont.querySelector('.mob-pill');
    if (!pill) { pill = document.createElement('span'); pill.className = 'mob-pill'; cont.insertBefore(pill, cont.firstChild); }
    return pill;
  }
  function placePill(pill, btn) { pill.style.width = btn.offsetWidth + 'px'; pill.style.transform = 'translateX(' + btn.offsetLeft + 'px)'; }
  // Coloca la pastilla en el botón activo (sin animar) — para scope y estados estáticos.
  function slidePill(cont) {
    if (!cont || !cont.offsetWidth) return;
    var active = cont.querySelector('.on') || cont.querySelector('button'); if (!active) return;
    placePill(ensurePill(cont), active);
  }
  // Anima la pastilla desde la pestaña anterior hasta la activa (Emil): se DESLIZA al llegar.
  function animateSeg(cont) {
    if (!cont || !cont.offsetWidth) return;
    var active = cont.querySelector('.on'), other = cont.querySelector('button:not(.on)');
    if (!active) return;
    var pill = ensurePill(cont);
    if (other) {
      pill.style.transition = 'none';
      placePill(pill, other);
      void pill.offsetWidth;            // reflow: fija el punto de partida
      pill.style.transition = '';
      requestAnimationFrame(function () { placePill(pill, active); });
    } else placePill(pill, active);
  }
  function slideScope() {
    var cont = document.querySelector('#pageTasks .tk-toggle'); if (!cont) return;
    // Solo móvil: en escritorio la pastilla (sin CSS) quedaba como caja vacía dentro del flex,
    // empujaba los botones y descolocaba el slider propio del app. Se limpia y se recoloca el original.
    if (!isMob()) {
      var p = cont.querySelector('.mob-pill'); if (p) p.remove();
      if (window.tkMoveSlider) try { window.tkMoveSlider(); } catch (e) {}
      return;
    }
    slidePill(cont);
  }

  /* ── Carpetas de Notas: desplegable PROPIO "Carpetas" (reemplaza el riel de pastillas).
     Lee las carpetas del riel oculto #ntFolders (que la app sigue renderizando) y, al
     elegir, dispara el click de la pastilla real → ntSelectFolder. "Nueva carpeta" abre el modal. */
  function folderMenuHTML() {
    var chips = document.querySelectorAll('#ntFolders .nt-folder');
    var check = '<svg class="ck" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 13 4 4L19 7"></path></svg>';
    var html = '';
    for (var i = 0; i < chips.length; i++) {
      var c = chips[i];
      var nmEl = c.querySelector('.nt-folder-nm');
      var nm = nmEl ? nmEl.textContent : ('Carpeta ' + i);
      var dot = c.querySelector('.nt-folder-dot');
      var color = dot ? dot.style.background : '';
      var on = c.classList.contains('on');
      html += '<button class="mob-dd-opt' + (on ? ' on' : '') + '" onclick="mobFolderPick(' + i + ')">' +
        '<span class="fdot"' + (color ? ' style="background:' + esc(color) + '"' : '') + '></span>' +
        '<span>' + esc(nm) + '</span>' + (on ? check : '') + '</button>';
    }
    // Editar la carpeta actual (renombrar/color/borrar) si es una carpeta real (no General)
    var ed = document.getElementById('ntFolderEdit');
    if (ed && ed.style.display !== 'none') {
      html += '<button class="mob-dd-opt mob-dd-edit" onclick="mobFolderEdit()">' +
        '<span class="fdot"><i class="fa-solid fa-pen"></i></span><span>Editar carpeta actual</span></button>';
    }
    html += '<button class="mob-dd-opt mob-dd-new" onclick="mobFolderNew()">' +
      '<span class="fdot plus"><i class="fa-solid fa-plus"></i></span><span>Nueva carpeta</span></button>';
    return html;
  }
  window.mobFolderEdit = function () { window.mobFolderClose(); var b = document.getElementById('ntFolderEdit'); if (b) b.click(); };
  function updateFolderLabel() {
    var lbl = document.getElementById('mobFolderLabel'); if (!lbl) return;
    var a = document.querySelector('#ntFolders .nt-folder.on .nt-folder-nm');
    lbl.textContent = a ? a.textContent : 'Carpetas';
  }
  function ensureFolderDD() {
    var pg = document.getElementById('pageNotes'); if (!pg) return;
    if (!document.getElementById('mobFolderDD')) {
      var wrap = document.createElement('div'); wrap.className = 'mob-projrow mob-folderrow';
      wrap.innerHTML =
        '<div class="mob-dd" id="mobFolderDD">' +
          '<button class="mob-dd-btn" onclick="mobFolderToggle(event)" aria-haspopup="menu">' +
            '<i class="fa-solid fa-folder mob-dd-lead"></i>' +
            '<span class="mob-dd-label" id="mobFolderLabel">Carpetas</span>' +
            '<svg class="mob-dd-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"></path></svg>' +
          '</button>' +
          '<div class="mob-dd-menu" id="mobFolderMenu" role="menu"></div>' +
        '</div>';
      var search = pg.querySelector('.nt-search');
      if (search && search.parentNode) search.parentNode.insertBefore(wrap, search);
      else pg.insertBefore(wrap, pg.firstChild);
    }
    updateFolderLabel();
  }
  function folderOutside(e) { var dd = document.getElementById('mobFolderDD'); if (dd && !dd.contains(e.target)) window.mobFolderClose(); }
  window.mobFolderToggle = function (e) {
    if (e) e.stopPropagation();
    var dd = document.getElementById('mobFolderDD'); if (!dd) return;
    if (dd.classList.contains('open')) { window.mobFolderClose(); return; }
    document.getElementById('mobFolderMenu').innerHTML = folderMenuHTML();
    dd.classList.add('open');
    setTimeout(function () { document.addEventListener('click', folderOutside); }, 0);
  };
  window.mobFolderClose = function () {
    var dd = document.getElementById('mobFolderDD'); if (!dd || !dd.classList.contains('open')) return;
    dd.classList.remove('open'); document.removeEventListener('click', folderOutside);
  };
  window.mobFolderPick = function (i) {
    window.mobFolderClose();
    var chips = document.querySelectorAll('#ntFolders .nt-folder');
    if (chips[i]) chips[i].click();
    setTimeout(updateFolderLabel, 40);
  };
  window.mobFolderNew = function () { window.mobFolderClose(); if (window.openFolderModal) window.openFolderModal(null); };

  /* ── Calendario: apagado por default, se activa con "+ Calendario" ── */
  function calOn() { try { return localStorage.getItem('mob_cal') === '1'; } catch (e) { return false; } }
  window.mobToggleCal = function () {
    var on = !calOn();
    try { localStorage.setItem('mob_cal', on ? '1' : '0'); } catch (e) {}
    document.body.classList.toggle('mob-cal-on', on);
    syncCalBtn();
  };
  function syncCalBtn() {
    var b = document.getElementById('mobCalBtn'); if (!b) return;
    var on = calOn();
    b.textContent = (on ? '– ' : '+ ') + 'Calendario';
    b.classList.toggle('on', on);
  }

  /* ── Secciones inyectadas del home (portafolio + noticias + calendario) ── */
  function ensureHome() {
    var page = document.getElementById('pageHome'); if (!page) return;
    if (!document.getElementById('mobHome')) {
      var host = document.createElement('div');
      host.id = 'mobHome';
      host.innerHTML =
        '<section class="mob-sec" id="mobPf" style="display:none"><div class="mob-sec-h"><span>Estado del portafolio</span></div><div class="rail mob-pf-rail"></div></section>' +
        '<section class="mob-sec" id="mobUrgent" style="display:none"><div class="mob-sec-h"><span>Tareas urgentes</span><button class="mob-sec-a" onclick="switchView(\'tasks\')">Ver To Do</button></div><div class="mob-urg-list"></div></section>' +
        '<section class="mob-sec" id="mobNews" style="display:none"><div class="mob-sec-h"><span>Noticias</span><button class="mob-sec-a" onclick="mobOpenFeed()">Ver feed</button></div><div class="rail mob-news-rail"></div></section>' +
        '<div class="mob-calrow"><button id="mobCalBtn" class="mob-calbtn" onclick="mobToggleCal()">+ Calendario</button></div>';
      var anchor = document.getElementById('homeEvents');
      if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(host, anchor);
      else page.appendChild(host);
    }
    syncCalBtn();
    loadPortfolio();
    loadUrgent();
    renderNewsRail();
  }

  /* ── Tareas pendientes urgentes en el home (vencidas o prioridad Alta) ── */
  function fmtDue(d) {
    if (!d) return '';
    if (window.isOD && window.isOD(d)) return 'Vencida';
    var t = Date.parse(d + 'T12:00:00'); if (isNaN(t)) return '';
    try {
      return new Date(t).toLocaleDateString('es-MX', { day: 'numeric', month: 'short' });
    } catch (e) { return d; }
  }
  function loadUrgent() {
    var host = document.getElementById('mobUrgent'); if (!host) return;
    if (!window.myTasks || !window.isDone) { host.style.display = 'none'; return; }
    var mine;
    try { mine = window.myTasks() || []; } catch (e) { host.style.display = 'none'; return; }
    var urg = mine.filter(function (t) {
      return !window.isDone(t) && ((window.isOD && window.isOD(t.due)) || t.prio === 'Alta');
    });
    urg.sort(function (a, b) {
      var ao = (window.isOD && window.isOD(a.due)) ? 0 : 1, bo = (window.isOD && window.isOD(b.due)) ? 0 : 1;
      return ao - bo;
    });
    urg = urg.slice(0, 5);
    if (!urg.length) { host.style.display = 'none'; return; }
    host.querySelector('.mob-urg-list').innerHTML = urg.map(function (t) {
      var od = window.isOD && window.isOD(t.due);
      var due = fmtDue(t.due);
      return '<button class="mob-urg-item" onclick="switchView(\'tasks\')">' +
        '<span class="dot' + (od ? ' od' : '') + '"></span>' +
        '<span class="tx">' + esc(t.name || t.text || '') + '</span>' +
        (due ? '<span class="due' + (od ? ' od' : '') + '">' + esc(due) + '</span>' : '') +
        '</button>';
    }).join('');
    host.style.display = '';
  }

  /* ── Quick-add de To Do (Enter = directo, + = detalles) ── */
  function ensureTaskQuick() {
    var pg = document.getElementById('pageTasks'); if (!pg) return;
    if (document.getElementById('mobQuick')) return;
    var box = document.createElement('div');
    box.id = 'mobQuick'; box.className = 'mob-quick';
    box.innerHTML =
      '<input id="mobQuickInput" class="mob-quick-in" type="text" placeholder="' + esc(tr('Añadir a To Do…')) + '" autocomplete="off" onkeydown="mobQuickKey(event)">' +
      '<button class="mob-quick-add" aria-label="Añadir con detalles" onclick="mobQuickPlus()">' + svg('M12 5v14M5 12h14') + '</button>';
    var seg = pg.querySelector('.mob-seg-nav');
    if (seg && seg.nextSibling) pg.insertBefore(box, seg.nextSibling);
    else pg.insertBefore(box, pg.firstChild);
  }
  window.mobQuickKey = function (e) { if (e.key === 'Enter') mobQuickCommit(false); };
  window.mobQuickPlus = function () { mobQuickCommit(true); };
  function mobQuickCommit(details) {
    var inp = document.getElementById('mobQuickInput'); if (!inp) return;
    var text = inp.value.trim();
    if (details) { // el + abre el modal con detalles (prefijado con lo escrito)
      if (window.openTaskModal) window.openTaskModal();
      var fd = document.getElementById('fName'); if (fd && text) fd.value = text;
      inp.value = '';
      return;
    }
    if (!text) return;                       // Enter en vacío: nada
    if (window.openTaskModal) window.openTaskModal();   // resetea el modal de creación…
    var fn = document.getElementById('fName'); if (fn) fn.value = text;
    if (window.addSimple) window.addSimple();           // …crea y lo cierra (sin verse)
    inp.value = ''; inp.focus();
  }

  /* ── Filtro de proyectos: desplegable PROPIO (diseño de la página, no del sistema) ── */
  function curProj() {
    var c = null; try { c = localStorage.getItem('tkProject'); } catch (e) {}
    return (c && c !== 'null') ? c : '__all__';
  }
  function projLabel() {
    var c = curProj();
    return c === '__all__' ? 'Todas' : c === '__none__' ? 'Sin proyecto' : c;
  }
  function ddOptionsHTML() {
    var names = [];
    try { names = (window.tkAllProjects && window.tkAllProjects()) || []; } catch (e) {}
    var cur = curProj();
    var check = '<svg class="ck" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 13 4 4L19 7"></path></svg>';
    var row = function (val, label) {
      return '<button class="mob-dd-opt' + (val === cur ? ' on' : '') + '" role="menuitem" data-v="' + esc(val) + '" onclick="mobProjPick(this.getAttribute(\'data-v\'))">' +
        '<span>' + esc(label) + '</span>' + (val === cur ? check : '') + '</button>';
    };
    var html = row('__all__', 'Todas');
    names.forEach(function (n) { html += row(n, n); });
    html += row('__none__', 'Sin proyecto');
    return html;
  }
  function ensureProjDD() {
    var pg = document.getElementById('pageTasks'); if (!pg) return;
    if (!document.getElementById('mobProjDD')) {
      var wrap = document.createElement('div'); wrap.className = 'mob-projrow';
      wrap.innerHTML =
        '<div class="mob-dd" id="mobProjDD">' +
          '<button class="mob-dd-btn" onclick="mobProjToggle(event)" aria-haspopup="menu">' +
            '<i class="fa-solid fa-folder-open mob-dd-lead"></i>' +
            '<span class="mob-dd-label" id="mobProjLabel"></span>' +
            '<svg class="mob-dd-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"></path></svg>' +
          '</button>' +
          '<div class="mob-dd-menu" id="mobProjMenu" role="menu"></div>' +
        '</div>';
      var q = document.getElementById('mobQuick');
      if (q && q.nextSibling) pg.insertBefore(wrap, q.nextSibling);
      else pg.insertBefore(wrap, pg.firstChild);
    }
    // el menú se arma al ABRIR (mobProjToggle); aquí solo la etiqueta (barato)
    document.getElementById('mobProjLabel').textContent = projLabel();
  }
  function projOutside(e) {
    var dd = document.getElementById('mobProjDD');
    if (dd && !dd.contains(e.target)) window.mobProjClose();
  }
  window.mobProjToggle = function (e) {
    if (e) e.stopPropagation();
    var dd = document.getElementById('mobProjDD'); if (!dd) return;
    if (dd.classList.contains('open')) { window.mobProjClose(); return; }
    document.getElementById('mobProjMenu').innerHTML = ddOptionsHTML();
    dd.classList.add('open');
    setTimeout(function () { document.addEventListener('click', projOutside); }, 0);
  };
  window.mobProjClose = function () {
    var dd = document.getElementById('mobProjDD');
    if (!dd || !dd.classList.contains('open')) return;
    dd.classList.remove('open');
    document.removeEventListener('click', projOutside);
  };
  window.mobProjPick = function (v) {
    window.mobProjClose();
    setTimeout(function () {
      if (window.tkSetProject) window.tkSetProject(v);
      var lbl = document.getElementById('mobProjLabel'); if (lbl) lbl.textContent = projLabel();
    }, 30);
  };

  /* ── Sincronización de estado (visibilidad, activo, org, home) ──
     Debounced: el MutationObserver + hashchange pueden dispararlo en ráfaga; colapsamos. */
  var _syncQ = false;
  window.mobSyncNav = function () {
    if (_syncQ) return;                 // colapsa llamadas en ráfaga a un solo frame
    _syncQ = true;
    requestAnimationFrame(function () { _syncQ = false; _mobSyncNow(); });
  };
  function _mobSyncNow() {
    var bar = document.getElementById('mobTabbar'); if (!bar) return;
    var app = document.getElementById('app');
    // getComputedStyle: en la pantalla de login #app está oculto por CSS (no inline).
    var loggedIn = app && getComputedStyle(app).display !== 'none';
    var v = curView();

    // Saltar el selector inicial en móvil: elegir org por default
    if (loggedIn && v === 'selector' && isMob() && window.selectOrg) {
      var saved = 'cretum';
      try { saved = localStorage.getItem('mob_pref_org') || localStorage.getItem('mob_org') || 'cretum'; } catch (e) {}
      window.selectOrg(saved);
      return; // selectOrg re-navega a home → hashchange → re-sync
    }

    bar.style.display = (!loggedIn || v === 'selector') ? 'none' : '';
    var feed = document.getElementById('mobFeed');
    var feedOpen = feed && feed.classList.contains('open');
    var pr = document.getElementById('mobProf');
    var profOpen = pr && pr.classList.contains('open');
    var tabs = bar.querySelectorAll('.mob-tab');
    for (var i = 0; i < tabs.length; i++) {
      var t = tabs[i].getAttribute('data-tab');
      var on = feedOpen ? (t === 'news')
        : profOpen ? (t === 'profile')
        : ((t === 'home' && v === 'home') || (t === 'notes' && (v === 'notes' || v === 'tasks')));
      tabs[i].classList.toggle('active', on);
    }
    syncOrgToggle();
    if (loggedIn && isMob() && (v === 'tasks' || v === 'notes')) {
      ensureSeg(); syncSeg(v);
      if (v === 'notes') ensureFolderDD();
      if (v === 'tasks') {
        ensureTaskQuick();
        ensureProjDD();
        try { if (window.setView && localStorage.getItem('tkView') !== 'lista') window.setView('lista'); } catch (e) {}
        // En móvil el ámbito "Otros miembros" no aplica: si quedó activo, volver a "Mis tareas".
        var otros = document.getElementById('togOtros');
        if (otros && otros.classList.contains('on') && window.setScope) window.setScope('personal');
      }
      requestAnimationFrame(function () {
        syncSeg(v);
        var seg = document.querySelector('#page' + (v === 'notes' ? 'Notes' : 'Tasks') + ' .mob-seg-nav');
        if (v !== lastSegV) animateSeg(seg); else slidePill(seg);
        lastSegV = v;
        if (v === 'tasks') slideScope();
      });
    }
    if (loggedIn && v === 'home' && isMob()) ensureHome();
  };

  // FAB "guardar nota" en <body> (fixed real; el editor usa transform y atraparía un fixed dentro).
  function ensureNoteSaveFab() {
    if (document.getElementById('mobNoteSave')) return;
    var b = document.createElement('button');
    b.id = 'mobNoteSave'; b.type = 'button'; b.setAttribute('aria-label', 'Guardar nota');
    b.innerHTML = '<i class="fa-solid fa-floppy-disk"></i>';
    b.onclick = function () {
      if (!window.ntSaveNow) return;
      var i = b.querySelector('i');
      Promise.resolve(window.ntSaveNow()).then(function () {
        b.classList.add('ok'); if (i) i.className = 'fa-solid fa-check';
        setTimeout(function () { b.classList.remove('ok'); if (i) i.className = 'fa-solid fa-floppy-disk'; }, 1300);
      }).catch(function () {});
    };
    document.body.appendChild(b);
  }

  function init() {
    buildBar();
    ensureNoteSaveFab();
    buildOrgToggle();
    document.body.classList.toggle('mob-cal-on', calOn());
    ensureSeg();
    window.mobSyncNav();
    window.addEventListener('hashchange', function () { window.mobCloseFeed(true); window.mobCloseProfile(true); setTimeout(window.mobSyncNav, 0); });
    var app = document.getElementById('app');
    if (app && window.MutationObserver) {
      new MutationObserver(window.mobSyncNav).observe(app, { attributes: true, attributeFilter: ['style'] });
    }
    // Al cambiar de ámbito (Mis tareas/Equipo) mover la pastilla deslizante.
    if (window.setScope) {
      var _ss = window.setScope;
      window.setScope = function () { var r = _ss.apply(this, arguments); try { requestAnimationFrame(slideScope); } catch (e) {} return r; };
    }
    // Debounced: en móvil el resize se dispara al aparecer/ocultarse la barra del navegador
    // durante el scroll; recalcular la pastilla en cada frame causaba jank.
    var _rz = null;
    window.addEventListener('resize', function () {
      clearTimeout(_rz);
      _rz = setTimeout(function () {
        var v = curView();
        if (v === 'tasks' || v === 'notes') slidePill(document.querySelector('#page' + (v === 'notes' ? 'Notes' : 'Tasks') + ' .mob-seg-nav'));
        slideScope();
      }, 150);
    });
  }
  if (document.readyState !== 'loading') init();
  else document.addEventListener('DOMContentLoaded', init);
})();
