/**
 * api/sheets.js — puente Cretum Desk ⇄ Google Sheets (Apps Script web app)
 *
 * Puente temporal mientras el equipo migra del Sheets a Cretum Desk:
 * el admin manda la matriz de campañas y el Apps Script reescribe la hoja,
 * pero ANTES lee los Comentarios/Responsable que el equipo escribió ahí y
 * los devuelve, para que Desk los traiga de vuelta (sync bidireccional de
 * los campos de seguimiento).
 *
 * POST /api/sheets  body: { header, rows, meses, cancelados }
 * → reenvía al web app firmando con SHEETS_SYNC_SECRET y devuelve su JSON:
 *   { ok, filas, seguimiento: { email: { comentarios, responsable } } }
 *
 * Solo admins (verifica el rol en profiles con el propio JWT del usuario).
 * Env: SHEETS_WEBAPP_URL, SHEETS_SYNC_SECRET.
 */

import { authenticate, bearerToken } from './_lib/auth.js';
import { supabaseUrl } from './_lib/supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST requerido' });
  }
  const missing = ['SHEETS_WEBAPP_URL', 'SHEETS_SYNC_SECRET'].filter(k => !process.env[k]);
  if (missing.length) {
    return res.status(500).json({ error: `Sheets no configurado: faltan ${missing.join(', ')}` });
  }

  const user = await authenticate(req);
  if (!user) return res.status(401).json({ error: 'No autorizado' });

  // Solo admin: lee su propio perfil con su mismo JWT (RLS aplica)
  try {
    const pr = await fetch(
      `${supabaseUrl()}/rest/v1/profiles?id=eq.${user.id}&select=role`,
      {
        headers: {
          apikey: process.env.SUPABASE_ANON_KEY,
          Authorization: `Bearer ${bearerToken(req)}`,
        },
      },
    );
    const profiles = pr.ok ? await pr.json() : [];
    if (profiles[0]?.role !== 'admin') {
      return res.status(403).json({ error: 'Solo admins pueden sincronizar el Sheets' });
    }
  } catch (err) {
    return res.status(500).json({ error: 'No se pudo verificar el rol: ' + err.message });
  }

  const { header, rows, meses, cancelados } = req.body || {};
  if (!Array.isArray(header) || !Array.isArray(rows) || !rows.length) {
    return res.status(400).json({ error: 'Payload inválido: faltan header/rows' });
  }

  // Tolera comillas literales y espacios alrededor en las env vars
  // (mismo criterio que DROPBOX_ROOT_PATH en api/dropbox.js)
  const clean = (v) => (v || '').trim().replace(/^["']|["']$/g, '');
  const webappUrl = clean(process.env.SHEETS_WEBAPP_URL);
  const syncSecret = clean(process.env.SHEETS_SYNC_SECRET);

  try {
    const payload = {
      secret: syncSecret,
      header,
      rows,
      meses: meses || 0,
      cancelados: cancelados || [],
    };
    // text/plain: Apps Script no acepta bien preflight CORS ni JSON puro
    const r = await fetch(webappUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      redirect: 'follow', // Apps Script responde con 302 a googleusercontent
    });
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch (e) { /* respuesta no-JSON */ }
    if (!r.ok || !data) {
      return res.status(502).json({ error: `Apps Script ${r.status}: ${text.slice(0, 300)}` });
    }
    if (!data.ok) {
      return res.status(502).json({ error: data.error || 'El Apps Script devolvió error' });
    }
    return res.status(200).json(data);
  } catch (err) {
    console.error('[sheets]', err);
    return res.status(500).json({ error: err.message });
  }
}
