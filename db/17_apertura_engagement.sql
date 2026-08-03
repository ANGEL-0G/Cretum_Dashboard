-- ═══════════════════════════════════════════════════════════════════════════
-- CRETUM DASHBOARD · Seguimiento de la Apertura Cretum Diaria
--
-- Como campaign_engagement (Cartas GVV) pero para el correo DIARIO de Apertura,
-- con granularidad por DÍA. Un registro por (email, fecha). Re-subir el mismo
-- día hace UPSERT (actualiza), nunca duplica. Parte de apertura_contacts.
--
-- Solo-admin a nivel RLS (igual que campaign_engagement). El formato del archivo
-- de origen y el parser se definen con el flujo (pendiente).
-- Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS apertura_engagement (
  id          bigserial PRIMARY KEY,
  email       text NOT NULL,
  fecha       date NOT NULL,               -- día del envío/apertura
  opened      boolean NOT NULL DEFAULT false,
  clicked     boolean NOT NULL DEFAULT false,
  nivel       smallint NOT NULL DEFAULT 0, -- 0 nada · 1 abrió · 2 abrió+click
  uploaded_by text,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (email, fecha)
);
CREATE INDEX IF NOT EXISTS apertura_engagement_email_idx ON apertura_engagement (email);
CREATE INDEX IF NOT EXISTS apertura_engagement_fecha_idx ON apertura_engagement (fecha);

ALTER TABLE apertura_engagement ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "apertura_eng_admin" ON apertura_engagement;
CREATE POLICY "apertura_eng_admin" ON apertura_engagement
  FOR ALL TO authenticated
  USING (is_admin()) WITH CHECK (is_admin());
