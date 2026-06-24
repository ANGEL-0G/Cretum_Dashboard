/**
 * api/_lib/report-template.js
 * Construye el HTML del reporte de portafolio (1 página carta, paleta MVP).
 * Se renderiza a PDF con chromium en api/report.js. Mismo diseño que el prototipo aprobado.
 *
 * payload = {
 *   meta:   { title, accountsLine, count, dateStr, single },
 *   totals: { compromiso, nav, valor, distribuido, moic, dpi },
 *   pos:    [{ acct, company, series, estado, entry_pps, current_pps,
 *              commitment, commitment_actual, valor, moic, theme, reinvSource }]
 * }
 * fontFaces = string CSS con los @font-face (data URIs) generados en el handler.
 */

const PAL = ['#E8650D', '#3F3A36', '#E8A05A', '#8A8079', '#C25A2A', '#B89160', '#A9A29A', '#6E665F', '#D98F4E', '#cabfb4'];

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : null; };

function money(v) {
  if (v == null || !Number.isFinite(+v)) return '—';
  v = +v; const a = Math.abs(v);
  if (a >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
  return '$' + v.toFixed(0);
}
function pps(v) { const x = n(v); return x == null ? '—' : '$' + x.toFixed(2); }
function shortSer(s) {
  return String(s || '').replace('MVP Opportunity Fund VI LLC, ', '').replace('MVP Opportunity Series ', 'Serie ').replace('MVP ', '');
}
function donut(items, size = 132, stroke = 25) {
  const tot = items.reduce((s, [, v]) => s + v, 0) || 1;
  const r = (size - stroke) / 2, cx = size / 2, cy = size / 2, C = 2 * Math.PI * r;
  let off = 0, segs = '';
  items.forEach(([, v], i) => {
    const seg = v / tot * C;
    segs += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${PAL[i % PAL.length]}" stroke-width="${stroke}" stroke-dasharray="${seg.toFixed(2)} ${(C - seg).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`;
    off += seg;
  });
  const leg = items.map(([lab, v], i) => `<div class="lg"><span class="dot" style="background:${PAL[i % PAL.length]}"></span>${esc(lab)} <b>${(v / tot * 100).toFixed(0)}%</b></div>`).join('');
  return `<div class="donutwrap"><svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${segs}</svg><div class="legend">${leg}</div></div>`;
}

export function buildReportHtml(payload, fontFaces) {
  const { meta, totals, pos } = payload;
  const active = pos.filter(p => p.estado === 'Activa');

  // Agregaciones (NAV activo)
  const aggBy = (key) => {
    const d = {};
    active.forEach(p => { const v = +p.commitment_actual || 0; if (v > 0) d[p[key]] = (d[p[key]] || 0) + v; });
    return Object.entries(d).sort((a, b) => b[1] - a[1]);
  };
  let byco = aggBy('company');
  if (byco.length > 7) byco = byco.slice(0, 6).concat([['Otros', byco.slice(6).reduce((s, [, v]) => s + v, 0)]]);
  const bytheme = aggBy('theme');

  // MOIC por posición (activas)
  const moicp = active.filter(p => n(p.moic) != null).sort((a, b) => b.moic - a.moic).slice(0, 8);
  const mxM = Math.max(1, ...moicp.map(p => +p.moic));
  const moicbars = moicp.map(p => {
    const m = +p.moic, col = m >= 1 ? '#E8650D' : '#b08968';
    return `<div class="barrow"><span class="bn">${esc(p.company)}</span><span class="bt"><span class="bf" style="width:${(m / mxM * 100).toFixed(0)}%;background:${col}"></span></span><span class="bv">${m.toFixed(2)}x</span></div>`;
  }).join('');

  // Comprometido vs valor por empresa (activas)
  const cv = {};
  active.forEach(p => { const d = cv[p.company] || (cv[p.company] = { c: 0, v: 0 }); d.c += +p.commitment || 0; d.v += +p.valor || 0; });
  const cvl = Object.entries(cv).sort((a, b) => b[1].v - a[1].v).slice(0, 7);
  const mxCv = Math.max(1, ...cvl.map(([, d]) => Math.max(d.c, d.v)));
  const cvbars = cvl.map(([co, d]) => `<div class="cvrow"><span class="bn">${esc(co)}</span><span class="cvbars"><span class="cvb"><span class="cvf gray" style="width:${(d.c / mxCv * 100).toFixed(0)}%"></span></span><span class="cvb"><span class="cvf orange" style="width:${(d.v / mxCv * 100).toFixed(0)}%"></span></span></span><span class="bv">${money(d.v)}</span></div>`).join('');

  // KPIs
  const kpis = [
    ['Compromiso total', money(totals.compromiso), 'accent'],
    ['Comp. ejecutado', money(totals.nav), ''],
    ['Valor actual est.', money(totals.valor), totals.valor >= totals.nav ? 'pos' : 'neg'],
    ['Distribuido', money(totals.distribuido), ''],
    ['MOIC', (+totals.moic).toFixed(2) + 'x', ''],
    ['DPI', (+totals.dpi).toFixed(2) + 'x', ''],
  ];
  const kpihtml = kpis.map(([l, v, c]) => `<div class="kpi ${c}"><div class="kl">${esc(l)}</div><div class="kv">${esc(v)}</div></div>`).join('');

  // Tabla (oculta posiciones que son fuente de reinversión). La columna "Cuenta" solo en combinados.
  const showAcct = !!meta.combined;
  const rows = pos.filter(p => !p.reinvSource).slice().sort((a, b) => (+b.commitment || 0) - (+a.commitment || 0));
  const posrows = rows.map(p => {
    const on = p.estado === 'Activa';
    return `<tr>${showAcct ? `<td class="acct" title="${esc(p.acct)}">${esc(p.acct)}</td>` : ''}<td class="co">${esc(p.company)}</td><td class="ser">${esc(shortSer(p.series))}</td>` +
      `<td><span class="badge ${on ? 'on' : 'off'}">${esc(p.estado)}</span></td>` +
      `<td class="n">${pps(p.entry_pps)}</td><td class="n">${pps(p.current_pps)}</td>` +
      `<td class="n">${money(p.commitment)}</td><td class="n">${money(p.commitment_actual)}</td>` +
      `<td class="n">${n(p.moic) != null ? (+p.moic).toFixed(2) + 'x' : '—'}</td></tr>`;
  }).join('');
  const acctHead = showAcct ? '<th>Cuenta</th>' : '';

  return `<!doctype html><html><head><meta charset="utf-8"><style>
${fontFaces}
*{margin:0;padding:0;box-sizing:border-box}
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
<div class="hero"><div class="eyebrow">MVP · ${meta.single ? 'Reporte de oportunidad' : 'Reporte de portafolio'}</div>
<div class="htitle">${esc(meta.title)}</div>
<div class="hsub">${meta.accountsLine ? meta.accountsLine + ' · ' : ''}${meta.count} posiciones · Generado ${esc(meta.dateStr)}</div>
<div class="accentbar"></div></div>
<div class="body">
<div class="kpis">${kpihtml}</div>
<div class="grid2">
<div class="card"><div class="ctitle">Composición por empresa</div>${donut(byco)}</div>
<div class="card"><div class="ctitle">Exposición por tema</div>${donut(bytheme)}</div>
</div>
<div class="grid2">
<div class="card"><div class="ctitle">MOIC por posición</div>${moicbars}</div>
<div class="card"><div class="ctitle">Comprometido vs. valor · por empresa</div><div class="leg2">▮ gris = comprometido · ▮ naranja = valor actual</div>${cvbars}</div>
</div>
<div class="sec">Posiciones</div>
<table><thead><tr>${acctHead}<th>Empresa</th><th>Serie</th><th>Estado</th><th class="n">PPS Entrada</th><th class="n">PPS Actual</th><th class="n">Compromiso</th><th class="n">Comp. ejec.</th><th class="n">MOIC</th></tr></thead><tbody>${posrows}</tbody></table>
</div>
<div class="foot">MVP MANAGER · DOCUMENTO INTERNO · ${esc(meta.dateStr)}</div>
</div></body></html>`;
}
