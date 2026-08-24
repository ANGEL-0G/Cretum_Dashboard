-- ═══════════════════════════════════════════════════════════════════════════
-- CRETUM DASHBOARD · Portal de LP's (información privada por inversionista)
-- Sistema APARTE del Portal de clientes: cada LP tiene su propio acceso por
-- ENLACE MÁGICO (un token en la URL, sin contraseña) y su propio set de
-- documentos. Aislado: estas tablas viven en el mismo Supabase pero con RLS
-- cerrada — solo el backend (service role, api/lp.js) las toca; el frontend
-- nunca las lee directo. Los archivos van a un bucket privado (lp-files) y se
-- sirven por URL firmada temporal, igual que el portal.
-- Idempotente (re-ejecutable).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── LP's con acceso ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lp_portal_users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,                       -- nombre visible del LP
  email          text,                                -- referencia (a quién se le compartió)
  token          text NOT NULL UNIQUE,                -- secreto del enlace mágico
  active         boolean NOT NULL DEFAULT true,
  org            text NOT NULL DEFAULT 'cretum',      -- por si luego se quiere separar por marca
  last_access_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lp_portal_users_token_idx ON lp_portal_users (token);

-- ── Documentos que ve cada LP ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lp_portal_docs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lp_user_id  uuid NOT NULL REFERENCES lp_portal_users (id) ON DELETE CASCADE,
  title       text NOT NULL,
  file_path   text NOT NULL,                          -- ruta dentro del bucket lp-files
  file_mime   text,
  file_name   text,
  position    int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lp_portal_docs_user_idx ON lp_portal_docs (lp_user_id);

-- ── RLS cerrada: SOLO el backend con service role (que omite RLS) las usa. ──
-- Al habilitar RLS sin políticas, anon/authenticated no ven nada. Aislamiento total.
ALTER TABLE lp_portal_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE lp_portal_docs  ENABLE ROW LEVEL SECURITY;

-- ── Bucket privado para los PDFs/documentos de LP's ─────────────────────────
INSERT INTO storage.buckets (id, name, public) VALUES ('lp-files', 'lp-files', false)
ON CONFLICT (id) DO NOTHING;

-- Subir/gestionar archivos: solo editores/admins de la app (Supabase Auth).
-- La lectura de los LP's NO pasa por RLS: el backend firma URLs con service role.
DROP POLICY IF EXISTS lp_files_manage ON storage.objects;
CREATE POLICY lp_files_manage ON storage.objects FOR ALL TO authenticated
  USING (bucket_id = 'lp-files' AND is_editor_or_admin())
  WITH CHECK (bucket_id = 'lp-files' AND is_editor_or_admin());
