-- ═══════════════════════════════════════════════════════════════════════════
-- CRETUM DASHBOARD · Columnas extra de investments (Start / End / Duration)
-- Correr en Supabase: SQL Editor → New query → pegar todo → Run
-- IF NOT EXISTS hace el script idempotente — se puede re-ejecutar sin error.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE investments
  ADD COLUMN IF NOT EXISTS start_date     DATE,
  ADD COLUMN IF NOT EXISTS end_date       DATE,
  ADD COLUMN IF NOT EXISTS duration_years NUMERIC(6,2);

-- Notas:
-- • end_date NO es lo mismo que distributed_at — coexisten.
--   distributed_at sigue siendo el campo que usa la UI para "activa vs terminada".
-- • Las 3 columnas son nullable; las filas existentes quedan en NULL hasta
--   que el script update_from_csv.mjs las popule desde el CSV.
