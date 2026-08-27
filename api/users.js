/**
 * api/users.js — Administración de cuentas (SOLO admin).
 *
 * Crear/editar/borrar usuarios, roles, acceso a módulos, reset de contraseña y
 * habilitar/deshabilitar. Todo con service role server-side, validando el JWT.
 * Las cuentas 'hidden' (break-glass) nunca se exponen ni se tocan; a un admin no
 * se le borra/deshabilita desde aquí (se hace en Supabase).
 *
 * (Antes vivía dentro de /api/contacts por el tope de 12 funciones de Vercel
 * Hobby; con el plan de pago se separó a su propia función.)
 *
 * POST /api/users  body: { action: 'users_*', ... }
 */

import { authenticate } from './_lib/auth.js';
import { getSupabaseAdmin } from './_lib/supabase.js';

const ROLES = ['viewer', 'editor', 'colaborador', 'admin'];
const initialsOf = (s) => String(s || '').trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase();

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST requerido' });

  const user = await authenticate(req);
  if (!user) return res.status(401).json({ error: 'No autorizado' });

  const admin = getSupabaseAdmin();
  if (!admin) return res.status(500).json({ error: 'Servidor sin configuración de Supabase' });

  const { data: prof } = await admin.from('profiles').select('role').eq('id', user.id).single();
  if (prof?.role !== 'admin') return res.status(403).json({ error: 'Solo administradores' });

  const body = req.body || {};
  const action = body.action;

  try {
    if (action === 'users_list') {
      const { data: list, error: e } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
      if (e) throw e;
      const { data: profs } = await admin.from('profiles').select('id, full_name, initials, role, hidden, allowed_modules');
      const pById = {}; (profs || []).forEach(p => { pById[p.id] = p; });
      const users = (list?.users || []).map(u => {
        const p = pById[u.id] || {};
        return {
          id: u.id, email: u.email || '',
          full_name: p.full_name || '', role: p.role || null, hidden: !!p.hidden,
          allowed_modules: Array.isArray(p.allowed_modules) ? p.allowed_modules : null,
          disabled: !!(u.banned_until && new Date(u.banned_until) > new Date()),
          last_sign_in: u.last_sign_in_at || null, created_at: u.created_at || null,
        };
      }).filter(u => !u.hidden)
        .sort((a, b) => (a.full_name || a.email).localeCompare(b.full_name || b.email, 'es'));
      return res.status(200).json({ users, me: user.id });
    }

    if (action === 'users_create') {
      const email = String(body.email || '').trim().toLowerCase();
      const full = String(body.full_name || '').trim();
      const role = String(body.role || 'viewer');
      const password = String(body.password || '').trim();
      if (!email || !email.includes('@')) return res.status(400).json({ error: 'Email inválido' });
      if (!full) return res.status(400).json({ error: 'Falta el nombre' });
      if (!ROLES.includes(role)) return res.status(400).json({ error: 'Rol inválido' });
      if (!password || password.length < 8) return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
      const { data: created, error: e } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      if (e) return res.status(400).json({ error: e.message });
      // allowed_modules opcional: array = solo esos módulos; null/omitido = sin restricción.
      const allowed_modules = Array.isArray(body.allowed_modules) ? body.allowed_modules.map(String) : null;
      const { error: pe } = await admin.from('profiles').upsert({ id: created.user.id, full_name: full, initials: initialsOf(full), role, allowed_modules });
      if (pe) throw pe;
      return res.status(200).json({ ok: true, id: created.user.id });
    }

    const targetId = String(body.id || '');
    if (!targetId) return res.status(400).json({ error: 'Falta el usuario' });
    const { data: target } = await admin.from('profiles').select('id, role, hidden').eq('id', targetId).single();
    if (!target || target.hidden) return res.status(404).json({ error: 'Usuario no encontrado' });
    const isSelf = targetId === user.id;
    const targetIsAdmin = target.role === 'admin';

    if (action === 'users_update') {
      const patch = {};
      if (body.full_name != null) { patch.full_name = String(body.full_name).trim(); patch.initials = initialsOf(patch.full_name); }
      if (body.role != null) {
        const role = String(body.role);
        if (!ROLES.includes(role)) return res.status(400).json({ error: 'Rol inválido' });
        if (isSelf && role !== 'admin') return res.status(400).json({ error: 'No puedes quitarte a ti mismo el rol admin' });
        patch.role = role;
      }
      // Acceso a módulos por usuario: array = solo esos; null = sin restricción (todo).
      if (body.allowed_modules !== undefined) {
        patch.allowed_modules = Array.isArray(body.allowed_modules) ? body.allowed_modules.map(String) : null;
      }
      if (Object.keys(patch).length) { const { error: pe } = await admin.from('profiles').update(patch).eq('id', targetId); if (pe) throw pe; }
      if (body.email != null) {
        const email = String(body.email).trim().toLowerCase();
        if (!email.includes('@')) return res.status(400).json({ error: 'Email inválido' });
        const { error: ee } = await admin.auth.admin.updateUserById(targetId, { email, email_confirm: true });
        if (ee) return res.status(400).json({ error: ee.message });
      }
      return res.status(200).json({ ok: true });
    }

    if (action === 'users_reset_pw') {
      const password = String(body.password || '').trim();
      if (password.length < 8) return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
      const { error: e } = await admin.auth.admin.updateUserById(targetId, { password });
      if (e) return res.status(400).json({ error: e.message });
      return res.status(200).json({ ok: true });
    }

    if (action === 'users_disable' || action === 'users_enable') {
      if (isSelf) return res.status(400).json({ error: 'No puedes deshabilitarte a ti mismo' });
      if (targetIsAdmin) return res.status(400).json({ error: 'No se puede deshabilitar a un admin (hazlo desde Supabase)' });
      const ban_duration = action === 'users_disable' ? '87600h' : 'none';
      const { error: e } = await admin.auth.admin.updateUserById(targetId, { ban_duration });
      if (e) return res.status(400).json({ error: e.message });
      return res.status(200).json({ ok: true });
    }

    if (action === 'users_delete') {
      if (isSelf) return res.status(400).json({ error: 'No puedes eliminarte a ti mismo' });
      if (targetIsAdmin) return res.status(400).json({ error: 'Un admin no puede borrar a otro admin — hazlo desde Supabase' });
      const { error: e } = await admin.auth.admin.deleteUser(targetId);
      if (e) return res.status(400).json({ error: e.message });
      await admin.from('profiles').delete().eq('id', targetId);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Acción no reconocida' });
  } catch (err) {
    console.error('[users]', err);
    return res.status(500).json({ error: 'No se pudo completar la operación' });
  }
}
