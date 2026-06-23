/**
 * api/logo.js — proxy same-origin para logos de empresas (favicons).
 *
 * Sirve para generar el PDF en el cliente (html2canvas) sin que los logos
 * de otro dominio "tainten" el canvas por CORS. Solo proxea hosts en whitelist.
 *   GET /api/logo?u=<url-encoded del favicon>
 */
const ALLOWED = ['google.com', 'gstatic.com', 'duckduckgo.com'];

export default async function handler(req, res) {
  const u = req.query.u;
  if (!u) { res.status(400).end('missing u'); return; }
  let url;
  try { url = new URL(decodeURIComponent(u)); } catch { res.status(400).end('bad url'); return; }
  if (url.protocol !== 'https:' || !ALLOWED.some(h => url.hostname === h || url.hostname.endsWith('.' + h))) {
    res.status(400).end('host not allowed'); return;
  }
  try {
    const r = await fetch(url.toString(), { redirect: 'follow' });
    if (!r.ok) { res.status(502).end('upstream ' + r.status); return; }
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader('Content-Type', r.headers.get('content-type') || 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=604800');
    res.status(200).send(buf);
  } catch (e) {
    res.status(502).end('fetch error');
  }
}
