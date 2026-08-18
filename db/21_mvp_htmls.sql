-- ═══════════════════════════════════════════════════════════════════════════
-- CRETUM DASHBOARD · HTML's MVP (Ventas · exclusivo de MVP)
-- Biblioteca simple de HTMLs de correo: cada quien sube un .html o pega el
-- código; todos los ven, los copian listos para pegar en Outlook/Gmail y los
-- borran. SIN editor ni historial: para cambiar uno, se vuelve a subir (lo hace
-- quien lo tenga). Por eso no hay tabla de versiones (a diferencia de
-- email_templates). Biblioteca compartida del equipo. Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists mvp_htmls (
  id          uuid primary key default gen_random_uuid(),
  title       text not null default 'HTML',
  html        text not null default '',
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists mvp_htmls_updated_idx on mvp_htmls (updated_at desc);

-- RLS: biblioteca compartida — cualquier usuario autenticado lee y escribe.
-- (Mismo criterio que email_templates: el equipo es de confianza.)
alter table mvp_htmls enable row level security;

drop policy if exists mvp_htmls_all on mvp_htmls;
create policy mvp_htmls_all on mvp_htmls
  for all to authenticated using (true) with check (true);

-- Trigger de updated_at (usa el helper set_updated_at() de 01_schema.sql si existe)
do $$
begin
  if exists (select 1 from pg_proc where proname = 'set_updated_at') then
    drop trigger if exists mvp_htmls_touch on mvp_htmls;
    create trigger mvp_htmls_touch before update on mvp_htmls
      for each row execute function set_updated_at();
  end if;
end $$;
