-- ═══════════════════════════════════════════════════════════════
-- 18_dropbox_activity.sql — registro interno de subidas a Dropbox
--
-- Cada subida hecha desde el desk queda asentada: quién, qué archivo,
-- a qué carpeta y cuándo. No es un mecanismo de permisos — es un
-- historial para prevenir malentendidos (la cuenta de Dropbox es
-- compartida, así que Dropbox no distingue quién subió qué).
--
-- El backend inserta la fila al EMITIR el link de subida (confirmed=false)
-- y la marca confirmed=true cuando el navegador reporta que la subida a
-- Dropbox terminó bien. Una fila sin confirmar = se pidió subir pero no
-- consta que haya terminado (cerró la pestaña, falló la red, etc.).
--
-- Idempotente: re-ejecutable sin efectos.
-- ═══════════════════════════════════════════════════════════════

create table if not exists public.dropbox_activity (
  id          bigint generated always as identity primary key,
  user_id     uuid references auth.users(id),
  user_name   text,                      -- copia del nombre al momento (por si el perfil cambia)
  action      text not null default 'upload',
  file_name   text not null,
  folder_path text,                      -- carpeta destino tal como se ve en el desk
  size_bytes  numeric,
  confirmed   boolean not null default false,
  created_at  timestamptz not null default now()
);

create index if not exists dropbox_activity_created_idx
  on public.dropbox_activity (created_at desc);

alter table public.dropbox_activity enable row level security;

-- Todos los usuarios autenticados del desk pueden VER el historial
-- (transparencia interna: el registro sirve justo para que cualquiera
-- pueda consultar quién subió qué). Escritura solo desde el backend
-- con service role (no hay policy de insert/update para authenticated).
drop policy if exists dropbox_activity_select on public.dropbox_activity;
create policy dropbox_activity_select on public.dropbox_activity
  for select to authenticated using (true);
