/**
 * api/reminder.js — resumen semanal por email
 *
 * Dos modos de uso:
 *   1) Cron (Authorization: Bearer $CRON_SECRET) — Vercel lo dispara cada lunes;
 *      envía resumen a TODOS los usuarios de Supabase.
 *   2) Usuario (Authorization: Bearer <supabase_jwt>) — disparado desde la UI
 *      con el botón "Enviar resumen ahora"; envía solo al usuario autenticado.
 *
 * Hasta que verifiquemos el dominio en Resend, todos los emails se redirigen
 * a la dirección registrada (ON_DEMAND_RECIPIENT) — quien tenga esa cuenta es
 * quien recibe físicamente los correos. La info del resumen sí es por usuario.
 */

import { getRedis } from './_lib/redis.js';
import { getSupabase, getSupabaseAdmin } from './_lib/supabase.js';
import { bearerToken } from './_lib/auth.js';

const APP_URL = 'https://cretum-tasks.vercel.app';

// Mientras el dominio cretumpartners.com no esté verificado en Resend,
// todos los correos van a esta dirección (la registrada en Resend).
const ON_DEMAND_RECIPIENT = 'angelarmandooliverosgutierrez@gmail.com';

const SEED = { simple: [], progress: [], assigned: [], invites: [] };

async function getTasks() {
  const r = getRedis();
  if (!r) return SEED;
  const raw = await r.get('tasks');
  return raw ? JSON.parse(raw) : SEED;
}

function fmtDate(d) {
  if (!d) return '';
  return new Date(d + 'T12:00:00').toLocaleDateString('es-MX', {
    weekday: 'short', day: 'numeric', month: 'short'
  });
}

function buildSummary(userId, tasks, displayName) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const weekAhead = new Date(today.getTime() + 7 * 86400000);
  const isMine = (t) => !t.owner || t.owner === userId;
  const taskDone = (t) => t.kind === 'simple' ? t.done : t.done >= t.total;

  const all = [
    ...tasks.simple.map(t => ({ ...t, kind: 'simple' })),
    ...tasks.progress.map(t => ({ ...t, kind: 'progress' })),
  ].filter(isMine);

  const pending = all.filter(t => !taskDone(t));
  const overdue = pending.filter(t => t.due && new Date(t.due + 'T12:00:00') < today);
  const dueWeek = pending.filter(t => {
    if (!t.due) return false;
    const d = new Date(t.due + 'T12:00:00');
    return d >= today && d <= weekAhead;
  });
  const inProgress = tasks.progress
    .filter(t => isMine(t) && t.done > 0 && t.done < t.total);

  return { pending, overdue, dueWeek, inProgress, displayName, total: all.length };
}

function htmlList(items, opts = {}) {
  if (!items.length) return '<p style="color:#9aa3b5;font-style:italic;margin:4px 0 14px;font-size:13px">— ninguna —</p>';
  return `<ul style="margin:4px 0 14px;padding-left:20px;color:#3d4559;font-size:14px;line-height:1.6">
    ${items.map(t => {
      const tail = opts.progress
        ? ` <span style="color:#9aa3b5;font-size:12px">— ${t.done}/${t.total} ${t.unit}</span>`
        : (t.due ? ` <span style="color:#9aa3b5;font-size:12px">— ${fmtDate(t.due)}</span>` : '');
      return `<li style="margin:4px 0">${t.name}${tail}</li>`;
    }).join('')}
  </ul>`;
}

function htmlEmail(s) {
  return `<!doctype html>
<html><body style="font-family:-apple-system,'Segoe UI',Arial,sans-serif;background:#f8f9fc;margin:0;padding:24px;color:#1a1f2e">
  <div style="max-width:560px;margin:0 auto;background:white;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(26,58,107,.1)">
    <div style="background:white;padding:22px 26px 0;text-align:center">
      <img src="${APP_URL}/logo.png" alt="CRETUM Partners" width="160" style="display:inline-block;max-width:100%">
    </div>
    <div style="background:linear-gradient(135deg,#1a3a6b,#2a4f8f);color:white;padding:18px 26px">
      <div style="font-size:11px;letter-spacing:1.6px;opacity:.75">RESUMEN DE TAREAS</div>
      <div style="font-size:22px;font-weight:500;margin-top:4px">Hola, ${s.displayName}</div>
    </div>
    <div style="padding:24px 26px">
      <p style="color:#3d4559;line-height:1.6;margin:0 0 20px;font-size:14px">
        Tienes <strong style="color:#1a3a6b">${s.pending.length}</strong> tarea${s.pending.length !== 1 ? 's' : ''} pendiente${s.pending.length !== 1 ? 's' : ''}${s.overdue.length ? `, de las cuales <strong style="color:#c0392b">${s.overdue.length}</strong> ${s.overdue.length !== 1 ? 'están vencidas' : 'está vencida'}` : ''}.
      </p>

      ${s.overdue.length ? `
        <div style="font-size:12px;font-weight:600;color:#c0392b;letter-spacing:.4px;text-transform:uppercase;margin-bottom:2px">⚠️ Vencidas</div>
        ${htmlList(s.overdue)}` : ''}

      <div style="font-size:12px;font-weight:600;color:#1a3a6b;letter-spacing:.4px;text-transform:uppercase;margin-bottom:2px">📅 Esta semana</div>
      ${htmlList(s.dueWeek)}

      ${s.inProgress.length ? `
        <div style="font-size:12px;font-weight:600;color:#b07d20;letter-spacing:.4px;text-transform:uppercase;margin-bottom:2px">⏳ En progreso</div>
        ${htmlList(s.inProgress, { progress: true })}` : ''}

      <a href="${APP_URL}" style="display:inline-block;background:#1a3a6b;color:white;text-decoration:none;padding:11px 22px;border-radius:6px;font-size:13px;font-weight:500;margin-top:6px">Abrir CRETUM →</a>
    </div>
    <div style="padding:14px 26px;border-top:1px solid #eef0f5;color:#9aa3b5;font-size:11px">
      Resumen automático · Cretum Partners
    </div>
  </div>
</body></html>`;
}

async function sendEmail(to, subject, html) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'CRETUM <onboarding@resend.dev>',
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

async function sendForUser({ id, email, displayName }, tasks) {
  const summary = buildSummary(id, tasks, displayName);
  const subject = summary.overdue.length
    ? `CRETUM · ${summary.pending.length} pendientes (${summary.overdue.length} vencidas)`
    : `CRETUM · Resumen — ${summary.pending.length} pendientes`;
  const html = htmlEmail(summary);
  const recipient = ON_DEMAND_RECIPIENT;  // hasta verificar dominio
  const r = await sendEmail(recipient, subject, html);
  return { user: email, recipient, id: r.id };
}

export default async function handler(req, res) {
  const token = bearerToken(req);

  if (!process.env.RESEND_API_KEY) {
    return res.status(500).json({ error: 'RESEND_API_KEY no configurada' });
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    return res.status(500).json({ error: 'Supabase no configurado' });
  }

  // Modo 1: cron (CRON_SECRET)
  if (process.env.CRON_SECRET && token === process.env.CRON_SECRET) {
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY no configurada' });
    }
    try {
      const sbAdmin = getSupabaseAdmin();
      const { data: { users }, error } = await sbAdmin.auth.admin.listUsers();
      if (error) throw error;
      const { data: profiles } = await sbAdmin.from('profiles')
        .select('id, full_name, reminder_enabled, reminder_day, reminder_hour');
      const profileById = {};
      (profiles || []).forEach(p => { profileById[p.id] = p; });

      // Día actual en CDMX (UTC-6, sin horario de verano)
      const cdmxNow = new Date(Date.now() - 6 * 3600 * 1000);
      const todayDow = cdmxNow.getUTCDay();

      const tasks = await getTasks();
      const results = [];
      for (const u of users || []) {
        if (!u.email) continue;
        const profile = profileById[u.id];
        if (!profile?.reminder_enabled) {
          results.push({ user: u.email, skipped: 'disabled' });
          continue;
        }
        if (profile.reminder_day !== todayDow) {
          results.push({ user: u.email, skipped: `not their day (today=${todayDow}, want=${profile.reminder_day})` });
          continue;
        }
        try {
          const r = await sendForUser({
            id: u.id,
            email: u.email,
            displayName: profile?.full_name || u.email,
          }, tasks);
          results.push({ ...r, ok: true });
        } catch (err) {
          results.push({ user: u.email, ok: false, error: err.message });
        }
      }
      return res.status(200).json({ ok: true, mode: 'cron', sentAt: new Date().toISOString(), todayDow, results });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // Modo 2: usuario (Supabase JWT)
  if (!token) return res.status(401).json({ error: 'No autorizado' });

  try {
    const sb = getSupabase();
    const { data: userData, error: userErr } = await sb.auth.getUser(token);
    if (userErr || !userData?.user) return res.status(401).json({ error: 'JWT inválido' });

    const user = userData.user;
    // Obtener nombre desde profiles (con anon respetando RLS)
    const { data: profile } = await sb.from('profiles').select('full_name').eq('id', user.id).single();
    const displayName = profile?.full_name || user.email;

    const tasks = await getTasks();
    const result = await sendForUser({ id: user.id, email: user.email, displayName }, tasks);
    return res.status(200).json({ ok: true, mode: 'user', sentTo: result.recipient, id: result.id });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
