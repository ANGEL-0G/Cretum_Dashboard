/**
 * api/lp.js — Portal de LP's (información privada por inversionista)
 *
 * DOS mundos en un endpoint (mismo patrón que api/portal.js), pero SISTEMA APARTE:
 *  · PÚBLICO (sin Supabase Auth): un solo enlace (cretumdesk.com/lp); el LP entra
 *    con su USUARIO + CONTRASEÑA y ve solo su información. Al validar se emite un
 *    token de sesión propio (HMAC, PORTAL_JWT_SECRET, namespace k:'lp'). Se sirve
 *    con SERVICE ROLE (omite RLS); las tablas lp_* tienen RLS cerrada.
 *      action=access {username, password} → { token, name, documents:[...] }
 *      action=file   {token, id}          → { url, mime, name }   (URL firmada 1h)
 *  · ADMIN (Supabase Auth, editor/admin): gestión desde el desk.
 *      action=admin_list                                              → { lps:[...] }
 *      action=save_lp   {id?, name, email, username, password, active} → { id }
 *      action=delete_lp {id}
 *      action=lp_docs   {lp_user_id}                                  → { documents:[...] }
 *      action=save_doc  {lp_user_id, title, file_path, file_mime, file_name}
 *      action=delete_doc {id}
 */

import crypto from 'crypto';
import { getSupabaseAdmin, supabaseUrl } from './_lib/supabase.js';
import { authenticate, bearerToken } from './_lib/auth.js';
import { getRedis } from './_lib/redis.js';

const BUCKET = 'lp-files';

// Rate limit (Redis). Ante falta de Redis o error, NO bloquea.
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

/* ── Token de sesión propio (HMAC-SHA256, sin dependencias) ── */
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
    if (payload.k !== 'lp') return null;                 // namespace: no confundir con tokens del portal
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch { return null; }
}

// Secreto del enlace de un LP (token en la URL). URL-safe, difícil de adivinar.
function newAccessToken() { return crypto.randomBytes(24).toString('base64url'); }

// Contraseña del LP: hash scrypt (`salt$hash`), igual que el portal de clientes.
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

// Gestión: editores y admins (las tablas tienen RLS cerrada; el gate es esto).
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

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST requerido' });
  const secret = process.env.PORTAL_JWT_SECRET;
  const sb = getSupabaseAdmin();
  if (!secret || !sb) return res.status(500).json({ error: 'Portal LP no configurado (falta service role o secret)' });

  const action = (req.body?.action || '').toString();

  try {
    /* ───────── PÚBLICO (enlace mágico) ───────── */
    if (action === 'access') {
      const username = String(req.body.username || '').trim().toLowerCase();
      const password = String(req.body.password || '');
      if (!username || !password) return res.status(400).json({ error: 'Escribe tu usuario y contraseña.' });
      // Rate limit ANTES del scrypt: por IP (amplio) y por usuario (estricto).
      const okIp = await rateLimit(`lp:rl:ip:${clientIp(req)}`, 60, 600);
      const okUser = await rateLimit(`lp:rl:u:${username}`, 10, 600);
      if (!okIp || !okUser) return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos.' });

      // username se guarda normalizado en minúsculas → comparación exacta (sin wildcards).
      const { data: lp } = await sb.from('lp_portal_users')
        .select('id, name, active, password_hash, data').eq('username', username).maybeSingle();
      // Mismo mensaje exista o no el usuario (anti-enumeración).
      const ok = lp && lp.active && lp.password_hash && verifyPassword(password, lp.password_hash);
      if (!ok) return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
      try { const r = getRedis(); if (r) await r.del(`lp:rl:u:${username}`); } catch {}   // login OK → limpia contador

      // Marca último acceso (best-effort) y arma la sesión.
      sb.from('lp_portal_users').update({ last_access_at: new Date().toISOString() }).eq('id', lp.id).then(() => {}, () => {});
      const token = signToken({ lp: lp.id, k: 'lp', exp: Date.now() + 12 * 3600 * 1000 }, secret);
      const { data: docs } = await sb.from('lp_portal_docs')
        .select('id, title, file_name, file_mime').eq('lp_user_id', lp.id)
        .order('position', { ascending: true }).order('created_at', { ascending: true });
      const documents = (docs || []).map(d => ({ id: d.id, title: d.title, name: d.file_name || '', mime: d.file_mime || '' }));
      const { admin: _priv, ...dataPub } = (lp.data && typeof lp.data === 'object') ? lp.data : {};
      return res.status(200).json({ token, name: lp.name || '', documents, data: lp.data ? dataPub : null });
    }

    if (action === 'session') {
      // Sesión por token ya emitido (login previo o impersonación de un admin).
      const payload = verifyTokenStr(req.body.token, secret);
      if (!payload) return res.status(401).json({ error: 'Sesión inválida o expirada.' });
      const { data: lp } = await sb.from('lp_portal_users')
        .select('id, name, active, data').eq('id', payload.lp).maybeSingle();
      if (!lp || (!lp.active && !payload.imp)) return res.status(401).json({ error: 'Acceso desactivado — contacta a tu asesor.' });
      const { data: docs } = await sb.from('lp_portal_docs')
        .select('id, title, file_name, file_mime').eq('lp_user_id', lp.id)
        .order('position', { ascending: true }).order('created_at', { ascending: true });
      const documents = (docs || []).map(d => ({ id: d.id, title: d.title, name: d.file_name || '', mime: d.file_mime || '' }));
      const { admin: _priv2, ...dataPub2 } = (lp.data && typeof lp.data === 'object') ? lp.data : {};
      return res.status(200).json({ name: lp.name || '', documents, data: lp.data ? dataPub2 : null, imp: !!payload.imp });
    }

    if (action === 'statement_link') {
      // Estado de cuenta GVV al momento: valida la sesión del LP y emite la URL
      // firmada (HMAC con la service role compartida) hacia el servicio de la Mini.
      const payload = verifyTokenStr(req.body.token, secret);
      if (!payload) return res.status(401).json({ error: 'Sesión inválida o expirada.' });
      const { data: lp } = await sb.from('lp_portal_users')
        .select('active, data').eq('id', payload.lp).maybeSingle();
      if (!lp || (!lp.active && !payload.imp)) return res.status(401).json({ error: 'Acceso desactivado.' });
      const lpId = lp.data && lp.data.gvv && lp.data.gvv.lp_id;
      if (!lpId || lpId === 'demo') return res.status(404).json({ error: 'Sin estado de cuenta disponible.' });
      const ts = Math.floor(Date.now() / 1000);
      const sig = crypto.createHmac('sha256', process.env.SUPABASE_SERVICE_ROLE_KEY)
        .update(`${lpId}|${ts}`).digest('hex');
      const url = `https://mac-mini-de-cretum.tail4eeacb.ts.net:8443/gvv-statement?lp_id=${encodeURIComponent(lpId)}&ts=${ts}&sig=${sig}`;
      return res.status(200).json({ url });
    }

    if (action === 'file') {
      const payload = verifyTokenStr(req.body.token, secret);
      if (!payload) return res.status(401).json({ error: 'Sesión expirada — vuelve a abrir tu enlace.' });
      const { data: lp } = await sb.from('lp_portal_users').select('active').eq('id', payload.lp).maybeSingle();
      if (!lp || (!lp.active && !payload.imp)) return res.status(401).json({ error: 'Acceso desactivado — contacta a tu asesor.' });
      const { data: doc } = await sb.from('lp_portal_docs')
        .select('file_path, file_mime, file_name').eq('id', req.body.id).eq('lp_user_id', payload.lp).maybeSingle();
      if (!doc || !doc.file_path) return res.status(404).json({ error: 'Documento no encontrado' });
      const { data: signed, error: sErr } = await sb.storage.from(BUCKET).createSignedUrl(doc.file_path, 3600);
      if (sErr || !signed) return res.status(500).json({ error: 'No se pudo abrir el documento' });
      return res.status(200).json({ url: signed.signedUrl, mime: doc.file_mime || '', name: doc.file_name || '' });
    }

    /* ───────── ADMIN (sesión de la app, editor/admin) ───────── */
    const KNOWN = ['admin_list', 'save_lp', 'delete_lp', 'lp_docs', 'save_doc', 'delete_doc', 'impersonate'];
    if (!KNOWN.includes(action)) return res.status(400).json({ error: `Acción inválida: ${action}` });
    if (!(await canManage(req))) return res.status(403).json({ error: 'Solo editores o admins' });

    if (action === 'admin_list') {
      const { data: lps } = await sb.from('lp_portal_users')
        .select('id, name, email, username, active, last_access_at, created_at, password_hash, data').order('created_at', { ascending: false });
      const { data: docs } = await sb.from('lp_portal_docs').select('lp_user_id');
      const counts = {};
      (docs || []).forEach(d => { counts[d.lp_user_id] = (counts[d.lp_user_id] || 0) + 1; });
      return res.status(200).json({ lps: (lps || []).map(l => {
        const { password_hash, data, ...rest } = l;   // nunca sale el hash ni el data completo
        return { ...rest, docs: counts[l.id] || 0, has_password: !!password_hash,
                 password: (data && data.admin && data.admin.pw) || null };
      }) });
    }

    if (action === 'save_lp') {
      const name = String(req.body.name || '').trim();
      if (!name) return res.status(400).json({ error: 'Falta el nombre del LP' });
      const email = String(req.body.email || '').trim() || null;
      const active = req.body.active !== false;
      const password = String(req.body.password || '');
      const username = String(req.body.username || '').trim().toLowerCase();
      if (username && !/^[a-z0-9._@-]{3,}$/.test(username)) {
        return res.status(400).json({ error: 'Usuario inválido (mínimo 3, solo letras, números y . _ - @)' });
      }
      if (req.body.id) {
        // Edición: usuario y contraseña solo cambian si se mandan.
        const patch = { name, email, active, updated_at: new Date().toISOString() };
        if (username) patch.username = username;
        if (password) {
          if (password.length < 8) return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
          patch.password_hash = hashPassword(password);
          const { data: cur } = await sb.from('lp_portal_users').select('data').eq('id', req.body.id).maybeSingle();
          const dataCur = (cur && cur.data && typeof cur.data === 'object') ? cur.data : {};
          patch.data = { ...dataCur, admin: { ...(dataCur.admin || {}), pw: password } };
        }
        const { error } = await sb.from('lp_portal_users').update(patch).eq('id', req.body.id);
        if (error) throw error;
        return res.status(200).json({ ok: true, id: req.body.id });
      }
      // Alta: usuario y contraseña obligatorios (login = usuario + contraseña).
      if (!username) return res.status(400).json({ error: 'Falta el usuario' });
      if (!password || password.length < 8) return res.status(400).json({ error: 'La contraseña es obligatoria (mínimo 8 caracteres)' });
      const { data, error } = await sb.from('lp_portal_users')
        .insert({ name, email, active, username, token: newAccessToken(), org: 'cretum',
                  password_hash: hashPassword(password), data: { admin: { pw: password } } })
        .select('id').single();
      if (error) throw error;
      return res.status(200).json({ ok: true, id: data.id });
    }

    if (action === 'impersonate') {
      const { data: lp } = await sb.from('lp_portal_users').select('id').eq('id', req.body.id).maybeSingle();
      if (!lp) return res.status(404).json({ error: 'LP no encontrado' });
      const token = signToken({ lp: lp.id, k: 'lp', imp: true, exp: Date.now() + 60 * 60 * 1000 }, secret);
      return res.status(200).json({ token });
    }

    if (action === 'delete_lp') {
      const { data: docs } = await sb.from('lp_portal_docs').select('file_path').eq('lp_user_id', req.body.id);
      const { error } = await sb.from('lp_portal_users').delete().eq('id', req.body.id);   // cascade borra docs
      if (error) throw error;
      const paths = (docs || []).map(d => d.file_path).filter(Boolean);
      if (paths.length) await sb.storage.from(BUCKET).remove(paths).catch(() => {});
      return res.status(200).json({ ok: true });
    }

    if (action === 'lp_docs') {
      const { data } = await sb.from('lp_portal_docs')
        .select('id, title, file_name, file_mime, file_path, position, created_at')
        .eq('lp_user_id', req.body.lp_user_id)
        .order('position', { ascending: true }).order('created_at', { ascending: true });
      return res.status(200).json({ documents: data || [] });
    }

    if (action === 'save_doc') {
      const lp_user_id = req.body.lp_user_id;
      const title = String(req.body.title || '').trim();
      const file_path = String(req.body.file_path || '').trim();
      if (!lp_user_id || !title || !file_path) return res.status(400).json({ error: 'Faltan datos del documento' });
      const { error } = await sb.from('lp_portal_docs').insert({
        lp_user_id, title, file_path,
        file_mime: req.body.file_mime || null,
        file_name: req.body.file_name || null,
        position: Number.isFinite(+req.body.position) ? +req.body.position : 0,
      });
      if (error) throw error;
      return res.status(200).json({ ok: true });
    }

    if (action === 'delete_doc') {
      const { data: doc } = await sb.from('lp_portal_docs').select('file_path').eq('id', req.body.id).maybeSingle();
      const { error } = await sb.from('lp_portal_docs').delete().eq('id', req.body.id);
      if (error) throw error;
      if (doc?.file_path) await sb.storage.from(BUCKET).remove([doc.file_path]).catch(() => {});
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: `Acción inválida: ${action}` });
  } catch (err) {
    console.error('[lp]', err);
    if (String(err.message).includes('duplicate')) return res.status(409).json({ error: 'Registro duplicado' });
    return res.status(500).json({ error: 'No se pudo completar la operación' });
  }
}
