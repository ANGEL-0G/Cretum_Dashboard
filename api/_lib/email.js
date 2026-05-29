/**
 * api/_lib/email.js — envío de correos vía Resend
 *
 * Centraliza remitente y handshake con la API de Resend.
 * Usado por api/reminder.js y api/notify-assignment.js.
 */

const FROM_ADDRESS = 'Cretum Desk <notificaciones@cretumdesk.com>';
const ADMIN_EMAIL = 'aoliveros@cretumpartners.com';

export async function sendEmail(to, subject, html) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM_ADDRESS,
      to: [to],
      subject,
      html,
    }),
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`Resend ${r.status}: ${err}`);
  }
  return r.json();
}

/** Notifica al admin con el detalle de un error de envío, para diagnóstico. */
export async function notifyAdminOfFailure({ context, recipient, error }) {
  try {
    await sendEmail(
      ADMIN_EMAIL,
      `Error enviando email (${context})`,
      `<p>No se pudo entregar un email automático.</p>
       <ul>
         <li><strong>Contexto:</strong> ${context}</li>
         <li><strong>Destinatario:</strong> ${recipient || '(desconocido)'}</li>
         <li><strong>Error:</strong> ${escapeHtml(error)}</li>
         <li><strong>Timestamp:</strong> ${new Date().toISOString()}</li>
       </ul>`
    );
  } catch (e) {
    console.error('notifyAdminOfFailure: no se pudo avisar al admin', e);
  }
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
