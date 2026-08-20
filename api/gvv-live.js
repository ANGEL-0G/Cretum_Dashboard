/**
 * api/gvv-live.js — GVV Mesa: snapshot intradía del fondo (solo uso interno)
 *
 * El robot `gvv_spots` (Mini, launchd cada 10 min en horario de mercado) sube el
 * snapshot al bucket privado `portal-files` bajo `cretum/_internal/`. Este
 * endpoint lo sirve a la app interna: requiere sesión de Supabase (cualquier
 * usuario del equipo). El bucket nunca se expone directo al navegador.
 *
 *   GET /api/gvv-live            → gvv-live.json (snapshot actual)
 *   GET /api/gvv-live?hist=1     → gvv-hist-YYYYMMDD.json (serie del día, CDMX)
 */
import { getSupabaseAdmin } from './_lib/supabase.js';
import { authenticate } from './_lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET requerido' });
  if (!(await authenticate(req))) return res.status(401).json({ error: 'No autorizado' });
  const sb = getSupabaseAdmin();
  if (!sb) return res.status(500).json({ error: 'Sin service role' });

  let key = 'cretum/_internal/gvv-live.json';
  if (req.query.hist) {
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' })
      .format(new Date()).replace(/-/g, '');
    key = `cretum/_internal/gvv-hist-${day}.json`;
  }
  const { data, error } = await sb.storage.from('portal-files').download(key);
  if (error || !data) return res.status(404).json({ error: 'Sin snapshot todavía' });
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(Buffer.from(await data.arrayBuffer()));
}
