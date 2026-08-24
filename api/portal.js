/**
 * api/portal.js — Portal de Clientes (dashboards externos)
 *
 * DOS mundos en un endpoint:
 *  · PÚBLICO (sin Supabase Auth): clientes externos con usuario+contraseña
 *    propios. Se sirve con SERVICE ROLE (omite RLS) — los hashes nunca salen.
 *      action=login  {username, password}      → { token, dashboards:[{slug,title}] }
 *      action=view   {slug, token}             → { title, html }
 *  · ADMIN (Supabase Auth, rol admin): gestión desde la app interna.
 *      action=admin_list                       → { dashboards, users }
 *      action=save_dashboard {id?, slug, title, html}
 *      action=delete_dashboard {id}
 *      action=save_user {id?, username, password?, label, active, dashboardIds[]}
 *      action=delete_user {id}
 *
 * Aislamiento: los usuarios del portal NO son usuarios de Supabase; su token
 * (HMAC propio, PORTAL_JWT_SECRET) solo da acceso a sus dashboards asignados.
 */

import crypto from 'crypto';
import { getSupabaseAdmin, supabaseUrl } from './_lib/supabase.js';
import { authenticate, bearerToken } from './_lib/auth.js';
import { getRedis } from './_lib/redis.js';

// Rate limit contra fuerza bruta del login público. Cuenta intentos por clave
// en una ventana; si se pasa, bloquea. Ante falta de Redis o error, NO bloquea
// (no queremos tumbar el login por un problema de infraestructura).
async function rateLimit(key, max, windowSec) {
  const r = getRedis();
  if (!r) return true;
  try {
    const n = await r.incr(key);
    if (n === 1) await r.expire(key, windowSec);
    return n <= max;
  } catch { return true; }
}
function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'na';
}

/* ── Password hashing (scrypt nativo) ── */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return `${salt}$${hash}`;
}
function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored || '').split('$');
  if (!salt || !hash) return false;
  const calc = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  const a = Buffer.from(calc, 'hex'), b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ── Token propio del portal (HMAC-SHA256, sin dependencias) ── */
function b64url(buf) { return Buffer.from(buf).toString('base64url'); }
function signToken(payload, secret) {
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verifyTokenStr(token, secret) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const expect = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch { return null; }
}

// Gestión del portal: editores y admins (las tablas tienen RLS is_admin(),
// pero estas acciones escriben con service role; el gate es esta verificación).
async function canManage(req) {
  const user = await authenticate(req);
  if (!user) return false;
  try {
    const r = await fetch(`${supabaseUrl()}/rest/v1/profiles?id=eq.${user.id}&select=role`,
      { headers: { apikey: process.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${bearerToken(req)}` } });
    const rows = r.ok ? await r.json() : [];
    return ['admin', 'editor'].includes(rows[0]?.role);
  } catch { return false; }
}

// Empresa del portal: 'mvp' o 'cretum' (default). Separa dashboards/clientes por org.
function reqOrg(req) { return (req.body && req.body.org === 'mvp') ? 'mvp' : 'cretum'; }

/* ── Data room (kind 'folder') ──
 * El prefijo del bucket contiene un manifest.json:
 *   { root: [{key, name}], sections: [{name, files: [{key, name}]}] }
 * `key` es relativo al prefijo (claves ASCII-safe); `name` es el nombre a mostrar
 * (con acentos). Sin manifest → se lista el prefijo (raíz + 1 nivel de carpetas). */
function escHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
async function buildDataRoomHtml(sb, dash) {
  const prefix = String(dash.file_path).replace(/\/+$/, '');
  const store = sb.storage.from('portal-files');
  let manifest = null;
  try {
    const { data: mf } = await store.download(`${prefix}/manifest.json`);
    if (mf) manifest = JSON.parse(await mf.text());
  } catch { /* sin manifest → listamos */ }
  if (!manifest) {
    const { data: rootEntries } = await store.list(prefix, { limit: 500, sortBy: { column: 'name', order: 'asc' } });
    if (!rootEntries) return null;
    const root = rootEntries.filter(e => e.id && e.name !== 'manifest.json').map(e => ({ key: e.name, name: e.name }));
    const folders = rootEntries.filter(e => !e.id);
    const sections = await Promise.all(folders.map(async f => {
      const { data: sub } = await store.list(`${prefix}/${f.name}`, { limit: 500, sortBy: { column: 'name', order: 'asc' } });
      return { name: f.name, files: (sub || []).filter(x => x.id).map(x => ({ key: `${f.name}/${x.name}`, name: x.name })) };
    }));
    manifest = { root, sections };
  }
  const allFiles = [...(manifest.root || []), ...(manifest.sections || []).flatMap(s => s.files || [])];
  if (!allFiles.length) return null;
  const paths = allFiles.map(f => `${prefix}/${f.key}`);
  const { data: signed, error } = await store.createSignedUrls(paths, 3600);
  if (error || !signed) return null;
  const urlByPath = {};
  signed.forEach(s => { if (s.signedUrl) urlByPath[s.path || s.signedUrl.split('?')[0]] = s.signedUrl; });
  // createSignedUrls devuelve en el MISMO orden que paths — usamos el índice como respaldo.
  const urlOf = (i) => signed[i]?.signedUrl || urlByPath[paths[i]] || '#';
  let idx = 0;
  const fileRow = (f) => {
    const u = urlOf(idx++);
    return `<a class="f" href="${escHtml(u)}" target="_blank" rel="noopener">` +
      `<span class="fi">📄</span><span class="fn">${escHtml(f.name)}</span><span class="op">Abrir ↗</span></a>`;
  };
  const rootHtml = (manifest.root || []).map(fileRow).join('');
  const secHtml = (manifest.sections || []).map(s =>
    `<details class="sec"><summary><span class="chev">▸</span>${escHtml(s.name)}` +
    `<span class="cnt">${(s.files || []).length} documento${(s.files || []).length === 1 ? '' : 's'}</span></summary>` +
    `<div class="files">${(s.files || []).map(fileRow).join('')}</div></details>`).join('');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escHtml(dash.title)}</title><style>
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,'Segoe UI','Helvetica Neue',Arial,sans-serif;background:#f4f6f9;color:#1a2332}
.wrap{max-width:860px;margin:0 auto;padding:28px 18px 60px}
.hd{border-bottom:2.5px solid #0f2849;padding-bottom:12px;margin-bottom:6px}
.hd .wm{font-size:12px;font-weight:700;letter-spacing:3.5px;color:#0f2849}
h1{font-family:Georgia,serif;font-size:22px;color:#0f2849;margin:14px 0 4px}
.sub{color:#5a6b82;font-size:12px;margin:0 0 18px}
.note{background:#eef3fa;border:1px solid #d5e0ef;border-radius:8px;padding:9px 13px;font-size:11.5px;color:#33475f;margin:0 0 18px}
.f{display:flex;align-items:center;gap:10px;padding:9px 12px;border:1px solid #dde3ec;border-radius:8px;margin:6px 0;background:#fff;text-decoration:none;color:#1a2332;font-size:12.5px}
.f:hover{border-color:#1c4e80;background:#fbfdff}
.fi{flex:none}.fn{flex:1;min-width:0;overflow-wrap:anywhere}.op{flex:none;font-size:10.5px;color:#1c4e80;font-weight:600}
.main .f{border-color:#0f2849;background:#0f2849;color:#fff}.main .f .op{color:#cfe0f5}.main .f:hover{background:#1c4e80}
.sec{border:1px solid #dde3ec;border-radius:10px;background:#fff;margin:8px 0;padding:0 12px}
.sec summary{display:flex;align-items:center;gap:8px;list-style:none;cursor:pointer;padding:11px 2px;font-size:13px;font-weight:600;color:#0f2849;user-select:none}
.sec summary::-webkit-details-marker{display:none}
.chev{transition:transform .15s;color:#5a6b82}.sec[open] .chev{transform:rotate(90deg)}
.cnt{margin-left:auto;font-size:10.5px;font-weight:400;color:#5a6b82;background:#f4f6f9;border-radius:99px;padding:2px 9px}
.files{padding:2px 0 10px}
.ft{margin-top:26px;padding-top:10px;border-top:1px solid #dde3ec;font-size:9px;letter-spacing:1px;text-transform:uppercase;color:#5a6b82;display:flex;justify-content:space-between}
</style></head><body><div class="wrap">
<div class="hd"><span class="wm">CRETUM&nbsp;PARTNERS</span></div>
<h1>${escHtml(dash.title)}</h1>
<p class="sub">Data room · ${allFiles.length} documentos</p>
<div class="note">Los documentos se abren con enlaces seguros que se renuevan automáticamente al entrar al data room. Si dejaste esta página abierta mucho tiempo y un documento no abre, vuelve a entrar desde el menú.</div>
<div class="main">${rootHtml}</div>
${secHtml}
<div class="ft"><span>Cretum Partners GVV Fund, LP</span><span>Confidencial</span></div>
</div></body></html>`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST requerido' });
  const secret = process.env.PORTAL_JWT_SECRET;
  const sb = getSupabaseAdmin();
  if (!secret || !sb) return res.status(500).json({ error: 'Portal no configurado (falta service role o secret)' });

  const action = (req.body?.action || '').toString();

  try {
    /* ───────── PÚBLICO ───────── */
    if (action === 'login') {
      const org = reqOrg(req);
      const username = String(req.body.username || '').trim().toLowerCase();
      const password = String(req.body.password || '');
      if (!username || !password) return res.status(400).json({ error: 'Faltan credenciales' });
      // Rate limit ANTES del scrypt: por IP (amplio) y por usuario+org (estricto).
      const okIp = await rateLimit(`portal:rl:ip:${clientIp(req)}`, 40, 600);        // 40 / 10 min por IP
      const okUser = await rateLimit(`portal:rl:u:${org}:${username}`, 8, 600);      // 8 / 10 min por usuario
      if (!okIp || !okUser) {
        return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.' });
      }
      const { data: u } = await sb.from('portal_users')
        .select('id, password_hash, active, label').eq('username', username).eq('org', org).maybeSingle();
      // Mismo mensaje y trabajo similar exista o no el usuario (anti-enumeración)
      const ok = u && u.active && verifyPassword(password, u.password_hash);
      if (!ok) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
      try { const r = getRedis(); if (r) await r.del(`portal:rl:u:${org}:${username}`); } catch {}  // login OK → limpia el contador
      const { data: acc } = await sb.from('portal_access')
        .select('portal_dashboards(slug, title, org)').eq('user_id', u.id);
      const dashboards = (acc || []).map(a => a.portal_dashboards).filter(Boolean)
        .filter(d => d.org === org)
        .map(d => ({ slug: d.slug, title: d.title }))
        .sort((a, b) => a.title.localeCompare(b.title, 'es'));
      const token = signToken({ uid: u.id, org, exp: Date.now() + 12 * 3600 * 1000 }, secret);
      return res.status(200).json({ token, label: u.label || '', dashboards });
    }

    if (action === 'view') {
      const payload = verifyTokenStr(req.body.token, secret);
      if (!payload) return res.status(401).json({ error: 'Sesión expirada — vuelve a entrar' });
      // Revalida que el usuario siga activo: si se desactivó, el token deja de servir
      // de inmediato (no espera a que expire a las 12h).
      const { data: pu } = await sb.from('portal_users').select('active').eq('id', payload.uid).maybeSingle();
      if (!pu || !pu.active) return res.status(401).json({ error: 'Acceso desactivado — contacta a tu asesor' });
      const org = reqOrg(req);
      const slug = String(req.body.slug || '');
      const { data: dash } = await sb.from('portal_dashboards')
        .select('id, title, html, org, kind, file_path, file_mime, file_name').eq('slug', slug).eq('org', org).maybeSingle();
      if (!dash || dash.org !== org) return res.status(404).json({ error: 'Dashboard no encontrado' });
      const { data: link } = await sb.from('portal_access')
        .select('user_id').eq('user_id', payload.uid).eq('dashboard_id', dash.id).maybeSingle();
      if (!link) return res.status(403).json({ error: 'Sin acceso a este dashboard' });
      // Dashboard tipo archivo: firmamos una URL temporal (1h) con service role.
      // El bucket es privado; el cliente nunca ve una URL permanente.
      if (dash.kind === 'file' && dash.file_path) {
        const { data: signed, error: sErr } = await sb.storage.from('portal-files')
          .createSignedUrl(dash.file_path, 3600);
        if (sErr || !signed) return res.status(500).json({ error: 'No se pudo abrir el archivo' });
        return res.status(200).json({ title: dash.title, kind: 'file', url: signed.signedUrl, mime: dash.file_mime || '', name: dash.file_name || '' });
      }
      // Dashboard tipo carpeta (data room): file_path es un PREFIJO del bucket con un
      // manifest.json que define el orden y los nombres a mostrar. Se firman TODOS los
      // archivos (1h) en cada apertura y se devuelve la página generada como HTML —
      // portal.html no necesita saber nada nuevo.
      if (dash.kind === 'folder' && dash.file_path) {
        const html = await buildDataRoomHtml(sb, dash);
        if (!html) return res.status(500).json({ error: 'No se pudo abrir el data room' });
        return res.status(200).json({ title: dash.title, kind: 'html', html });
      }
      return res.status(200).json({ title: dash.title, kind: 'html', html: dash.html });
    }

    /* ───────── ACCIONES INTERNAS (requieren sesión de la app) ───────── */
    const KNOWN = ['admin_list', 'get_dashboard', 'save_dashboard', 'delete_dashboard', 'save_user', 'delete_user'];
    if (!KNOWN.includes(action)) {
      return res.status(400).json({ error: `Acción inválida: ${action}` });
    }
    // Toda acción interna exige sesión de Supabase.
    if (!(await authenticate(req))) return res.status(401).json({ error: 'No autorizado' });

    const org = reqOrg(req);

    // LECTURA visible para todo el equipo (incluidos viewers): lista de
    // dashboards y accesos. NUNCA incluye password_hash (no se selecciona).
    if (action === 'admin_list') {
      const [{ data: dashboards }, { data: users }, { data: access }] = await Promise.all([
        sb.from('portal_dashboards').select('id, slug, title, updated_at').eq('org', org).order('title'),
        sb.from('portal_users').select('id, username, label, active, created_at').eq('org', org).order('username'),
        sb.from('portal_access').select('user_id, dashboard_id'),
      ]);
      return res.status(200).json({ dashboards: dashboards || [], users: users || [], access: access || [] });
    }

    // De aquí en adelante: crear/editar/borrar → solo editores/admins (no viewers).
    if (!(await canManage(req))) return res.status(403).json({ error: 'Solo editores o admins' });

    if (action === 'get_dashboard') {
      const { data } = await sb.from('portal_dashboards')
        .select('id, slug, title, html, kind, file_path, file_mime, file_name')
        .eq('id', req.body.id).eq('org', org).maybeSingle();
      if (!data) return res.status(404).json({ error: 'No encontrado' });
      return res.status(200).json(data);
    }

    if (action === 'save_dashboard') {
      const slug = String(req.body.slug || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
      const title = String(req.body.title || '').trim();
      const kind = ['file', 'folder'].includes(req.body.kind) ? req.body.kind : 'html';
      const html = kind === 'html' ? String(req.body.html || '') : '';
      const file_path = kind !== 'html' ? String(req.body.file_path || '') : null;
      const file_mime = kind === 'file' ? String(req.body.file_mime || '') : null;
      const file_name = kind === 'file' ? String(req.body.file_name || '') : null;
      if (!slug || !title) return res.status(400).json({ error: 'Falta slug o título' });
      if (kind === 'file' && !file_path) return res.status(400).json({ error: 'Falta el archivo subido' });
      if (kind === 'folder' && !file_path) return res.status(400).json({ error: 'Falta el prefijo del data room' });
      const fields = { slug, title, kind, html, file_path, file_mime, file_name, updated_at: new Date().toISOString() };
      if (req.body.id) {
        // Si cambia el archivo, borramos el anterior del bucket para no dejar basura.
        // (Solo dashboards tipo 'file': en 'folder' file_path es un prefijo, no un objeto.)
        const { data: old } = await sb.from('portal_dashboards').select('file_path, kind').eq('id', req.body.id).eq('org', org).maybeSingle();
        const { error } = await sb.from('portal_dashboards').update(fields).eq('id', req.body.id).eq('org', org);
        if (error) throw error;
        if (old?.kind === 'file' && old?.file_path && old.file_path !== file_path) {
          await sb.storage.from('portal-files').remove([old.file_path]).catch(() => {});
        }
      } else {
        const { error } = await sb.from('portal_dashboards').insert({ ...fields, org });
        if (error) throw error;
      }
      return res.status(200).json({ ok: true, slug });
    }

    if (action === 'delete_dashboard') {
      const { data: old } = await sb.from('portal_dashboards').select('file_path, kind').eq('id', req.body.id).eq('org', org).maybeSingle();
      const { error } = await sb.from('portal_dashboards').delete().eq('id', req.body.id).eq('org', org);
      if (error) throw error;
      // 'folder': los archivos del prefijo se conservan (borrarlos exige listado recursivo;
      // se hace manualmente si de verdad se quiere vaciar el data room).
      if (old?.kind === 'file' && old?.file_path) await sb.storage.from('portal-files').remove([old.file_path]).catch(() => {});
      return res.status(200).json({ ok: true });
    }

    if (action === 'save_user') {
      const username = String(req.body.username || '').trim().toLowerCase();
      if (!username) return res.status(400).json({ error: 'Falta usuario' });
      const fields = { username, label: req.body.label || null, active: req.body.active !== false };
      if (req.body.password) fields.password_hash = hashPassword(req.body.password);
      let userId = req.body.id;
      if (userId) {
        const { error } = await sb.from('portal_users').update(fields).eq('id', userId).eq('org', org);
        if (error) throw error;
      } else {
        if (!req.body.password) return res.status(400).json({ error: 'La contraseña es obligatoria para un usuario nuevo' });
        const { data, error } = await sb.from('portal_users').insert({ ...fields, org }).select('id').single();
        if (error) throw error;
        userId = data.id;
      }
      // Reemplaza el set de accesos
      if (Array.isArray(req.body.dashboardIds)) {
        await sb.from('portal_access').delete().eq('user_id', userId);
        const rows = req.body.dashboardIds.map(d => ({ user_id: userId, dashboard_id: d }));
        if (rows.length) {
          const { error } = await sb.from('portal_access').insert(rows);
          if (error) throw error;
        }
      }
      return res.status(200).json({ ok: true, id: userId });
    }

    if (action === 'delete_user') {
      const { error } = await sb.from('portal_users').delete().eq('id', req.body.id).eq('org', org);
      if (error) throw error;
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: `Acción inválida: ${action}` });
  } catch (err) {
    console.error('[portal]', err);   // detalle en logs, no al cliente
    // Violación de unique (slug/username duplicado)
    if (String(err.message).includes('duplicate')) {
      return res.status(409).json({ error: 'Ya existe un registro con ese slug/usuario' });
    }
    return res.status(500).json({ error: 'No se pudo completar la operación' });
  }
}
