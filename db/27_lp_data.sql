-- ═══════════════════════════════════════════════════════════════════════════
-- CRETUM DASHBOARD · Portal de LP's — datos del dashboard (posición GVV)
-- Cada LP tiene un JSON con su posición/rendimiento/histórico/movimientos que
-- alimenta el dashboard interactivo. Esta es la ESTRUCTURA NORMALIZADA que más
-- adelante llenará la carga masiva (Excel → un LP por fila). Idempotente.
--
-- Forma esperada de `data`:
--   {
--     "corte": "31 ago 2026", "moneda": "USD",
--     "aportacion": 500000, "valor_actual": 632000,
--     "rendimiento_pct": 26.4, "rendimiento_abs": 132000,
--     "moic": 1.26, "distribuido": 50000,
--     "serie": [ {"t":"2024-Q4","v":500000}, ... ],
--     "movimientos": [ {"fecha":"15 ene 2024","tipo":"Aportación","monto":500000}, ... ]
--   }
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE lp_portal_users ADD COLUMN IF NOT EXISTS data jsonb;
