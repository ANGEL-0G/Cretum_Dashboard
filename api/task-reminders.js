/**
 * api/task-reminders.js — recordatorios por tarea (correo a la hora indicada).
 *
 * Cada tarea puede tener `remindAt` (ISO) elegido al crearla (en 1 h / 4 h /
 * mañana / 1 semana). Un cron dispara este endpoint cada ~15 min; aquí se
 * buscan las tareas cuyo recordatorio ya venció, se envía un correo al dueño y
 * se marcan (`remindSent`) para no repetir. Es idempotente: reprocesar no
 * reenvía nada.
 *
 * Auth: Bearer $CRON_SECRET (igual que reminder.js).
 */

import { timingSafeEqual } from 'crypto';
import { getRedis } from './_lib/redis.js';
import { getSupabaseAdmin } from './_lib/supabase.js';
import { sendEmail } from './_lib/email.js';

const APP_URL = 'https://cretumdesk.com';
const SEED = { simple: [], progress: [], assigned: [], invites: [] };

function safeEq(a, b) {
  const ba = Buffer.from(String(a || '')), bb = Buffer.from(String(b || ''));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function isDone(t) {
  return typeof t.done === 'number' ? t.done >= t.total : t.done === true;
}
function fmtDue(d) {
  if (!d) return '';
  try { return new Date(d + 'T12:00:00').toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' }); }
  catch (e) { return d; }
}

function emailHtml(name, task) {
  const t = escapeHtml(task.name || 'tu tarea');
  const desc = task.desc ? `<p style="color:#3d4559;line-height:1.6;margin:0 0 16px;font-size:14px">${escapeHtml(task.desc)}</p>` : '';
  const due = task.due ? `<div style="font-size:13px;color:#6b7280;margin:0 0 4px">Vence: <b style="color:#1a3a6b">${escapeHtml(fmtDue(task.due))}</b></div>` : '';
  return `<!doctype html>
<html><body style="font-family:-apple-system,'Segoe UI',Arial,sans-serif;background:#f8f9fc;margin:0;padding:24px;color:#1a1f2e">
  <div style="max-width:560px;margin:0 auto;background:white;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(26,58,107,.1)">
    <div style="background:white;padding:22px 26px 0;text-align:center">
      <img src="${APP_URL}/logo.png" alt="CRETUM Partners" width="150" style="display:inline-block;max-width:100%">
    </div>
    <div style="background:linear-gradient(135deg,#1a3a6b,#2a4f8f);color:white;padding:18px 26px">
      <div style="font-size:11px;letter-spacing:1.6px;opacity:.75">RECORDATORIO</div>
      <div style="font-size:21px;font-weight:500;margin-top:4px">${t}</div>
    </div>
    <div style="padding:24px 26px">
      <p style="color:#3d4559;line-height:1.6;margin:0 0 12px;font-size:14px">Hola ${escapeHtml(name)}, este es el recordatorio que pusiste para esta tarea.</p>
      ${due}
      ${desc}
      <a href="${APP_URL}/" style="display:inline-block;background:#1a3a6b;color:white;text-decoration:none;padding:11px 22px;border-radius:6px;font-size:13px;font-weight:500;margin-top:6px">Abrir Cretum Desk →</a>
    </div>
    <div style="padding:14px 26px;border-top:1px solid #eef0f5;color:#9aa3b5;font-size:11px">
      Recordatorio automático · Cretum Partners
    </div>
  </div>
</body></html>`;
}

export default async function handler(req, res) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!process.env.CRON_SECRET || !safeEq(token, process.env.CRON_SECRET)) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY no configurada' });
  }
  const r = getRedis();
  if (!r) return res.status(500).json({ error: 'REDIS_URL no configurada' });

  try {
    const raw = await r.get('tasks');
    const tasks = raw ? JSON.parse(raw) : SEED;
    const now = Date.now();

    // Tareas (propias) con recordatorio vencido y no enviado, aún no completadas.
    const due = [...(tasks.simple || []), ...(tasks.progress || [])].filter(t =>
      t.remindAt && !t.remindSent && !isDone(t) && new Date(t.remindAt).getTime() <= now
    );
    if (!due.length) return res.status(200).json({ ok: true, sent: 0 });

    // Correos de los dueños (auth) + nombre (profiles), igual que reminder.js.
    const sbAdmin = getSupabaseAdmin();
    const { data: { users } = { users: [] } } = await sbAdmin.auth.admin.listUsers();
    const byId = {};
    (users || []).forEach(u => { if (u.email) byId[u.id] = { email: u.email }; });
    const { data: profiles } = await sbAdmin.from('profiles').select('id, full_name');
    (profiles || []).forEach(p => { if (byId[p.id]) byId[p.id].name = p.full_name; });

    let sent = 0;
    for (const t of due) {
      const owner = byId[t.owner];
      // Sin correo del dueño no se puede avisar, pero igual se marca para no reintentar en bucle.
      if (owner?.email) {
        try {
          const name = (owner.name || owner.email.split('@')[0]).split(' ')[0];
          await sendEmail(owner.email, `Recordatorio: ${t.name || 'tarea'}`, emailHtml(name, t));
          sent++;
        } catch (e) { /* best-effort; se marca abajo igual */ }
      }
      t.remindSent = true;
    }

    await r.set('tasks', JSON.stringify(tasks));
    return res.status(200).json({ ok: true, sent, scanned: due.length });
  } catch (err) {
    console.error('[task-reminders]', err);
    return res.status(500).json({ error: 'No se pudieron procesar los recordatorios' });
  }
}
