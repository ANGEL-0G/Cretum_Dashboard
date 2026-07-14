/**
 * api/prices.js — precios públicos de un set fijo de empresas del portafolio.
 *
 * Usado por materiales de presentación (deck de casos de estudio) para mostrar
 * precio/valuación EN VIVO sin exponer la DB: whitelist fija de company_ids,
 * solo current_ev_pps y current_ev_b, CORS abierto, cache 5 min.
 */

import { getSupabaseAdmin } from './_lib/supabase.js';

// SpaceX, Anthropic, Figure AI, Groq, Revolut, Agility, Base Power, Kraken, Lime
const PUBLIC_COMPANY_IDS = [27, 2, 13, 14, 25, 31, 32, 17, 18];

export default async function handler(req, res) {
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
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
  res.status(200).json(out);
}
