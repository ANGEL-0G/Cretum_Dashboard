-- ═══════════════════════════════════════════════════════════════════════════
-- CRETUM DASHBOARD · Funciones Beta (auto-servicio por usuario)
-- profiles.beta_optin: si el usuario activó el switch "Funciones Beta" en su
-- perfil. Los módulos marcados `beta:true` en el frontend los ven los admins
-- (siempre) y quien tenga esto en true. El propio usuario lo cambia (RLS
-- profiles_update_own, igual que las preferencias de recordatorio). Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS beta_optin boolean NOT NULL DEFAULT false;
