-- ═══════════════════════════════════════════════════════════════════════════
-- CRETUM DASHBOARD · Portal de Clientes — soporte de ARCHIVOS
-- Además del HTML pegado, un dashboard puede ser un archivo (PDF / HTML) subido
-- a Supabase Storage. El archivo vive en un bucket PRIVADO y se sirve al cliente
-- por URL firmada temporal desde /api/portal (service role), nunca público.
-- Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE portal_dashboards ADD COLUMN IF NOT EXISTS kind      TEXT NOT NULL DEFAULT 'html'; -- 'html' | 'file'
ALTER TABLE portal_dashboards ADD COLUMN IF NOT EXISTS file_path TEXT;   -- ruta dentro del bucket
ALTER TABLE portal_dashboards ADD COLUMN IF NOT EXISTS file_mime TEXT;   -- p. ej. application/pdf
ALTER TABLE portal_dashboards ADD COLUMN IF NOT EXISTS file_name TEXT;   -- nombre original mostrado

-- Bucket privado para los archivos del portal.
INSERT INTO storage.buckets (id, name, public) VALUES ('portal-files', 'portal-files', false)
ON CONFLICT (id) DO NOTHING;

-- Subir/gestionar archivos: solo editores/admins de la app (Supabase Auth).
-- La lectura de clientes NO pasa por RLS: el backend firma URLs con service role.
DROP POLICY IF EXISTS portal_files_manage ON storage.objects;
CREATE POLICY portal_files_manage ON storage.objects FOR ALL TO authenticated
  USING (bucket_id = 'portal-files' AND is_editor_or_admin())
  WITH CHECK (bucket_id = 'portal-files' AND is_editor_or_admin());
