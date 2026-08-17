/**
 * api/contacts.js — "Tabla de Contactos" para usuarios NO admin
 *
 * Los datos de LP (lp_contacts) son una tabla sensible con RLS solo-admin.
 * Este endpoint es la puerta controlada para que el equipo (editores/viewers)
 * pueda ver la lista de contactos y AÑADIR los suyos, sin abrir la tabla a
 * todos a nivel de RLS. Todo pasa por service-role server-side y valida el JWT.
 *
 * Reglas (decididas con el equipo):
 *  - Cualquier usuario autenticado puede LISTAR todos los contactos
 *    (email + nombre + responsable). Los comentarios de seguimiento NO se
 *    exponen aquí (quedan en Gestión, solo-admin).
 *  - AÑADIR: el responsable se fuerza al propio usuario (su full_name del
 *    perfil). El "nombre" (lo que ve Yesware) se deriva del nombre completo.
 *  - EDITAR / BORRAR: solo si el usuario es responsable de ese contacto
 *    (o admin). El email es la llave del histórico y no se edita.
 *
 * POST /api/contacts  body: { action, ... }
 *   action 'list'                                  → { contacts, me }
 *   action 'add'    { nombre_completo, email }     → { ok }
 *   action 'update' { email, nombre_completo }     → { ok }
 *   action 'delete' { email }                      → { ok }
 */

import { authenticate } from './_lib/auth.js';
import { getSupabaseAdmin } from './_lib/supabase.js';

// El nombre que ve Yesware = primera palabra del nombre completo.
const firstWord = (s) => String(s || '').trim().split(/\s+/)[0] || '';
// Clave normalizada (sin acentos/espacios) para comparar nombres de responsable.
const respKey = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
// Un contacto puede tener varios responsables ("A / B"); separa en personas.
const respPeople = (s) => String(s || '')
  .split(/\s*(?:\/|&|,)\s*/)
  .map(x => x.replace(/\s+/g, ' ').trim())
  .filter(x => x && !['na', 'n/a', '-', 'sin', 'tbd', 'pendiente'].includes(x.toLowerCase()));

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST requerido' });

  const user = await authenticate(req);
  if (!user) return res.status(401).json({ error: 'No autorizado' });

  const admin = getSupabaseAdmin();
  if (!admin) return res.status(500).json({ error: 'Servidor sin configuración de Supabase' });

  // Perfil del usuario (nombre para el responsable + rol)
  const { data: prof } = await admin.from('profiles').select('full_name, role').eq('id', user.id).single();
  const myName = (prof?.full_name || '').trim();
  const myKey = respKey(myName);
  const isAdmin = prof?.role === 'admin';

  const body = req.body || {};
  const action = body.action;

  const ownsContact = (responsable) => isAdmin || respPeople(responsable).map(respKey).includes(myKey);

  try {
    // ── Panel de administración de cuentas (SOLO admin) ─────────────────────
    // Crear/editar/borrar usuarios, roles, reset de contraseña y habilitar/
    // deshabilitar. Va aquí (no en una función nueva) por el tope de 12
    // funciones de Vercel Hobby. Las cuentas 'hidden' (break-glass) nunca se
    // exponen ni se tocan; a un admin no se le borra/deshabilita desde aquí.
    if (action && action.startsWith('users_')) {
      if (!isAdmin) return res.status(403).json({ error: 'Solo administradores' });
      const ROLES = ['viewer', 'editor', 'colaborador', 'admin'];
      const initialsOf = (s) => String(s || '').trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase();

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
        const { error: pe } = await admin.from('profiles').upsert({ id: created.user.id, full_name: full, initials: initialsOf(full), role });
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
    }

    // Tabla de Contactos de Apertura (para todos): apertura_contacts + engagement
    // agregado por contacto. apertura_engagement es RLS-admin, aquí se expone
    // agregado (días abiertos + último día), igual que el ranking que ven todos.
    if (action === 'apertura_tabla') {
      const { data: cts, error: ec } = await admin.from('apertura_contacts').select('email, nombre').order('nombre', { nullsFirst: false });
      if (ec) throw ec;
      // Paginado: apertura_engagement crece ~170 filas/día; sin paginar, el default
      // de 1000 filas de PostgREST truncaba y cortaba los días recientes.
      let eng = [], engFrom = 0;
      for (;;) {
        const { data: page, error: ee } = await admin.from('apertura_engagement')
          .select('email, fecha, nivel').order('fecha').range(engFrom, engFrom + 999);
        if (ee) throw ee;
        eng = eng.concat(page || []);
        if (!page || page.length < 1000) break;
        engFrom += 1000;
      }
      const byEmail = {};
      (eng || []).forEach(e => { (byEmail[e.email] ||= []).push(e); });
      const out = (cts || []).map(c => {
        const all = byEmail[c.email] || [];
        const vistos = all.filter(h => h.nivel >= 1);
        const ultimo = vistos.map(h => h.fecha).sort().slice(-1)[0] || null;
        return { email: c.email, nombre: c.nombre || '', dias: vistos.length, ultimo, score: all.reduce((s, h) => s + (h.nivel || 0), 0) };
      });
      return res.status(200).json({ contactos: out });
    }

    if (action === 'list') {
      const { data: contacts, error } = await admin
        .from('lp_contacts')
        .select('email, nombre, nombre_completo, responsable, cancelado')
        .order('nombre_completo', { nullsFirst: false });
      if (error) throw error;
      // Interacción por contacto (campaign_engagement es solo-admin a nivel RLS;
      // aquí la exponemos agregada por LP — igual que el ranking que ya ven todos).
      const { data: eng, error: e2 } = await admin
        .from('campaign_engagement')
        .select('email, periodo, nivel, opened, clicked, replied');
      if (e2) throw e2;
      const byEmail = {};
      (eng || []).forEach(e => { (byEmail[e.email] ||= []).push(e); });
      Object.values(byEmail).forEach(arr => arr.sort((a, b) => String(a.periodo).localeCompare(String(b.periodo))));
      const out = (contacts || []).map(c => ({ ...c, hist: byEmail[c.email] || [] }));
      return res.status(200).json({ contacts: out, me: myName });
    }

    if (action === 'add') {
      const full = String(body.nombre_completo || '').trim();
      const email = String(body.email || '').trim().toLowerCase();
      if (!full) return res.status(400).json({ error: 'El nombre completo es obligatorio' });
      if (!email || !email.includes('@')) return res.status(400).json({ error: 'El email no parece válido' });
      if (!myName) return res.status(400).json({ error: 'Tu perfil no tiene nombre configurado; pídele al admin que lo ponga' });
      const { data: dup } = await admin.from('lp_contacts').select('email').eq('email', email).maybeSingle();
      if (dup) return res.status(409).json({ error: 'Ya existe un contacto con ese email' });
      const { error } = await admin.from('lp_contacts').insert({
        email, nombre: firstWord(full), nombre_completo: full, responsable: myName,
      });
      if (error) throw error;
      return res.status(200).json({ ok: true });
    }

    if (action === 'update' || action === 'delete') {
      const email = String(body.email || '').trim().toLowerCase();
      if (!email) return res.status(400).json({ error: 'Falta el email del contacto' });
      const { data: cur, error: e0 } = await admin.from('lp_contacts').select('responsable').eq('email', email).maybeSingle();
      if (e0) throw e0;
      if (!cur) return res.status(404).json({ error: 'Contacto no encontrado' });
      if (!ownsContact(cur.responsable)) {
        return res.status(403).json({ error: 'Solo puedes modificar contactos donde eres responsable' });
      }

      if (action === 'delete') {
        // Mismo criterio que el admin: borra el histórico de campañas y luego el contacto.
        const { error: e1 } = await admin.from('campaign_engagement').delete().eq('email', email);
        if (e1) throw e1;
        const { error: e2 } = await admin.from('lp_contacts').delete().eq('email', email);
        if (e2) throw e2;
        return res.status(200).json({ ok: true });
      }

      // update: solo el nombre (el email es la llave del histórico, no se cambia aquí)
      const full = String(body.nombre_completo || '').trim();
      if (!full) return res.status(400).json({ error: 'El nombre completo es obligatorio' });
      const { error } = await admin.from('lp_contacts')
        .update({ nombre: firstWord(full), nombre_completo: full })
        .eq('email', email);
      if (error) throw error;
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Acción no reconocida' });
  } catch (err) {
    console.error('[api/contacts]', err);   // detalle en logs, no al cliente
    return res.status(500).json({ error: 'No se pudo completar la operación' });
  }
}
