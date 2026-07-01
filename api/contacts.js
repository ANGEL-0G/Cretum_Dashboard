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
