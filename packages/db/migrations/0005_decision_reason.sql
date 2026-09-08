-- 0005_decision_reason.sql
-- Adds nullable `reason` text column to decisions for reject/invalidate commands.
-- Idempotent: uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.

ALTER TABLE decisions ADD COLUMN IF NOT EXISTS reason text;
