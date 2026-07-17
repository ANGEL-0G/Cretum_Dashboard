-- ═══════════════════════════════════════════════════════════════════════════
-- CRETUM DASHBOARD · Notas personales (por blocs) en el To Do
-- Cada usuario ve y edita SOLO sus propias notas (RLS por auth.uid()).
-- El frontend (cliente Supabase autenticado) lee/escribe directo, respetando RLS.
-- Idempotente — re-ejecutable sin efectos secundarios.
-- ═══════════════════════════════════════════════════════════════════════════
create table if not exists user_notes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  title       text not null default '',
  content     text not null default '',
  position    int  not null default 0,
  updated_at  timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

create index if not exists user_notes_user_idx on user_notes (user_id, position);

alter table user_notes enable row level security;

-- Un usuario solo puede ver/crear/editar/borrar sus propias notas.
drop policy if exists user_notes_own on user_notes;
create policy user_notes_own on user_notes
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
