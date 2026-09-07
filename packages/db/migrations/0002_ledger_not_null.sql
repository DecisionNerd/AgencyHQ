-- Migration 0002: Add NOT NULL constraints to columns always written by the coordinator.
--
-- Applied migrations are immutable; this file adds SET NOT NULL to columns that
-- every coordinator insert site supplies. Each statement is guarded by an
-- information_schema check so the migration is safe to re-execute (idempotent).

-- ---------------------------------------------------------------------------
-- findings
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'findings'
      AND column_name = 'severity'
      AND is_nullable = 'YES'
  ) THEN
    ALTER TABLE findings ALTER COLUMN severity SET NOT NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'findings'
      AND column_name = 'kind'
      AND is_nullable = 'YES'
  ) THEN
    ALTER TABLE findings ALTER COLUMN kind SET NOT NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'findings'
      AND column_name = 'description'
      AND is_nullable = 'YES'
  ) THEN
    ALTER TABLE findings ALTER COLUMN description SET NOT NULL;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- decisions
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'decisions'
      AND column_name = 'kind'
      AND is_nullable = 'YES'
  ) THEN
    ALTER TABLE decisions ALTER COLUMN kind SET NOT NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'decisions'
      AND column_name = 'actor'
      AND is_nullable = 'YES'
  ) THEN
    ALTER TABLE decisions ALTER COLUMN actor SET NOT NULL;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- failures
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'failures'
      AND column_name = 'class'
      AND is_nullable = 'YES'
  ) THEN
    ALTER TABLE failures ALTER COLUMN class SET NOT NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'failures'
      AND column_name = 'phase'
      AND is_nullable = 'YES'
  ) THEN
    ALTER TABLE failures ALTER COLUMN phase SET NOT NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'failures'
      AND column_name = 'cause'
      AND is_nullable = 'YES'
  ) THEN
    ALTER TABLE failures ALTER COLUMN cause SET NOT NULL;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- reviews
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'reviews'
      AND column_name = 'reviewer_model'
      AND is_nullable = 'YES'
  ) THEN
    ALTER TABLE reviews ALTER COLUMN reviewer_model SET NOT NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'reviews'
      AND column_name = 'profile'
      AND is_nullable = 'YES'
  ) THEN
    ALTER TABLE reviews ALTER COLUMN profile SET NOT NULL;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- commands
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'commands'
      AND column_name = 'kind'
      AND is_nullable = 'YES'
  ) THEN
    ALTER TABLE commands ALTER COLUMN kind SET NOT NULL;
  END IF;
END $$;
