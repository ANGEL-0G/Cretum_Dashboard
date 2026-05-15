/**
 * api/config.js — devuelve la configuración pública para el frontend
 *
 * Tanto SUPABASE_URL como SUPABASE_ANON_KEY son seguros de exponer
 * al navegador; el anon key respeta las políticas RLS automáticamente.
 */

function normalizeUrl(u) {
  if (!u) return u;
  // Si la URL trae /rest/v1/ al final, lo quitamos — el SDK necesita la project URL base
  return u.replace(/\/rest\/v1\/?$/, '').replace(/\/$/, '');
}

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.status(200).json({
    supabaseUrl: normalizeUrl(process.env.SUPABASE_URL),
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
  });
}
