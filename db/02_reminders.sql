-- Migration 02 — Preferencias de recordatorios por usuario
-- Correr en Supabase: SQL Editor → New query → pegar todo → Run

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS reminder_enabled BOOLEAN  NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS reminder_day     SMALLINT NOT NULL DEFAULT 1
    CHECK (reminder_day BETWEEN 0 AND 6),  -- 0=Domingo, 1=Lunes, …, 6=Sábado
  ADD COLUMN IF NOT EXISTS reminder_hour    SMALLINT NOT NULL DEFAULT 9
    CHECK (reminder_hour BETWEEN 0 AND 23);  -- en hora local CDMX (UTC-6)

-- Verificación rápida
-- SELECT id, full_name, reminder_enabled, reminder_day, reminder_hour FROM profiles;
