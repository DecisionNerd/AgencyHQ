-- 0011_lease_token_hash.sql
-- Adds token_hash to leases: sha256 of the upload token handed out in an
-- upload-purpose lease grant (W-3 / D2). The raw token is never persisted;
-- source download and artifact upload routes compare sha256(bearer) with it.
-- Idempotent: ADD COLUMN IF NOT EXISTS (schema-local, unlike an
-- information_schema lookup that would see other schemas' columns).
ALTER TABLE leases ADD COLUMN IF NOT EXISTS token_hash text;
CREATE INDEX IF NOT EXISTS leases_token_hash_idx ON leases (token_hash);
