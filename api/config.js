/**
 * api/config.js — devuelve la configuración pública para el frontend
 *
 * Tanto SUPABASE_URL como SUPABASE_ANON_KEY son seguros de exponer
 * al navegador; el anon key respeta las políticas RLS automáticamente.
 */

import { supabaseUrl } from './_lib/supabase.js';

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.status(200).json({
    supabaseUrl: supabaseUrl(),
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
  });
}
