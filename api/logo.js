/**
 * api/logo.js — proxy same-origin para logos de empresas (favicons).
 *
 * Sirve para generar el PDF en el cliente (html2canvas) sin que los logos
 * de otro dominio "tainten" el canvas por CORS. Solo proxea hosts en whitelist.
 *   GET /api/logo?u=<url-encoded del favicon>
 */
const ALLOWED = ['google.com', 'gstatic.com', 'duckduckgo.com'];
const hostOk = (h) => ALLOWED.some(a => h === a || h.endsWith('.' + a));

export default async function handler(req, res) {
  const u = req.query.u;
  if (!u) { res.status(400).end('missing u'); return; }
  let url;
  try { url = new URL(decodeURIComponent(u)); } catch { res.status(400).end('bad url'); return; }
  if (url.protocol !== 'https:' || !hostOk(url.hostname)) {
    res.status(400).end('host not allowed'); return;
  }
  try {
    // redirect:'manual' — no seguimos redirecciones a ciegas: un open-redirect en
    // un host permitido podría llevar la petición a un destino interno (SSRF).
    // Si hay redirect, revalidamos el host destino contra la whitelist.
    let r = await fetch(url.toString(), { redirect: 'manual' });
    if (r.status >= 300 && r.status < 400) {
      let loc; try { loc = new URL(r.headers.get('location'), url); } catch { res.status(502).end('bad redirect'); return; }
      if (loc.protocol !== 'https:' || !hostOk(loc.hostname)) { res.status(400).end('redirect not allowed'); return; }
      r = await fetch(loc.toString(), { redirect: 'manual' });
    }
    if (!r.ok) { res.status(502).end('upstream ' + r.status); return; }
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader('Content-Type', r.headers.get('content-type') || 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=604800');
    res.status(200).send(buf);
  } catch (e) {
    res.status(502).end('fetch error');
  }
}
