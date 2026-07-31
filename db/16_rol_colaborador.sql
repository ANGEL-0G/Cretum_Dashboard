-- ═══════════════════════════════════════════════════════════════════════════
-- CRETUM DASHBOARD · Rol "colaborador" (vendedores MVP)
--
-- Igual que un editor en TODO, salvo la Base de Datos Cretum (cretum_contactos),
-- que no puede ver ni escribir. Se asigna directo en profiles.role desde Supabase.
--
-- El ADD VALUE del enum va en su propia transacción (Postgres no deja usar un
-- valor nuevo en la misma tx donde se agrega).
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'colaborador';

-- Colaborador cuenta como editor en el resto del sistema.
CREATE OR REPLACE FUNCTION public.is_editor_or_admin()
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$ SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('editor','admin','colaborador')); $$;

-- Acceso a la Base de Datos Cretum: todos MENOS colaborador (lectura) y editores/admin (escritura).
CREATE OR REPLACE FUNCTION public.can_cretum_db()
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$ SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('viewer','editor','admin')); $$;

CREATE OR REPLACE FUNCTION public.can_cretum_db_write()
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$ SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('editor','admin')); $$;

DROP POLICY IF EXISTS "cretum_contactos_read" ON cretum_contactos;
CREATE POLICY "cretum_contactos_read" ON cretum_contactos
  FOR SELECT TO authenticated USING (can_cretum_db());
DROP POLICY IF EXISTS "cretum_contactos_write" ON cretum_contactos;
CREATE POLICY "cretum_contactos_write" ON cretum_contactos
  FOR ALL TO authenticated USING (can_cretum_db_write()) WITH CHECK (can_cretum_db_write());
