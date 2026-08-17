-- ═══════════════════════════════════════════════════════════════════════════
-- CRETUM DASHBOARD · Acceso a módulos por usuario (definido por admin)
--
-- profiles.allowed_modules: lista (jsonb array) de las "views" a las que el
-- usuario tiene acceso (p. ej. ["notes","tasks","dropbox"]). Es gating de
-- INTERFAZ (oculta bloques del home + menú + bloquea la vista), como la
-- personalización pero controlada por el admin.
--
--   NULL  → sin restricción: ve TODO lo que su rol permite (default).
--   []    → no ve ningún módulo (solo el inicio).
--   [...] → solo esos módulos.
--
-- Los admins ignoran esta lista (siempre ven todo). La seguridad real de datos
-- sigue en los roles + RLS; esto solo adapta el espacio de trabajo de cada quien.
-- Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS allowed_modules jsonb;
