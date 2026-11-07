-- Application RBAC, account suspension and immutable administrator audit log.
-- Authing authenticates identity; these database fields are the authority for
-- all application authorization decisions.

BEGIN;

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS app_role VARCHAR(16) NOT NULL DEFAULT 'user',
  ADD COLUMN IF NOT EXISTS account_status VARCHAR(24) NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS role_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS auth_valid_after TIMESTAMPTZ NOT NULL DEFAULT TO_TIMESTAMP(0),
  ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS suspended_by VARCHAR(255),
  ADD COLUMN IF NOT EXISTS suspension_reason TEXT,
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

-- Ensure historical content/account owners participate in database-backed
-- authorization even if they have not opened the profile page before.
CREATE TEMPORARY TABLE rbac_historical_user_ids (
  user_id      TEXT NOT NULL,
  source_table TEXT NOT NULL
) ON COMMIT DROP;

-- Some installations predate subscription billing, while others already
-- contain those tables. Resolve every source dynamically in the same schema
-- as user_profiles so an absent optional table cannot fail at parse time and
-- a temporary/search_path shadow table cannot be selected accidentally.
DO $migration$
DECLARE
  application_schema NAME;
  source_record       RECORD;
  source_relation     REGCLASS;
BEGIN
  SELECT namespace.nspname
  INTO application_schema
  FROM pg_class relation
  JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
  WHERE relation.oid = 'user_profiles'::regclass;

  FOR source_record IN
    SELECT *
    FROM (VALUES
      ('user_point_accounts', 'user_id'),
      ('creations', 'user_id'),
      ('canvases', 'user_id'),
      ('digital_human_roles', 'user_id'),
      ('prompt_templates', 'owner_user_id'),
      ('subscriptions', 'user_id'),
      ('subscription_orders', 'user_id'),
      ('subscription_refunds', 'user_id'),
      ('point_lots', 'user_id'),
      ('point_ledger', 'user_id'),
      ('point_orders', 'user_id'),
      ('membership_bonus_grants', 'user_id')
    ) AS sources(table_name, column_name)
  LOOP
    source_relation := to_regclass(
      format('%I.%I', application_schema, source_record.table_name)
    );

    IF source_relation IS NULL THEN
      CONTINUE;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_attribute
      WHERE attrelid = source_relation
        AND attname = source_record.column_name
        AND attnum > 0
        AND NOT attisdropped
    ) THEN
      RAISE EXCEPTION USING
        MESSAGE = format(
          'RBAC migration source %s is missing expected column %I',
          source_relation,
          source_record.column_name
        ),
        HINT = 'Repair the historical owner source schema before retrying migration 018.';
    END IF;

    EXECUTE format(
      'INSERT INTO pg_temp.rbac_historical_user_ids (user_id, source_table) '
      'SELECT %1$I::text, %2$L FROM %3$s WHERE %1$I IS NOT NULL',
      source_record.column_name,
      source_relation::text,
      source_relation
    );
  END LOOP;
END;
$migration$;

DO $migration$
DECLARE
  invalid_owner RECORD;
BEGIN
  SELECT user_id, source_table
  INTO invalid_owner
  FROM rbac_historical_user_ids
  WHERE LENGTH(user_id) > 255
     OR BTRIM(user_id) = ''
     OR user_id <> BTRIM(user_id)
  ORDER BY source_table, user_id
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      MESSAGE = 'Historical user id cannot be represented safely in user_profiles',
      DETAIL = format(
        'source=%s, length=%s, value_is_blank=%s, has_surrounding_whitespace=%s',
        invalid_owner.source_table,
        LENGTH(invalid_owner.user_id),
        BTRIM(invalid_owner.user_id) = '',
        invalid_owner.user_id <> BTRIM(invalid_owner.user_id)
      ),
      HINT = 'Correct the source row before retrying migration 018; user ids are never truncated or normalized automatically.';
  END IF;
END;
$migration$;

INSERT INTO user_profiles (user_id)
SELECT DISTINCT user_id
FROM rbac_historical_user_ids
ON CONFLICT (user_id) DO NOTHING;

-- Migration 016 implemented account deletion.  The confirmed product rule is
-- content deletion only, so no login identity remains in a deletion state.
UPDATE user_profiles
SET account_status = 'active',
    deletion_requested_at = NULL,
    deletion_scheduled_at = NULL,
    updated_at = NOW()
WHERE account_status = 'deletion_pending';

ALTER TABLE user_profiles DROP CONSTRAINT IF EXISTS user_profiles_account_status_check;
ALTER TABLE user_profiles DROP CONSTRAINT IF EXISTS user_profiles_app_role_check;

ALTER TABLE user_profiles
  ADD CONSTRAINT user_profiles_account_status_check
    CHECK (account_status IN ('active', 'suspended')),
  ADD CONSTRAINT user_profiles_app_role_check
    CHECK (app_role IN ('root', 'admin', 'user'));

DROP INDEX IF EXISTS idx_user_profiles_deletion_schedule;
CREATE INDEX IF NOT EXISTS idx_user_profiles_role_status
  ON user_profiles (app_role, account_status, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_profiles_single_root
  ON user_profiles (app_role) WHERE app_role = 'root';

CREATE TABLE IF NOT EXISTS administrator_audit_log (
  id                 BIGSERIAL PRIMARY KEY,
  actor_user_id      VARCHAR(255) NOT NULL,
  actor_role         VARCHAR(16) NOT NULL,
  action             VARCHAR(120) NOT NULL,
  target_type        VARCHAR(80),
  target_id          VARCHAR(255),
  request_id         VARCHAR(128),
  ip_address         INET,
  user_agent         TEXT,
  reason             TEXT,
  before_value       JSONB,
  after_value        JSONB,
  metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (actor_role IN ('root', 'admin'))
);

CREATE INDEX IF NOT EXISTS idx_administrator_audit_created
  ON administrator_audit_log (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_administrator_audit_actor
  ON administrator_audit_log (actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_administrator_audit_target
  ON administrator_audit_log (target_type, target_id, created_at DESC);

CREATE OR REPLACE FUNCTION prevent_administrator_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'administrator_audit_log is append-only';
END;
$$;

DROP TRIGGER IF EXISTS administrator_audit_no_update ON administrator_audit_log;
CREATE TRIGGER administrator_audit_no_update
  BEFORE UPDATE OR DELETE ON administrator_audit_log
  FOR EACH ROW EXECUTE FUNCTION prevent_administrator_audit_mutation();

DROP TRIGGER IF EXISTS administrator_audit_no_truncate ON administrator_audit_log;
CREATE TRIGGER administrator_audit_no_truncate
  BEFORE TRUNCATE ON administrator_audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_administrator_audit_mutation();

REVOKE TRUNCATE ON administrator_audit_log FROM PUBLIC;

COMMIT;
