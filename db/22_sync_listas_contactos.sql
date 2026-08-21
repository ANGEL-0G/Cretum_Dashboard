-- ═══════════════════════════════════════════════════════════════════════════
-- CRETUM DASHBOARD · Sincroniza listas de distribución → Contactos Cretum
-- Al agregar a alguien a una lista (apertura_contacts / lp_contacts), aparece
-- también en cretum_contactos si no existe por email. NO toca los existentes.
-- Idempotente. SECURITY DEFINER para que el alta funcione sin importar el rol
-- que haga el insert en la lista.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.sync_contacto_from_lista()
returns trigger language plpgsql security definer set search_path = public as $$
declare j jsonb := to_jsonb(new); em text; nm text;
begin
  em := lower(btrim(coalesce(j->>'email','')));
  if em = '' then return new; end if;
  -- nombre: usa nombre_completo (lp_contacts) si existe; si no, nombre (apertura_contacts)
  nm := nullif(btrim(coalesce(nullif(btrim(j->>'nombre_completo'), ''), j->>'nombre', '')), '');
  if not exists (select 1 from cretum_contactos c where lower(btrim(c.email)) = em) then
    insert into cretum_contactos (email, nombre, revisar, rebote) values (em, coalesce(nm, ''), false, false);
  end if;
  return new;
end $$;

drop trigger if exists trg_sync_contacto_apertura on apertura_contacts;
create trigger trg_sync_contacto_apertura after insert on apertura_contacts
  for each row execute function public.sync_contacto_from_lista();

drop trigger if exists trg_sync_contacto_lp on lp_contacts;
create trigger trg_sync_contacto_lp after insert on lp_contacts
  for each row execute function public.sync_contacto_from_lista();

-- Backfill: los que ya están en las listas pero faltan en contactos (one-time, idempotente).
insert into cretum_contactos (email, nombre, revisar, rebote)
select e, coalesce(max(nm), ''), false, false from (
  select lower(btrim(email)) e, nullif(btrim(nombre_completo), '') nm from lp_contacts where coalesce(btrim(email), '') <> ''
  union all
  select lower(btrim(email)) e, nullif(btrim(nombre), '') nm from apertura_contacts where coalesce(btrim(email), '') <> ''
) s
where e not in (select lower(btrim(email)) from cretum_contactos where coalesce(btrim(email), '') <> '')
group by e;
