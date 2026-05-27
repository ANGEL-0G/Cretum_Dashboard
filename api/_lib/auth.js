/**
 * api/_lib/auth.js — autenticación compartida vía JWT de Supabase
 *
 * Antes cada endpoint reimplementaba la extracción del Bearer token y la
 * validación contra Supabase (tasks.js, reminder.js, dropbox.js).
 */

import { getSupabase } from './supabase.js';

/** Extrae el token crudo del header Authorization (o '' si no hay). */
export function bearerToken(req) {
  const auth = req.headers.authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
}

/**
 * Valida el Bearer JWT contra Supabase.
 * Devuelve el `user` autenticado o null si el token falta/es inválido.
 */
export async function authenticate(req) {
  const token = bearerToken(req);
  if (!token) return null;
  const sb = getSupabase();
  if (!sb) return null;
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}
