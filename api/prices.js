/**
 * api/prices.js — precios públicos de un set fijo de empresas del portafolio.
 *
 * Usado por materiales de presentación (deck de casos de estudio) para mostrar
 * precio/valuación EN VIVO sin exponer la DB: whitelist fija de company_ids,
 * solo current_ev_pps y current_ev_b, CORS abierto, cache 5 min.
 */

import { getSupabaseAdmin } from './_lib/supabase.js';
import { authenticate } from './_lib/auth.js';

// SpaceX, Anthropic, Figure AI, Groq, Revolut, Agility, Base Power, Kraken, Lime
const PUBLIC_COMPANY_IDS = [27, 2, 13, 14, 25, 31, 32, 17, 18];

export default async function handler(req, res) {
  // /api/gvv-live llega aqui via rewrite (?gvvlive=1): vive dentro de esta
  // funcion porque el plan Hobby de Vercel tope 12 serverless functions.
  if (req.query.gvvlive) return gvvLive(req, res);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });

  const sb = getSupabaseAdmin();
  if (!sb) return res.status(500).json({ error: 'config' });

  const { data, error } = await sb
    .from('investments')
    .select('company_id,current_ev_pps,current_ev_b')
    .in('company_id', PUBLIC_COMPANY_IDS)
    .is('distributed_at', null)
    .not('current_ev_pps', 'is', null);
  if (error) return res.status(500).json({ error: 'query' });

  const out = {};
  for (const r of data || []) {
    if (!out[r.company_id]) {
      out[r.company_id] = {
        pps: +r.current_ev_pps,
        evb: r.current_ev_b == null ? null : +r.current_ev_b,
      };
    }
  }
  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60');
  res.status(200).json(out);
}

/**
 * GVV Mesa — snapshot intradia del fondo (SOLO uso interno, sesion Supabase).
 * El robot gvv_spots (Mini, cada 10 min en horario de mercado) sube el snapshot
 * al bucket privado portal-files bajo cretum/_internal/. Sin CORS abierto.
 *   GET /api/gvv-live          → gvv-live.json (snapshot actual)
 *   GET /api/gvv-live?hist=1   → gvv-hist-YYYYMMDD.json (serie del dia, CDMX)
 */
async function gvvLive(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET requerido' });
  if (!(await authenticate(req))) return res.status(401).json({ error: 'No autorizado' });
  const sb = getSupabaseAdmin();
  if (!sb) return res.status(500).json({ error: 'Sin service role' });
  let key = 'cretum/_internal/gvv-live.json';
  if (req.query.analytics) key = 'cretum/_internal/gvv-analytics.json';
  else if (req.query.riesgo) key = 'cretum/_internal/gvv-riesgo.json';
  else if (req.query.privados) key = 'cretum/_internal/gvv-privados.json';
  else if (req.query.hist) {
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' })
      .format(new Date()).replace(/-/g, '');
    key = `cretum/_internal/gvv-hist-${day}.json`;
  }
  const { data, error } = await sb.storage.from('portal-files').download(key);
  if (error || !data) return res.status(404).json({ error: 'Sin snapshot todavia' });
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(Buffer.from(await data.arrayBuffer()));
}
