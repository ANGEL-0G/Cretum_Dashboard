-- ═══════════════════════════════════════════════════════════════════════════
-- CRETUM DASHBOARD · Portal de Clientes (dashboards externos)
-- El equipo sube HTML por dashboard; usuarios-cliente con acceso a ciertos
-- dashboards entran por /portal (login propio, NO Supabase Auth).
-- El portal público se sirve vía SERVICE ROLE desde /api/portal (omite RLS).
-- Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS portal_dashboards (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug        TEXT UNIQUE NOT NULL,
  title       TEXT NOT NULL,
  html        TEXT NOT NULL DEFAULT '',
  org         TEXT NOT NULL DEFAULT 'cretum',      -- 'cretum' | 'mvp' (portal por empresa)
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS portal_users (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username       TEXT UNIQUE NOT NULL,            -- siempre en minúsculas
  password_hash  TEXT NOT NULL,                   -- scrypt: salt$hash (hex)
  label          TEXT,
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  org            TEXT NOT NULL DEFAULT 'cretum',  -- 'cretum' | 'mvp'
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Migración para tablas existentes (idempotente)
ALTER TABLE portal_dashboards ADD COLUMN IF NOT EXISTS org TEXT NOT NULL DEFAULT 'cretum';
ALTER TABLE portal_users      ADD COLUMN IF NOT EXISTS org TEXT NOT NULL DEFAULT 'cretum';

CREATE TABLE IF NOT EXISTS portal_access (
  user_id       BIGINT NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  dashboard_id  BIGINT NOT NULL REFERENCES portal_dashboards(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, dashboard_id)
);

ALTER TABLE portal_dashboards ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_users      ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_access     ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS portal_dashboards_admin ON portal_dashboards;
CREATE POLICY portal_dashboards_admin ON portal_dashboards
  FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());
DROP POLICY IF EXISTS portal_users_admin ON portal_users;
CREATE POLICY portal_users_admin ON portal_users
  FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());
DROP POLICY IF EXISTS portal_access_admin ON portal_access;
CREATE POLICY portal_access_admin ON portal_access
  FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());
