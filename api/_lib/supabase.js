/**
 * api/_lib/supabase.js — helpers compartidos de Supabase
 *
 * Centraliza la normalización de la URL del proyecto y la creación de
 * clientes (anon y service-role). Antes esta lógica estaba duplicada en
 * config.js, tasks.js, reminder.js y dropbox.js.
 */

import { createClient } from '@supabase/supabase-js';

/** Devuelve la project URL base, quitando /rest/v1 y slashes finales. */
export function supabaseUrl() {
  return (process.env.SUPABASE_URL || '')
    .replace(/\/rest\/v1\/?$/, '')
    .replace(/\/$/, '');
}

let anonClient = null;

/**
 * Cliente con el anon key (respeta RLS). Singleton por instancia de función.
 * Devuelve null si falta configuración.
 */
export function getSupabase() {
  if (anonClient) return anonClient;
  const url = supabaseUrl();
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  anonClient = createClient(url, key, { auth: { persistSession: false } });
  return anonClient;
}

/**
 * Cliente con el service-role key (omite RLS — solo backend, nunca exponer).
 * Devuelve null si falta configuración.
 */
export function getSupabaseAdmin() {
  const url = supabaseUrl();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}
