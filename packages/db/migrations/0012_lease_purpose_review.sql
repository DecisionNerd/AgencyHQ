-- 0012_lease_purpose_review.sql
-- Adds the `review` lease purpose (download-only token for review and integrate
-- source/attempt bundle downloads). Idempotent: the check constraint is
-- dropped and re-created with the full purpose list.
ALTER TABLE leases DROP CONSTRAINT IF EXISTS leases_purpose_check;
ALTER TABLE leases ADD CONSTRAINT leases_purpose_check
  CHECK (purpose IN ('provider', 'git-read', 'integrate', 'upload', 'review'));
