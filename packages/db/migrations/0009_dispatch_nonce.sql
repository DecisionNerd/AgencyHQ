-- 0009_dispatch_nonce.sql
-- Adds dispatch_nonce_hash column to dispatch_intents (P17.1, epic #14).
-- The coordinator stores only the sha256 hash of the generated nonce here.
-- The raw nonce is passed to the task container in the payload and never persisted.
-- Idempotent: ADD COLUMN IF NOT EXISTS.

ALTER TABLE dispatch_intents ADD COLUMN IF NOT EXISTS dispatch_nonce_hash text;
