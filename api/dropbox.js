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
 *   download  → binario del archivo (inline por defecto; ?dl=1 fuerza guardado
 *               a la PC con Content-Disposition: attachment y nombre)
 *   upload_link    → link temporal de subida (?path=carpeta&name=archivo&size=n)
 *                    [solo editor/admin] — asienta el intento en dropbox_activity
 *   upload_confirm → marca la subida como completada (?id=activity_id)
 *   activity       → historial interno de subidas desde el desk (últimas 100)
 *
 * Auth: requiere Bearer JWT de Supabase en todas las acciones.
 * Escritura en Dropbox: requiere scope files.content.write en la app.
 */

import { createHash } from 'node:crypto';
import { getRedis } from './_lib/redis.js';
import { authenticate } from './_lib/auth.js';
import { getSupabaseAdmin } from './_lib/supabase.js';

const DROPBOX_API = 'https://api.dropboxapi.com';
const DROPBOX_CONTENT = 'https://content.dropboxapi.com';
// La llave del caché incluye una huella del refresh token: al rotar la
// autorización (p. ej. para sumar scopes) el access token cacheado del
// token anterior deja de encontrarse, en vez de servirse hasta 4h con
// permisos viejos.
const TOKEN_CACHE_KEY = 'dropbox:access_token:'
  + createHash('sha256').update(process.env.DROPBOX_REFRESH_TOKEN || '').digest('hex').slice(0, 12);

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

// Dropbox-API-Arg viaja como header HTTP, y los headers solo aceptan Latin-1.
// Un nombre de archivo con caracteres fuera de ese rango (p. ej. el espacio fino
// U+202F que macOS mete en "… 11.30 AM.pdf") revienta fetch() antes de salir la
// petición. Dropbox documenta la solución: JSON "header-safe" con todo lo
// no-ASCII escapado como \uXXXX.
function httpHeaderSafeJson(obj) {
  return JSON.stringify(obj).replace(
    /[\u007f-\uffff]/g,
    c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
  );
}

async function dbxContent(endpoint, arg, accessToken) {
  const res = await fetch(`${DROPBOX_CONTENT}${endpoint}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Dropbox-API-Arg': httpHeaderSafeJson(arg),
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
      // ?dl=1 fuerza guardado a la PC (attachment con nombre); si no, inline
      // (necesario para renderizar PDFs/vistas previas dentro de un iframe).
      if (req.query.dl) {
        const base = (path.split('/').pop() || 'archivo').replace(/[\r\n"]/g, '');
        const asciiName = base.replace(/[^\x20-\x7E]/g, '_');   // fallback ASCII
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(base)}`
        );
      } else {
        res.setHeader('Content-Disposition', 'inline');
      }
      res.setHeader('Cache-Control', 'private, max-age=600');
      return res.status(200).send(buf);
    }

    // ── Subida en 3 pasos ──────────────────────────────────────────
    // 1) upload_link  → emite un link temporal de Dropbox y asienta el intento
    //    en dropbox_activity (registro interno: la cuenta de Dropbox es
    //    compartida, así que quién subió qué solo lo sabemos nosotros).
    // 2) el navegador sube el binario DIRECTO a Dropbox con ese link — las
    //    funciones de Vercel cortan cuerpos >4.5MB, proxear no es opción.
    // 3) upload_confirm → marca la fila como confirmada (subida terminada).
    // autorename: nunca pisa un archivo existente, Dropbox agrega " (1)".
    if (action === 'upload_link') {
      const admin = getSupabaseAdmin();
      const { data: prof } = admin
        ? await admin.from('profiles').select('role, full_name').eq('id', user.id).maybeSingle()
        : { data: null };
      if (prof?.role !== 'editor' && prof?.role !== 'admin') {
        return res.status(403).json({ error: 'Solo editores o administradores pueden subir archivos' });
      }
      const name = (req.query.name || '').toString().replace(/[\\/]/g, '').replace(/[\x00-\x1f]/g, '').trim();
      if (!name) return res.status(400).json({ error: 'name requerido' });
      const relPath = (req.query.path || '').toString();
      const folder = joinPath(root, relPath);
      if (folder && !underRoot(folder, root)) {
        return res.status(403).json({ error: 'Ruta fuera del alcance permitido' });
      }
      const data = await dbxJson('/2/files/get_temporary_upload_link', {
        commit_info: { path: `${folder}/${name}`, mode: 'add', autorename: true, mute: false },
      }, accessToken);
      // Registro interno — si falla no bloquea la subida, pero queda en logs
      let activityId = null;
      if (admin) {
        try {
          const size = Number(req.query.size);
          const { data: row } = await admin.from('dropbox_activity').insert({
            user_id: user.id,
            user_name: prof?.full_name || user.email || null,
            action: 'upload',
            file_name: name,
            folder_path: relPath || '/',
            size_bytes: Number.isFinite(size) ? size : null,
          }).select('id').single();
          activityId = row?.id ?? null;
        } catch (e) { console.error('[dropbox] registro de subida falló:', e); }
      }
      return res.status(200).json({ link: data.link, activity_id: activityId });
    }

    if (action === 'upload_confirm') {
      const id = Number(req.query.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'id requerido' });
      const admin = getSupabaseAdmin();
      if (admin) {
        // Solo el mismo usuario que pidió el link puede confirmar su fila
        await admin.from('dropbox_activity')
          .update({ confirmed: true })
          .eq('id', id)
          .eq('user_id', user.id);
      }
      return res.status(200).json({ ok: true });
    }

    // Historial de subidas hechas desde el desk (visible a todo el equipo)
    if (action === 'activity') {
      const admin = getSupabaseAdmin();
      if (!admin) return res.status(200).json({ entries: [] });
      const { data: rows } = await admin.from('dropbox_activity')
        .select('id, user_name, action, file_name, folder_path, size_bytes, confirmed, created_at')
        .order('created_at', { ascending: false })
        .limit(100);
      return res.status(200).json({ entries: rows || [] });
    }

    return res.status(400).json({ error: `action inválida: ${action}` });
  } catch (err) {
    console.error('[dropbox]', err);   // detalle en logs del servidor, no al cliente
    return res.status(500).json({ error: 'No se pudo completar la operación en Dropbox' });
  }
}
