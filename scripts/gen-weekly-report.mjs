/* ═══════════════════════════════════════════════════════════════════════════
 * Blog semanal · Avances en el desk — generador automático
 *
 * Lee los commits de la última semana con `git log`, los agrupa POR MÓDULO
 * (por el prefijo del mensaje: "Ventas:", "Campañas:", "GVV…") y POR PERSONA
 * (Angel / Eugenio / Automatización), y escribe una página estática
 * self-contained en public/blog-semanal.html (servida en cretumdesk.com/blog).
 *
 * Corre en GitHub Actions cada viernes (.github/workflows/weekly-report.yml).
 * Local: `node scripts/gen-weekly-report.mjs`  (env REPORT_DAYS=7 por defecto).
 * ═══════════════════════════════════════════════════════════════════════════ */
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'blog-semanal.html');
const DAYS = Number(process.env.REPORT_DAYS || 7);

function bucket(a) {
  const s = (a || '').toLowerCase();
  if (s.includes('eugenio')) return 'eug';
  if (s.includes('angel')) return 'angel';
  return 'auto';                         // Cretum Mini + automatización
}

const MODMAP = [
  [/^reporte/i, 'Reportes'],
  [/^(to do|tareas|detalle)/i, 'To Do'],
  [/^(ventas|editor de plantillas)/i, 'Ventas · Plantillas'],
  [/^campañas?/i, 'Campañas · Carta'],
  [/^notas/i, 'Notas'],
  [/^dropbox/i, 'Dropbox'],
  [/^(gvv|control de precios|panel admin|lock-up|docs)/i, 'GVV · Datos'],
  [/^(usuarios|home|atrás|optimización|documentar|base de datos|contactos)/i, 'Plataforma'],
];
function moduleOf(s) {
  for (const [re, name] of MODMAP) if (re.test(s)) return name;
  return 'Otros';
}

// ── Datos ──────────────────────────────────────────────────────────────────
const US = '\x1f';
const raw = execSync(
  `git log --since="${DAYS} days ago" --no-merges --date=short --pretty=format:"%h${US}%an${US}%ad${US}%s"`,
  { cwd: ROOT, encoding: 'utf8' }
).trim();

const commits = raw ? raw.split('\n').map(l => {
  const [hash, author, date, subject] = l.split(US);
  return { hash, author, date, subject, who: bucket(author), module: moduleOf(subject) };
}) : [];

// Iconos SVG propios (línea, currentColor) — sin emojis ni dependencias.
const ICONS = {
  flag: `<path d="M6 21V4h11l-2.5 3L17 10H6"/>`,
  check: `<rect x="3.5" y="3.5" width="17" height="17" rx="4.5"/><path d="M8 12.3l2.6 2.6L16.2 9"/>`,
  mail: `<rect x="3" y="5.5" width="18" height="13" rx="2.6"/><path d="M4.2 7.5 12 12.8 19.8 7.5"/>`,
  letter: `<rect x="4.5" y="3" width="15" height="18" rx="2.4"/><path d="M8.5 8h7M8.5 12h7M8.5 16h4.5"/>`,
  pencil: `<path d="M4 20.5h4L19.3 9.2l-4-4L4 16.5z"/><path d="M14 6.5l4 4"/>`,
  folder: `<path d="M3.5 7.4A1.6 1.6 0 0 1 5.1 5.8h3.6l2 2.4h7.2a1.6 1.6 0 0 1 1.6 1.6v7.8a1.6 1.6 0 0 1-1.6 1.6H5.1a1.6 1.6 0 0 1-1.6-1.6z"/>`,
  bars: `<path d="M6 20.5v-6M12 20.5V8M18 20.5v-9"/>`,
  layout: `<rect x="3.5" y="4" width="17" height="16" rx="3.2"/><path d="M3.5 9.4h17M9.2 9.4V20"/>`,
  dots: `<g fill="currentColor" stroke="none"><circle cx="6" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="18" cy="12" r="1.5"/></g>`,
  calendar: `<rect x="3.5" y="5.2" width="17" height="15.3" rx="2.6"/><path d="M3.5 9.6h17M8 3.4v3.6M16 3.4v3.6"/>`,
  clock: `<circle cx="12" cy="12" r="8.4"/><path d="M12 7.4V12l3.1 2"/>`,
  globe: `<circle cx="12" cy="12" r="8.4"/><path d="M3.6 12h16.8M12 3.6c2.6 2.3 2.6 14.5 0 16.8M12 3.6c-2.6 2.3-2.6 14.5 0 16.8"/>`,
};
function ICON(name, cls = '') {
  return `<svg class="ic${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.dots}</svg>`;
}
const MOD_ICON = {
  'Reportes': 'flag', 'To Do': 'check', 'Ventas · Plantillas': 'mail', 'Campañas · Carta': 'letter',
  'Notas': 'pencil', 'Dropbox': 'folder', 'GVV · Datos': 'bars', 'Plataforma': 'layout', 'Otros': 'dots',
};
const WHO = {
  angel: { label: 'Angel · producto', cls: 'angel' },
  eug:   { label: 'Eugenio',          cls: 'eug' },
  auto:  { label: 'Automatización',   cls: 'auto' },
};

// ── Helpers de formato ───────────────────────────────────────────────────────
const MES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
function fmtDate(iso) { const [y, m, d] = iso.split('-'); return `${+d} ${MES[+m - 1]} ${y}`; }
function fmtDay(iso) { const [, m, d] = iso.split('-'); return `${+d} ${MES[+m - 1]}`; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function shortSubject(s) { const i = s.indexOf(':'); return esc(i > -1 && i < 26 ? s.slice(i + 1).trim() : s); }
function pct(n) { return total ? (n / total * 100).toFixed(1) : 0; }

// ── Agregados ────────────────────────────────────────────────────────────────
const total = commits.length;
const counts = { angel: 0, eug: 0, auto: 0 };
commits.forEach(c => counts[c.who]++);

const byModule = {};
commits.forEach(c => (byModule[c.module] ||= []).push(c));
const modulesSorted = Object.entries(byModule).sort((a, b) => b[1].length - a[1].length);

const byWho = { angel: [], eug: [], auto: [] };
commits.forEach(c => byWho[c.who].push(c));

const byDay = {};
commits.forEach(c => (byDay[c.date] ||= []).push(c));
const days = Object.keys(byDay).sort().reverse();

const dates = commits.map(c => c.date).sort();
const range = dates.length ? `${fmtDate(dates[0])} – ${fmtDate(dates.at(-1))}` : 'sin cambios';
const genDate = fmtDate(new Date().toISOString().slice(0, 10));

// ── Render ───────────────────────────────────────────────────────────────────
const statTiles = [
  { n: total, k: 'commits en la semana', sw: '' },
  { n: counts.angel, k: 'Angel · producto', sw: 'sw-navy' },
  { n: counts.auto, k: 'Automatización GVV', sw: 'sw-auto' },
  { n: counts.eug, k: 'Eugenio', sw: 'sw-eug' },
].map(s => `<div class="stat"><div class="n">${s.n}</div><div class="k">${s.sw ? `<span class="swatch ${s.sw}"></span>` : ''}${esc(s.k)}</div></div>`).join('');

const moduleCards = modulesSorted.map(([mod, list]) => {
  const whoTags = [...new Set(list.map(c => c.who))].map(w =>
    `<span class="who ${WHO[w].cls}"><span class="swatch sw-${w === 'angel' ? 'navy' : w}"></span>${esc(WHO[w].label.split(' · ')[0])}</span>`).join('');
  const items = list.map(c =>
    `<li>${shortSubject(c.subject)} <span class="lh">${esc(c.hash)}</span></li>`).join('');
  return `<article class="card rise" data-owner="${[...new Set(list.map(c => c.who))].join(' ')}">
    <div class="card-top">
      <span class="card-icon">${ICON(MOD_ICON[mod] || 'dots')}</span>
      <h3>${esc(mod)}</h3>
      ${whoTags}
      <span class="commits">${list.length} commit${list.length === 1 ? '' : 's'}</span>
    </div>
    <ul>${items}</ul>
  </article>`;
}).join('\n');

const personBlocks = ['angel', 'auto', 'eug'].filter(w => byWho[w].length).map(w => {
  const list = byWho[w];
  const items = list.map(c =>
    `<div class="cl"><span class="h" style="color:var(--${w === 'angel' ? 'navy-2' : w})">${esc(c.hash)}</span><span>${shortSubject(c.subject)}</span></div>`).join('');
  return `<div class="panel">
    <h3><span class="swatch sw-${w === 'angel' ? 'navy' : w}" style="display:inline-block;margin-right:8px"></span>${esc(WHO[w].label)}</h3>
    <p class="sub">${list.length} commit${list.length === 1 ? '' : 's'} esta semana</p>
    <div class="commit-list">${items}</div>
  </div>`;
}).join('\n');

const logDays = days.map(day => `
  <div class="day"><p class="day-h">${fmtDay(day)} · ${byDay[day].length} commits</p>
    ${byDay[day].map(c => `<div class="lrow"><span class="lw" style="background:var(--${c.who === 'angel' ? 'navy' : c.who})"></span><span class="lh">${esc(c.hash)}</span><span>${esc(c.subject)}</span></div>`).join('')}
  </div>`).join('');

const emptyState = `<section><div class="wrap"><div class="panel" style="text-align:center;padding:48px 22px">
  <h3 style="margin-bottom:8px">Semana tranquila</h3>
  <p class="sub" style="margin:0">No hubo commits en los últimos ${DAYS} días. El próximo viernes se regenera.</p>
</div></div></section>`;

const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>Avances en el desk · Cretum</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect x='1' y='1' width='30' height='30' rx='7' fill='%231A3A6B'/><g fill='%23fff'><rect x='7.4' y='17' width='4.2' height='8' rx='1.4'/><rect x='13.9' y='11.5' width='4.2' height='13.5' rx='1.4'/><rect x='20.4' y='7.5' width='4.2' height='17.5' rx='1.4'/></g></svg>">
<style>
${STYLE()}
</style>
</head>
<body>
<header>
  <div class="wrap rise">
    <p class="eyebrow"><span class="dot"></span> Blog semanal · Avances en el desk</p>
    <h1>Qué se movió esta semana en Cretum Desk</h1>
    <p class="lede">Generado automáticamente desde los commits de la semana. Agrupado por módulo y por quién lo llevó.</p>
    <div class="meta-row">
      <span class="tag">${ICON('calendar', 'ti')} Periodo <b>${esc(range)}</b></span>
      <span class="tag">${ICON('clock', 'ti')} Cadencia <b>viernes</b></span>
      <span class="tag">${ICON('globe', 'ti')} <b>cretumdesk.com</b></span>
    </div>
    <div class="stats">${statTiles}</div>
    <div class="distrib">
      <div class="bar" id="bar">
        <div class="seg seg-navy" data-w="${pct(counts.angel)}" title="Angel · ${counts.angel}"></div>
        <div class="seg seg-auto" data-w="${pct(counts.auto)}" title="Automatización · ${counts.auto}"></div>
        <div class="seg seg-eug" data-w="${pct(counts.eug)}" title="Eugenio · ${counts.eug}"></div>
      </div>
      <div class="cap">Distribución de commits · ${modulesSorted.length} módulos tocados · ${days.length} días activos</div>
    </div>
  </div>
</header>
<main>
${total === 0 ? emptyState : `
  <section><div class="wrap">
    <div class="sec-head"><span class="num">01</span><h2>Lo que se movió, por módulo</h2></div>
    <div class="filter" role="group" aria-label="Filtrar por autor">
      <button class="fbtn" data-filter="all" aria-pressed="true">Todos</button>
      <button class="fbtn" data-filter="angel" aria-pressed="false"><span class="swatch sw-navy"></span> Angel</button>
      <button class="fbtn" data-filter="eug" aria-pressed="false"><span class="swatch sw-eug"></span> Eugenio</button>
      <button class="fbtn" data-filter="auto" aria-pressed="false"><span class="swatch sw-auto"></span> Automatización</button>
    </div>
    <div class="cards" id="cards">${moduleCards}</div>
  </div></section>

  <section><div class="wrap">
    <div class="sec-head"><span class="num">02</span><h2>Qué hizo cada quien</h2></div>
    <div class="duo">${personBlocks}</div>
  </div></section>

  <section><div class="wrap">
    <div class="sec-head"><span class="num">03</span><h2>Cómo se trabaja</h2></div>
    <div class="panel">
      <div class="flow">
        <div class="step"><div class="rail"><div class="node">1</div><div class="line"></div></div><div class="body"><b>Necesidad</b><span>Sale de una petición, un reporte del equipo o un pendiente.</span></div></div>
        <div class="step"><div class="rail"><div class="node">2</div><div class="line"></div></div><div class="body"><b>Construir + revisar</b><span>Se arma, se valida y se muestra antes de tocar producción.</span></div></div>
        <div class="step"><div class="rail"><div class="node">3</div><div class="line"></div></div><div class="body"><b>Aprobación</b><span>Nada se despliega sin visto bueno.</span></div></div>
        <div class="step"><div class="rail"><div class="node">4</div><div class="line"></div></div><div class="body"><b>Deploy</b><span>Push a <span class="mono">main</span> → Vercel despliega solo → <span class="mono">cretumdesk.com</span>.</span></div></div>
      </div>
    </div>
  </div></section>

  <section><div class="wrap">
    <div class="sec-head"><span class="num">04</span><h2>Registro de GitHub</h2></div>
    <details class="log">
      <summary><span class="caret">▸</span> Ver los ${total} commits de la semana <span class="count">${esc(range)}</span></summary>
      <div class="logbody">${logDays}</div>
    </details>
  </div></section>
`}
</main>
<footer>
  <div class="wrap">
    <span>Blog semanal · <b style="color:var(--ink-soft)">Cretum Desk</b></span>
    <span class="mono">Generado ${esc(genDate)} · automático los viernes</span>
  </div>
</footer>
<script>
(function(){
  "use strict";
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function fillBar(){ document.querySelectorAll('#bar .seg').forEach(function(s){ s.style.width = s.getAttribute('data-w') + '%'; }); }
  if (reduce) fillBar(); else requestAnimationFrame(function(){ setTimeout(fillBar, 120); });
  var cards = Array.prototype.slice.call(document.querySelectorAll('#cards .card'));
  document.querySelectorAll('.fbtn').forEach(function(btn){
    btn.addEventListener('click', function(){
      var f = btn.getAttribute('data-filter');
      document.querySelectorAll('.fbtn').forEach(function(b){ b.setAttribute('aria-pressed', b === btn ? 'true' : 'false'); });
      cards.forEach(function(c){
        var owners = (c.getAttribute('data-owner') || '').split(' ');
        c.classList.toggle('is-hidden', !(f === 'all' || owners.indexOf(f) !== -1));
      });
    });
  });
})();
</script>
</body>
</html>`;

writeFileSync(OUT, html, 'utf8');
console.log(`[blog-semanal] ${total} commits (${range}) → ${OUT}`);

// ── Estilos (idénticos al diseño aprobado del reporte) ───────────────────────
function STYLE() {
  return `
  :root{
    --bg:#F5F8FC; --surface:#FFFFFF; --surface-2:#EEF3FA; --raise:0 1px 2px rgba(18,30,54,.05),0 6px 20px rgba(18,30,54,.05);
    --ink:#17202E; --ink-soft:#525E72; --ink-mute:#8894A6;
    --line:#E2E9F2; --line-soft:#EDF1F7;
    --navy:#1A3A6B; --navy-2:#2E5BA3; --navy-pale:#E9F0FA;
    --green:#2E9C68; --green-bg:#E4F3EB; --amber:#B9782A; --amber-bg:#F6ECDA;
    --eug:#177E86; --eug-bg:#E1F1F1; --auto:#5C6B82; --auto-bg:#EAEEF4;
    --focus:#2E5BA3; --maxw:860px;
  }
  @media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
    --bg:#0D1421; --surface:#141D2F; --surface-2:#1A2540; --raise:0 1px 2px rgba(0,0,0,.3),0 8px 24px rgba(0,0,0,.28);
    --ink:#E7ECF5; --ink-soft:#A7B3C7; --ink-mute:#6E7B91; --line:#26324A; --line-soft:#1E2939;
    --navy:#79A2E4; --navy-2:#9CBDF0; --navy-pale:#1B2A47;
    --green:#4FC088; --green-bg:rgba(79,192,136,.15); --amber:#E0A250; --amber-bg:rgba(224,162,80,.15);
    --eug:#4FBEC6; --eug-bg:rgba(79,190,198,.15); --auto:#93A2BB; --auto-bg:rgba(147,162,187,.15); --focus:#9CBDF0;
  }}
  *{box-sizing:border-box} html{-webkit-text-size-adjust:100%}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;letter-spacing:-.006em;-webkit-font-smoothing:antialiased}
  .mono,.lh{font-family:ui-monospace,"SF Mono","Cascadia Code","JetBrains Mono",Menlo,Consolas,monospace}
  .wrap{max-width:var(--maxw);margin:0 auto;padding:0 22px}
  :focus-visible{outline:2px solid var(--focus);outline-offset:3px;border-radius:6px}
  @keyframes rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
  .rise{animation:rise .55s cubic-bezier(.22,1,.36,1) both}
  @media (prefers-reduced-motion:reduce){.rise{animation:none}}
  header{padding:54px 0 30px;border-bottom:1px solid var(--line)}
  .eyebrow{font-family:ui-monospace,monospace;font-size:12.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--navy-2);display:flex;align-items:center;gap:9px;margin:0 0 18px}
  .eyebrow .dot{width:7px;height:7px;border-radius:50%;background:var(--navy-2);box-shadow:0 0 0 4px var(--navy-pale)}
  h1{font-size:clamp(30px,5.6vw,46px);line-height:1.05;letter-spacing:-.03em;font-weight:700;margin:0 0 16px;text-wrap:balance}
  .lede{font-size:clamp(16px,2.3vw,18.5px);color:var(--ink-soft);max-width:60ch;margin:0;text-wrap:pretty}
  .meta-row{display:flex;flex-wrap:wrap;gap:8px 10px;margin-top:22px}
  .tag{font-size:12.5px;font-weight:500;padding:5px 11px;border-radius:999px;background:var(--surface-2);color:var(--ink-soft);border:1px solid var(--line);display:inline-flex;align-items:center;gap:6px}
  .tag b{color:var(--ink);font-weight:600}
  .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:26px 0 6px}
  @media (max-width:640px){.stats{grid-template-columns:repeat(2,1fr)}}
  .stat{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:16px 16px 14px;box-shadow:var(--raise)}
  .stat .n{font-size:30px;font-weight:700;letter-spacing:-.03em;line-height:1;font-variant-numeric:tabular-nums}
  .stat .k{font-size:12.5px;color:var(--ink-mute);margin-top:7px;display:flex;align-items:center;gap:6px}
  .swatch{width:9px;height:9px;border-radius:3px;flex:0 0 auto}
  .sw-navy{background:var(--navy)} .sw-eug{background:var(--eug)} .sw-auto{background:var(--auto)}
  .distrib{margin:20px 0 4px}
  .distrib .bar{display:flex;height:16px;border-radius:8px;overflow:hidden;border:1px solid var(--line);background:var(--surface-2)}
  .distrib .seg{height:100%;width:0;transition:width 1.1s cubic-bezier(.22,1,.36,1)}
  @media (prefers-reduced-motion:reduce){.distrib .seg{transition:none}}
  .seg-navy{background:var(--navy)} .seg-auto{background:var(--auto)} .seg-eug{background:var(--eug)}
  .distrib .cap{font-size:12.5px;color:var(--ink-mute);margin-top:9px}
  section{padding:38px 0}
  .sec-head{display:flex;align-items:baseline;gap:12px;margin:0 0 20px}
  .sec-head h2{font-size:22px;font-weight:700;letter-spacing:-.02em;margin:0}
  .sec-head .num{font-family:ui-monospace,monospace;font-size:12.5px;color:var(--ink-mute);letter-spacing:.06em;padding-top:3px}
  .sec-note{color:var(--ink-soft);margin:-8px 0 20px;font-size:15px;max-width:64ch}
  .filter{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 22px}
  .fbtn{font-size:13.5px;font-weight:500;padding:7px 14px;border-radius:999px;cursor:pointer;background:var(--surface);border:1px solid var(--line);color:var(--ink-soft);display:inline-flex;align-items:center;gap:7px;transition:border-color .15s,color .15s,background .15s}
  .fbtn:hover{border-color:var(--navy-2);color:var(--ink)}
  .fbtn[aria-pressed="true"]{background:var(--navy);border-color:var(--navy);color:#fff}
  @media (prefers-color-scheme:dark){:root:not([data-theme="light"]) .fbtn[aria-pressed="true"]{color:#0D1421}}
  .cards{display:flex;flex-direction:column;gap:14px}
  .card{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:20px 22px;box-shadow:var(--raise);transition:transform .18s ease,border-color .18s ease}
  .card.is-hidden{display:none}
  .card:hover{transform:translateY(-2px);border-color:var(--navy-pale)}
  .card-top{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:6px}
  .card-top h3{font-size:18px;font-weight:650;letter-spacing:-.015em;margin:0}
  .card-icon{width:34px;height:34px;border-radius:10px;background:var(--navy-pale);color:var(--navy);display:grid;place-items:center;flex:0 0 auto}
  .ic{width:18px;height:18px;display:block}
  .ic.ti{width:13px;height:13px}
  .tag .ic{opacity:.85}
  .who{font-size:11.5px;font-weight:600;padding:3px 9px 3px 7px;border-radius:999px;display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
  .who.angel{background:var(--navy-pale);color:var(--navy-2)} .who.eug{background:var(--eug-bg);color:var(--eug)} .who.auto{background:var(--auto-bg);color:var(--auto)}
  .who .swatch{border-radius:50%}
  .card .commits{margin-left:auto;font-family:ui-monospace,monospace;font-size:12px;color:var(--ink-mute);white-space:nowrap}
  .card ul{margin:12px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:9px}
  .card li{position:relative;padding-left:22px;color:var(--ink-soft);font-size:14.5px;line-height:1.55}
  .card li::before{content:"";position:absolute;left:4px;top:9px;width:7px;height:7px;border-radius:2px;background:var(--navy);opacity:.55}
  .card li .lh{font-size:11px;color:var(--ink-mute);margin-left:4px}
  .duo{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  @media (max-width:720px){.duo{grid-template-columns:1fr}}
  .panel{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:22px;box-shadow:var(--raise)}
  .panel h3{margin:0 0 4px;font-size:17px;font-weight:650;letter-spacing:-.01em;display:flex;align-items:center}
  .panel .sub{color:var(--ink-mute);font-size:13px;margin:0 0 16px}
  .commit-list{display:flex;flex-direction:column;gap:8px}
  .cl{display:flex;gap:11px;align-items:baseline;font-size:14px;color:var(--ink-soft)}
  .cl .h{font-family:ui-monospace,monospace;font-size:11.5px;flex:0 0 auto;padding-top:1px}
  .flow{display:flex;flex-direction:column}
  .step{display:flex;gap:14px;position:relative;padding-bottom:18px}
  .step:last-child{padding-bottom:0}
  .step .rail{display:flex;flex-direction:column;align-items:center;flex:0 0 auto}
  .step .node{width:28px;height:28px;border-radius:50%;background:var(--navy-pale);color:var(--navy);display:grid;place-items:center;font-size:12px;font-weight:700;font-family:ui-monospace,monospace;z-index:1}
  .step .line{width:2px;flex:1;background:var(--line);margin:3px 0 -3px}
  .step:last-child .line{display:none}
  .step .body{padding-top:2px}
  .step .body b{display:block;font-size:15px;color:var(--ink);font-weight:600}
  .step .body span{font-size:13.5px;color:var(--ink-soft)}
  details.log{background:var(--surface);border:1px solid var(--line);border-radius:14px;box-shadow:var(--raise);overflow:hidden}
  details.log summary{cursor:pointer;padding:16px 20px;font-weight:600;font-size:15px;list-style:none;display:flex;align-items:center;gap:10px}
  details.log summary::-webkit-details-marker{display:none}
  details.log summary .caret{transition:transform .2s ease;color:var(--ink-mute)}
  details.log[open] summary .caret{transform:rotate(90deg)}
  details.log summary .count{margin-left:auto;font-family:ui-monospace,monospace;font-size:12px;color:var(--ink-mute)}
  .logbody{padding:4px 20px 18px;border-top:1px solid var(--line-soft)}
  .day{margin-top:16px}
  .day-h{font-family:ui-monospace,monospace;font-size:12px;letter-spacing:.05em;color:var(--ink-mute);text-transform:uppercase;margin:0 0 8px;padding-top:8px;border-top:1px dashed var(--line)}
  .day:first-child .day-h{border-top:none;padding-top:0}
  .lrow{display:flex;gap:10px;align-items:baseline;padding:4px 0;font-size:13.5px;color:var(--ink-soft);line-height:1.45}
  .lrow .lw{width:8px;height:8px;border-radius:2px;flex:0 0 auto;position:relative;top:4px}
  footer{border-top:1px solid var(--line);padding:30px 0 60px;color:var(--ink-mute);font-size:13px;margin-top:20px}
  footer .wrap{display:flex;flex-wrap:wrap;gap:6px 14px;justify-content:space-between;align-items:center}`;
}
