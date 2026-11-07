-- Content recycle bin. This migration deliberately handles content only;
-- accounts, sessions, subscriptions, orders, payments, point balances,
-- point ledgers and administrator audit records are outside its scope.

BEGIN;

CREATE TABLE IF NOT EXISTS user_content_uploads (
  id                BIGSERIAL PRIMARY KEY,
  user_id           VARCHAR(255) NOT NULL,
  object_key        VARCHAR(255) NOT NULL UNIQUE,
  asset_url         TEXT,
  media_type        VARCHAR(20) NOT NULL DEFAULT 'file',
  mime_type         VARCHAR(160),
  original_name     VARCHAR(255),
  source_type       VARCHAR(32) NOT NULL DEFAULT 'upload',
  source_resource_id VARCHAR(255),
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT user_content_uploads_media_type_check
    CHECK (media_type IN ('image', 'video', 'audio', 'file'))
);

CREATE INDEX IF NOT EXISTS idx_user_content_uploads_user_created_at
  ON user_content_uploads (user_id, created_at DESC);

-- Existing canvas uploads have no independent database row. Register them so
-- later deletion can address the upload itself without treating a canvas as
-- the owner of the physical object. Deleting a canvas therefore never
-- cascades to media that another canvas may reference.
--
-- Refuse malformed historical shapes instead of silently treating them as an
-- empty canvas. The exception includes one canvas id so the release operator
-- can inspect and repair the source row during the maintenance window.
DO $migration$
DECLARE
  invalid_canvas_id TEXT;
BEGIN
  SELECT id::text
  INTO invalid_canvas_id
  FROM canvases
  WHERE jsonb_typeof(canvas_state) <> 'object'
     OR (
       canvas_state ? 'elements'
       AND jsonb_typeof(canvas_state->'elements') <> 'array'
     )
  ORDER BY id
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      MESSAGE = 'Canvas upload backfill found an unsupported canvas_state shape',
      DETAIL = format('sample_canvas_id=%s', invalid_canvas_id),
      HINT = 'canvas_state must be an object and canvas_state.elements, when present, must be an array; repair it before retrying migration 019.';
  END IF;

  SELECT c.id::text
  INTO invalid_canvas_id
  FROM canvases c
  CROSS JOIN LATERAL jsonb_array_elements(
    COALESCE(c.canvas_state->'elements', '[]'::jsonb)
  ) AS item(element)
  WHERE jsonb_typeof(item.element) <> 'object'
  ORDER BY c.id
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      MESSAGE = 'Canvas upload backfill found a non-object element',
      DETAIL = format('sample_canvas_id=%s', invalid_canvas_id),
      HINT = 'Every canvas_state.elements entry must be a JSON object; repair it before retrying migration 019.';
  END IF;
END;
$migration$;

CREATE TEMPORARY TABLE canvas_upload_backfill_candidates
ON COMMIT DROP
AS
SELECT
  c.id::text AS canvas_id,
  c.user_id::text AS user_id,
  item.position,
  item.element,
  COALESCE(
    NULLIF(item.element->>'objectKey', ''),
    NULLIF(item.element->>'object_key', '')
  ) AS object_key,
  COALESCE(
    NULLIF(item.element->>'src', ''),
    NULLIF(item.element->>'url', ''),
    NULLIF(item.element->>'content', ''),
    NULLIF(item.element->>'preview_image_url', ''),
    NULLIF(item.element->>'thumbnail_url', ''),
    NULLIF(item.element->>'reference_preview_url', ''),
    NULLIF(item.element->>'poster', '')
  ) AS asset_url,
  LOWER(COALESCE(
    NULLIF(item.element->>'source', ''),
    NULLIF(item.element->>'source_type', ''),
    ''
  )) AS element_source,
  COALESCE(
    NULLIF(item.element->>'creationId', ''),
    NULLIF(item.element->>'creation_id', '')
  ) AS creation_id,
  c.created_at,
  c.updated_at
FROM canvases c
CROSS JOIN LATERAL jsonb_array_elements(
  COALESCE(c.canvas_state->'elements', '[]'::jsonb)
) WITH ORDINALITY AS item(element, position);

DO $migration$
DECLARE
  invalid_candidate RECORD;
BEGIN
  -- A non-empty camelCase value must not hide a different snake_case value.
  SELECT canvas_id, position, object_key
  INTO invalid_candidate
  FROM canvas_upload_backfill_candidates
  WHERE NULLIF(element->>'objectKey', '') IS NOT NULL
    AND NULLIF(element->>'object_key', '') IS NOT NULL
    AND (element->>'objectKey') IS DISTINCT FROM (element->>'object_key')
  ORDER BY canvas_id, position
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      MESSAGE = 'Canvas upload backfill found conflicting objectKey aliases',
      DETAIL = format(
        'sample_canvas_id=%s, element_position=%s',
        invalid_candidate.canvas_id,
        invalid_candidate.position
      ),
      HINT = 'Choose the correct object key explicitly in the source canvas; migration 019 never guesses between conflicting aliases.';
  END IF;

  SELECT canvas_id, position, object_key
  INTO invalid_candidate
  FROM canvas_upload_backfill_candidates
  WHERE object_key IS NOT NULL
    AND (
      LENGTH(object_key) > 255
      OR object_key <> BTRIM(object_key)
      OR LEFT(object_key, LENGTH('quickai/' || user_id || '/'))
           <> 'quickai/' || user_id || '/'
    )
  ORDER BY canvas_id, position
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      MESSAGE = 'Canvas upload backfill found an unsafe object key',
      DETAIL = format(
        'sample_canvas_id=%s, element_position=%s, object_key_length=%s',
        invalid_candidate.canvas_id,
        invalid_candidate.position,
        LENGTH(invalid_candidate.object_key)
      ),
      HINT = 'Object keys must be at most 255 characters, contain no surrounding whitespace, and start with quickai/{canvas owner user_id}/.';
  END IF;

  -- Newer clients identify direct uploads explicitly. Also catch unclassified
  -- URL-only elements which point into the canvas owner's OSS prefix and have
  -- no creation id. Such an element cannot be registered safely from its URL
  -- alone because signed/proxy URLs are not stable ownership identifiers.
  SELECT canvas_id, position, object_key
  INTO invalid_candidate
  FROM canvas_upload_backfill_candidates
  WHERE object_key IS NULL
    AND (
      element_source IN ('canvas_upload', 'canvas-upload')
      OR (
        creation_id IS NULL
        AND asset_url IS NOT NULL
        AND POSITION('quickai/' || user_id || '/' IN asset_url) > 0
      )
    )
  ORDER BY canvas_id, position
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      MESSAGE = 'Canvas upload backfill found an upload without an object key',
      DETAIL = format(
        'sample_canvas_id=%s, element_position=%s',
        invalid_candidate.canvas_id,
        invalid_candidate.position
      ),
      HINT = 'Recover and store the OSS object key in objectKey/object_key before retrying migration 019; URLs are not converted heuristically.';
  END IF;

  SELECT canvas_id, position, object_key
  INTO invalid_candidate
  FROM canvas_upload_backfill_candidates
  WHERE asset_url IS NOT NULL
    AND (
      asset_url <> BTRIM(asset_url)
      OR asset_url ~ '[[:cntrl:]]'
    )
  ORDER BY canvas_id, position
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      MESSAGE = 'Canvas upload backfill found an unsafe asset URL',
      DETAIL = format(
        'sample_canvas_id=%s, element_position=%s',
        invalid_candidate.canvas_id,
        invalid_candidate.position
      ),
      HINT = 'Remove surrounding whitespace/control characters or set a verified canonical URL before retrying migration 019.';
  END IF;

  -- The supported historical layout stores objectKey/object_key directly on
  -- an element. Keys elsewhere would otherwise be omitted silently.
  SELECT c.id::text AS canvas_id, NULL::bigint AS position, NULL::text AS object_key
  INTO invalid_candidate
  FROM canvases c
  WHERE jsonb_path_exists(c.canvas_state - 'elements', 'strict $.**.objectKey')
     OR jsonb_path_exists(c.canvas_state - 'elements', 'strict $.**.object_key')
  ORDER BY c.id
  LIMIT 1;

  IF NOT FOUND THEN
    SELECT canvas_id, position, NULL::text AS object_key
    INTO invalid_candidate
    FROM canvas_upload_backfill_candidates
    WHERE jsonb_path_exists(element - 'objectKey' - 'object_key', 'strict $.**.objectKey')
       OR jsonb_path_exists(element - 'objectKey' - 'object_key', 'strict $.**.object_key')
    ORDER BY canvas_id, position
    LIMIT 1;
  END IF;

  IF FOUND THEN
    RAISE EXCEPTION USING
      MESSAGE = 'Canvas upload backfill found an object key outside the supported element fields',
      DETAIL = format(
        'sample_canvas_id=%s, element_position=%s',
        invalid_candidate.canvas_id,
        COALESCE(invalid_candidate.position::text, 'outside-elements')
      ),
      HINT = 'Move the verified key to elements[*].objectKey/object_key or handle that historical JSON path explicitly before retrying migration 019.';
  END IF;

  SELECT
    MIN(canvas_id) AS canvas_id,
    MIN(position) AS position,
    object_key
  INTO invalid_candidate
  FROM canvas_upload_backfill_candidates
  WHERE object_key IS NOT NULL
  GROUP BY object_key
  HAVING COUNT(DISTINCT user_id) > 1
  ORDER BY object_key
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      MESSAGE = 'Canvas upload backfill found one object key claimed by multiple users',
      DETAIL = format(
        'sample_canvas_id=%s, object_key=%s',
        invalid_candidate.canvas_id,
        invalid_candidate.object_key
      ),
      HINT = 'Resolve OSS ownership before retrying migration 019; ON CONFLICT is not allowed to choose an owner.';
  END IF;

  SELECT candidate.canvas_id, candidate.position, candidate.object_key
  INTO invalid_candidate
  FROM canvas_upload_backfill_candidates candidate
  JOIN user_content_uploads existing
    ON existing.object_key = candidate.object_key
  WHERE candidate.object_key IS NOT NULL
    AND existing.user_id IS DISTINCT FROM candidate.user_id
  ORDER BY candidate.canvas_id, candidate.position
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      MESSAGE = 'Canvas upload backfill conflicts with an existing upload owner',
      DETAIL = format(
        'sample_canvas_id=%s, object_key=%s',
        invalid_candidate.canvas_id,
        invalid_candidate.object_key
      ),
      HINT = 'Verify the existing user_content_uploads owner before retrying migration 019.';
  END IF;
END;
$migration$;

INSERT INTO user_content_uploads
  (user_id, object_key, asset_url, media_type, original_name,
   source_type, source_resource_id, metadata, created_at, updated_at)
SELECT DISTINCT ON (object_key)
  user_id,
  object_key,
  asset_url,
  CASE
    WHEN LOWER(COALESCE(element->>'type', '')) = 'video' THEN 'video'
    WHEN LOWER(COALESCE(element->>'type', '')) = 'audio' THEN 'audio'
    WHEN LOWER(COALESCE(element->>'type', '')) = 'image' THEN 'image'
    ELSE 'file'
  END,
  NULLIF(LEFT(COALESCE(element->>'title', ''), 255), ''),
  'canvas_upload',
  canvas_id,
  jsonb_build_object('backfilled_from_canvas', canvas_id),
  created_at,
  updated_at
FROM canvas_upload_backfill_candidates
WHERE object_key IS NOT NULL
ORDER BY object_key, updated_at DESC, canvas_id, position DESC
ON CONFLICT (object_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS content_recycle_entries (
  id                         BIGSERIAL PRIMARY KEY,
  owner_user_id              VARCHAR(255) NOT NULL,
  resource_type              VARCHAR(32) NOT NULL,
  resource_id                VARCHAR(255) NOT NULL,
  resource_label             VARCHAR(255),
  deletion_origin            VARCHAR(16) NOT NULL,
  visibility                 VARCHAR(16) NOT NULL,
  deleted_by_user_id         VARCHAR(255) NOT NULL,
  deleted_by_role            VARCHAR(16) NOT NULL,
  deletion_reason            TEXT,
  membership_tier_at_deletion VARCHAR(20) NOT NULL DEFAULT 'free',
  resource_snapshot          JSONB NOT NULL,
  reference_snapshot         JSONB NOT NULL DEFAULT '{"canvases":[],"retained_creations":[]}'::jsonb,
  object_keys                JSONB NOT NULL DEFAULT '[]'::jsonb,
  status                     VARCHAR(24) NOT NULL DEFAULT 'active',
  deleted_at                 TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  purge_after                TIMESTAMPTZ NOT NULL,
  restored_at                TIMESTAMPTZ,
  restored_by_user_id        VARCHAR(255),
  purged_at                  TIMESTAMPTZ,
  purged_by_user_id          VARCHAR(255),
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT content_recycle_entries_resource_type_check
    CHECK (resource_type IN ('creation', 'canvas', 'private_template', 'digital_human', 'upload')),
  CONSTRAINT content_recycle_entries_origin_check
    CHECK (deletion_origin IN ('user', 'admin')),
  CONSTRAINT content_recycle_entries_visibility_check
    CHECK (visibility IN ('user', 'admin_only')),
  CONSTRAINT content_recycle_entries_deleted_by_role_check
    CHECK (deleted_by_role IN ('user', 'admin', 'root', 'system')),
  CONSTRAINT content_recycle_entries_status_check
    CHECK (status IN ('active', 'restored', 'purged')),
  CONSTRAINT content_recycle_entries_object_keys_array_check
    CHECK (jsonb_typeof(object_keys) = 'array'),
  CONSTRAINT content_recycle_entries_origin_visibility_check
    CHECK (
      (deletion_origin = 'user' AND visibility = 'user') OR
      (deletion_origin = 'admin' AND visibility = 'admin_only')
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_content_recycle_entries_active_resource
  ON content_recycle_entries (resource_type, resource_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_content_recycle_entries_user_active
  ON content_recycle_entries (owner_user_id, purge_after, deleted_at DESC)
  WHERE status = 'active' AND visibility = 'user';

CREATE INDEX IF NOT EXISTS idx_content_recycle_entries_admin_active
  ON content_recycle_entries (purge_after, deleted_at DESC)
  WHERE status = 'active' AND visibility = 'admin_only';

CREATE INDEX IF NOT EXISTS idx_content_recycle_entries_user_purge
  ON content_recycle_entries (purge_after, id)
  WHERE status = 'active' AND visibility = 'user' AND deletion_origin = 'user';

CREATE TABLE IF NOT EXISTS content_restore_requests (
  id                  BIGSERIAL PRIMARY KEY,
  recycle_entry_id    BIGINT NOT NULL REFERENCES content_recycle_entries(id),
  requested_by_user_id VARCHAR(255) NOT NULL,
  request_reason      TEXT NOT NULL,
  idempotency_key     VARCHAR(128),
  status              VARCHAR(16) NOT NULL DEFAULT 'pending',
  reviewed_by_user_id VARCHAR(255),
  review_note         TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at         TIMESTAMPTZ,
  CONSTRAINT content_restore_requests_status_check
    CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled'))
);

ALTER TABLE content_restore_requests
  ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(128);

CREATE UNIQUE INDEX IF NOT EXISTS idx_content_restore_requests_one_pending
  ON content_restore_requests (recycle_entry_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_content_restore_requests_status_created_at
  ON content_restore_requests (status, created_at ASC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_content_restore_requests_requester_idempotency
  ON content_restore_requests (requested_by_user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Kept separate from the recycle entry so the user can receive a moderation
-- notice without gaining visibility of, or restore access to, the admin bin.
CREATE TABLE IF NOT EXISTS content_recycle_notifications (
  id                BIGSERIAL PRIMARY KEY,
  user_id           VARCHAR(255) NOT NULL,
  notification_type VARCHAR(32) NOT NULL,
  title             VARCHAR(160) NOT NULL,
  message           TEXT NOT NULL,
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  read_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT content_recycle_notifications_type_check
    CHECK (notification_type IN ('content_removed', 'content_restored'))
);

CREATE INDEX IF NOT EXISTS idx_content_recycle_notifications_user_created_at
  ON content_recycle_notifications (user_id, created_at DESC);

-- External object deletion is retriable and deliberately occurs after the
-- database transaction. No user content snapshot is stored in this queue.
CREATE TABLE IF NOT EXISTS content_object_cleanup_jobs (
  id                BIGSERIAL PRIMARY KEY,
  owner_user_id     VARCHAR(255) NOT NULL,
  source_type       VARCHAR(32) NOT NULL,
  source_id         VARCHAR(255) NOT NULL,
  object_keys       JSONB NOT NULL,
  status            VARCHAR(16) NOT NULL DEFAULT 'pending',
  attempts          INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT,
  next_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processing_started_at TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at      TIMESTAMPTZ,
  CONSTRAINT content_object_cleanup_jobs_status_check
    CHECK (status IN ('pending', 'processing', 'failed', 'completed')),
  CONSTRAINT content_object_cleanup_jobs_keys_array_check
    CHECK (jsonb_typeof(object_keys) = 'array')
);

ALTER TABLE content_object_cleanup_jobs
  ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ;

DROP INDEX IF EXISTS idx_content_object_cleanup_jobs_retry;
CREATE INDEX IF NOT EXISTS idx_content_object_cleanup_jobs_retry
  ON content_object_cleanup_jobs (next_attempt_at, id)
  WHERE status IN ('pending', 'failed');

CREATE INDEX IF NOT EXISTS idx_content_object_cleanup_jobs_stuck
  ON content_object_cleanup_jobs (processing_started_at, id)
  WHERE status = 'processing';

COMMIT;
