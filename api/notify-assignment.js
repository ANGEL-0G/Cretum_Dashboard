/**
 * api/notify-assignment.js — emails transaccionales de asignación de tareas
 *
 * Disparado desde el frontend en tres momentos:
 *   - 'new_assignment' → alguien asigna una tarea (notifica al destinatario)
 *   - 'accepted'       → destinatario aceptó (notifica al asignador)
 *   - 'declined'       → destinatario declinó (notifica al asignador)
 *
 * Si Resend rechaza la entrega, se avisa al admin con el detalle del error y
 * se devuelve { ok: false, error } al frontend para que muestre toast al user.
 */

import { authenticate } from './_lib/auth.js';
import { getSupabaseAdmin } from './_lib/supabase.js';
import { sendEmail, notifyAdminOfFailure } from './_lib/email.js';

const APP_URL = 'https://cretumdesk.com';
const ALLOWED_TYPES = new Set(['new_assignment', 'accepted', 'declined']);

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtDate(d) {
  if (!d) return '';
  try {
    return new Date(d + 'T12:00:00').toLocaleDateString('es-MX', {
      weekday: 'long', day: 'numeric', month: 'long'
    });
  } catch { return d; }
}

function wrapTemplate(headerLabel, headerTitle, bodyHtml) {
  return `<!doctype html>
<html><body style="font-family:-apple-system,'Segoe UI',Arial,sans-serif;background:#f8f9fc;margin:0;padding:24px;color:#1a1f2e">
  <div style="max-width:560px;margin:0 auto;background:white;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(26,58,107,.1)">
    <div style="background:white;padding:22px 26px 0;text-align:center">
      <img src="${APP_URL}/logo.png" alt="CRETUM Partners" width="160" style="display:inline-block;max-width:100%">
    </div>
    <div style="background:linear-gradient(135deg,#1a3a6b,#2a4f8f);color:white;padding:18px 26px">
      <div style="font-size:11px;letter-spacing:1.6px;opacity:.75">${headerLabel}</div>
      <div style="font-size:22px;font-weight:500;margin-top:4px">${headerTitle}</div>
    </div>
    <div style="padding:24px 26px">
      ${bodyHtml}
    </div>
    <div style="padding:14px 26px;border-top:1px solid #eef0f5;color:#9aa3b5;font-size:11px">
      Notificación automática · Cretum Partners
    </div>
  </div>
</body></html>`;
}

function ctaButton(label, href) {
  return `<a href="${href}" style="display:inline-block;background:#1a3a6b;color:white;text-decoration:none;padding:11px 22px;border-radius:6px;font-size:13px;font-weight:500;margin-top:6px">${label}</a>`;
}

function taskCard(taskName) {
  return `<div style="background:#f8f9fc;border-left:3px solid #1a3a6b;padding:12px 16px;border-radius:6px;margin:0 0 16px">
    <div style="color:#1a3a6b;font-size:16px;font-weight:500">${escapeHtml(taskName)}</div>
  </div>`;
}

function buildEmail(type, { actorName, taskName, due }) {
  const safeActor = escapeHtml(actorName);
  const safeTask = escapeHtml(taskName);

  if (type === 'new_assignment') {
    const dueLine = due
      ? `<p style="color:#3d4559;margin:0 0 16px;font-size:14px">📅 Fecha límite: <strong>${escapeHtml(fmtDate(due))}</strong></p>`
      : '';
    return {
      subject: `${actorName} te asignó "${taskName}"`,
      html: wrapTemplate('NUEVA ASIGNACIÓN', `${safeActor} te asignó una tarea`, `
        <p style="color:#3d4559;line-height:1.6;margin:0 0 16px;font-size:14px">
          <strong style="color:#1a3a6b">${safeActor}</strong> te asignó esta tarea para que la revises:
        </p>
        ${taskCard(taskName)}
        ${dueLine}
        <p style="color:#3d4559;line-height:1.6;margin:0 0 16px;font-size:13px">
          Entra al dashboard para aceptarla o declinarla — una vez aceptada, aparecerá en tu lista de pendientes.
        </p>
        ${ctaButton('Ver y aceptar →', `${APP_URL}/#equipo`)}
      `),
    };
  }

  if (type === 'accepted') {
    return {
      subject: `${actorName} aceptó "${taskName}"`,
      html: wrapTemplate('TAREA ACEPTADA', `${safeActor} aceptó tu asignación`, `
        <p style="color:#3d4559;line-height:1.6;margin:0 0 16px;font-size:14px">
          <strong style="color:#1a3a6b">${safeActor}</strong> aceptó la tarea que le asignaste:
        </p>
        ${taskCard(taskName)}
        <p style="color:#3d4559;line-height:1.6;margin:0 0 16px;font-size:13px">
          Ya está en su lista de pendientes. Puedes seguir su progreso desde el dashboard.
        </p>
        ${ctaButton('Abrir CRETUM →', APP_URL)}
      `),
    };
  }

  // declined
  return {
    subject: `${actorName} declinó "${taskName}"`,
    html: wrapTemplate('TAREA DECLINADA', `${safeActor} declinó tu asignación`, `
      <p style="color:#3d4559;line-height:1.6;margin:0 0 16px;font-size:14px">
        <strong style="color:#c0392b">${safeActor}</strong> declinó la tarea que le asignaste:
      </p>
      ${taskCard(taskName)}
      <p style="color:#3d4559;line-height:1.6;margin:0 0 16px;font-size:13px">
        Si todavía necesitas que alguien la tome, puedes reasignarla desde el dashboard.
      </p>
      ${ctaButton('Abrir CRETUM →', APP_URL)}
    `),
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }
  if (!process.env.RESEND_API_KEY) {
    return res.status(500).json({ error: 'RESEND_API_KEY no configurada' });
  }

  const user = await authenticate(req);
  if (!user) return res.status(401).json({ error: 'No autorizado' });

  const { type, recipientUserId, actorName, taskName, due } = req.body || {};
  if (!type || !recipientUserId || !actorName || !taskName) {
    return res.status(400).json({ error: 'Faltan parámetros (type, recipientUserId, actorName, taskName)' });
  }
  if (!ALLOWED_TYPES.has(type)) {
    return res.status(400).json({ error: `Tipo inválido: ${type}` });
  }

  const sbAdmin = getSupabaseAdmin();
  if (!sbAdmin) {
    return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY no configurada' });
  }

  // Resolver el email del destinatario (UUID → email vía Supabase Auth)
  let recipientEmail;
  try {
    const { data, error } = await sbAdmin.auth.admin.getUserById(recipientUserId);
    if (error) throw error;
    if (!data?.user?.email) throw new Error('Usuario sin email registrado');
    recipientEmail = data.user.email;
  } catch (err) {
    await notifyAdminOfFailure({
      context: `${type} (resolviendo email para ${recipientUserId})`,
      recipient: recipientUserId,
      error: err.message,
    });
    return res.status(200).json({ ok: false, error: 'No se pudo resolver el email del destinatario' });
  }

  const { subject, html } = buildEmail(type, { actorName, taskName, due });

  try {
    const r = await sendEmail(recipientEmail, subject, html);
    return res.status(200).json({ ok: true, id: r.id, recipient: recipientEmail });
  } catch (err) {
    await notifyAdminOfFailure({
      context: type,
      recipient: recipientEmail,
      error: err.message,
    });
    return res.status(200).json({ ok: false, error: err.message, recipient: recipientEmail });
  }
}
