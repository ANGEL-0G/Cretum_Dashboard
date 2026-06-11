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
-- RANKING (visible para TODOS los usuarios) + CAMPAÑA ACTUAL
-- ═══════════════════════════════════════════════════════════════════════════

-- Campaña actual: un solo registro. La escribe el admin (desde el generador de
-- plantilla); la leen todos los autenticados (es el correo de marketing).
CREATE TABLE IF NOT EXISTS campaign_current (
  id          SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  html        TEXT,
  mes         TEXT,
  params      JSONB,   -- valores del generador (mes, año, %, link) para pre-llenar
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE campaign_current ADD COLUMN IF NOT EXISTS params JSONB;
ALTER TABLE campaign_current ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "campaign_current_read" ON campaign_current;
CREATE POLICY "campaign_current_read" ON campaign_current
  FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS "campaign_current_admin" ON campaign_current;
CREATE POLICY "campaign_current_admin" ON campaign_current
  FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());

-- Ranking de interacción. SECURITY DEFINER: salta RLS pero SOLO devuelve
-- nombre + agregados + historial mes a mes (nunca email ni comentarios).
-- Solo authenticated (no anon). historial alimenta el detalle por LP.
DROP FUNCTION IF EXISTS public.campaign_ranking();
CREATE FUNCTION public.campaign_ranking()
RETURNS TABLE (nombre TEXT, score INT, meses_vistos INT, ultimo_periodo DATE, momentum TEXT, historial JSONB)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  WITH per AS (SELECT DISTINCT periodo FROM campaign_engagement),
       ranked AS (SELECT periodo, row_number() OVER (ORDER BY periodo DESC) rn FROM per),
       lastp AS (SELECT periodo FROM ranked WHERE rn = 1),
       prevp AS (SELECT periodo FROM ranked WHERE rn = 2),
       agg AS (
         SELECT c.email,
                COALESCE(c.nombre_completo, c.nombre, 'LP') AS nombre,
                COALESCE(SUM(e.nivel), 0) AS score,
                COUNT(*) FILTER (WHERE e.nivel >= 1) AS meses_vistos,
                MAX(e.periodo) FILTER (WHERE e.nivel >= 1) AS ultimo_periodo,
                COALESCE(MAX(e.nivel) FILTER (WHERE e.periodo = (SELECT periodo FROM lastp)), 0) AS last_n,
                COALESCE(MAX(e.nivel) FILTER (WHERE e.periodo = (SELECT periodo FROM prevp)), 0) AS prev_n,
                COALESCE(jsonb_agg(jsonb_build_object(
                    'periodo', e.periodo, 'opened', e.opened, 'clicked', e.clicked,
                    'replied', e.replied, 'nivel', e.nivel) ORDER BY e.periodo)
                  FILTER (WHERE e.periodo IS NOT NULL), '[]'::jsonb) AS historial
         FROM lp_contacts c
         LEFT JOIN campaign_engagement e ON e.email = c.email
         WHERE COALESCE(c.cancelado, FALSE) = FALSE
         GROUP BY c.email, COALESCE(c.nombre_completo, c.nombre, 'LP')
       )
  SELECT nombre, score::INT, meses_vistos::INT, ultimo_periodo,
         CASE WHEN last_n >= 1 AND last_n >= prev_n THEN 'up'
              WHEN last_n < prev_n THEN 'down'
              ELSE 'flat' END AS momentum,
         historial
  FROM agg WHERE meses_vistos >= 1
  ORDER BY score DESC, meses_vistos DESC, nombre;
$$;
REVOKE EXECUTE ON FUNCTION public.campaign_ranking() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.campaign_ranking() TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- LISTO. Gestión (matriz/upload) = solo admin · Ranking + Campaña Actual = todos.
-- ═══════════════════════════════════════════════════════════════════════════
