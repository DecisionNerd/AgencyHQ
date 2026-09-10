-- Adds a monotonically increasing insertion-order column to dispatch_intents.
-- Used as a stable sort tiebreaker when created_at timestamps tie (e.g. two
-- intents created within the same microsecond in fast test environments).
-- Existing rows each receive a unique sequence value from the new sequence;
-- new rows continue it in insertion order.
ALTER TABLE dispatch_intents ADD COLUMN IF NOT EXISTS seq BIGSERIAL;
