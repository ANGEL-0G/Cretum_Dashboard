-- ═══════════════════════════════════════════════════════════════════════════
-- CRETUM DASHBOARD · Portal de LP's — CONTRASEÑA por LP
-- El acceso ahora es de DOS factores: el ENLACE (token en la URL) identifica al
-- LP y la CONTRASEÑA lo autentica. Si el enlace se filtra, sin la contraseña no
-- se entra. El hash es scrypt (`salt$hash`), igual que el portal de clientes; se
-- guarda y verifica server-side (api/lp.js). Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE lp_portal_users ADD COLUMN IF NOT EXISTS password_hash text;
