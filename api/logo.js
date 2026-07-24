/**
 * api/logo.js — proxy same-origin para logos + tracking de correos.
 *
 * (1) Proxy de favicons para el PDF en cliente (html2canvas sin taint CORS).
 *     GET /api/logo?u=<url-encoded del favicon>  (hosts en whitelist)
 * (2) Tracking de correos (montado aquí para no crear una 13.ª función en
 *     Vercel Hobby; se enruta /api/track → este archivo):
 *     - Apertura: GET /api/track?o=<sendId>  → registra 'open' y devuelve GIF 1x1
 *     - Clic:     GET /api/track?c=<sendId>&d=<url> → registra 'click' y redirige
 *     La escritura de eventos usa service role (bypassa RLS). Es best-effort:
 *     si la BD falla, igual devuelve el pixel / hace la redirección.
 */
import { getSupabaseAdmin } from './_lib/supabase.js';

const ALLOWED = ['google.com', 'gstatic.com', 'duckduckgo.com'];
const hostOk = (h) => ALLOWED.some(a => h === a || h.endsWith('.' + a));

// GIF transparente 1x1 (pixel de apertura)
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() || null;
}
async function logEvent(sendId, type, url, req) {
  try {
    const sb = getSupabaseAdmin();
    if (!sb) return;
    await sb.from('email_events').insert({
      send_id: sendId, type, url: url || null,
      ip: clientIp(req), ua: (req.headers['user-agent'] || '').toString().slice(0, 400),
    });
  } catch (e) { /* best-effort: nunca bloquea el pixel/redirect */ }
}

export default async function handler(req, res) {
  // ── (2) Tracking ──
  const openId = req.query.o, clickId = req.query.c;
  if (openId) {
    await logEvent(String(openId), 'open', null, req);
    res.setHeader('Content-Type', 'image/gif');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    return res.status(200).send(PIXEL);
  }
  if (clickId) {
    let dest = req.query.d ? decodeURIComponent(req.query.d) : '';
    // Solo redirigimos a http(s) (evita javascript:/data: en redirección abierta).
    if (!/^https?:\/\//i.test(dest)) dest = 'https://cretumdesk.com/';
    await logEvent(String(clickId), 'click', dest.slice(0, 2000), req);
    res.setHeader('Cache-Control', 'no-store');
    res.writeHead(302, { Location: dest });
    return res.end();
  }

  // ── (1) Proxy de favicon ──
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
