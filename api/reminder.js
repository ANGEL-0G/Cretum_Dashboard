/**
 * api/reminder.js — resumen semanal por email
 *
 * Dos modos de uso:
 *   1) Cron (Authorization: Bearer $CRON_SECRET) — Vercel lo dispara cada lunes;
 *      envía resumen a TODOS los usuarios de Supabase.
 *   2) Usuario (Authorization: Bearer <supabase_jwt>) — disparado desde la UI
 *      con el botón "Enviar resumen ahora"; envía solo al usuario autenticado.
 */

import { getRedis } from './_lib/redis.js';
import { getSupabase, getSupabaseAdmin } from './_lib/supabase.js';
import { bearerToken } from './_lib/auth.js';
import { sendEmail } from './_lib/email.js';

const APP_URL = 'https://cretumdesk.com';

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

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Nombre legible: full_name si existe; si no, parte antes del @ capitalizada. */
function niceName(fullName, email) {
  const trimmed = (fullName || '').trim();
  if (trimmed) return trimmed;
  const username = (email || '').split('@')[0];
  if (!username) return 'tú';
  return username.charAt(0).toUpperCase() + username.slice(1);
}

function greetingByHour() {
  const cdmxNow = new Date(Date.now() - 6 * 3600 * 1000);
  const h = cdmxNow.getUTCHours();
  if (h < 12) return 'Buenos días';
  if (h < 19) return 'Buenas tardes';
  return 'Buenas noches';
}

function taskCard(t, accent) {
  const due = t.due
    ? `<div style="color:#9aa3b5;font-size:12px;margin-top:4px">${fmtDate(t.due)}</div>`
    : '';
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:separate;margin:0 0 8px">
    <tr><td style="background:#fafbfd;border-left:3px solid ${accent};border-radius:6px;padding:14px 16px">
      <div style="color:#1a1f2e;font-size:14px;font-weight:500;line-height:1.4">${escapeHtml(t.name)}</div>
      ${due}
    </td></tr>
  </table>`;
}

function progressCard(t) {
  const pct = Math.min(100, Math.round((t.done / t.total) * 100));
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:separate;margin:0 0 8px">
    <tr><td style="background:#fafbfd;border-left:3px solid #b07d20;border-radius:6px;padding:14px 16px">
      <div style="color:#1a1f2e;font-size:14px;font-weight:500;line-height:1.4">${escapeHtml(t.name)}</div>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:10px">
        <tr><td style="background:#eef0f5;height:6px;border-radius:3px;font-size:0;line-height:0">
          <div style="background:#b07d20;width:${pct}%;height:6px;border-radius:3px;font-size:0;line-height:0">&nbsp;</div>
        </td></tr>
      </table>
      <div style="color:#9aa3b5;font-size:11px;margin-top:6px">${t.done} de ${t.total} ${escapeHtml(t.unit || '')}</div>
    </td></tr>
  </table>`;
}

function sectionHeader(label, count, color) {
  return `<div style="font-size:11px;font-weight:700;color:${color};letter-spacing:1.2px;text-transform:uppercase;margin:0 0 10px">
    ${label} <span style="opacity:.55;font-weight:500">· ${count}</span>
  </div>`;
}

function htmlEmail(s) {
  const firstName = (s.displayName || 'tú').split(' ')[0] || s.displayName;
  const pendingCount = s.pending.length;
  const overdueCount = s.overdue.length;

  const heroLine = pendingCount === 0
    ? 'Sin tareas pendientes'
    : `Tienes <span style="color:#1a3a6b">${pendingCount}</span> ${pendingCount === 1 ? 'tarea pendiente' : 'tareas pendientes'}`;

  const subLine = pendingCount === 0
    ? '¡Buen trabajo! 🎉'
    : (overdueCount
        ? `<strong style="color:#c0392b">${overdueCount} ${overdueCount === 1 ? 'está vencida' : 'están vencidas'}</strong> — atiéndelas primero`
        : 'esta semana');

  // Preheader oculto: lo que aparece en la línea de preview del inbox
  const preheader = pendingCount === 0
    ? 'Sin tareas pendientes esta semana · ¡Buen trabajo!'
    : `Tienes ${pendingCount} ${pendingCount === 1 ? 'tarea pendiente' : 'tareas pendientes'}${overdueCount ? ' · ' + overdueCount + ' vencidas' : ''}`;

  return `<!doctype html>
<html><body style="font-family:-apple-system,'Segoe UI',Arial,sans-serif;background:#f5f6fa;margin:0;padding:28px 16px;color:#1a1f2e">
  <div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:transparent;mso-hide:all">${preheader}</div>
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:600px;margin:0 auto;background:white;border-radius:14px;box-shadow:0 4px 24px rgba(26,58,107,.06)">
    <tr><td style="padding:36px 36px 4px">
      <p style="margin:0;font-size:11px;color:#9aa3b5;letter-spacing:1.2px;text-transform:uppercase;font-weight:700">Resumen Semanal</p>
      <h1 style="margin:10px 0 8px;font-size:30px;font-weight:600;color:#1a1f2e;line-height:1.15">${heroLine}</h1>
      <p style="margin:0;font-size:14px;color:#5a6478;line-height:1.5">${subLine}</p>
      <div style="margin-top:22px;padding-top:16px;border-top:1px solid #eef0f5;font-size:13px;color:#5a6478">
        ${greetingByHour()}, <strong style="color:#1a1f2e">${escapeHtml(firstName)}</strong>
      </div>
    </td></tr>

    ${s.overdue.length ? `<tr><td style="padding:28px 36px 0">
      ${sectionHeader('Vencidas', s.overdue.length, '#c0392b')}
      ${s.overdue.map(t => taskCard(t, '#c0392b')).join('')}
    </td></tr>` : ''}

    ${s.dueWeek.length ? `<tr><td style="padding:${s.overdue.length ? '18' : '28'}px 36px 0">
      ${sectionHeader('Esta semana', s.dueWeek.length, '#1a3a6b')}
      ${s.dueWeek.map(t => taskCard(t, '#1a3a6b')).join('')}
    </td></tr>` : ''}

    ${s.inProgress.length ? `<tr><td style="padding:18px 36px 0">
      ${sectionHeader('En progreso', s.inProgress.length, '#b07d20')}
      ${s.inProgress.map(t => progressCard(t)).join('')}
    </td></tr>` : ''}

    <tr><td style="padding:28px 36px 8px">
      <a href="${APP_URL}" style="display:inline-block;background:#1a3a6b;color:white;text-decoration:none;padding:13px 28px;border-radius:8px;font-size:14px;font-weight:500">Abrir CRETUM →</a>
    </td></tr>

    <tr><td style="padding:24px 36px 30px">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-top:1px solid #eef0f5">
        <tr>
          <td style="padding-top:16px;font-size:11px;color:#9aa3b5;vertical-align:middle">Resumen automático · Cretum Partners</td>
          <td style="padding-top:16px;text-align:right;vertical-align:middle;width:50px">
            <img src="${APP_URL}/logo-icon.png" alt="CRETUM" width="36" height="36" style="display:inline-block;opacity:.75;border:0">
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

async function sendForUser({ id, email, displayName }, tasks) {
  const summary = buildSummary(id, tasks, displayName);
  const subject = 'Resumen Semanal';
  const html = htmlEmail(summary);
  const r = await sendEmail(email, subject, html);
  return { user: email, recipient: email, id: r.id };
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

      // Día y hora actuales en CDMX (UTC-6, sin horario de verano)
      const cdmxNow = new Date(Date.now() - 6 * 3600 * 1000);
      const todayDow = cdmxNow.getUTCDay();
      const nowHour = cdmxNow.getUTCHours();
      // Cuando se invoca a una hora concreta (cron horario) respeta reminder_hour;
      // si se invoca con ?anyhour=1 (o sin disparador horario) ignora la hora.
      const honorHour = !/[?&]anyhour=1/.test(req.url || '');

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
        const wantHour = (profile.reminder_hour ?? 9);
        if (honorHour && wantHour !== nowHour) {
          results.push({ user: u.email, skipped: `not their hour (now=${nowHour}, want=${wantHour})` });
          continue;
        }
        try {
          const r = await sendForUser({
            id: u.id,
            email: u.email,
            displayName: niceName(profile?.full_name, u.email),
          }, tasks);
          results.push({ ...r, ok: true });
        } catch (err) {
          results.push({ user: u.email, ok: false, error: err.message });
        }
      }
      return res.status(200).json({ ok: true, mode: 'cron', sentAt: new Date().toISOString(), todayDow, nowHour, honorHour, results });
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
    // Leer profile con cliente admin para evitar RLS (ya validamos el JWT arriba).
    // Con el cliente anon, sb.from('profiles')... no respeta auth.uid() porque
    // no le estamos pasando la sesión del usuario, por lo que devuelve null.
    const sbAdmin = getSupabaseAdmin();
    let profileName = null;
    if (sbAdmin) {
      const { data: profile } = await sbAdmin.from('profiles').select('full_name').eq('id', user.id).single();
      profileName = profile?.full_name;
    }
    const displayName = niceName(profileName, user.email);

    const tasks = await getTasks();
    const result = await sendForUser({ id: user.id, email: user.email, displayName }, tasks);
    return res.status(200).json({ ok: true, mode: 'user', sentTo: result.recipient, id: result.id });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
