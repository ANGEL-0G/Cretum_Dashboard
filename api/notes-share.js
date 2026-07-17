/**
 * api/notes-share.js — compartir una nota personal con miembros del equipo.
 *
 * Como user_notes tiene RLS (cada quien solo escribe las suyas), el frontend no
 * puede insertar en las notas de otro. Este endpoint usa service role para:
 *   1) verificar que la nota es del usuario autenticado (solo compartes las tuyas),
 *   2) crear una COPIA en las notas de cada destinatario,
 *   3) mandarle un correo "X compartió una nota contigo".
 *
 * El nombre del que comparte se deriva de su perfil (no del body) para que nadie
 * pueda suplantar a otro. No se exponen los emails de los destinatarios.
 */

import { authenticate } from './_lib/auth.js';
import { getSupabaseAdmin } from './_lib/supabase.js';
import { sendEmail, notifyAdminOfFailure } from './_lib/email.js';

const APP_URL = 'https://cretumdesk.com';

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function emailHtml(sharerName, noteTitle) {
  const t = escapeHtml(noteTitle || 'una nota');
  const who = escapeHtml(sharerName);
  return `<!doctype html>
<html><body style="font-family:-apple-system,'Segoe UI',Arial,sans-serif;background:#f8f9fc;margin:0;padding:24px;color:#1a1f2e">
  <div style="max-width:560px;margin:0 auto;background:white;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(26,58,107,.1)">
    <div style="background:white;padding:22px 26px 0;text-align:center">
      <img src="${APP_URL}/logo.png" alt="CRETUM Partners" width="160" style="display:inline-block;max-width:100%">
    </div>
    <div style="background:linear-gradient(135deg,#1a3a6b,#2a4f8f);color:white;padding:18px 26px">
      <div style="font-size:11px;letter-spacing:1.6px;opacity:.75">NOTA COMPARTIDA</div>
      <div style="font-size:22px;font-weight:500;margin-top:4px">${who} compartió una nota contigo</div>
    </div>
    <div style="padding:24px 26px">
      <p style="color:#3d4559;line-height:1.6;margin:0 0 16px;font-size:14px">
        <strong style="color:#1a3a6b">${who}</strong> compartió una nota personal contigo. La encuentras en <strong>To Do → Notas Personales</strong>.
      </p>
      <div style="background:#f8f9fc;border:1px solid #eef0f5;padding:12px 16px;border-radius:8px;margin:0 0 16px">
        <div style="color:#1a3a6b;font-size:16px;font-weight:500">${t}</div>
      </div>
      <a href="${APP_URL}/" style="display:inline-block;background:#1a3a6b;color:white;text-decoration:none;padding:11px 22px;border-radius:6px;font-size:13px;font-weight:500">Abrir Cretum Desk →</a>
    </div>
    <div style="padding:14px 26px;border-top:1px solid #eef0f5;color:#9aa3b5;font-size:11px">
      Notificación automática · Cretum Partners
    </div>
  </div>
</body></html>`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  const user = await authenticate(req);
  if (!user) return res.status(401).json({ error: 'No autorizado' });

  const sbAdmin = getSupabaseAdmin();
  if (!sbAdmin) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY no configurada' });

  const { noteId, to } = req.body || {};
  const recipients = Array.isArray(to) ? [...new Set(to.filter(x => x && x !== user.id))] : [];
  if (!noteId || !recipients.length) return res.status(400).json({ error: 'Faltan parámetros (noteId, to)' });
  if (recipients.length > 20) return res.status(400).json({ error: 'Demasiados destinatarios' });

  // La nota se lee de la BD (autoritativa) y solo puedes compartir las TUYAS.
  const { data: note, error: nerr } = await sbAdmin
    .from('user_notes').select('title,content,user_id').eq('id', noteId).maybeSingle();
  if (nerr || !note) return res.status(404).json({ error: 'Nota no encontrada' });
  if (note.user_id !== user.id) return res.status(403).json({ error: 'No es tu nota' });

  const { data: prof } = await sbAdmin.from('profiles').select('full_name').eq('id', user.id).single();
  const sharerName = (prof?.full_name || 'Un compañero').replace(/[\r\n]+/g, ' ').slice(0, 120);

  const title = String(note.title || '').slice(0, 200);
  const content = `— Compartida por ${sharerName} —\n\n${String(note.content || '')}`;

  let shared = 0;
  for (const rid of recipients) {
    try {
      const { error: ierr } = await sbAdmin.from('user_notes')
        .insert({ user_id: rid, title, content, position: 0 });
      if (ierr) throw ierr;                          // si falla la copia, no cuenta como compartida
      shared++;
      // Correo best-effort (no bloquea si Resend falla)
      try {
        const { data, error } = await sbAdmin.auth.admin.getUserById(rid);
        if (!error && data?.user?.email && process.env.RESEND_API_KEY) {
          await sendEmail(data.user.email, `${sharerName} compartió una nota contigo`, emailHtml(sharerName, title));
        }
      } catch (mailErr) {
        await notifyAdminOfFailure({ context: 'notes-share email', recipient: rid, error: mailErr.message });
      }
    } catch (err) {
      await notifyAdminOfFailure({ context: 'notes-share insert', recipient: rid, error: err.message });
    }
  }

  if (!shared) return res.status(200).json({ ok: false, error: 'No se pudo compartir la nota' });
  return res.status(200).json({ ok: true, shared });
}
