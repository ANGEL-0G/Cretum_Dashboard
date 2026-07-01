/**
 * api/forms.js — Formularios para clientes (onboarding)
 *
 * Misma lógica que el portal: un miembro del equipo GENERA un enlace (token
 * que apunta a SU correo), se lo manda al cliente, el cliente llena el
 * formulario público y las RESPUESTAS le llegan por correo al remitente
 * (y se guardan en form_submissions).
 *
 * POST /api/forms  body: { action, ... }
 *  Público (con token, sin login):
 *   - 'meta'    { token }                      → { ok, advisor }
 *   - 'submit'  { token, data }                → { ok }
 *  Admin (JWT de equipo):
 *   - 'create'  { label }                      → { ok, token, link }
 *   - 'list'                                   → { links: [...] }
 *   - 'delete'  { id }                         → { ok }
 *
 * form_links / form_submissions son solo service-role (RLS); este endpoint
 * es la puerta controlada.
 */

import { randomBytes } from 'crypto';
import { authenticate } from './_lib/auth.js';
import { getSupabaseAdmin } from './_lib/supabase.js';
import { sendEmail, notifyAdminOfFailure } from './_lib/email.js';

// Copia de archivo: además del remitente, las respuestas llegan a este buzón
// (tiene etiqueta/regla para clasificarlas).
const REPORTS_EMAIL = 'reportescretumpartners@gmail.com';

// El endpoint de submit es público (solo token): whitelist de campos + topes
// para que nadie guarde claves arbitrarias ni payloads gigantes en la BD.
const FORM_FIELDS = ['nombres', 'apellidos', 'email', 'telefono', 'calle', 'numero',
  'codigoPostal', 'estado', 'pais', 'tipo', 'empresaNombre', 'empresaDireccion'];
const MAX_FIELD_LEN = 300;
// Anti-spam: cada respuesta dispara correos; un token filtrado no debe poder
// mandar infinitos. Tope holgado (un cliente real llena el formulario 1-2 veces).
const MAX_SUBMISSIONS_PER_LINK = 100;

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Construye el correo con las respuestas del formulario
function buildEmailHtml(d, advisorName) {
  const row = (k, v) => v ? `<tr><td style="padding:6px 14px 6px 0;color:#6b7589;font-size:13px;white-space:nowrap;vertical-align:top">${esc(k)}</td><td style="padding:6px 0;color:#1a1f2e;font-size:13px">${esc(v)}</td></tr>` : '';
  const tipo = d.tipo === 'empresa' ? 'Empresa' : 'Inversionista individual';
  const dir = [d.calle, d.numero, d.codigoPostal, d.estado, d.pais].filter(Boolean).join(', ');
  const empresa = d.tipo === 'empresa'
    ? `<h3 style="font-size:14px;color:#17436b;margin:20px 0 6px">Datos de la empresa</h3>
       <table style="border-collapse:collapse">${row('Nombre', d.empresaNombre)}${row('Dirección', d.empresaDireccion)}</table>` : '';
  return `<div style="font-family:-apple-system,'Segoe UI',Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1f2e">
    <div style="background:#17436b;color:#fff;border-radius:12px;padding:20px 22px;margin-bottom:18px">
      <div style="font-size:11px;letter-spacing:1.5px;opacity:.8">CRETUM PARTNERS · FORMULARIO DE CLIENTE</div>
      <div style="font-size:19px;font-weight:500;margin-top:4px">${esc(d.nombres)} ${esc(d.apellidos)}</div>
      <div style="font-size:12.5px;opacity:.85;margin-top:6px">${esc(tipo)}${advisorName ? ` · Enviado por ${esc(advisorName)}` : ''}</div>
    </div>
    <h3 style="font-size:14px;color:#17436b;margin:0 0 6px">Datos del inversionista</h3>
    <table style="border-collapse:collapse">
      ${row('Nombre(s)', d.nombres)}${row('Apellidos', d.apellidos)}
      ${row('Email', d.email)}${row('Teléfono', d.telefono)}
      ${row('Dirección', dir)}
    </table>
    ${empresa}
    <p style="font-size:11px;color:#9aa3b5;margin-top:20px">Recibido vía Cretum Desk · ${new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' })}</p>
  </div>`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST requerido' });
  const admin = getSupabaseAdmin();
  if (!admin) return res.status(500).json({ error: 'Servidor sin configuración de Supabase' });

  const body = req.body || {};
  const action = body.action;

  try {
    // ── Acciones PÚBLICAS (con token, sin login) ──
    if (action === 'meta') {
      const token = String(body.token || '').trim();
      const { data: link } = await admin.from('form_links').select('recipient_name').eq('token', token).maybeSingle();
      if (!link) return res.status(404).json({ ok: false, error: 'Enlace no válido o expirado' });
      return res.status(200).json({ ok: true, advisor: link.recipient_name || null });
    }

    if (action === 'submit') {
      const token = String(body.token || '').trim();
      const raw = body.data || {};
      const { data: link } = await admin.from('form_links')
        .select('id, recipient_email, recipient_name').eq('token', token).maybeSingle();
      if (!link) return res.status(404).json({ error: 'Enlace no válido o expirado' });

      // Whitelist + trim + tope de longitud: solo guardamos los campos del formulario
      const d = {};
      FORM_FIELDS.forEach(k => { const v = String(raw[k] ?? '').trim(); if (v) d[k] = v.slice(0, MAX_FIELD_LEN); });
      if (d.email) d.email = d.email.toLowerCase().replace(/\s+/g, '');   // convención: email normalizado

      // Validación de obligatorios (los valores ya vienen trim + no vacíos)
      const req2 = ['nombres', 'apellidos', 'pais', 'estado', 'calle', 'codigoPostal', 'numero', 'telefono', 'email', 'tipo'];
      const missing = req2.filter(k => !d[k]);
      if (d.tipo === 'empresa' && !d.empresaNombre) missing.push('empresaNombre');
      if (missing.length) return res.status(400).json({ error: 'Faltan campos obligatorios' });
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.email)) return res.status(400).json({ error: 'Correo no válido' });
      if (d.tipo !== 'empresa' && d.tipo !== 'individual') return res.status(400).json({ error: 'Tipo no válido' });

      // Anti-spam: tope de respuestas por enlace
      const { count } = await admin.from('form_submissions')
        .select('id', { count: 'exact', head: true }).eq('link_id', link.id);
      if ((count || 0) >= MAX_SUBMISSIONS_PER_LINK) {
        return res.status(429).json({ error: 'Este enlace ya no acepta más respuestas; pide uno nuevo a tu contacto.' });
      }

      // Guarda la respuesta ANTES de enviar correo: si no se pudo guardar, no
      // reportamos éxito (la garantía es "la respuesta nunca se pierde").
      const { data: sub, error: subErr } = await admin.from('form_submissions')
        .insert({ link_id: link.id, token, data: d }).select('id').single();
      if (subErr) throw subErr;

      // Envía el correo al remitente
      let emailed = false;
      // Va al remitente y, siempre, al buzón de reportes (sin duplicar si coinciden)
      const recipients = [...new Set([link.recipient_email, REPORTS_EMAIL].filter(Boolean))];
      try {
        await sendEmail(
          recipients,
          `Formulario de cliente — ${d.nombres} ${d.apellidos}`,
          buildEmailHtml(d, link.recipient_name),
        );
        emailed = true;
        if (sub?.id) await admin.from('form_submissions').update({ emailed: true }).eq('id', sub.id);
      } catch (mailErr) {
        // No perdemos la respuesta (queda guardada); avisamos al admin del fallo de correo
        await notifyAdminOfFailure({ context: 'forms submit', recipient: recipients.join(', '), error: mailErr.message });
      }
      return res.status(200).json({ ok: true, emailed });
    }

    // ── Acciones ADMIN (requieren login de equipo) ──
    const user = await authenticate(req);
    if (!user) return res.status(401).json({ error: 'No autorizado' });
    const { data: prof } = await admin.from('profiles').select('full_name, role').eq('id', user.id).single();
    const myName = (prof?.full_name || '').trim();

    if (action === 'create') {
      if (!user.email) return res.status(400).json({ error: 'Tu cuenta no tiene correo; avisa al admin' });
      const token = randomBytes(9).toString('base64url');   // ~12 chars, URL-safe
      const { error } = await admin.from('form_links').insert({
        token, recipient_email: user.email, recipient_name: myName || null,
        created_by: user.id, label: String(body.label || '').trim().slice(0, 120) || null,
      });
      if (error) throw error;
      return res.status(200).json({ ok: true, token });
    }

    if (action === 'list') {
      const { data: links, error } = await admin.from('form_links')
        .select('id, token, label, recipient_email, created_at')
        .eq('created_by', user.id).order('created_at', { ascending: false });
      if (error) throw error;
      // Conteo de respuestas por enlace: agregado en SQL (form_link_counts),
      // no bajamos filas de submissions solo para contarlas.
      const counts = {};
      if ((links || []).length) {
        const { data: rows, error: cntErr } = await admin.rpc('form_link_counts', { p_user: user.id });
        if (cntErr) throw cntErr;
        (rows || []).forEach(r => { counts[r.link_id] = +r.n; });
      }
      return res.status(200).json({ links: (links || []).map(l => ({ ...l, submissions: counts[l.id] || 0 })) });
    }

    if (action === 'delete') {
      const id = +body.id;
      if (!id) return res.status(400).json({ error: 'Falta id' });
      const { error } = await admin.from('form_links').delete().eq('id', id).eq('created_by', user.id);
      if (error) throw error;
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Acción no reconocida' });
  } catch (err) {
    console.error('[api/forms]', err);
    return res.status(500).json({ error: err.message });
  }
}
