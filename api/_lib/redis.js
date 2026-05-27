/**
 * api/_lib/redis.js — cliente Redis compartido (Upstash vía REDIS_URL)
 *
 * Singleton por instancia de función serverless. Devuelve null si no hay
 * REDIS_URL configurada, para que los callers puedan caer a su fallback.
 */

import Redis from 'ioredis';

let client = null;

export function getRedis() {
  if (client || !process.env.REDIS_URL) return client;
  client = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    connectTimeout: 10000,
  });
  client.on('error', (e) => console.error('[redis]', e.message));
  return client;
}
