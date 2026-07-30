-- ═══════════════════════════════════════════════════════════════════════════
-- CRETUM DASHBOARD · Lectura de "Listas" para EDITORES (Apertura + Cartas GVV)
--
-- El apartado Campañas → Listas muestra los destinatarios de Apertura Cretum
-- (apertura_contacts) y de las Cartas GVV (lp_contacts). Hasta ahora ambas
-- tablas eran RLS SOLO-ADMIN. Esto AGREGA permiso de LECTURA (SELECT) para
-- editores (is_editor_or_admin) para que también puedan VER las listas.
--
-- ⚠️ Implica que los editores verán los correos de LPs (PII). La ESCRITURA
--    (añadir / editar / borrar) sigue siendo SOLO-ADMIN: las políticas FOR ALL
--    existentes (lp_contacts_admin / apertura_admin) NO se tocan; esto solo
--    suma una política de lectura. El histórico de engagement (campaign_engagement)
--    tampoco se abre: sigue solo-admin.
--
-- Idempotente (DROP POLICY IF EXISTS → CREATE): se puede re-ejecutar.
-- ═══════════════════════════════════════════════════════════════════════════

-- Cartas GVV: los editores pueden LEER los contactos (no escribir).
DROP POLICY IF EXISTS "lp_contacts_read_editor" ON lp_contacts;
CREATE POLICY "lp_contacts_read_editor" ON lp_contacts
  FOR SELECT TO authenticated
  USING (is_editor_or_admin());

-- Apertura Cretum: los editores pueden LEER los contactos (no escribir).
DROP POLICY IF EXISTS "apertura_read_editor" ON apertura_contacts;
CREATE POLICY "apertura_read_editor" ON apertura_contacts
  FOR SELECT TO authenticated
  USING (is_editor_or_admin());
