/**
 * api/tasks.js — Vercel Serverless Function
 *
 * GET  /api/tasks  → devuelve el estado actual (requiere JWT de Supabase)
 * POST /api/tasks  → guarda el estado completo (requiere JWT de Supabase)
 *
 * Auth: header `Authorization: Bearer <access_token>` validado contra Supabase.
 * Persistencia: Upstash Redis vía REDIS_URL (TCP+TLS), fallback en memoria.
 */

import { getRedis } from './_lib/redis.js';
import { authenticate, getUserRole } from './_lib/auth.js';

const SEED = { simple: [], progress: [], assigned: [], invites: [] };

let memoryStore = SEED;

async function getStore() {
  const r = getRedis();
  if (r) {
    return {
      async get() {
        const raw = await r.get('tasks');
        return raw ? JSON.parse(raw) : SEED;
      },
      async set(data) {
        await r.set('tasks', JSON.stringify(data));
      }
    };
  }
  return {
    async get() { return memoryStore; },
    async set(data) { memoryStore = data; }
  };
}

// Orígenes permitidos para CORS. El frontend se sirve del MISMO deployment (same-origin,
// no necesita CORS); esta lista solo habilita los dominios propios como cross-origin.
// Los *.vercel.app (previews) se permiten por sufijo. Cualquier otro origen no recibe
// cabecera CORS → el navegador bloquea la lectura de la respuesta.
const ALLOWED_ORIGINS = [
  'https://cretumdesk.com',
  'https://www.cretumdesk.com',
];
function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && (ALLOWED_ORIGINS.includes(origin) || /^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
}

export default async function handler(req, res) {
  applyCors(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await authenticate(req);
  if (!user) return res.status(401).json({ error: 'No autorizado' });

  const store = await getStore();

  if (req.method === 'GET') {
    try {
      const data = await store.get();
      return res.status(200).json(data);
    } catch (err) {
      console.error('[tasks GET]', err);
      return res.status(500).json({ error: 'Error leyendo datos' });
    }
  }

  if (req.method === 'POST') {
    try {
      // Solo editores y admins pueden guardar (crear/editar) tareas.
      // Las tareas viven en un blob compartido; un viewer no debe sobrescribirlo.
      const role = await getUserRole(user.id);
      if (role !== 'editor' && role !== 'admin') {
        return res.status(403).json({ error: 'Solo editores y admins pueden modificar tareas' });
      }
      const body = req.body;
      if (!body || typeof body !== 'object') {
        return res.status(400).json({ error: 'Body inválido' });
      }
      const clean = {
        simple:   Array.isArray(body.simple)   ? body.simple   : [],
        progress: Array.isArray(body.progress) ? body.progress : [],
        assigned: Array.isArray(body.assigned) ? body.assigned : [],
        invites:  Array.isArray(body.invites)  ? body.invites  : [],
      };
      await store.set(clean);
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('[tasks POST]', err);
      return res.status(500).json({ error: 'Error guardando datos' });
    }
  }

  return res.status(405).json({ error: 'Método no permitido' });
}
