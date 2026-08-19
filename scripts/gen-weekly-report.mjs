/* ═══════════════════════════════════════════════════════════════════════════
 * Blog semanal · Avances en el desk — generador automático
 *
 * Lee los commits de la última semana con `git log`, los agrupa POR MÓDULO
 * (por el prefijo del mensaje) y POR PERSONA (Angel / Eugenio / Automatización),
 * y escribe una página estática self-contained en public/blog-semanal.html
 * (servida en cretumdesk.com/blog).
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
  [/^(usuarios|home|atrás|optimización|documentar|base de datos|contactos|blog)/i, 'Plataforma'],
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
  search: `<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>`,
  copy: `<rect x="8.5" y="8.5" width="11" height="11" rx="2.5"/><path d="M15.5 8.5V6A2 2 0 0 0 13.5 4h-7A2 2 0 0 0 4.5 6v7a2 2 0 0 0 2 2H8.5"/>`,
  sun: `<circle cx="12" cy="12" r="4.2"/><path d="M12 2.6v2.3M12 19.1v2.3M4.9 4.9l1.6 1.6M17.5 17.5l1.6 1.6M2.6 12h2.3M19.1 12h2.3M4.9 19.1l1.6-1.6M17.5 6.5l1.6-1.6"/>`,
  moon: `<path d="M20 14.4A8 8 0 1 1 9.6 4 6.5 6.5 0 0 0 20 14.4z"/>`,
};
function ICON(name, cls = '') {
  return `<svg class="ic${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.dots}</svg>`;
}
const MOD_ICON = {
  'Reportes': 'flag', 'To Do': 'check', 'Ventas · Plantillas': 'mail', 'Campañas · Carta': 'letter',
  'Notas': 'pencil', 'Dropbox': 'folder', 'GVV · Datos': 'bars', 'Plataforma': 'layout', 'Otros': 'dots',
};
const WHO = {
  angel: { label: 'Angel · producto', short: 'Angel', sw: 'navy' },
  eug:   { label: 'Eugenio', short: 'Eugenio', sw: 'eug' },
  auto:  { label: 'Automatización GVV', short: 'Automatización', sw: 'auto' },
};

// ── Helpers de formato ───────────────────────────────────────────────────────
const MES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
function fmtDate(iso) { const [y, m, d] = iso.split('-'); return `${+d} ${MES[+m - 1]} ${y}`; }
function fmtDay(iso) { const [, m, d] = iso.split('-'); return `${+d} ${MES[+m - 1]}`; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function shortSubject(s) { const i = s.indexOf(':'); return esc(i > -1 && i < 26 ? s.slice(i + 1).trim() : s); }

// ── Agregados ────────────────────────────────────────────────────────────────
const total = commits.length;
const counts = { angel: 0, eug: 0, auto: 0 };
commits.forEach(c => counts[c.who]++);
const maxWho = Math.max(1, counts.angel, counts.eug, counts.auto);

const byModule = {};
commits.forEach(c => (byModule[c.module] ||= []).push(c));
const modulesSorted = Object.entries(byModule).sort((a, b) => b[1].length - a[1].length);
const maxMod = modulesSorted.length ? modulesSorted[0][1].length : 1;

const byWho = { angel: [], eug: [], auto: [] };
commits.forEach(c => byWho[c.who].push(c));

const byDay = {};
commits.forEach(c => (byDay[c.date] ||= []).push(c));
const dayKeys = Object.keys(byDay).sort().reverse();

const dates = commits.map(c => c.date).sort();
const range = dates.length ? `${fmtDate(dates[0])} – ${fmtDate(dates.at(-1))}` : 'sin cambios';
const genDate = fmtDate(new Date().toISOString().slice(0, 10));

// Actividad por día: 7 días que terminan en el último commit (rellena ceros).
const DOW = ['D', 'L', 'M', 'M', 'J', 'V', 'S'];
const lastIso = dates.length ? dates.at(-1) : new Date().toISOString().slice(0, 10);
const weekDays = [];
{
  const base = new Date(lastIso + 'T00:00:00');
  for (let i = 6; i >= 0; i--) {
    const d = new Date(base); d.setDate(base.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    weekDays.push({ iso, dow: DOW[d.getDay()], day: +iso.slice(8), count: (byDay[iso] || []).length });
  }
}
const maxDay = Math.max(1, ...weekDays.map(d => d.count));

// Historial ~13 semanas: heatmap estilo GitHub + tendencia semanal por módulo.
const HEAT_WEEKS = 13;
const histRaw = execSync(
  `git log --since="${HEAT_WEEKS * 7 + 7} days ago" --no-merges --date=short --pretty=format:"%ad${US}%s"`,
  { cwd: ROOT, encoding: 'utf8' }
).trim();
const hist = histRaw ? histRaw.split('\n').map(l => { const [d, s] = l.split(US); return { date: d, module: moduleOf(s) }; }) : [];
const histByDate = {};
hist.forEach(h => { histByDate[h.date] = (histByDate[h.date] || 0) + 1; });

const ONE_DAY = 86400000;
const gridEnd = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00');
const gridStart = new Date(gridEnd);
gridStart.setDate(gridEnd.getDate() - (HEAT_WEEKS * 7 - 1));
gridStart.setDate(gridStart.getDate() - ((gridStart.getDay() + 6) % 7)); // atrás hasta lunes
const heatCells = [];
for (let d = new Date(gridStart); d <= gridEnd; d.setDate(d.getDate() + 1)) {
  const iso = d.toISOString().slice(0, 10);
  heatCells.push({ iso, count: histByDate[iso] || 0 });
}
const heatMax = Math.max(1, ...heatCells.map(c => c.count));
const NWEEKS = Math.ceil(heatCells.length / 7);
function heatLevel(n) { if (!n) return 0; const r = n / heatMax; return r > .75 ? 4 : r > .5 ? 3 : r > .25 ? 2 : 1; }
function weekIdx(iso) { const dd = (new Date(iso + 'T00:00:00') - gridStart) / ONE_DAY; return dd < 0 ? -1 : Math.floor(dd / 7); }

// Tendencia semanal por módulo (para sparklines).
const modWeekly = {};
hist.forEach(h => { const wi = weekIdx(h.date); if (wi < 0 || wi >= NWEEKS) return; (modWeekly[h.module] ||= Array(NWEEKS).fill(0))[wi]++; });

// Resumen en texto plano (para el botón "Copiar resumen").
const summaryText = [
  `Blog semanal · Cretum Desk (${range})`,
  `${total} commits — Angel ${counts.angel} · Automatización ${counts.auto} · Eugenio ${counts.eug}`,
  '', 'Por módulo:',
  ...modulesSorted.map(([m, l]) => `• ${m}: ${l.length}`),
].join('\n');

// ── Render de secciones ──────────────────────────────────────────────────────
const chartCols = weekDays.map((d, i) => `
  <div class="acol" style="--i:${i}">
    <div class="aval">${d.count || ''}</div>
    <div class="abar"><div class="afill${d.count === maxDay && d.count > 0 ? ' peak' : ''}${d.count === 0 ? ' zero' : ''}" style="--h:${(d.count / maxDay * 100).toFixed(1)}%" title="${d.dow} ${fmtDay(d.iso)} · ${d.count} commit${d.count === 1 ? '' : 's'}"></div></div>
    <div class="adow">${d.dow}<span class="adate">${d.day}</span></div>
  </div>`).join('');

const legend = ['angel', 'auto', 'eug'].map(w =>
  `<span class="lg"><span class="swatch sw-${WHO[w].sw}"></span>${esc(WHO[w].short)} <b>${counts[w]}</b></span>`).join('');

// Dona de reparto por persona (SVG, arcos por proporción).
function donutSvg() {
  const r = 40, C = 2 * Math.PI * r, cx = 52, cy = 52, sw = 15;
  const segs = [['navy', counts.angel], ['auto', counts.auto], ['eug', counts.eug]].filter(s => s[1] > 0);
  let off = 0;
  const arcs = segs.map(([k, v]) => {
    const len = v / total * C;
    const a = `<circle class="a-${k}" cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke-width="${sw}" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}"/>`;
    off += len; return a;
  }).join('');
  return `<svg class="donut" viewBox="0 0 104 104" role="img" aria-label="Reparto de commits por persona">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--surface-2)" stroke-width="${sw}"/>
    <g transform="rotate(-90 ${cx} ${cy})">${arcs}</g>
    <text x="${cx}" y="${cy - 1}" class="don-n">${total}</text>
    <text x="${cx}" y="${cy + 14}" class="don-k">commits</text>
  </svg>`;
}
// Sparkline (área + línea) de la tendencia semanal de un módulo.
function sparkSvg(vals) {
  const w = 108, h = 26, n = vals.length, mx = Math.max(1, ...vals);
  if (n < 2) return '';
  const pts = vals.map((v, i) => [i / (n - 1) * w, h - 2 - v / mx * (h - 5)]);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  const area = `M0 ${h} ` + pts.map(p => `L${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ') + ` L${w} ${h} Z`;
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><path class="spark-a" d="${area}"/><path class="spark-l" d="${line}"/></svg>`;
}
const heatGrid = heatCells.map(c =>
  `<span class="hc h${heatLevel(c.count)}" title="${fmtDay(c.iso)} · ${c.count} commit${c.count === 1 ? '' : 's'}"></span>`).join('');

const moduleCards = modulesSorted.map(([mod, list], idx) => {
  const owners = [...new Set(list.map(c => c.who))];
  const whoTags = owners.map(w => `<span class="who ${w}"><span class="swatch sw-${WHO[w].sw}"></span>${esc(WHO[w].short)}</span>`).join('');
  const items = list.map((c, li) => `<li style="--li:${Math.min(li, 12)}">${shortSubject(c.subject)} <span class="lh">${esc(c.hash)}</span></li>`).join('');
  return `<article class="card reveal" data-owner="${owners.join(' ')}">
    <div class="card-top">
      <span class="card-icon">${ICON(MOD_ICON[mod] || 'dots')}</span>
      <div class="card-h"><h3>${esc(mod)}</h3><div class="card-who">${whoTags}</div></div>
      <span class="card-n">${list.length}<span>commit${list.length === 1 ? '' : 's'}</span></span>
    </div>
    ${sparkSvg(modWeekly[mod] || Array(NWEEKS).fill(0))}
    <ul>${items}</ul>
  </article>`;
}).join('\n');

const personBlocks = ['angel', 'auto', 'eug'].filter(w => byWho[w].length).map(w => {
  const list = byWho[w];
  const items = list.slice(0, 6).map((c, ci) => `<div class="cl" style="--li:${ci}"><span class="h">${esc(c.hash)}</span><span>${shortSubject(c.subject)}</span></div>`).join('');
  const more = list.length > 6 ? `<div class="pmore">+${list.length - 6} más</div>` : '';
  return `<div class="prow reveal">
    <div class="phead"><span class="swatch sw-${WHO[w].sw}"></span><span class="pname">${esc(WHO[w].label)}</span><span class="pcount">${list.length}</span></div>
    <div class="pbar"><div class="pbar-fill fill-${w}" style="--s:${(list.length / maxWho).toFixed(3)}"></div></div>
    <div class="pcommits">${items}${more}</div>
  </div>`;
}).join('\n');

const logDays = dayKeys.map(day => `
  <div class="day"><p class="day-h">${fmtDay(day)} · ${byDay[day].length} commits</p>
    ${byDay[day].map((c, ri) => `<div class="lrow" style="--li:${Math.min(ri, 14)}"><span class="lw sw-${WHO[c.who].sw}"></span><span class="lh">${esc(c.hash)}</span><span>${esc(c.subject)}</span></div>`).join('')}
  </div>`).join('');

const emptyState = `<section class="wrap"><div class="empty reveal">
  <h3>Semana tranquila</h3><p>No hubo commits en los últimos ${DAYS} días. El próximo viernes se regenera.</p>
</div></section>`;

const body = total === 0 ? emptyState : `
  <nav class="snav" id="snav">
    <div class="wrap snav-in">
      <div class="snav-links">
        <a href="#resumen" class="on">Resumen</a>
        <a href="#modulos">Módulos</a>
        <a href="#personas">Personas</a>
        <a href="#registro">Registro</a>
      </div>
      <div class="snav-act">
        <button class="iconbtn" id="copyBtn" title="Copiar resumen">${ICON('copy')}<span>Copiar</span></button>
      </div>
    </div>
  </nav>

  <!-- TENTATIVO (futuro, opcional): bloque "Destacado de la semana" con imagen.
       Un admin subiría 1 captura + texto (p. ej. a Supabase Storage, bucket público)
       y aquí se insertaría SOLO si existe; si no, no aparece. Así el resto sigue
       auto-generado desde git y este bloque queda como toque manual opcional. -->
  <section id="resumen" class="wrap sec">
    <div class="sec-head"><h2 class="type">Resumen de la semana</h2><span class="sec-meta">${range}</span></div>
    <div class="summary reveal">
      <div class="chart-card">
        <div class="chart-lbl">Actividad por día</div>
        <div class="chart" id="chart" role="img" aria-label="Commits por día de la semana">${chartCols}</div>
      </div>
      <div class="dist-card">
        <div class="chart-lbl">Reparto por persona</div>
        <div class="donut-wrap">${donutSvg()}</div>
        <div class="legend">${legend}</div>
        <div class="dist-note">${modulesSorted.length} módulos tocados · ${dayKeys.length} días activos</div>
      </div>
    </div>
    <div class="heat-card reveal">
      <div class="heat-top"><div class="chart-lbl">Actividad de las últimas ${HEAT_WEEKS} semanas</div>
        <div class="heat-legend"><span>Menos</span><span class="hc h0"></span><span class="hc h1"></span><span class="hc h2"></span><span class="hc h3"></span><span class="hc h4"></span><span>Más</span></div></div>
      <div class="heat-scroll"><div class="heat" role="img" aria-label="Mapa de calor de commits por día (últimas ${HEAT_WEEKS} semanas)">${heatGrid}</div></div>
    </div>
  </section>

  <section id="modulos" class="wrap sec">
    <div class="sec-head"><h2 class="type">Lo que se movió, por módulo</h2></div>
    <div class="filter" role="group" aria-label="Filtrar por autor">
      <button class="fbtn" data-filter="all" aria-pressed="true">Todos</button>
      <button class="fbtn" data-filter="angel" aria-pressed="false"><span class="swatch sw-navy"></span> Angel</button>
      <button class="fbtn" data-filter="eug auto" aria-pressed="false"><span class="swatch sw-eug"></span><span class="swatch sw-auto" style="margin-left:-4px"></span> Eugenio + Automatización</button>
    </div>
    <div class="cards" id="cards">${moduleCards}</div>
  </section>

  <section id="personas" class="wrap sec">
    <div class="sec-head"><h2 class="type">Qué hizo cada quien</h2></div>
    <div class="ppl">${personBlocks}</div>
  </section>

  <section id="registro" class="wrap sec">
    <div class="sec-head"><h2 class="type">Registro de GitHub</h2><span class="sec-meta">${total} commits</span></div>
    <div class="search reveal">${ICON('search', 'ic-s')}<input id="q" type="search" placeholder="Buscar en los commits (módulo, texto, hash…)" autocomplete="off" aria-label="Buscar commits"></div>
    <div class="logbody reveal" id="logbody">${logDays}</div>
  </section>`;

const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>Noticias Cretum</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect x='1' y='1' width='30' height='30' rx='7' fill='%231A3A6B'/><g fill='%23fff'><rect x='7.4' y='17' width='4.2' height='8' rx='1.4'/><rect x='13.9' y='11.5' width='4.2' height='13.5' rx='1.4'/><rect x='20.4' y='7.5' width='4.2' height='17.5' rx='1.4'/></g></svg>">
<script>try{var r=document.documentElement,t=localStorage.getItem('blog-theme');if(t==='light'||t==='dark')r.setAttribute('data-theme',t);r.setAttribute('data-eff',r.getAttribute('data-theme')||(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light'));}catch(e){}</script>
<style>
${STYLE()}
</style>
</head>
<body>
<div class="progress" id="progress" aria-hidden="true"></div>

<nav class="tabbar" id="tabbar">
  <div class="wrap tabbar-in">
    <span class="brand"><span class="brand-mark"></span> Cretum</span>
    <div class="tabs" role="tablist" aria-label="Secciones">
      <button class="tab on" data-pane="noticias" role="tab" aria-selected="true">Noticias</button>
      <button class="tab" data-pane="avances" role="tab" aria-selected="false">Avances del desk</button>
    </div>
    <div class="news-lang" id="newsLang" role="group" aria-label="Idioma de las noticias">
      <button type="button" class="nl-btn" data-nlang="es">ES</button>
      <button type="button" class="nl-btn" data-nlang="en">EN</button>
    </div>
    <button class="iconbtn only-ic" id="themeBtn" title="Cambiar tema" aria-label="Cambiar tema">${ICON('moon', 'ic-moon')}${ICON('sun', 'ic-sun')}</button>
  </div>
</nav>

<main>
  <!-- ═══════════ NOTICIAS (principal) ═══════════ -->
  <section class="pane on" id="pane-noticias">
    <header class="hero-news">
      <div class="wrap">
        <p class="eyebrow reveal" style="--d:40ms"><span class="pulse"></span> <span id="newsEyebrowTx">Novedades del portafolio</span></p>
        <h1 class="hnews-title reveal" id="newsH1" style="--d:110ms">Noticias de las empresas en seguimiento</h1>
        <p class="lede reveal" id="newsLede" style="--d:180ms">Titulares recientes de las compañías donde invierte el portafolio, de <b>medios confiables</b> (Reuters, Bloomberg, TechCrunch, CNBC, FT…). Se actualiza varias veces al día.</p>
        <div class="meta-row reveal" style="--d:280ms">
          <span class="tag">${ICON('globe', 'ti')} <b id="newsMetaCount">cargando…</b></span>
          <span class="tag">${ICON('clock', 'ti')} <span id="newsMetaWhenLbl">actualizado</span> <b id="newsMetaWhen">—</b></span>
        </div>
      </div>
    </header>
    <div class="wrap sec">
      <div class="news-bar">
        <div class="news-cddf" id="newsCddf">
          <button type="button" class="news-cddf-btn" id="newsFilterBtn" aria-haspopup="true" aria-expanded="false" onclick="toggleNewsFilter(event)">
            ${ICON('globe', 'ti')} <span id="newsFilterLabel">Todas las empresas</span> <span class="news-cddf-chev" aria-hidden="true">▾</span>
          </button>
          <div class="news-cddf-panel" id="newsFilterPanel" role="menu">
            <p class="news-cddf-hint" id="newsFilterHint">Filtra según la(s) empresa(s) que sean de tu interés.</p>
            <div class="news-cddf-search"><input type="text" id="newsFilterSearch" placeholder="Buscar empresa…" autocomplete="off" oninput="filterNewsFilterList(this.value)"></div>
            <div class="news-cddf-list" id="newsFilterList"></div>
            <div class="news-cddf-foot"><button type="button" class="news-cddf-clear" id="newsFilterClear" onclick="newsFilterClear()">Limpiar</button></div>
          </div>
        </div>
      </div>
      <div class="news-grid" id="newsGrid"><div class="news-empty">Cargando noticias…</div></div>
    </div>
  </section>

  <!-- ═══════════ AVANCES DEL DESK (secundario) ═══════════ -->
  <section class="pane" id="pane-avances" hidden>
    <header>
      <div class="wrap">
        <p class="eyebrow reveal" style="--d:40ms"><span class="pulse"></span> Blog semanal · Avances en el desk</p>
        <h1>El pulso de la semana en Cretum&nbsp;Desk</h1>
        <p class="lede reveal" style="--d:180ms">Lo que se construyó estos días, sacado de los commits y ordenado por módulo y por quién lo llevó. Se regenera solo cada viernes.</p>
        <div class="meta-row reveal" style="--d:280ms">
          <span class="tag">${ICON('calendar', 'ti')} <b>${esc(range)}</b></span>
          <span class="tag">${ICON('clock', 'ti')} Cada <b>viernes</b></span>
          <span class="tag">${ICON('globe', 'ti')} <b>cretumdesk.com</b></span>
        </div>
        <div class="hstats reveal" style="--d:360ms">
          <div class="hstat"><div class="n" data-count="${total}">0</div><div class="k">commits</div></div>
          <div class="hstat"><div class="n" data-count="${counts.angel}">0</div><div class="k"><span class="swatch sw-navy"></span>Angel</div></div>
          <div class="hstat"><div class="n" data-count="${counts.auto}">0</div><div class="k"><span class="swatch sw-auto"></span>Automatización</div></div>
          <div class="hstat"><div class="n" data-count="${counts.eug}">0</div><div class="k"><span class="swatch sw-eug"></span>Eugenio</div></div>
        </div>
      </div>
    </header>
    ${body}
  </section>
</main>
<footer>
  <div class="wrap">
    <span>Blog semanal · <b>Cretum Desk</b></span>
    <span class="mono">Generado ${esc(genDate)} · automático los viernes</span>
  </div>
</footer>
<div class="toast" id="toast" role="status" aria-live="polite"></div>
<script>
const SUMMARY = ${JSON.stringify(summaryText)};
(function(){
  "use strict";
  var reduce = matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var root = document.documentElement;

  // ── Tema (persistente) ──
  var TKEY = 'blog-theme';
  var saved = localStorage.getItem(TKEY);
  if (saved === 'light' || saved === 'dark') root.setAttribute('data-theme', saved);
  function effective(){ return root.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); }
  function syncTheme(){ root.setAttribute('data-eff', effective()); }
  syncTheme();
  var themeBtn = document.getElementById('themeBtn');
  if (themeBtn) themeBtn.addEventListener('click', function(){
    var next = effective() === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next); localStorage.setItem(TKEY, next); syncTheme();
  });

  // ── Barra de progreso de scroll ──
  var prog = document.getElementById('progress');
  function onScroll(){ var h = document.documentElement; var m = h.scrollHeight - h.clientHeight; prog.style.transform = 'scaleX(' + (m > 0 ? h.scrollTop / m : 0) + ')'; }
  addEventListener('scroll', onScroll, { passive: true }); onScroll();

  // ── Contadores ──
  function countUp(el){
    var t = +el.getAttribute('data-count');
    if (reduce || t === 0){ el.textContent = t; return; }
    var s = performance.now(), dur = 850;
    (function tick(now){ var p = Math.min(1, (now - s) / dur); el.textContent = Math.round(t * (1 - Math.pow(1 - p, 3))); if (p < 1) requestAnimationFrame(tick); })(s);
  }
  document.querySelectorAll('.hstat .n').forEach(countUp);

  // ── Títulos "typewriter": teclea en mono como código, lo selecciona y lo
  //    formatea a la fuente de títulos (Outfit). Enmascara el swap con blur. ──
  function typeTitle(el){
    if (el.dataset.typed) return; el.dataset.typed = '1';
    var full = el.textContent;
    el.setAttribute('aria-label', full);
    var txt = document.createElement('span'); txt.className = 'ty-txt'; txt.setAttribute('aria-hidden', 'true');
    var caret = document.createElement('span'); caret.className = 'ty-caret'; caret.setAttribute('aria-hidden', 'true');
    var h = el.getBoundingClientRect().height; if (h) el.style.minHeight = h + 'px';
    el.textContent = ''; el.classList.add('coding'); el.appendChild(txt); el.appendChild(caret);
    var i = 0;
    (function step(){
      txt.textContent = full.slice(0, i);
      if (i < full.length){ i++; setTimeout(step, 15 + Math.random() * 26); }
      else finish();
    })();
    function finish(){
      setTimeout(function(){
        caret.remove(); txt.classList.add('sel');           // "seleccionar"
        setTimeout(function(){
          el.classList.add('formatting');                    // blur para enmascarar
          setTimeout(function(){
            el.classList.remove('coding'); txt.classList.remove('sel');   // → Outfit
            requestAnimationFrame(function(){ el.classList.remove('formatting'); });
            setTimeout(function(){ el.style.minHeight = ''; }, 220);
          }, 120);
        }, 470);
      }, 230);
    }
  }
  var titles = [].slice.call(document.querySelectorAll('.type'));
  if (reduce) { /* sin animación: se quedan como están */ }
  else {
    titles.filter(function(t){ return t.getAttribute('data-type') === 'load'; }).forEach(function(t){ setTimeout(function(){ typeTitle(t); }, 200); });
    var scrollT = titles.filter(function(t){ return t.getAttribute('data-type') !== 'load'; });
    if ('IntersectionObserver' in window) {
      var tio = new IntersectionObserver(function(es){ es.forEach(function(e){ if (e.isIntersecting){ typeTitle(e.target); tio.unobserve(e.target); } }); }, { rootMargin: '0px 0px -12% 0px' });
      scrollT.forEach(function(t){ tio.observe(t); });
    } else scrollT.forEach(typeTitle);
  }

  // ── Reveal on scroll (mejora un default ya visible) ──
  var revs = [].slice.call(document.querySelectorAll('.reveal'));
  if (reduce || !('IntersectionObserver' in window)) { revs.forEach(function(r){ r.classList.add('in'); }); }
  else {
    revs.forEach(function(r){ r.classList.add('pre'); });
    var io = new IntersectionObserver(function(es){ es.forEach(function(e){ if (e.isIntersecting){ e.target.classList.add('in'); io.unobserve(e.target); } }); }, { rootMargin: '0px 0px -8% 0px' });
    revs.forEach(function(r){ io.observe(r); });
  }

  // ── Scroll-spy del nav ──
  var links = [].slice.call(document.querySelectorAll('.snav-links a'));
  var secs = links.map(function(a){ return document.getElementById(a.getAttribute('href').slice(1)); });
  if ('IntersectionObserver' in window) {
    var spy = new IntersectionObserver(function(es){ es.forEach(function(e){ if (e.isIntersecting){ links.forEach(function(a){ a.classList.toggle('on', a.getAttribute('href') === '#' + e.target.id); }); } }); }, { rootMargin: '-45% 0px -50% 0px' });
    secs.forEach(function(s){ if (s) spy.observe(s); });
  }

  // ── Filtro por autor ──
  var cards = [].slice.call(document.querySelectorAll('#cards .card'));
  document.querySelectorAll('.fbtn').forEach(function(btn){
    btn.addEventListener('click', function(){
      var f = btn.getAttribute('data-filter'), toks = f.split(' ');
      document.querySelectorAll('.fbtn').forEach(function(b){ b.setAttribute('aria-pressed', b === btn ? 'true' : 'false'); });
      cards.forEach(function(c){
        var owners = (c.getAttribute('data-owner') || '').split(' ');
        var show = f === 'all' || toks.some(function(t){ return owners.indexOf(t) !== -1; });
        if (show){ c.hidden = false; requestAnimationFrame(function(){ c.classList.remove('out'); }); }
        else { c.classList.add('out'); setTimeout(function(){ if (c.classList.contains('out')) c.hidden = true; }, reduce ? 0 : 200); }
      });
    });
  });

  // ── Buscador del registro ──
  var q = document.getElementById('q');
  if (q) q.addEventListener('input', function(){
    var v = this.value.trim().toLowerCase();
    document.querySelectorAll('#logbody .day').forEach(function(day){
      var any = false;
      day.querySelectorAll('.lrow').forEach(function(r){ var m = r.textContent.toLowerCase().indexOf(v) !== -1; r.style.display = m ? '' : 'none'; if (m) any = true; });
      day.style.display = any ? '' : 'none';
    });
  });

  // ── Copiar resumen ──
  var toastEl = document.getElementById('toast'), toastT;
  function toast(msg){ toastEl.textContent = msg; toastEl.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(function(){ toastEl.classList.remove('show'); }, 2200); }
  var copyBtn = document.getElementById('copyBtn');
  if (copyBtn) copyBtn.addEventListener('click', function(){
    if (navigator.clipboard) navigator.clipboard.writeText(SUMMARY).then(function(){ toast('Resumen copiado'); }, function(){ toast('No se pudo copiar'); });
    else toast('No se pudo copiar');
  });

  // ── Pestañas: Noticias (principal) / Avances del desk ──
  var tabs = [].slice.call(document.querySelectorAll('.tab'));
  var panes = { noticias: document.getElementById('pane-noticias'), avances: document.getElementById('pane-avances') };
  function showPane(name){
    if (!panes[name]) return;
    tabs.forEach(function(t){ var on = t.getAttribute('data-pane') === name; t.classList.toggle('on', on); t.setAttribute('aria-selected', on ? 'true' : 'false'); });
    Object.keys(panes).forEach(function(k){ panes[k].hidden = (k !== name); });
    var nl = document.getElementById('newsLang'); if (nl) nl.style.display = (name === 'noticias') ? '' : 'none';   // el idioma solo aplica a Noticias
    // Revela lo que quedó oculto por vivir en una pestaña no visible.
    panes[name].querySelectorAll('.reveal').forEach(function(r){ r.classList.add('in'); });
    window.scrollTo(0, 0);
    try { if (location.hash !== '#' + name) history.replaceState(null, '', name === 'noticias' ? location.pathname : '#' + name); } catch(e){}
  }
  tabs.forEach(function(t){ t.addEventListener('click', function(){ showPane(t.getAttribute('data-pane')); }); });
  if (location.hash === '#avances') showPane('avances');

  // ── Noticias del portafolio (lee /data/company-news.json) ──
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function ago(iso){ var d = new Date(iso); if (isNaN(d)) return ''; var s = (Date.now() - d.getTime())/1000; if (s < 3600) return Math.max(1, Math.round(s/60)) + ' min'; if (s < 86400) return Math.round(s/3600) + ' h'; return Math.round(s/86400) + ' d'; }
  var newsData = null;
  var newsSel = {};   // multi-selección de empresas {empresa:true}; vacío = todas
  // Idioma: comparte la llave 'lang' con el dashboard. Cada nota trae title (inglés
  // original) y title_es (traducido) → el toggle elige cuál mostrar.
  var newsLang = (function(){ try { return localStorage.getItem('lang') === 'en' ? 'en' : 'es'; } catch(e){ return 'es'; } })();
  function NT(es, en){ return newsLang === 'en' ? en : es; }
  function setTx(id, tx){ var el = document.getElementById(id); if (el) el.textContent = tx; }
  var grid = document.getElementById('newsGrid');

  // ── Idioma ES/EN ──
  (function wireNewsLang(){
    var lb = document.getElementById('newsLang'); if (!lb) return;
    lb.querySelectorAll('.nl-btn').forEach(function(b){
      b.classList.toggle('on', b.getAttribute('data-nlang') === newsLang);
      b.addEventListener('click', function(){
        newsLang = b.getAttribute('data-nlang');
        try { localStorage.setItem('lang', newsLang); } catch(e){}
        lb.querySelectorAll('.nl-btn').forEach(function(x){ x.classList.toggle('on', x === b); });
        renderNewsHero(); renderMeta(); buildFilterList(); updateFilterBtn(); renderNews();
      });
    });
  })();

  // ── Hero (traducible) ──
  function renderNewsHero(){
    setTx('newsEyebrowTx', NT('Novedades del portafolio', 'Portfolio news'));
    setTx('newsH1', NT('Noticias de las empresas en seguimiento', 'News from the companies we track'));
    var lede = document.getElementById('newsLede');
    if (lede) lede.innerHTML = NT(
      'Titulares recientes de las compañías donde invierte el portafolio, de <b>medios confiables</b> (Reuters, Bloomberg, TechCrunch, CNBC, FT…). Se actualiza varias veces al día.',
      'Recent headlines from the companies the portfolio invests in, from <b>trusted outlets</b> (Reuters, Bloomberg, TechCrunch, CNBC, FT…). Updated several times a day.'
    );
  }
  function renderMeta(){
    if (!newsData) return;
    setTx('newsMetaCount', newsData.count + NT(' notas · ', ' stories · ') + (newsData.companies ? newsData.companies.length : 0) + NT(' empresas', ' companies'));
    setTx('newsMetaWhenLbl', NT('actualizado', 'updated'));
    setTx('newsMetaWhen', ago(newsData.generated) + NT(' atrás', ' ago'));
  }

  // ── Filtro desplegable (multi-empresa) ──
  function newsCompanies(){ return Object.keys(newsData.items.reduce(function(a, i){ a[i.company] = 1; return a; }, {})).sort(); }
  function selCount(){ return Object.keys(newsSel).length; }
  function updateFilterBtn(){
    var lbl = document.getElementById('newsFilterLabel'); if (!lbl) return;
    var n = selCount();
    if (!n) lbl.textContent = NT('Todas las empresas', 'All companies');
    else if (n === 1) lbl.textContent = Object.keys(newsSel)[0];
    else lbl.textContent = n + NT(' empresas', ' companies');
    var clr = document.getElementById('newsFilterClear'); if (clr) clr.style.visibility = n ? 'visible' : 'hidden';
  }
  function buildFilterList(){
    var box = document.getElementById('newsFilterList'); if (!box || !newsData) return;
    setTx('newsFilterHint', NT('Filtra según la(s) empresa(s) que sean de tu interés.', 'Filter by the companies you care about.'));
    var srch = document.getElementById('newsFilterSearch'); if (srch) srch.placeholder = NT('Buscar empresa…', 'Search company…');
    setTx('newsFilterClear', NT('Limpiar', 'Clear'));
    box.innerHTML = newsCompanies().map(function(co){
      return '<div class="ncf-opt' + (newsSel[co] ? ' on' : '') + '" data-co="' + esc(co) + '"><span class="ncf-check">' + (newsSel[co] ? '✓' : '') + '</span><span class="ncf-nm">' + esc(co) + '</span></div>';
    }).join('');
    box.querySelectorAll('.ncf-opt').forEach(function(o){
      o.addEventListener('click', function(){
        var co = o.getAttribute('data-co');
        if (newsSel[co]) delete newsSel[co]; else newsSel[co] = true;
        o.classList.toggle('on', !!newsSel[co]);
        var c = o.querySelector('.ncf-check'); if (c) c.textContent = newsSel[co] ? '✓' : '';
        updateFilterBtn(); renderNews();
      });
    });
  }
  window.filterNewsFilterList = function(q){
    q = (q || '').toLowerCase();
    document.querySelectorAll('#newsFilterList .ncf-opt').forEach(function(o){
      o.style.display = o.getAttribute('data-co').toLowerCase().indexOf(q) >= 0 ? '' : 'none';
    });
  };
  window.newsFilterClear = function(){
    newsSel = {};
    document.querySelectorAll('#newsFilterList .ncf-opt').forEach(function(o){ o.classList.remove('on'); var c = o.querySelector('.ncf-check'); if (c) c.textContent = ''; });
    updateFilterBtn(); renderNews();
  };
  window.toggleNewsFilter = function(e){
    if (e) e.stopPropagation();
    var d = document.getElementById('newsCddf'); if (!d) return;
    var open = d.classList.toggle('open');
    var btn = document.getElementById('newsFilterBtn'); if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  document.addEventListener('click', function(e){
    var d = document.getElementById('newsCddf');
    if (d && d.classList.contains('open') && !d.contains(e.target)) { d.classList.remove('open'); var btn = document.getElementById('newsFilterBtn'); if (btn) btn.setAttribute('aria-expanded', 'false'); }
  });

  // ── Carga ──
  fetch('/data/company-news.json', { cache: 'no-store' }).then(function(r){ if(!r.ok) throw 0; return r.json(); }).then(function(d){
    newsData = d;
    renderNewsHero(); renderMeta(); buildFilterList(); updateFilterBtn(); renderNews();
  }).catch(function(){ if (grid) grid.innerHTML = '<div class="news-empty">' + NT('No se pudieron cargar las noticias. Reintenta en un momento.', "Couldn't load the news. Try again in a moment.") + '</div>'; });

  // ── Tarjetas (con destacada = la más reciente) ──
  function titleOf(i){ return newsLang === 'en' ? (i.title || i.title_es) : (i.title_es || i.title); }
  function cardHtml(i, idx){
    return '<article class="news-card" style="--i:' + Math.min(idx, 24) + '" title="' + esc(i.title) + '">'
      + '<div class="news-top"><span class="news-co">' + esc(i.company) + '</span><span class="news-time">' + ago(i.published) + '</span></div>'
      + '<div class="news-title">' + esc(titleOf(i)) + '</div>'
      + '<div class="news-foot"><span class="news-src">' + esc(i.source) + '</span>'
      + '<a class="news-btn" href="' + esc(i.url) + '" target="_blank" rel="noopener">' + NT('Leer noticia', 'Read the story') + ' <span aria-hidden="true">↗</span></a></div>'
      + '</article>';
  }
  function featHtml(i){
    return '<article class="news-card feat" title="' + esc(i.title) + '">'
      + '<div class="news-feat-head"><span class="news-feat-tag"><span class="fdot"></span>' + NT('Lo más reciente', 'Latest') + '</span><span class="news-time">' + ago(i.published) + '</span></div>'
      + '<div class="news-top"><span class="news-co">' + esc(i.company) + '</span></div>'
      + '<div class="news-title">' + esc(titleOf(i)) + '</div>'
      + '<div class="news-foot"><span class="news-src">' + esc(i.source) + '</span>'
      + '<a class="news-btn" href="' + esc(i.url) + '" target="_blank" rel="noopener">' + NT('Leer noticia', 'Read the story') + ' <span aria-hidden="true">↗</span></a></div>'
      + '</article>';
  }
  function renderNews(){
    if (!grid || !newsData) return;
    var items = newsData.items.slice().sort(function(a, b){ return new Date(b.published) - new Date(a.published); });
    var sel = Object.keys(newsSel);
    if (sel.length) items = items.filter(function(i){ return newsSel[i.company]; });
    if (!items.length){ grid.innerHTML = '<div class="news-empty">' + NT('Sin noticias para este filtro por ahora.', 'No news for this filter yet.') + '</div>'; return; }
    var html = '';
    if (items.length >= 4) { html = featHtml(items[0]) + items.slice(1).map(function(i, k){ return cardHtml(i, k); }).join(''); }
    else { html = items.map(function(i, k){ return cardHtml(i, k); }).join(''); }
    grid.innerHTML = html;
  }
})();
</script>
</body>
</html>`;

writeFileSync(OUT, html, 'utf8');
console.log(`[blog-semanal] ${total} commits (${range}) → ${OUT}`);

// ── Estilos ──────────────────────────────────────────────────────────────────
function STYLE() {
  return `
  /* Fuentes de marca (mismo dominio, sin CSP): Outfit + Geist Mono */
  @font-face{font-family:'Outfit';src:url('/fonts/Outfit-Regular.ttf') format('truetype');font-weight:400;font-display:swap}
  @font-face{font-family:'Outfit';src:url('/fonts/Outfit-Bold.ttf') format('truetype');font-weight:700;font-display:swap}
  @font-face{font-family:'Geist Mono';src:url('/fonts/GeistMono-Regular.ttf') format('truetype');font-weight:400;font-display:swap}
  :root{
    --font:'Outfit',system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    --mono:'Geist Mono',ui-monospace,"SF Mono",Menlo,Consolas,monospace;
    --bg:#F4F7FB; --surface:#FFFFFF; --surface-2:#EDF2F9; --raise:0 1px 2px rgba(18,30,54,.05),0 8px 24px rgba(18,30,54,.06);
    --ink:#161F2E; --ink-soft:#4F5B6E; --ink-mute:#7C889A;
    --line:#E1E8F1; --line-soft:#EEF2F8;
    --navy:#1A3A6B; --navy-2:#2E5BA3; --navy-pale:#E7EFFA;
    --green:#2E9C68; --amber:#B9782A;
    --eug:#137A82; --eug-bg:#DEF0F0; --auto:#586A85; --auto-bg:#E7EBF2;
    --focus:#2E5BA3;
    --ease-out:cubic-bezier(.23,1,.32,1); --ease-io:cubic-bezier(.77,0,.175,1);
    --maxw:920px; --z-prog:60; --z-nav:50; --z-toast:70;
  }
  /* Oscuro: por sistema (salvo elección explícita de claro) + por toggle. */
  @media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
    --bg:#0C121E; --surface:#141D2E; --surface-2:#1A2740; --raise:0 1px 2px rgba(0,0,0,.34),0 10px 28px rgba(0,0,0,.3);
    --ink:#E8EDF6; --ink-soft:#A8B4C8; --ink-mute:#6C7994;
    --line:#25324A; --line-soft:#1C273A;
    --navy:#7BA4E6; --navy-2:#9DBEF1; --navy-pale:#1A2A47;
    --green:#4FC088; --amber:#E0A250;
    --eug:#4FBEC6; --eug-bg:rgba(79,190,198,.15); --auto:#94A3BC; --auto-bg:rgba(148,163,188,.15);
    --focus:#9DBEF1;
  }}
  :root[data-theme="dark"]{
    --bg:#0C121E; --surface:#141D2E; --surface-2:#1A2740; --raise:0 1px 2px rgba(0,0,0,.34),0 10px 28px rgba(0,0,0,.3);
    --ink:#E8EDF6; --ink-soft:#A8B4C8; --ink-mute:#6C7994;
    --line:#25324A; --line-soft:#1C273A;
    --navy:#7BA4E6; --navy-2:#9DBEF1; --navy-pale:#1A2A47;
    --green:#4FC088; --amber:#E0A250;
    --eug:#4FBEC6; --eug-bg:rgba(79,190,198,.15); --auto:#94A3BC; --auto-bg:rgba(148,163,188,.15);
    --focus:#9DBEF1;
  }
  *{box-sizing:border-box} html{-webkit-text-size-adjust:100%;scroll-behavior:smooth}
  @media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--font);font-size:16px;line-height:1.6;letter-spacing:-.006em;-webkit-font-smoothing:antialiased}
  .mono,.lh,.h{font-family:var(--mono)}
  .wrap{max-width:var(--maxw);margin:0 auto;padding:0 22px}
  :focus-visible{outline:2px solid var(--focus);outline-offset:3px;border-radius:8px}
  .swatch{width:9px;height:9px;border-radius:3px;flex:0 0 auto;display:inline-block}
  .sw-navy{background:var(--navy)} .sw-eug{background:var(--eug)} .sw-auto{background:var(--auto)}
  .ic{width:18px;height:18px;display:block;flex:0 0 auto} .ic.ti{width:13px;height:13px}

  /* Progreso de scroll */
  .progress{position:fixed;top:0;left:0;right:0;height:2.5px;background:var(--navy);transform:scaleX(0);transform-origin:left;z-index:var(--z-prog);will-change:transform}

  /* Reveal (default visible; JS aplica pre→in) */
  .reveal.pre{opacity:0;transform:translateY(14px)}
  .reveal.in{opacity:1;transform:none;transition:opacity .55s var(--ease-out),transform .55s var(--ease-out);transition-delay:var(--d,0ms)}
  @media (prefers-reduced-motion:reduce){.reveal.pre{opacity:1;transform:none}}
  /* Composición tipo Notion: los ítems de un bloque "se escriben" en cascada */
  .reveal.pre li,.reveal.pre .lrow,.reveal.pre .cl{opacity:0;transform:translateY(6px)}
  .reveal.in li,.reveal.in .lrow,.reveal.in .cl{opacity:1;transform:none;transition:opacity .4s var(--ease-out),transform .4s var(--ease-out);transition-delay:calc(var(--li,0) * 28ms)}
  @media (prefers-reduced-motion:reduce){.reveal.pre li,.reveal.pre .lrow,.reveal.pre .cl{opacity:1;transform:none}}

  /* Typewriter de títulos: teclea en mono (código) → selecciona → formatea a Outfit */
  .type{--sel:var(--navy-pale);--sel-ink:var(--navy-2)}
  .type.coding{font-family:var(--mono);font-weight:400;letter-spacing:0;color:var(--ink-mute)}
  .type.formatting{filter:blur(3px);opacity:.9;transition:filter .14s ease,opacity .14s ease}
  .ty-txt{border-radius:4px;padding:0 .05em;box-decoration-break:clone;-webkit-box-decoration-break:clone}
  .ty-txt.sel{background-image:linear-gradient(var(--sel),var(--sel));background-repeat:no-repeat;background-position:left center;background-size:0% 80%;color:var(--sel-ink);animation:tySel .3s var(--ease-out) forwards}
  @keyframes tySel{to{background-size:100% 80%}}
  .ty-caret{display:inline-block;width:.11em;height:1em;background:var(--navy-2);margin-left:.06em;vertical-align:-.1em;border-radius:1px;animation:tyBlink 1.05s steps(1,end) infinite}
  @keyframes tyBlink{0%,50%{opacity:1}50.01%,100%{opacity:0}}
  @media (prefers-reduced-motion:reduce){.type.coding{font-family:var(--font);font-weight:inherit;color:inherit}.ty-caret{display:none}.ty-txt.sel{animation:none;background-size:0% 80%;color:inherit}}

  /* Header */
  header{padding:56px 0 26px}
  .eyebrow{font-family:var(--mono);font-size:12.5px;letter-spacing:.13em;text-transform:uppercase;color:var(--navy-2);display:flex;align-items:center;gap:9px;margin:0 0 18px}
  .pulse{width:8px;height:8px;border-radius:50%;background:var(--navy-2);position:relative}
  .pulse::after{content:"";position:absolute;inset:0;border-radius:50%;background:var(--navy-2);animation:pulse 2.4s var(--ease-out) infinite}
  @keyframes pulse{0%{transform:scale(1);opacity:.6}70%,100%{transform:scale(3);opacity:0}}
  @media (prefers-reduced-motion:reduce){.pulse::after{animation:none}}
  h1{font-size:clamp(31px,5.8vw,50px);line-height:1.04;letter-spacing:-.032em;font-weight:700;margin:0 0 16px;text-wrap:balance}
  .lede{font-size:clamp(16px,2.2vw,18.5px);color:var(--ink-soft);max-width:62ch;margin:0;text-wrap:pretty}
  .meta-row{display:flex;flex-wrap:wrap;gap:8px 10px;margin-top:22px}
  .tag{font-size:12.5px;font-weight:500;padding:5px 11px;border-radius:999px;background:var(--surface-2);color:var(--ink-soft);border:1px solid var(--line);display:inline-flex;align-items:center;gap:6px}
  .tag .ic{opacity:.8} .tag b{color:var(--ink);font-weight:600}
  .hstats{display:flex;flex-wrap:wrap;gap:10px 28px;margin-top:30px;padding:20px 0 4px;border-top:1px solid var(--line)}
  .hstat .n{font-size:clamp(28px,4vw,38px);font-weight:700;letter-spacing:-.03em;line-height:1;font-variant-numeric:tabular-nums}
  .hstat .k{font-size:12.5px;color:var(--ink-mute);margin-top:7px;display:flex;align-items:center;gap:6px}

  /* Nav sticky + scroll-spy */
  .snav{position:sticky;top:0;z-index:var(--z-nav);background:color-mix(in srgb,var(--bg) 82%,transparent);backdrop-filter:saturate(1.4) blur(10px);-webkit-backdrop-filter:saturate(1.4) blur(10px);border-bottom:1px solid var(--line);margin-top:14px}
  .snav-in{display:flex;align-items:center;justify-content:space-between;height:52px;gap:12px}
  .snav-links{display:flex;gap:4px;overflow-x:auto;scrollbar-width:none} .snav-links::-webkit-scrollbar{display:none}
  .snav-links a{font-size:13.5px;font-weight:500;color:var(--ink-soft);text-decoration:none;padding:7px 12px;border-radius:8px;white-space:nowrap;transition:color .16s var(--ease-out),background .16s var(--ease-out)}
  .snav-links a:hover{color:var(--ink);background:var(--surface-2)}
  .snav-links a.on{color:var(--navy-2);background:var(--navy-pale);font-weight:600}
  .snav-act{display:flex;gap:8px;flex:0 0 auto}
  .iconbtn{display:inline-flex;align-items:center;gap:7px;font-size:13px;font-weight:500;color:var(--ink-soft);background:var(--surface);border:1px solid var(--line);border-radius:9px;padding:7px 11px;cursor:pointer;transition:transform .16s var(--ease-out),border-color .16s var(--ease-out),color .16s var(--ease-out)}
  @media (hover:hover){.iconbtn:hover{border-color:var(--navy-2);color:var(--ink)}}
  .iconbtn:active{transform:scale(.96)} .iconbtn .ic{width:15px;height:15px}
  .iconbtn.only-ic{padding:7px} .only-ic span{display:none}
  .ic-sun{display:none} :root[data-eff="dark"] .ic-moon{display:none} :root[data-eff="dark"] .ic-sun{display:block}

  /* Secciones */
  .sec{padding:40px 22px}
  .sec-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin:0 0 22px;flex-wrap:wrap}
  .sec-head h2{font-size:clamp(20px,3vw,25px);font-weight:700;letter-spacing:-.022em;margin:0}
  .sec-meta{font-family:var(--mono);font-size:12.5px;color:var(--ink-mute)}

  /* Resumen: gráfica + reparto */
  .summary{display:grid;grid-template-columns:1.4fr 1fr;gap:16px}
  @media (max-width:720px){.summary{grid-template-columns:1fr}}
  .chart-card,.dist-card{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:20px;box-shadow:var(--raise)}
  .chart-lbl{font-size:12px;font-weight:600;letter-spacing:.02em;color:var(--ink-mute);margin-bottom:16px}
  .chart{display:grid;grid-template-columns:repeat(7,1fr);gap:8px;align-items:end;height:150px}
  .acol{display:flex;flex-direction:column;align-items:center;gap:7px;height:100%}
  .aval{font-family:var(--mono);font-size:11px;color:var(--ink-mute);height:14px;font-variant-numeric:tabular-nums}
  .abar{flex:1;width:100%;display:flex;align-items:flex-end;justify-content:center}
  .afill{width:66%;max-width:26px;min-height:4px;height:var(--h);background:var(--navy);border-radius:5px 5px 3px 3px;opacity:.32;transform:scaleY(1);transform-origin:bottom}
  .afill.peak{opacity:1} .afill.zero{background:var(--ink-mute);opacity:.18;min-height:4px}
  .reveal.pre .afill{transform:scaleY(0)}
  .reveal.in .afill{transform:scaleY(1);transition:transform .6s var(--ease-out);transition-delay:calc(var(--i) * 55ms)}
  .adow{font-size:11px;color:var(--ink-mute);font-weight:600;display:flex;flex-direction:column;align-items:center;line-height:1.2}
  .adow .adate{font-family:var(--mono);font-size:9.5px;font-weight:400;opacity:.7}
  .dist-card{display:flex;flex-direction:column}
  .bar{display:flex;height:16px;border-radius:8px;overflow:hidden;border:1px solid var(--line);background:var(--surface-2);margin-bottom:14px}
  .seg{height:100%;width:0}
  .reveal.in .seg{width:var(--w);transition:width 1s var(--ease-out) .1s}
  @media (prefers-reduced-motion:reduce){.reveal.in .seg{transition:none;width:var(--w)}}
  .seg-navy{background:var(--navy)} .seg-auto{background:var(--auto)} .seg-eug{background:var(--eug)}
  .legend{display:flex;flex-wrap:wrap;gap:8px 16px}
  .lg{font-size:12.5px;color:var(--ink-soft);display:inline-flex;align-items:center;gap:6px} .lg b{color:var(--ink);font-variant-numeric:tabular-nums}
  .dist-note{margin-top:auto;padding-top:14px;font-size:12px;color:var(--ink-mute)}
  /* Dona de reparto */
  .donut-wrap{display:flex;justify-content:center;padding:4px 0 12px}
  .donut{width:132px;height:132px}
  .donut circle[class^="a-"]{transform-origin:center;animation:donIn .8s var(--ease-out) both}
  @keyframes donIn{from{opacity:0}to{opacity:1}}
  @media (prefers-reduced-motion:reduce){.donut circle[class^="a-"]{animation:none}}
  .a-navy{stroke:var(--navy)} .a-auto{stroke:var(--auto)} .a-eug{stroke:var(--eug)}
  .don-n{text-anchor:middle;font-family:var(--mono);font-size:23px;font-weight:600;fill:var(--ink)}
  .don-k{text-anchor:middle;font-size:9px;fill:var(--ink-mute);letter-spacing:.05em;text-transform:uppercase}
  /* Heatmap estilo GitHub */
  .heat-card{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:20px;box-shadow:var(--raise);margin-top:16px}
  .heat-top{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:16px}
  .heat-scroll{overflow-x:auto;padding-bottom:2px}
  .heat{display:grid;grid-auto-flow:column;grid-template-rows:repeat(7,15px);grid-auto-columns:15px;gap:3px;width:max-content}
  .hc{border-radius:3px;background:var(--surface-2)}
  .hc.h1{background:color-mix(in srgb,var(--navy) 26%,var(--surface-2))}
  .hc.h2{background:color-mix(in srgb,var(--navy) 48%,var(--surface-2))}
  .hc.h3{background:color-mix(in srgb,var(--navy) 72%,var(--surface-2))}
  .hc.h4{background:var(--navy)}
  .heat-legend{display:flex;align-items:center;gap:4px;font-size:11.5px;color:var(--ink-mute)}
  .heat-legend .hc{width:12px;height:12px}
  /* Sparkline por módulo */
  .spark{width:100%;height:26px;display:block;margin:14px 0 2px}
  .spark-a{fill:var(--navy);opacity:.1}
  .spark-l{fill:none;stroke:var(--navy);stroke-width:1.6;opacity:.5;vector-effect:non-scaling-stroke;stroke-linejoin:round;stroke-linecap:round}

  /* Filtro */
  .filter{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 20px}
  .fbtn{font-size:13.5px;font-weight:500;padding:7px 14px;border-radius:999px;cursor:pointer;background:var(--surface);border:1px solid var(--line);color:var(--ink-soft);display:inline-flex;align-items:center;gap:7px;transition:transform .16s var(--ease-out),border-color .16s var(--ease-out),color .16s var(--ease-out),background .16s var(--ease-out)}
  @media (hover:hover){.fbtn:hover{border-color:var(--navy-2);color:var(--ink)}}
  .fbtn:active{transform:scale(.96)}
  .fbtn[aria-pressed="true"]{background:var(--navy);border-color:var(--navy);color:#fff}
  @media (prefers-color-scheme:dark){:root:not([data-theme="light"]) .fbtn[aria-pressed="true"]{color:#0C121E}}
  :root[data-theme="dark"] .fbtn[aria-pressed="true"]{color:#0C121E}

  /* Tarjetas de módulo */
  .cards{display:flex;flex-direction:column;gap:14px}
  .card{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:20px 22px;box-shadow:var(--raise);transition:opacity .2s var(--ease-out),transform .22s var(--ease-out),border-color .22s var(--ease-out)}
  .card[hidden]{display:none}
  .card.out{opacity:0;transform:scale(.97)}
  @media (hover:hover){.card:hover{transform:translateY(-3px);border-color:var(--navy-pale)}}
  .card-top{display:flex;align-items:center;gap:13px}
  .card-icon{width:38px;height:38px;border-radius:11px;background:var(--navy-pale);color:var(--navy);display:grid;place-items:center;flex:0 0 auto}
  .card-h{flex:1;min-width:0} .card-h h3{font-size:17.5px;font-weight:650;letter-spacing:-.015em;margin:0}
  .card-who{display:flex;flex-wrap:wrap;gap:6px;margin-top:5px}
  .who{font-size:11px;font-weight:600;padding:2px 8px 2px 6px;border-radius:999px;display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
  .who.angel{background:var(--navy-pale);color:var(--navy-2)} .who.eug{background:var(--eug-bg);color:var(--eug)} .who.auto{background:var(--auto-bg);color:var(--auto)}
  .who .swatch{border-radius:50%}
  .card-n{font-family:var(--mono);font-size:26px;font-weight:600;color:var(--ink);line-height:1;text-align:right;font-variant-numeric:tabular-nums}
  .card-n span{display:block;font-size:10.5px;font-weight:400;color:var(--ink-mute);letter-spacing:.02em;margin-top:3px}
  .mshare{height:3px;background:var(--line-soft);border-radius:2px;margin:15px 0 2px;overflow:hidden}
  .mshare-fill{height:100%;background:var(--navy);opacity:.55;border-radius:2px;transform:scaleX(var(--s));transform-origin:left}
  .reveal.pre .mshare-fill{transform:scaleX(0)}
  .reveal.in .mshare-fill{transform:scaleX(var(--s));transition:transform .7s var(--ease-out) .1s}
  .card ul{margin:12px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:9px}
  .card li{position:relative;padding-left:20px;color:var(--ink-soft);font-size:14.5px;line-height:1.55}
  .card li::before{content:"";position:absolute;left:3px;top:9px;width:6px;height:6px;border-radius:2px;background:var(--navy);opacity:.5}
  .card li .lh{font-size:11px;color:var(--ink-mute);margin-left:4px}

  /* Personas */
  .ppl{display:flex;flex-direction:column;gap:14px}
  .prow{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:18px 20px;box-shadow:var(--raise)}
  .phead{display:flex;align-items:center;gap:9px;margin-bottom:11px}
  .phead .swatch{width:11px;height:11px;border-radius:50%}
  .pname{font-size:15px;font-weight:600;flex:1} .pcount{font-family:var(--mono);font-size:16px;font-weight:600;color:var(--ink);font-variant-numeric:tabular-nums}
  .pbar{height:7px;background:var(--surface-2);border-radius:4px;overflow:hidden;margin-bottom:15px}
  .pbar-fill{height:100%;border-radius:4px;transform:scaleX(var(--s));transform-origin:left}
  .reveal.pre .pbar-fill{transform:scaleX(0)}
  .reveal.in .pbar-fill{transform:scaleX(var(--s));transition:transform .8s var(--ease-out) .12s}
  .fill-angel{background:var(--navy)} .fill-auto{background:var(--auto)} .fill-eug{background:var(--eug)}
  .pcommits{display:flex;flex-direction:column;gap:8px}
  .cl{display:flex;gap:11px;align-items:baseline;font-size:14px;color:var(--ink-soft)}
  .cl .h{font-size:11.5px;color:var(--ink-mute);flex:0 0 auto;padding-top:1px}
  .pmore{font-size:12.5px;color:var(--ink-mute);padding-top:2px}

  /* Registro + buscador */
  .search{display:flex;align-items:center;gap:10px;background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:0 14px;margin-bottom:14px;box-shadow:var(--raise);transition:border-color .16s var(--ease-out)}
  .search:focus-within{border-color:var(--navy-2)}
  .search .ic-s{color:var(--ink-mute);width:17px;height:17px}
  .search input{flex:1;border:0;background:none;outline:none;color:var(--ink);font:inherit;font-size:14.5px;padding:13px 0}
  .search input::placeholder{color:var(--ink-mute)}
  .logbody{background:var(--surface);border:1px solid var(--line);border-radius:14px;box-shadow:var(--raise);padding:6px 20px 16px}
  .day{margin-top:14px}
  .day-h{font-family:var(--mono);font-size:12px;letter-spacing:.05em;color:var(--ink-mute);text-transform:uppercase;margin:0 0 8px;padding-top:12px;border-top:1px dashed var(--line)}
  .day:first-child .day-h{border-top:none;padding-top:4px}
  .lrow{display:flex;gap:10px;align-items:baseline;padding:4px 0;font-size:13.5px;color:var(--ink-soft);line-height:1.45}
  .lrow .lw{width:8px;height:8px;border-radius:2px;flex:0 0 auto;position:relative;top:4px}
  .lrow .lh{font-size:11px;color:var(--ink-mute);flex:0 0 auto}

  .empty{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:48px 22px;text-align:center;box-shadow:var(--raise);margin-top:20px}
  .empty h3{margin:0 0 8px;font-size:19px} .empty p{margin:0;color:var(--ink-mute)}

  /* ── Barra de pestañas (Noticias / Avances del desk) ── */
  .tabbar{position:sticky;top:0;z-index:55;background:color-mix(in srgb,var(--bg) 85%,transparent);backdrop-filter:saturate(1.4) blur(10px);-webkit-backdrop-filter:saturate(1.4) blur(10px);border-bottom:1px solid var(--line)}
  .tabbar-in{display:flex;align-items:center;gap:14px;height:54px}
  .brand{display:flex;align-items:center;gap:8px;font-weight:700;font-size:15px;letter-spacing:-.01em;color:var(--ink)}
  .brand-mark{width:10px;height:10px;border-radius:3px;background:var(--navy)}
  .tabs{display:flex;gap:4px;flex:1}
  .tab{font-size:14px;font-weight:600;color:var(--ink-soft);background:none;border:none;padding:8px 14px;border-radius:9px;cursor:pointer;font-family:inherit;transition:color .16s var(--ease-out),background .16s var(--ease-out)}
  .tab:hover{color:var(--ink);background:var(--surface-2)}
  .tab.on{color:var(--navy-2);background:var(--navy-pale)}
  .tab:active{transform:scale(.98)}
  #pane-avances .snav{top:54px}   /* la sub-nav del reporte, bajo la barra de pestañas */
  .hero-news{padding:52px 0 26px}
  /* Título editorial de Noticias (sin typewriter): grande, confiado */
  .hnews-title{font-size:clamp(30px,5.4vw,50px);line-height:1.05;letter-spacing:-.03em;font-weight:700;margin:0 0 16px;text-wrap:balance;color:var(--ink)}
  /* ── Barra: filtro desplegable (multi-empresa) + idioma ── */
  .news-bar{display:flex;flex-wrap:wrap;gap:12px 16px;align-items:center;justify-content:flex-start;margin-bottom:24px}
  .news-cddf{position:relative;flex:0 1 auto;min-width:0}
  .news-cddf-btn{display:inline-flex;align-items:center;gap:9px;max-width:100%;font-family:inherit;font-size:13.5px;font-weight:600;color:var(--ink);background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:10px 14px;cursor:pointer;box-shadow:var(--raise);transition:border-color .15s ease,transform .12s var(--ease-out)}
  .news-cddf-btn .ti{color:var(--navy-2);flex:0 0 auto}
  .news-cddf-btn #newsFilterLabel{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  @media (hover:hover){.news-cddf-btn:hover{border-color:var(--navy-2)}}
  .news-cddf-btn:active{transform:scale(.98)}
  .news-cddf-chev{color:var(--ink-mute);font-size:11px;flex:0 0 auto;transition:transform .18s var(--ease-out)}
  .news-cddf.open .news-cddf-chev{transform:rotate(180deg)}
  .news-cddf-panel{position:absolute;top:calc(100% + 8px);left:0;z-index:40;width:min(360px,88vw);background:var(--surface);border:1px solid var(--line);border-radius:16px;box-shadow:0 18px 50px rgba(18,30,54,.20);padding:14px;opacity:0;visibility:hidden;transform:translateY(-6px) scale(.98);transform-origin:top left;transition:opacity .16s var(--ease-out),transform .16s var(--ease-out),visibility 0s linear .16s}
  .news-cddf.open .news-cddf-panel{opacity:1;visibility:visible;transform:none;transition:opacity .18s var(--ease-out),transform .18s var(--ease-out)}
  .news-cddf-hint{margin:0 2px 12px;font-size:13px;line-height:1.45;color:var(--ink-soft)}
  .news-cddf-search input{width:100%;font:inherit;font-size:13.5px;color:var(--ink);background:var(--surface-2);border:1px solid var(--line);border-radius:10px;padding:9px 12px;outline:none;margin-bottom:8px}
  .news-cddf-search input:focus{border-color:var(--navy-2)}
  .news-cddf-list{max-height:264px;overflow-y:auto;display:flex;flex-direction:column;gap:2px;margin:0 -4px;padding:0 4px}
  .ncf-opt{display:flex;align-items:center;gap:10px;padding:8px 9px;border-radius:9px;cursor:pointer;font-size:13.5px;color:var(--ink-soft);transition:background .12s ease,color .12s ease}
  @media (hover:hover){.ncf-opt:hover{background:var(--surface-2);color:var(--ink)}}
  .ncf-check{width:17px;height:17px;flex:0 0 auto;border:1.5px solid var(--line);border-radius:5px;display:inline-flex;align-items:center;justify-content:center;color:#fff;font-size:11px;line-height:1;transition:background .12s ease,border-color .12s ease}
  .ncf-opt.on{color:var(--ink);font-weight:600}
  .ncf-opt.on .ncf-check{background:var(--navy);border-color:var(--navy)}
  @media (prefers-color-scheme:dark){:root:not([data-theme="light"]) .ncf-opt.on .ncf-check{color:#0C121E}}
  :root[data-theme="dark"] .ncf-opt.on .ncf-check{color:#0C121E}
  .news-cddf-foot{display:flex;justify-content:flex-end;margin-top:10px;padding-top:10px;border-top:1px solid var(--line)}
  .news-cddf-clear{font:inherit;font-size:12.5px;font-weight:600;color:var(--navy-2);background:none;border:0;cursor:pointer;padding:5px 9px;border-radius:8px}
  @media (hover:hover){.news-cddf-clear:hover{background:var(--navy-pale)}}
  .news-lang{display:inline-flex;flex:0 0 auto;background:var(--surface-2);border:1px solid var(--line);border-radius:999px;padding:2px;gap:2px}
  .nl-btn{font-size:11.5px;font-weight:600;letter-spacing:.03em;padding:5px 12px;border-radius:999px;cursor:pointer;background:none;border:0;color:var(--ink-mute);font-family:inherit;transition:background .15s ease,color .15s ease}
  .nl-btn.on{background:var(--navy);color:#fff}
  @media (prefers-color-scheme:dark){:root:not([data-theme="light"]) .nl-btn.on{color:#0C121E}}
  :root[data-theme="dark"] .nl-btn.on{color:#0C121E}
  .news-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:15px}
  .news-card{display:flex;flex-direction:column;gap:10px;background:var(--surface);border:1px solid var(--line);border-radius:15px;padding:17px 18px;box-shadow:var(--raise);text-decoration:none;color:inherit;transition:transform .18s var(--ease-out),border-color .18s var(--ease-out),box-shadow .18s var(--ease-out);animation:newsIn .5s var(--ease-out) both;animation-delay:calc(var(--i,0) * 32ms)}
  @media (hover:hover){.news-card:hover{transform:translateY(-3px);border-color:var(--navy-pale);box-shadow:0 8px 26px rgba(18,30,54,.08)}}
  @keyframes newsIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
  @media (prefers-reduced-motion:reduce){.news-card{animation:none}}
  .news-top{display:flex;align-items:center;justify-content:space-between;gap:10px}
  .news-co{font-size:11.5px;font-weight:600;color:var(--navy-2);background:var(--navy-pale);padding:3px 9px;border-radius:999px;white-space:nowrap}
  .news-time{font-family:var(--mono);font-size:11px;color:var(--ink-mute);white-space:nowrap}
  .news-title{font-size:15px;line-height:1.35;font-weight:600;letter-spacing:-.01em;color:var(--ink);flex:1}
  .news-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;color:var(--ink-mute);padding-top:2px}
  .news-src{font-weight:500}
  .news-btn{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:600;color:var(--navy-2);background:var(--navy-pale);padding:6px 12px;border-radius:8px;text-decoration:none;white-space:nowrap;flex:0 0 auto;transition:transform .14s var(--ease-out),background .14s ease,color .14s ease}
  @media (hover:hover){.news-btn:hover{background:var(--navy);color:#fff}}
  :root[data-theme="dark"] .news-btn:hover{color:#0C121E}
  @media (prefers-color-scheme:dark){:root:not([data-theme="light"]) .news-btn:hover{color:#0C121E}}
  .news-btn:active{transform:scale(.96)}
  /* Tarjeta destacada: la nota más reciente, a todo lo ancho */
  .news-card.feat{grid-column:1/-1;gap:12px;padding:22px 24px;background:linear-gradient(180deg,var(--navy-pale),var(--surface) 64%);border-color:var(--navy-pale)}
  .news-card.feat .news-title{font-size:clamp(19px,2.6vw,25px);line-height:1.24;font-weight:700;letter-spacing:-.02em}
  .news-feat-tag{display:inline-flex;align-items:center;gap:7px;font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--navy-2)}
  .news-feat-tag .fdot{width:7px;height:7px;border-radius:50%;background:var(--navy-2);position:relative}
  .news-feat-tag .fdot::after{content:"";position:absolute;inset:0;border-radius:50%;background:var(--navy-2);animation:pulse 2.4s var(--ease-out) infinite}
  @media (prefers-reduced-motion:reduce){.news-feat-tag .fdot::after{animation:none}}
  .news-feat-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
  .news-empty{grid-column:1/-1;padding:40px 20px;text-align:center;color:var(--ink-mute);font-size:14px;border:1px dashed var(--line);border-radius:14px}
  footer{border-top:1px solid var(--line);padding:28px 0 60px;color:var(--ink-mute);font-size:13px;margin-top:24px}
  footer .wrap{display:flex;flex-wrap:wrap;gap:6px 14px;justify-content:space-between;align-items:center} footer b{color:var(--ink-soft)}

  /* Toast */
  .toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%) translateY(14px);background:var(--ink);color:var(--bg);font-size:13.5px;font-weight:500;padding:11px 18px;border-radius:11px;box-shadow:0 10px 30px rgba(0,0,0,.25);opacity:0;pointer-events:none;z-index:var(--z-toast);transition:opacity .22s var(--ease-out),transform .22s var(--ease-out)}
  .toast.show{opacity:1;transform:translateX(-50%) translateY(0)}`;
}
