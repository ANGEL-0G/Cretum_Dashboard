-- ═══════════════════════════════════════════════════════════════════════════
-- CRETUM DASHBOARD · Seguimiento de Campañas (Yesware)  [solo-admin]
-- Correr en Supabase: SQL Editor → New query → pegar todo → Run
-- Idempotente: IF NOT EXISTS / DROP POLICY IF EXISTS → se puede re-ejecutar.
--
-- Solo agrega filas a la base de datos (unos cientos de registros = kilobytes).
-- NO usa Storage de archivos. No afecta el cupo de archivos del proyecto.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Lista maestra de LPs (los destinatarios de las campañas) ─────────────────
-- email es la llave: se guarda SIEMPRE normalizado (minúsculas, sin espacios)
-- desde el front, para que el match con el CSV de Yesware sea confiable.
CREATE TABLE IF NOT EXISTS lp_contacts (
  email            TEXT PRIMARY KEY,
  nombre           TEXT,
  nombre_completo  TEXT,
  responsable      TEXT,
  comentarios      TEXT,
  cancelado        BOOLEAN NOT NULL DEFAULT FALSE,  -- respondió "CANCELAR" / baja
  cancelado_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- si la tabla ya existía sin estas columnas:
ALTER TABLE lp_contacts
  ADD COLUMN IF NOT EXISTS cancelado    BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS cancelado_at TIMESTAMPTZ;

-- ── Engagement por LP y por mes ──────────────────────────────────────────────
-- nivel: 0 = nada · 1 = ⚡ (abrió) · 2 = ⚡⚡ (abrió+click) · 3 = ⚡⚡⚡ (abrió+click+respondió)
-- periodo: primer día del mes (ej. 2026-04-01 para "Abril").
-- UNIQUE(email, periodo): un registro por LP por mes. Re-subir el mismo mes
-- hace UPSERT (actualiza), nunca duplica.
CREATE TABLE IF NOT EXISTS campaign_engagement (
  id           BIGSERIAL PRIMARY KEY,
  email        TEXT NOT NULL,
  periodo      DATE NOT NULL,
  opened       BOOLEAN NOT NULL DEFAULT FALSE,
  clicked      BOOLEAN NOT NULL DEFAULT FALSE,
  replied      BOOLEAN NOT NULL DEFAULT FALSE,
  nivel        SMALLINT NOT NULL DEFAULT 0 CHECK (nivel BETWEEN 0 AND 3),
  campaign     TEXT,                          -- etiqueta del archivo origen (opcional)
  uploaded_by  UUID REFERENCES auth.users(id),
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (email, periodo)
);
CREATE INDEX IF NOT EXISTS idx_campaign_eng_periodo ON campaign_engagement(periodo);
CREATE INDEX IF NOT EXISTS idx_campaign_eng_email   ON campaign_engagement(email);

-- ── updated_at automático en lp_contacts (reusa set_updated_at de 01_schema) ──
DROP TRIGGER IF EXISTS tg_lp_contacts_updated ON lp_contacts;
CREATE TRIGGER tg_lp_contacts_updated
  BEFORE UPDATE ON lp_contacts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY · SOLO ADMIN puede ver y escribir (is_admin() de 01_schema)
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE lp_contacts          ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_engagement  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "lp_contacts_admin" ON lp_contacts;
CREATE POLICY "lp_contacts_admin" ON lp_contacts
  FOR ALL TO authenticated
  USING (is_admin()) WITH CHECK (is_admin());

DROP POLICY IF EXISTS "campaign_eng_admin" ON campaign_engagement;
CREATE POLICY "campaign_eng_admin" ON campaign_engagement
  FOR ALL TO authenticated
  USING (is_admin()) WITH CHECK (is_admin());

-- ═══════════════════════════════════════════════════════════════════════════
-- LISTO. Las tablas quedan vacías; el front (sección "Campañas", solo-admin)
-- las llena: primero la carga inicial del histórico, luego cada CSV mensual.
-- ═══════════════════════════════════════════════════════════════════════════
