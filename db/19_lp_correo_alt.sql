-- ═══════════════════════════════════════════════════════════════════════════
-- CRETUM DASHBOARD · lp_contacts: correo alternativo (opcional)
--
-- Segundo correo de contacto de un LP (además del principal, que es la llave
-- del histórico). Solo informativo; el match con Yesware sigue por `email`.
-- Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.lp_contacts
  ADD COLUMN IF NOT EXISTS correo_alt text;
