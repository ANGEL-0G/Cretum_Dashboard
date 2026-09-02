#!/usr/bin/env node
/* Regenera la vista "Código completo" de public/system-map.html.
 *
 * Escanea api/*.js (y api/_lib) + public/{app,i18n,desk}.js, extrae archivos y
 * funciones (con línea y tamaño) y arma nodos/aristas en el formato embebido:
 *   CODE_NODES: {id,name,group:'code',gname,val,src,color}
 *   CODE_LINKS: {source,target}
 *
 * La taxonomía (gname/color por símbolo) se CONSERVA leyendo el HTML vigente:
 * un símbolo que ya existía mantiene su grupo; uno nuevo hereda el grupo del
 * símbolo con grupo conocido más cercano por línea en el mismo archivo (así los
 * bloques temáticos de app.js siguen agrupando bien sin re-curar a mano).
 * La vista "Arquitectura" (curada) no se toca.
 *
 * Uso:  node scripts/gen-system-map.mjs        # reescribe el HTML in-place
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const ROOT = new URL('..', import.meta.url).pathname;
const HTML = join(ROOT, 'public/system-map.html');

// ── 1. archivos a escanear ──────────────────────────────────────────────
const files = [];
const walk = (dir) => readdirSync(dir).forEach(f => {
  const p = join(dir, f);
  if (statSync(p).isDirectory()) return walk(p);
  if (f.endsWith('.js')) files.push(p);
});
walk(join(ROOT, 'api'));
for (const f of ['app.js', 'i18n.js', 'desk.js']) {
  try { statSync(join(ROOT, 'public', f)); files.push(join(ROOT, 'public', f)); } catch {}
}

// ── ecosistema fuera del dashboard (solo lectura; si una ruta no existe, se omite) ──
// cretum_reports (Python): generador de PDFs, pipeline de cartas, db_guard, crons de marks.
const HOME = process.env.HOME || '';
const REPORTS_ROOT = [join(HOME, 'srv/cretum-reports'), '/Users/air/cretum_reports']
  .find(p => { try { return statSync(p).isDirectory(); } catch { return false; } });
const OPS_ROOT = [join(HOME, 'srv/ops')]
  .find(p => { try { return statSync(p).isDirectory(); } catch { return false; } });
const pyFiles = [], shFiles = [];
if (REPORTS_ROOT) {
  const walkPy = (dir) => readdirSync(dir).forEach(f => {
    const p = join(dir, f);
    try {
      if (statSync(p).isDirectory()) { if (!/venv|__pycache__|\.git|_state|node_modules/.test(f)) walkPy(p); return; }
      if (f.endsWith('.py') && !f.endsWith('.bak')) pyFiles.push(p);
    } catch {}
  });
  for (const d of ['generator', 'tools', 'scrapers']) { try { walkPy(join(REPORTS_ROOT, d)); } catch {} }
}
if (OPS_ROOT) readdirSync(OPS_ROOT).forEach(f => {
  if ((f.endsWith('.sh') || f.endsWith('.py')) && !/\.bak/.test(f)) shFiles.push(join(OPS_ROOT, f));
});
const PY_GROUP = (rel) => {
  if (rel.startsWith('generator/')) return 'Reportes PDF · Generator';
  if (rel.startsWith('scrapers/')) return 'Scraper Altareturn';
  if (/letters|apply_distributions|parse_letters/.test(rel)) return 'Pipeline de cartas (Mini)';
  if (/db_guard|daily_verifier|audit_db/.test(rel)) return 'DB Guard & Verificador';
  if (/sync_|fund_moic|tracker_news|caplight|cas_marks|live_marks/.test(rel)) return 'Crons de marks & MOIC (Mini)';
  return 'Tools · Reportes';
};

const slug = s => s.toLowerCase().replace(/\.js$/, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

// ── 2. extraer símbolos ─────────────────────────────────────────────────
const FN_RE = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(|^(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/;
const nodes = [], perFile = {};
for (const p of files) {
  const rel = relative(ROOT, p);
  const fileId = slug(rel);
  const lines = readFileSync(p, 'utf8').split('\n');
  const fns = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(FN_RE);
    if (!m) continue;
    fns.push({ name: m[1] || m[2], line: i + 1 });
  }
  for (let k = 0; k < fns.length; k++) {
    fns[k].loc = Math.max(1, (k + 1 < fns.length ? fns[k + 1].line : lines.length) - fns[k].line);
  }
  const fileNode = { id: fileId, name: rel.split('/').pop(), rel, line: 1,
                     val: Math.min(40, fns.length ? Math.max(...fns.map(f => Math.min(40, f.loc))) : 6), fns };
  perFile[fileId] = fileNode;
  nodes.push(fileNode);
  for (const f of fns) {
    nodes.push({ id: `${fileId}_${f.name.toLowerCase()}`, name: `${f.name}()`, rel, line: f.line,
                 val: Math.min(40, f.loc), parent: fileId, fname: f.name });
  }
}

// ── 2b. símbolos Python (cretum_reports) y crons .sh de la Mini ─────────
const PY_RE = /^(?:def|class)\s+([A-Za-z_][\w]*)/;
for (const p of pyFiles) {
  const rel = relative(REPORTS_ROOT, p);
  const fileId = 'rep_' + slug(rel.replace(/\.py$/, ''));
  const lines = readFileSync(p, 'utf8').split('\n');
  const fns = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(PY_RE);
    if (m) fns.push({ name: m[1], line: i + 1 });
  }
  for (let k = 0; k < fns.length; k++) fns[k].loc = Math.max(1, (k + 1 < fns.length ? fns[k + 1].line : lines.length) - fns[k].line);
  const g = PY_GROUP(rel);
  const fileNode = { id: fileId, name: rel.split('/').pop(), rel: 'cretum_reports/' + rel, line: 1, gname: g,
                     val: Math.min(40, fns.length ? Math.max(...fns.map(f => Math.min(40, f.loc))) : 6), fns };
  perFile[fileId] = fileNode;
  nodes.push(fileNode);
  for (const f of fns) nodes.push({ id: `${fileId}_${f.name.toLowerCase()}`, name: `${f.name}()`,
    rel: 'cretum_reports/' + rel, line: f.line, val: Math.min(40, f.loc), parent: fileId, fname: f.name, gname: g });
}
for (const p of shFiles) {
  const nm = p.split('/').pop();
  const loc = readFileSync(p, 'utf8').split('\n').length;
  nodes.push({ id: 'ops_' + slug(nm), name: nm, rel: 'mini/srv/ops/' + nm, line: 1,
               val: Math.min(40, Math.max(4, Math.round(loc / 8))), gname: 'Crons Mini · Ops' });
}

// ── 3. taxonomía: heredar gname del HTML vigente ────────────────────────
const html = readFileSync(HTML, 'utf8');
const oldNodes = JSON.parse(html.match(/const CODE_NODES = (\[.*?\]);/s)[1]);
const oldG = Object.fromEntries(oldNodes.map(n => [n.id, n.gname]));

// ── Colores por PERTENENCIA (pedido Eugenio 2026-09-02): MVP = naranjas,
//    Cretum = azules, compartido = blancos/grises claros. Tono por hash del
//    nombre del grupo → determinista en cualquier máquina (sin ping-pong).
const DOMAIN = {
  'Investor Detail & Apertura': 'mvp', 'Investor Selection': 'mvp',
  'Report Building & Exports': 'mvp', 'Report Document Formatting': 'mvp',
  'Report Fuzzy Matching': 'mvp', 'Companies PDF Export': 'mvp',
  'Excel Native Charts': 'mvp', 'SpaceX Report Export': 'mvp',
  'Portal Admin Management': 'mvp', 'Portal Dashboard Preview': 'mvp',
  'Portal File Upload': 'mvp', 'Dropbox Files & Forms': 'mvp',
  'Reportes PDF · Generator': 'mvp', 'Tools · Reportes': 'mvp',
  'Pipeline de cartas (Mini)': 'mvp', 'DB Guard & Verificador': 'mvp',
  'Crons de marks & MOIC (Mini)': 'mvp', 'Scraper Altareturn': 'mvp',
  'Campaign UI & Modals': 'cretum', 'Campaign Contact Management': 'cretum',
  'Campaign Email Templates': 'cretum', 'Campaign CSV Import': 'cretum',
  'Campaign LP Detail': 'cretum', 'Monthly Letter Campaign': 'cretum',
  'Fundraising Prospects': 'cretum', 'Prospect Detail UI': 'cretum',
  'Task Views & Boards': 'cretum',
  'API Auth & Integrations': 'both', 'Core UI Utilities': 'both',
  'Navigation & Routing': 'both', 'Filters & UI Toggles': 'both',
  'Internationalization': 'both', 'Login & MFA': 'both',
  'Logo Proxy Endpoint': 'both', 'Reminder Preferences': 'both',
  'Crons Mini · Ops': 'both',
};
const domainOf = g => DOMAIN[g] ||
  (/campaign|prospect|task/i.test(g) ? 'cretum'
   : /report|portal|investor|carta|guard|marks|altareturn|spacex|dropbox/i.test(g) ? 'mvp' : 'both');
const ghash = g => [...g].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const colorOf = {};
const domainColor = (g) => {
  const h = ghash(g);
  const d = domainOf(g);
  if (d === 'mvp')    return `hsl(${14 + h % 36},${74 + h % 12}%,${50 + (h >> 3) % 14}%)`;   // naranjas 14-50°
  if (d === 'cretum') return `hsl(${202 + h % 34},${62 + h % 18}%,${52 + (h >> 3) % 16}%)`;  // azules 202-236°
  return `hsl(${210 + h % 20},${6 + h % 8}%,${66 + (h >> 3) % 20}%)`;                        // grises claros
};
// posiciones conocidas por archivo para "vecino más cercano"
const known = {};
for (const n of nodes) {
  const g = oldG[n.id];
  if (g) { n.gname = g; (known[n.rel] ||= []).push([n.line, g]); }
}
const groupColor = g => colorOf[g] || (colorOf[g] = domainColor(g));
for (const n of nodes) {
  if (n.gname) continue;
  const ks = (known[n.rel] || []).sort((a, b) => Math.abs(a[0] - n.line) - Math.abs(b[0] - n.line));
  n.gname = ks.length ? ks[0][1]
    : n.rel.startsWith('api/') ? 'API Auth & Integrations' : 'Core UI Utilities';
}

// ── 4. aristas ──────────────────────────────────────────────────────────
const links = [], seen = new Set();
const addLink = (a, b) => { const k = a + '>' + b; if (a !== b && !seen.has(k)) { seen.add(k); links.push({ source: a, target: b }); } };
// archivo→archivo: imports/require dentro de api/
for (const p of files.filter(f => relative(ROOT, f).startsWith('api/'))) {
  const rel = relative(ROOT, p), src = readFileSync(p, 'utf8');
  for (const m of src.matchAll(/from\s+['"](\.[^'"]+)['"]|require\(['"](\.[^'"]+)['"]\)/g)) {
    const imp = (m[1] || m[2]).replace(/^\.\//, rel.split('/').slice(0, -1).join('/') + '/').replace(/^\.\.\//, 'api/');
    const t = slug(imp.endsWith('.js') ? imp : imp + '.js');
    if (perFile[t]) addLink(slug(rel), t);
  }
}
// función→función: nombre( de otro símbolo del mismo archivo (>4 chars, único)
for (const [fid, f] of Object.entries(perFile)) {
  if (fid.startsWith('rep_')) continue;   // los Python tienen su propio loop abajo
  const src = readFileSync(join(ROOT, f.rel), 'utf8').split('\n');
  const names = new Map(f.fns.filter(x => x.name.length > 4).map(x => [x.name, x]));
  for (let k = 0; k < f.fns.length; k++) {
    const fn = f.fns[k];
    const body = src.slice(fn.line, fn.line + fn.loc - 1).join('\n');
    for (const [nm] of names) {
      if (nm !== fn.name && new RegExp(`\\b${nm}\\s*\\(`).test(body)) {
        addLink(`${fid}_${fn.name.toLowerCase()}`, `${fid}_${nm.toLowerCase()}`);
      }
    }
  }
  for (const fn of f.fns) addLink(fid, `${fid}_${fn.name.toLowerCase()}`);
}

// aristas python: archivo→funciones, llamadas internas e imports del repo
for (const [fid, f] of Object.entries(perFile)) {
  if (!fid.startsWith('rep_')) continue;
  const abs = join(REPORTS_ROOT, f.rel.replace(/^cretum_reports\//, ''));
  const srcLines = readFileSync(abs, 'utf8').split('\n');
  const names = new Map((f.fns || []).filter(x => x.name.length > 4).map(x => [x.name, x]));
  for (const fn of f.fns || []) {
    addLink(fid, `${fid}_${fn.name.toLowerCase()}`);
    const body = srcLines.slice(fn.line, fn.line + fn.loc - 1).join('\n');
    for (const [nm] of names) {
      if (nm !== fn.name && new RegExp(`\\b${nm}\\s*\\(`).test(body)) addLink(`${fid}_${fn.name.toLowerCase()}`, `${fid}_${nm.toLowerCase()}`);
    }
  }
  const whole = srcLines.join('\n');
  for (const m of whole.matchAll(/from\s+((?:generator|tools|scrapers)[.\w]*)\s+import|import\s+((?:generator|tools|scrapers)[.\w]*)/g)) {
    const mod = (m[1] || m[2]).replace(/\./g, '/');
    const t = 'rep_' + slug(mod);
    if (perFile[t]) addLink(fid, t);
  }
}

// ── 5. escribir ─────────────────────────────────────────────────────────
const out = nodes.map(n => ({ id: n.id, name: n.name, group: 'code', gname: n.gname,
  val: n.val, src: `${n.rel} · L${n.line}`, color: groupColor(n.gname) }));
let s = html.replace(/const CODE_NODES = \[.*?\];/s, `const CODE_NODES = ${JSON.stringify(out)};`)
            .replace(/const CODE_LINKS = \[.*?\];/s, `const CODE_LINKS = ${JSON.stringify(links)};`)
            .replace(/Código completo<small>\d+ símbolos<\/small>/, `Código completo<small>${out.length} símbolos</small>`);
writeFileSync(HTML, s);
const groups = new Set(out.map(n => n.gname));
console.log(`system-map: ${out.length} símbolos (${Object.keys(perFile).length} archivos) · ${links.length} aristas · ${groups.size} grupos`);
