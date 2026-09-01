/**
 * api/gvv-live.js — GVV Mesa: snapshot intradía del fondo (SOLO uso interno).
 *
 * El robot gvv_spots (Mini, cada 10 min en horario de mercado) sube los
 * snapshots al bucket privado portal-files bajo cretum/_internal/. Este endpoint
 * solo LOS LEE (sesión Supabase, sin CORS abierto):
 *   GET /api/gvv-live              → gvv-live.json (snapshot actual)
 *   GET /api/gvv-live?hist=1       → gvv-hist-YYYYMMDD.json (serie del día, CDMX)
 *   GET /api/gvv-live?privados=1   → gvv-privados.json
 *   GET /api/gvv-live?riesgo=1     → gvv-riesgo.json
 *   GET /api/gvv-live?track=1      → gvv-track.json (curva histórica por rangos)
 *   GET /api/gvv-live?intra=1      → gvv-intra-YYYYMMDD.json (SPX/NDX intradía de hoy)
 *   GET /api/gvv-live?analytics=1  → gvv-analytics.json
 *
 * (Antes vivía dentro de /api/prices por el tope de 12 funciones de Vercel
 * Hobby; con el plan de pago se separó a su propia función.)
 */

import { getSupabaseAdmin } from './_lib/supabase.js';
import { authenticate } from './_lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET requerido' });
  if (!(await authenticate(req))) return res.status(401).json({ error: 'No autorizado' });
  const sb = getSupabaseAdmin();
  if (!sb) return res.status(500).json({ error: 'Sin service role' });
  let key = 'cretum/_internal/gvv-live.json';
  if (req.query.trackernews) key = 'mvp/_internal/tracker-news.json';
  else if (req.query.analytics) key = 'cretum/_internal/gvv-analytics.json';
  else if (req.query.track) key = 'cretum/_internal/gvv-track.json';
  else if (req.query.riesgo) key = 'cretum/_internal/gvv-riesgo.json';
  else if (req.query.m13f) key = 'cretum/_internal/gvv-13f.json';
  else if (req.query.privados) key = 'cretum/_internal/gvv-privados.json';
  else if (req.query.hist || req.query.intra) {
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' })
      .format(new Date()).replace(/-/g, '');
    key = req.query.intra ? `cretum/_internal/gvv-intra-${day}.json`
                          : `cretum/_internal/gvv-hist-${day}.json`;
  }
  const { data, error } = await sb.storage.from('portal-files').download(key);
  if (error || !data) return res.status(404).json({ error: 'Sin snapshot todavia' });
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(Buffer.from(await data.arrayBuffer()));
}
