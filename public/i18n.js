/**
 * i18n.js — motor de traducción ES/EN para Cretum Desk (vanilla, sin build).
 *
 * Estrategia de retrofit: la llave del diccionario ES el texto en español
 * (fuente de verdad en el código). Si el idioma es 'en' y existe traducción,
 * la usa; si no, cae de vuelta al español. Así traducir es incremental y la
 * app nunca se rompe por un string sin traducir.
 *
 * Uso:
 *   - HTML estático: <div data-i18n>Texto</div>  (solo elementos de texto puro)
 *       placeholder:  <input data-i18n-ph placeholder="Texto">
 *       title/aria:   <button data-i18n-title title="Texto" aria-label="Texto">
 *   - JS dinámico:  t('Texto en español', { var: valor })  // {var} interpola
 *
 * Se carga ANTES de app.js, por lo que t()/setLang/applyI18n son globales.
 */

const EN = {
  // ── Login ──
  'Dashboard': 'Dashboard',
  'Accede con tu cuenta del equipo': 'Sign in with your team account',
  'Credenciales inválidas': 'Invalid credentials',
  'tu@email.com': 'you@email.com',
  'Contraseña': 'Password',
  'Entrar': 'Sign in',
  'Mostrar contraseña': 'Show password',
  'Ocultar contraseña': 'Hide password',
  'Acceso protegido · Cretum Partners': 'Secure access · Cretum Partners',
  'Código de verificación': 'Verification code',
  'Ingresa el código de 6 dígitos de tu app de autenticación': 'Enter the 6-digit code from your authenticator app',
  'Cancelar': 'Cancel',
  'Verificar': 'Verify',

  // ── Selector de empresa / saludos ──
  'Elige con cuál quieres trabajar': 'Choose which one to work with',
  'Hola': 'Hi',
  'tú': 'you',
  'Buenos días': 'Good morning',
  'Buenas tardes': 'Good afternoon',
  'Buenas noches': 'Good evening',

  // ── Home / menú de módulos ──
  '¿Con qué quieres empezar hoy?': 'What would you like to start with today?',
  'Pronto': 'Soon',
  'Próximamente': 'Coming soon',
  'Calendario': 'Calendar',
  'To Do Dashboard': 'To Do Dashboard',
  'Crea, organiza y da seguimiento a tareas tuyas y del equipo': 'Create, organize and track your own and your team’s tasks',
  'Base de Datos': 'Database',
  'Consulta inversionistas, empresas y posiciones del portafolio': 'Look up investors, companies and portfolio positions',
  'Archivos compartidos del equipo desde Dropbox': 'Team shared files from Dropbox',
  'Campañas': 'Campaigns',
  'Ranking de interacción de los LPs y la campaña actual del fondo': 'LP engagement ranking and the fund’s current campaign',
  'Formularios': 'Forms',
  'Utilería y formularios para el equipo administrativo': 'Tools and forms for the admin team',
  'Portal de clientes': 'Client Portal',
  'Sube dashboards externos y da acceso a clientes con su propio usuario': 'Upload external dashboards and give clients access with their own login',
  'Datos del proyecto MVP': 'MVP project data',
  'MVP Fund Trackers': 'MVP Fund Trackers',
  'Valuación de fondos por empresa subyacente': 'Fund valuation by underlying company',
  'Reportes': 'Reports',
  'Genera el reporte de distribuciones de un LP desde las cartas de Altareturn': 'Generate an LP distributions report from the Altareturn letters',
  'Sube dashboards de MVP y da acceso a clientes con su propio usuario': 'Upload MVP dashboards and give clients access with their own login',
  'Altareturn': 'Altareturn',
  'Ingesta y consulta de documentos del portafolio MVP': 'Ingest and browse MVP portfolio documents',

  // ── Navegación / header ──
  'Inicio': 'Home',
  'Dropbox': 'Dropbox',
  'Fund Trackers': 'Fund Trackers',
  'Cambiar empresa': 'Switch org',
  'Cambiar a MVP': 'Switch to MVP',
  'Cambiar a Cretum': 'Switch to Cretum',
  'Menú': 'Menu',
  'Cerrar menú': 'Close menu',
  'Atrás': 'Back',
  'Atrás (pantalla anterior)': 'Back (previous screen)',
  'Ir al menú de empresas': 'Go to the org menu',
  'Tu cuenta': 'Your account',

  // ── Estados de sincronización ──
  'Cargando…': 'Loading…',
  'Guardando…': 'Saving…',
  'Sin conexión': 'Offline',
  'Sincronizado': 'Synced',
  'Click para sincronizar ahora': 'Click to sync now',

  // ── Menú de ajustes ──
  'Preferencias': 'Preferences',
  'Idioma': 'Language',
  'Cambia el idioma de la interfaz': 'Change the interface language',
  'Recordatorios por email': 'Email reminders',
  'Recibe un resumen automático de tus tareas': 'Get an automatic summary of your tasks',
  'Día': 'Day',
  'Hora': 'Time',
  'El resumen llega el día y la hora que elijas (hora del centro de México).': 'The summary arrives on the day and time you choose (Mexico City time).',
  'Modo oscuro': 'Dark mode',
  'Tema con fondo oscuro y mejor contraste de noche': 'Dark background with better contrast at night',
  'Enviar resumen ahora': 'Send summary now',
  'Recibe el resumen semanal por email al instante': 'Get your weekly email summary instantly',
  'Verificación en dos pasos (2FA)': 'Two-factor authentication (2FA)',
  'Protege tu cuenta con un código de tu celular': 'Protect your account with a code from your phone',
  'Ver como (prueba)': 'View as (preview)',
  'Cambia solo lo que TÚ ves, para probar. No toca la base; refresca para volver a tu rol real.': 'Changes only what YOU see, for testing. It doesn’t touch the database; refresh to return to your real role.',
  'Cerrar sesión': 'Sign out',
  'Tu nombre': 'Your name',
  'Editar nombre': 'Edit name',
};

let LANG = 'es';
try { LANG = localStorage.getItem('lang') === 'en' ? 'en' : 'es'; } catch (e) {}

/** Traduce un string de origen (español). Interpola {vars} opcionales. */
function t(es, vars) {
  let s = (LANG === 'en' && EN[es] != null) ? EN[es] : es;
  if (vars) s = String(s).replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m));
  return s;
}

function currentLang() { return LANG; }

// Guarda los valores originales (español) por elemento, para poder volver a ES.
const _orig = new WeakMap();
function _cap(el) {
  if (!_orig.has(el)) {
    _orig.set(el, {
      text: el.textContent,
      ph: el.getAttribute('placeholder'),
      title: el.getAttribute('title'),
      aria: el.getAttribute('aria-label'),
    });
  }
  return _orig.get(el);
}
function _pick(es) {
  if (es == null) return es;
  const k = String(es).trim();
  return (LANG === 'en' && EN[k] != null) ? EN[k] : es;
}

/** Aplica el idioma actual al DOM (marcado con data-i18n / -ph / -title). */
function applyI18n(root) {
  root = root || document;
  root.querySelectorAll('[data-i18n]').forEach(el => {
    const o = _cap(el);
    el.textContent = _pick(o.text);
  });
  root.querySelectorAll('[data-i18n-ph]').forEach(el => {
    const o = _cap(el);
    if (o.ph != null) el.setAttribute('placeholder', _pick(o.ph));
  });
  root.querySelectorAll('[data-i18n-title]').forEach(el => {
    const o = _cap(el);
    if (o.title != null) el.setAttribute('title', _pick(o.title));
    if (o.aria != null) el.setAttribute('aria-label', _pick(o.aria));
  });
}

/** Cambia el idioma, persiste, re-aplica al DOM y refresca lo dinámico. */
function setLang(l) {
  LANG = (l === 'en') ? 'en' : 'es';
  try { localStorage.setItem('lang', LANG); } catch (e) {}
  document.documentElement.setAttribute('lang', LANG);
  document.querySelectorAll('[data-lang]').forEach(b =>
    b.classList.toggle('active', b.getAttribute('data-lang') === LANG));
  applyI18n(document);
  // Hook que app.js define para re-renderizar vistas dinámicas (menú, nav, tareas…).
  if (typeof window.__afterLang === 'function') {
    try { window.__afterLang(); } catch (e) { console.error('[i18n afterLang]', e); }
  }
}

// Inicialización: fija <html lang>, marca el botón activo y aplica al cargar.
(function initI18n() {
  const run = () => {
    document.documentElement.setAttribute('lang', LANG);
    document.querySelectorAll('[data-lang]').forEach(b =>
      b.classList.toggle('active', b.getAttribute('data-lang') === LANG));
    applyI18n(document);
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();

// Exponer en window para uso desde app.js y onclick inline.
window.t = t;
window.setLang = setLang;
window.applyI18n = applyI18n;
window.currentLang = currentLang;
