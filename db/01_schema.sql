-- ═══════════════════════════════════════════════════════════════════════════
-- CRETUM DASHBOARD · Schema inicial
-- Correr en Supabase: SQL Editor → New query → pegar todo → Run
-- ═══════════════════════════════════════════════════════════════════════════

-- ── EXTENSIONES ─────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";  -- gen_random_uuid()


-- ═══════════════════════════════════════════════════════════════════════════
-- ROLES Y PERFILES
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TYPE user_role AS ENUM ('viewer', 'editor', 'admin');

-- profiles: extensión 1-a-1 de auth.users con datos de equipo + rol
CREATE TABLE profiles (
  id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name   TEXT NOT NULL,
  initials    TEXT,
  role        user_role NOT NULL DEFAULT 'viewer',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Trigger: cada vez que se crea un user en auth.users, generamos su profile
CREATE OR REPLACE FUNCTION public.handle_new_user() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, initials)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email),
    COALESCE(NEW.raw_user_meta_data->>'initials', UPPER(SUBSTRING(NEW.email, 1, 2)))
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Helper: ¿es admin el usuario actual?
CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean
LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin'
  );
$$;

-- Helper: ¿es editor o admin?
CREATE OR REPLACE FUNCTION public.is_editor_or_admin() RETURNS boolean
LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('editor','admin')
  );
$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- PORTAFOLIO (copia del schema original de Proyecto BD)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE investors (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE contacts (
  id           BIGSERIAL PRIMARY KEY,
  investor_id  BIGINT NOT NULL REFERENCES investors(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  email        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_contacts_investor ON contacts(investor_id);

CREATE TABLE companies (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  is_public   BOOLEAN NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE series (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  company_id  BIGINT REFERENCES companies(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_series_company ON series(company_id);

CREATE TABLE investments (
  id                 BIGSERIAL PRIMARY KEY,
  investor_id        BIGINT NOT NULL REFERENCES investors(id),
  series_id          BIGINT NOT NULL REFERENCES series(id),
  company_id         BIGINT NOT NULL REFERENCES companies(id),

  entry_ev_b         NUMERIC(18,4),
  entry_pps          NUMERIC(18,4),
  current_ev_b       NUMERIC(18,4),
  current_ev_pps     NUMERIC(18,4),
  shares             NUMERIC(20,4),

  commitment         NUMERIC(18,2),
  commitment_actual  NUMERIC(18,2),
  dpi_moic           NUMERIC(10,4),
  carry_pct          NUMERIC(6,4),

  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_investments_investor ON investments(investor_id);
CREATE INDEX idx_investments_company  ON investments(company_id);
CREATE INDEX idx_investments_series   ON investments(series_id);


-- ═══════════════════════════════════════════════════════════════════════════
-- TASKS (reemplaza Redis)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TYPE task_kind AS ENUM ('simple', 'progress');
CREATE TYPE task_priority AS ENUM ('Alta', 'Media', 'Baja');

CREATE TABLE tasks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind        task_kind NOT NULL,
  name        TEXT NOT NULL,
  due         DATE,
  priority    task_priority NOT NULL DEFAULT 'Media',

  -- simple
  done_flag   BOOLEAN NOT NULL DEFAULT FALSE,
  collab      BOOLEAN NOT NULL DEFAULT FALSE,

  -- progress
  unit        TEXT,
  total       NUMERIC,
  done_count  NUMERIC NOT NULL DEFAULT 0,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_tasks_owner ON tasks(owner_id);
CREATE INDEX idx_tasks_due   ON tasks(due);

CREATE TABLE task_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id     UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  log_date    DATE NOT NULL,
  n           NUMERIC NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_task_log_task ON task_log(task_id);

CREATE TABLE task_invites (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_user    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  to_user      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  due          DATE,
  priority     task_priority NOT NULL DEFAULT 'Media',
  note         TEXT,
  accepted     BOOLEAN NOT NULL DEFAULT FALSE,
  accepted_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_task_invites_to ON task_invites(to_user);


-- ═══════════════════════════════════════════════════════════════════════════
-- TRIGGER: updated_at automático
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER tg_profiles_updated    BEFORE UPDATE ON profiles    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER tg_tasks_updated       BEFORE UPDATE ON tasks       FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER tg_investments_updated BEFORE UPDATE ON investments FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ═══════════════════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE profiles      ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks         ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_log      ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_invites  ENABLE ROW LEVEL SECURITY;
ALTER TABLE investors     ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts      ENABLE ROW LEVEL SECURITY;
ALTER TABLE companies     ENABLE ROW LEVEL SECURITY;
ALTER TABLE series        ENABLE ROW LEVEL SECURITY;
ALTER TABLE investments   ENABLE ROW LEVEL SECURITY;

-- ── profiles ────────────────────────────────────────────────────────────────
-- Cualquier autenticado puede leer perfiles (necesario para mostrar nombres)
CREATE POLICY "profiles_read_all" ON profiles
  FOR SELECT TO authenticated USING (TRUE);

-- Solo el dueño puede editar su propio profile (excepto el rol)
CREATE POLICY "profiles_update_own" ON profiles
  FOR UPDATE TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid() AND role = (SELECT role FROM profiles WHERE id = auth.uid()));

-- Solo admin puede cambiar roles / borrar profiles
CREATE POLICY "profiles_admin_all" ON profiles
  FOR ALL TO authenticated
  USING (is_admin()) WITH CHECK (is_admin());

-- ── tasks ───────────────────────────────────────────────────────────────────
-- Todos los autenticados ven todas las tareas (es de equipo)
CREATE POLICY "tasks_read_all" ON tasks
  FOR SELECT TO authenticated USING (TRUE);

-- Editor/admin pueden insertar tareas (suyas u otras)
CREATE POLICY "tasks_insert_editor" ON tasks
  FOR INSERT TO authenticated
  WITH CHECK (is_editor_or_admin());

-- Cada quien puede actualizar/borrar sus propias tareas; admin todo
CREATE POLICY "tasks_update_own" ON tasks
  FOR UPDATE TO authenticated
  USING (owner_id = auth.uid() OR is_admin())
  WITH CHECK (owner_id = auth.uid() OR is_admin());

CREATE POLICY "tasks_delete_own" ON tasks
  FOR DELETE TO authenticated
  USING (owner_id = auth.uid() OR is_admin());

-- ── task_log ────────────────────────────────────────────────────────────────
CREATE POLICY "task_log_read_all" ON task_log
  FOR SELECT TO authenticated USING (TRUE);

CREATE POLICY "task_log_write_owner" ON task_log
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM tasks WHERE tasks.id = task_log.task_id AND (tasks.owner_id = auth.uid() OR is_admin())))
  WITH CHECK (EXISTS (SELECT 1 FROM tasks WHERE tasks.id = task_log.task_id AND (tasks.owner_id = auth.uid() OR is_admin())));

-- ── task_invites ────────────────────────────────────────────────────────────
-- Ves invitaciones que mandaste o que te llegan
CREATE POLICY "task_invites_read" ON task_invites
  FOR SELECT TO authenticated USING (from_user = auth.uid() OR to_user = auth.uid() OR is_admin());

-- Editor/admin puede crear invites
CREATE POLICY "task_invites_insert" ON task_invites
  FOR INSERT TO authenticated WITH CHECK (is_editor_or_admin() AND from_user = auth.uid());

-- El destinatario o el remitente puede actualizar (aceptar/declinar) o borrar
CREATE POLICY "task_invites_update" ON task_invites
  FOR UPDATE TO authenticated
  USING (from_user = auth.uid() OR to_user = auth.uid() OR is_admin());

CREATE POLICY "task_invites_delete" ON task_invites
  FOR DELETE TO authenticated
  USING (from_user = auth.uid() OR to_user = auth.uid() OR is_admin());

-- ── portafolio (lectura para todos los autenticados, escritura editor/admin) ─
CREATE POLICY "investors_read"  ON investors  FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY "investors_write" ON investors  FOR ALL    TO authenticated USING (is_editor_or_admin()) WITH CHECK (is_editor_or_admin());

CREATE POLICY "contacts_read"  ON contacts  FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY "contacts_write" ON contacts  FOR ALL    TO authenticated USING (is_editor_or_admin()) WITH CHECK (is_editor_or_admin());

CREATE POLICY "companies_read"  ON companies  FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY "companies_write" ON companies  FOR ALL    TO authenticated USING (is_editor_or_admin()) WITH CHECK (is_editor_or_admin());

CREATE POLICY "series_read"  ON series  FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY "series_write" ON series  FOR ALL    TO authenticated USING (is_editor_or_admin()) WITH CHECK (is_editor_or_admin());

CREATE POLICY "investments_read"  ON investments  FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY "investments_write" ON investments  FOR ALL    TO authenticated USING (is_editor_or_admin()) WITH CHECK (is_editor_or_admin());


-- ═══════════════════════════════════════════════════════════════════════════
-- LISTO. Después de correr esto:
-- 1) Crea los 2 admins en Supabase → Authentication → Users → Add user
-- 2) Promueve esos perfiles a rol admin manualmente, ejemplo:
--    UPDATE profiles SET role = 'admin' WHERE id = 'UUID_DEL_USER';
--    (el UUID lo ves al hacer click en el usuario en Authentication)
-- ═══════════════════════════════════════════════════════════════════════════
