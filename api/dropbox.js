/**
 * api/dropbox.js — proxy autenticado al Dropbox de la cuenta admin
 *
 * Modelo: una sola cuenta de Dropbox autoriza la app una vez (refresh token
 * guardado en env). El servidor canjea refresh → access token y lo cachea
 * en Redis (~4h). Todos los usuarios autenticados del dashboard ven los
 * mismos archivos.
 *
 * Actions (GET /api/dropbox?action=...):
 *   list      → listado de una carpeta (?path=/foo, vacío=raíz)
 *   search    → búsqueda por nombre (?q=texto)
 *   link      → link temporal directo (?path=/foo/bar.pdf)
 *   thumbnail → preview binario JPEG (?path=...&size=w256h256)
 *   preview   → preview binario PDF (?path=...) — Office/Word/Excel
 *
 * Auth: requiere Bearer JWT de Supabase en todas las acciones.
 */

import { getRedis } from './_lib/redis.js';
import { authenticate } from './_lib/auth.js';

const DROPBOX_API = 'https://api.dropboxapi.com';
const DROPBOX_CONTENT = 'https://content.dropboxapi.com';
const TOKEN_CACHE_KEY = 'dropbox:access_token';

let memoryToken = { token: null, expiresAt: 0 };

async function getAccessToken() {
  const now = Date.now();
  if (memoryToken.token && memoryToken.expiresAt > now + 60000) {
    return memoryToken.token;
  }
  const r = getRedis();
  if (r) {
    try {
      const cached = await r.get(TOKEN_CACHE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed.expiresAt > now + 60000) {
          memoryToken = parsed;
          return parsed.token;
        }
      }
    } catch (e) { /* fall through to refresh */ }
  }

  const auth = Buffer.from(
    `${process.env.DROPBOX_APP_KEY}:${process.env.DROPBOX_APP_SECRET}`
  ).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: process.env.DROPBOX_REFRESH_TOKEN,
  });
  const res = await fetch(`${DROPBOX_API}/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`Dropbox refresh failed ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  const token = data.access_token;
  const expiresAt = now + (data.expires_in - 300) * 1000;
  memoryToken = { token, expiresAt };
  if (r) {
    try {
      await r.set(
        TOKEN_CACHE_KEY,
        JSON.stringify({ token, expiresAt }),
        'EX',
        Math.max(60, data.expires_in - 300),
      );
    } catch (e) { /* ignore */ }
  }
  return token;
}

function joinPath(root, path) {
  const r = (root || '').replace(/\/$/, '');
  const p = path ? (path.startsWith('/') ? path : '/' + path) : '';
  const full = r + p;
  // Dropbox usa "" (no "/") para representar la raíz
  return full === '/' || full === '' ? '' : full;
}

// Confinamiento: list/search ya listan solo dentro del root, pero devuelven
// rutas absolutas que luego se usan en link/thumbnail/preview/download. Sin
// esta validación, un usuario podría pedir una ruta absoluta ARBITRARIA y
// sacar archivos del Dropbox de la cuenta admin fuera de la carpeta compartida.
function underRoot(path, root) {
  const r = (root || '').replace(/\/$/, '');
  if (!r) return true;                          // sin root configurado no hay confinamiento
  const p = String(path || '');
  if (p.includes('..')) return false;           // Dropbox no resuelve '..', pero por si acaso
  const pl = p.toLowerCase(), rl = r.toLowerCase();   // Dropbox es case-insensitive
  return pl === rl || pl.startsWith(rl + '/');
}

function normalizeEntry(e) {
  return {
    type: e['.tag'],                   // 'folder' | 'file'
    name: e.name,
    path: e.path_display,
    size: e.size ?? null,
    modified: e.server_modified ?? null,
    id: e.id ?? null,
  };
}

async function dbxJson(endpoint, body, accessToken) {
  const res = await fetch(`${DROPBOX_API}${endpoint}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Dropbox ${endpoint} ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function dbxContent(endpoint, arg, accessToken) {
  const res = await fetch(`${DROPBOX_CONTENT}${endpoint}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Dropbox-API-Arg': JSON.stringify(arg),
    },
  });
  if (!res.ok) {
    throw new Error(`Dropbox ${endpoint} ${res.status}: ${await res.text()}`);
  }
  return res;
}

export default async function handler(req, res) {
  const missing = ['DROPBOX_APP_KEY', 'DROPBOX_APP_SECRET', 'DROPBOX_REFRESH_TOKEN']
    .filter(k => !process.env[k]);
  if (missing.length) {
    return res.status(500).json({ error: `Dropbox no configurado: faltan ${missing.join(', ')}` });
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    return res.status(500).json({ error: 'Supabase no configurado' });
  }

  const user = await authenticate(req);
  if (!user) return res.status(401).json({ error: 'No autorizado' });

  const action = (req.query.action || 'list').toString();
  // Tolera comillas literales y espacios alrededor en la env var
  const root = (process.env.DROPBOX_ROOT_PATH || '').trim().replace(/^["']|["']$/g, '');

  try {
    const accessToken = await getAccessToken();

    if (action === 'list') {
      const path = joinPath(root, (req.query.path || '').toString());
      const data = await dbxJson('/2/files/list_folder', {
        path,
        recursive: false,
        include_media_info: false,
        include_deleted: false,
      }, accessToken);
      const entries = (data.entries || []).map(normalizeEntry);
      entries.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
        return a.name.localeCompare(b.name, 'es', { sensitivity: 'base' });
      });
      return res.status(200).json({ entries, path: req.query.path || '', hasMore: data.has_more });
    }

    if (action === 'search') {
      const q = ((req.query.q || '') + '').trim();
      if (!q) return res.status(200).json({ entries: [] });
      const data = await dbxJson('/2/files/search_v2', {
        query: q,
        options: {
          path: joinPath(root, ''),
          max_results: 50,
          file_status: 'active',
          filename_only: true,
        },
      }, accessToken);
      const entries = (data.matches || [])
        .map(m => normalizeEntry(m.metadata.metadata))
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
          return a.name.localeCompare(b.name, 'es', { sensitivity: 'base' });
        });
      return res.status(200).json({ entries });
    }

    if (action === 'link') {
      const path = (req.query.path || '').toString();
      if (!path) return res.status(400).json({ error: 'path requerido' });
      if (!underRoot(path, root)) return res.status(403).json({ error: 'Ruta fuera del alcance permitido' });
      const data = await dbxJson('/2/files/get_temporary_link', { path }, accessToken);
      return res.status(200).json({ link: data.link, name: data.metadata?.name });
    }

    if (action === 'thumbnail') {
      const path = (req.query.path || '').toString();
      const size = (req.query.size || 'w256h256').toString();
      if (!path) return res.status(400).json({ error: 'path requerido' });
      if (!underRoot(path, root)) return res.status(403).json({ error: 'Ruta fuera del alcance permitido' });
      const validSizes = ['w32h32','w64h64','w128h128','w256h256','w480h320','w640h480','w960h640','w1024h768','w2048h1536'];
      const sizeTag = validSizes.includes(size) ? size : 'w256h256';
      const dbxRes = await dbxContent('/2/files/get_thumbnail_v2', {
        resource: { '.tag': 'path', path },
        format: { '.tag': 'jpeg' },
        size: { '.tag': sizeTag },
        mode: { '.tag': 'strict' },
      }, accessToken);
      const buf = Buffer.from(await dbxRes.arrayBuffer());
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'private, max-age=3600');
      return res.status(200).send(buf);
    }

    if (action === 'preview') {
      const path = (req.query.path || '').toString();
      if (!path) return res.status(400).json({ error: 'path requerido' });
      if (!underRoot(path, root)) return res.status(403).json({ error: 'Ruta fuera del alcance permitido' });
      const dbxRes = await dbxContent('/2/files/get_preview', { path }, accessToken);
      const buf = Buffer.from(await dbxRes.arrayBuffer());
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Cache-Control', 'private, max-age=600');
      return res.status(200).send(buf);
    }

    // Proxy de descarga: trae el binario y lo re-emite forzando inline.
    // Necesario para renderizar PDFs en iframe (Dropbox los marca como attachment).
    if (action === 'download') {
      const path = (req.query.path || '').toString();
      if (!path) return res.status(400).json({ error: 'path requerido' });
      if (!underRoot(path, root)) return res.status(403).json({ error: 'Ruta fuera del alcance permitido' });
      const dbxRes = await dbxContent('/2/files/download', { path }, accessToken);
      const buf = Buffer.from(await dbxRes.arrayBuffer());
      const ext = (path.split('.').pop() || '').toLowerCase();
      const CT_BY_EXT = {
        pdf: 'application/pdf',
        jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
        gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
        mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
        mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4',
        txt: 'text/plain; charset=utf-8',
        html: 'text/html; charset=utf-8',
      };
      const ct = CT_BY_EXT[ext]
        || dbxRes.headers.get('content-type')
        || 'application/octet-stream';
      res.setHeader('Content-Type', ct);
      res.setHeader('Content-Disposition', 'inline');
      res.setHeader('Cache-Control', 'private, max-age=600');
      return res.status(200).send(buf);
    }

    return res.status(400).json({ error: `action inválida: ${action}` });
  } catch (err) {
    console.error('[dropbox]', err);   // detalle en logs del servidor, no al cliente
    return res.status(500).json({ error: 'No se pudo completar la operación en Dropbox' });
  }
}
