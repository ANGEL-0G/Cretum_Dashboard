-- ═══════════════════════════════════════════════════════════════════════════
-- CRETUM DASHBOARD · Carpetas de notas + color por nota
-- Carpetas personales que agrupan notas; las notas sin carpeta son "General".
-- Todo privado por usuario (RLS por auth.uid()). Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════
create table if not exists note_folders (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null default '',
  color       text not null default '',
  position    int  not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists note_folders_user_idx on note_folders (user_id, position);

alter table note_folders enable row level security;
drop policy if exists note_folders_own on note_folders;
create policy note_folders_own on note_folders
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Notas: carpeta (opcional) + color. Al borrar la carpeta, sus notas pasan a General.
alter table user_notes add column if not exists folder_id uuid references note_folders(id) on delete set null;
alter table user_notes add column if not exists color text;
create index if not exists user_notes_folder_idx on user_notes (user_id, folder_id, position);
