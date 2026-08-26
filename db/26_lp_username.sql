-- ═══════════════════════════════════════════════════════════════════════════
-- CRETUM DASHBOARD · Portal de LP's — login por USUARIO + CONTRASEÑA
-- Se simplifica el acceso: un solo enlace (cretumdesk.com/lp) para todos; cada
-- LP entra con su USUARIO y su CONTRASEÑA y ve solo su información. Se agrega la
-- columna `username` (única, case-insensitive). La columna `token` se conserva
-- por si más adelante se quiere un enlace directo opcional, pero ya no es la vía
-- de acceso. Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE lp_portal_users ADD COLUMN IF NOT EXISTS username text;

-- Usuario único sin distinguir mayúsculas (permite varios NULL mientras se llena).
CREATE UNIQUE INDEX IF NOT EXISTS lp_portal_users_username_uidx
  ON lp_portal_users (lower(username)) WHERE username IS NOT NULL;
