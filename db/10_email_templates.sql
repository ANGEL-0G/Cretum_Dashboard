-- ═══════════════════════════════════════════════════════════════════════════
-- CRETUM DASHBOARD · Plantillas de correos (biblioteca compartida del equipo)
-- Cada quien sube/pega su HTML; todos pueden verlas, copiarlas y editarlas.
-- Historial de versiones para revertir cambios accidentales (se conservan 14
-- días; el frontend poda las más viejas al guardar). Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists email_templates (
  id          uuid primary key default gen_random_uuid(),
  title       text not null default 'Plantilla',
  html        text not null default '',
  created_by  uuid references auth.users(id) on delete set null,
  updated_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists email_templates_updated_idx on email_templates (updated_at desc);

-- Snapshot por cada guardado (para restaurar). Se conservan ~14 días.
create table if not exists email_template_versions (
  id           uuid primary key default gen_random_uuid(),
  template_id  uuid not null references email_templates(id) on delete cascade,
  title        text not null default '',
  html         text not null default '',
  edited_by    uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists email_template_versions_tpl_idx
  on email_template_versions (template_id, created_at desc);

-- RLS: biblioteca compartida — cualquier usuario autenticado lee y escribe.
-- (El equipo es de confianza; el historial de 14 días cubre los accidentes.)
alter table email_templates enable row level security;
alter table email_template_versions enable row level security;

drop policy if exists email_templates_all on email_templates;
create policy email_templates_all on email_templates
  for all to authenticated using (true) with check (true);

drop policy if exists email_template_versions_all on email_template_versions;
create policy email_template_versions_all on email_template_versions
  for all to authenticated using (true) with check (true);

-- Trigger de updated_at (usa el helper set_updated_at() de 01_schema.sql si existe)
do $$
begin
  if exists (select 1 from pg_proc where proname = 'set_updated_at') then
    drop trigger if exists email_templates_touch on email_templates;
    create trigger email_templates_touch before update on email_templates
      for each row execute function set_updated_at();
  end if;
end $$;
