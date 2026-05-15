/**
 * api/tasks.js — Vercel Serverless Function
 *
 * GET  /api/tasks  → devuelve el estado actual (requiere JWT de Supabase)
 * POST /api/tasks  → guarda el estado completo (requiere JWT de Supabase)
 *
 * Auth: header `Authorization: Bearer <access_token>` validado contra Supabase.
 * Persistencia: Upstash Redis vía REDIS_URL (TCP+TLS), fallback en memoria.
 */

import Redis from 'ioredis';
import { createClient } from '@supabase/supabase-js';

const SEED = { simple: [], progress: [], assigned: [], invites: [] };

let memoryStore = SEED;
let redisClient = null;
let supabaseClient = null;

function getRedis() {
  if (redisClient || !process.env.REDIS_URL) return redisClient;
  redisClient = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    connectTimeout: 10000,
  });
  redisClient.on('error', (e) => console.error('[redis]', e.message));
  return redisClient;
}

function getSupabase() {
  if (supabaseClient) return supabaseClient;
  const url = (process.env.SUPABASE_URL || '').replace(/\/rest\/v1\/?$/, '').replace(/\/$/, '');
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  supabaseClient = createClient(url, key, { auth: { persistSession: false } });
  return supabaseClient;
}

async function authenticate(req) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;
  const sb = getSupabase();
  if (!sb) return null;
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
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
      return res.status(500).json({ error: 'Error leyendo datos', detail: err.message });
    }
  }

  if (req.method === 'POST') {
    try {
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
      return res.status(500).json({ error: 'Error guardando datos', detail: err.message });
    }
  }

  return res.status(405).json({ error: 'Método no permitido' });
}
