-- ═══════════════════════════════════════════════════════════════════════════
-- CRETUM DASHBOARD · Marca de "rebote" en las listas (Apertura + Cartas GVV)
--
-- Permite marcar un contacto cuyo correo rebotó, para colorearlo, filtrarlo y
-- volver a investigar/actualizar el dato después. Es un flag simple; no afecta
-- envíos ni engagement. La escritura la hace solo-admin (política FOR ALL
-- existente); editores solo lo ven.
--
-- Idempotente (ADD COLUMN IF NOT EXISTS): re-ejecutable.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE apertura_contacts ADD COLUMN IF NOT EXISTS rebote BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE lp_contacts       ADD COLUMN IF NOT EXISTS rebote BOOLEAN NOT NULL DEFAULT FALSE;
