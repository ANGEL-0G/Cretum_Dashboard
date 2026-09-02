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

// ── 3. taxonomía: heredar gname del HTML vigente ────────────────────────
const html = readFileSync(HTML, 'utf8');
const oldNodes = JSON.parse(html.match(/const CODE_NODES = (\[.*?\]);/s)[1]);
const oldG = Object.fromEntries(oldNodes.map(n => [n.id, n.gname]));
const colorOf = {};
oldNodes.forEach(n => { if (!colorOf[n.gname]) colorOf[n.gname] = n.color; });
// posiciones conocidas por archivo para "vecino más cercano"
const known = {};
for (const n of nodes) {
  const g = oldG[n.id];
  if (g) { n.gname = g; (known[n.rel] ||= []).push([n.line, g]); }
}
let hue = 5;
const groupColor = g => colorOf[g] || (colorOf[g] = `hsl(${(hue += 47) % 360},70%,58%)`);
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

// ── 5. escribir ─────────────────────────────────────────────────────────
const out = nodes.map(n => ({ id: n.id, name: n.name, group: 'code', gname: n.gname,
  val: n.val, src: `${n.rel} · L${n.line}`, color: groupColor(n.gname) }));
let s = html.replace(/const CODE_NODES = \[.*?\];/s, `const CODE_NODES = ${JSON.stringify(out)};`)
            .replace(/const CODE_LINKS = \[.*?\];/s, `const CODE_LINKS = ${JSON.stringify(links)};`)
            .replace(/Código completo<small>\d+ símbolos<\/small>/, `Código completo<small>${out.length} símbolos</small>`);
writeFileSync(HTML, s);
const groups = new Set(out.map(n => n.gname));
console.log(`system-map: ${out.length} símbolos (${Object.keys(perFile).length} archivos) · ${links.length} aristas · ${groups.size} grupos`);
