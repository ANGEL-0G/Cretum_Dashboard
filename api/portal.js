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
        .select('id, title, html, org').eq('slug', slug).maybeSingle();
      if (!dash || dash.org !== org) return res.status(404).json({ error: 'Dashboard no encontrado' });
      const { data: link } = await sb.from('portal_access')
        .select('user_id').eq('user_id', payload.uid).eq('dashboard_id', dash.id).maybeSingle();
      if (!link) return res.status(403).json({ error: 'Sin acceso a este dashboard' });
      return res.status(200).json({ title: dash.title, html: dash.html });
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
      const { data } = await sb.from('portal_dashboards').select('id, slug, title, html').eq('id', req.body.id).eq('org', org).maybeSingle();
      if (!data) return res.status(404).json({ error: 'No encontrado' });
      return res.status(200).json(data);
    }

    if (action === 'save_dashboard') {
      const slug = String(req.body.slug || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
      const title = String(req.body.title || '').trim();
      const html = String(req.body.html || '');
      if (!slug || !title) return res.status(400).json({ error: 'Falta slug o título' });
      if (req.body.id) {
        const { error } = await sb.from('portal_dashboards')
          .update({ slug, title, html, updated_at: new Date().toISOString() })
          .eq('id', req.body.id).eq('org', org);
        if (error) throw error;
      } else {
        const { error } = await sb.from('portal_dashboards')
          .insert({ slug, title, html, org, updated_at: new Date().toISOString() });
        if (error) throw error;
      }
      return res.status(200).json({ ok: true, slug });
    }

    if (action === 'delete_dashboard') {
      const { error } = await sb.from('portal_dashboards').delete().eq('id', req.body.id).eq('org', org);
      if (error) throw error;
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
