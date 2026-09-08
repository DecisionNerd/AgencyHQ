-- 0007_intent_queue.sql
-- Adds skip_reason column to dispatch_intents for scheduler feedback (Slice 6, R-008).
-- Idempotent: ADD COLUMN IF NOT EXISTS.

-- skip_reason records why a queued worker intent was not dispatched in a given
-- scheduler pass. Null when the intent is not queued or was dispatched without
-- a skip. Values mirror the SkipReason enum in @agencyhq/domain's selectDispatch.
ALTER TABLE dispatch_intents ADD COLUMN IF NOT EXISTS skip_reason text;
