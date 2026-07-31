-- ═══════════════════════════════════════════════════════════════════════════
-- CRETUM DASHBOARD · Base de Contactos de CRETUM (Fase 1 de la separación MVP)
--
-- Tabla NUEVA y AISLADA. No toca ninguna tabla, política ni dato existente
-- (los datos de MVP quedan intactos). Semilla: export de Outlook de la cuenta
-- compartida, ya limpiado/deduplicado. El flag `revisar` marca los "posible
-- personal" para depurarlos dentro del módulo.
--
-- Idempotente. La carga masiva de contactos se hace por CSV desde Supabase.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS cretum_contactos (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             text UNIQUE,               -- llave natural; nullable (contactos sin correo)
  nombre            text NOT NULL DEFAULT '',
  telefono_movil    text,
  telefono_trabajo  text,
  organizacion      text,
  puesto            text,
  pais              text,
  revisar           boolean NOT NULL DEFAULT false,   -- posible personal, por depurar
  rebote            boolean NOT NULL DEFAULT false,    -- su correo rebotó
  notas             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cretum_contactos_nombre_idx ON cretum_contactos (nombre);
CREATE INDEX IF NOT EXISTS cretum_contactos_org_idx ON cretum_contactos (organizacion);

-- updated_at automático (reusa set_updated_at de 01_schema)
DROP TRIGGER IF EXISTS tg_cretum_contactos_updated ON cretum_contactos;
CREATE TRIGGER tg_cretum_contactos_updated
  BEFORE UPDATE ON cretum_contactos
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── RLS: el equipo autenticado lee; editores/admin escriben. Aislado de MVP. ──
ALTER TABLE cretum_contactos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "cretum_contactos_read" ON cretum_contactos;
CREATE POLICY "cretum_contactos_read" ON cretum_contactos
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "cretum_contactos_write" ON cretum_contactos;
CREATE POLICY "cretum_contactos_write" ON cretum_contactos
  FOR ALL TO authenticated
  USING (is_editor_or_admin()) WITH CHECK (is_editor_or_admin());
