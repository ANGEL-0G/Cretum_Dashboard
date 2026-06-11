-- ═══════════════════════════════════════════════════════════════════════════
-- CRETUM DASHBOARD · Contactos del correo de Apertura de mercados [solo-admin]
-- Lista de destinatarios del mail diario con noticias de mercados.
-- Idempotente: se puede re-ejecutar sin romper nada.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS apertura_contacts (
  email       TEXT PRIMARY KEY,
  nombre      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE apertura_contacts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "apertura_admin" ON apertura_contacts;
CREATE POLICY "apertura_admin" ON apertura_contacts
  FOR ALL TO authenticated
  USING (is_admin()) WITH CHECK (is_admin());
