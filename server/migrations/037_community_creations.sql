-- Public community publication for completed generated creations.
-- This migration is additive and deliberately does not change private content.

BEGIN;

ALTER TABLE creations
  ADD COLUMN IF NOT EXISTS community_status VARCHAR(16) NOT NULL DEFAULT 'private',
  ADD COLUMN IF NOT EXISTS community_title VARCHAR(160),
  ADD COLUMN IF NOT EXISTS community_tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS community_prompt_public BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS community_visual_parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS community_published_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS community_featured BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS community_hidden BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS community_hidden_reason TEXT,
  ADD COLUMN IF NOT EXISTS community_hidden_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS community_hidden_by VARCHAR(255);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'creations_community_status_check') THEN
    ALTER TABLE creations ADD CONSTRAINT creations_community_status_check
      CHECK (community_status IN ('private', 'public'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_creations_community_feed
  ON creations (community_featured DESC, community_published_at DESC, id DESC)
  WHERE status = 'completed' AND community_status = 'public' AND community_hidden = FALSE;

CREATE TABLE IF NOT EXISTS community_creation_likes (
  creation_id BIGINT NOT NULL REFERENCES creations(id) ON DELETE CASCADE,
  user_id VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (creation_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_community_creation_likes_creation
  ON community_creation_likes (creation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS community_creation_favorites (
  creation_id BIGINT NOT NULL REFERENCES creations(id) ON DELETE CASCADE,
  user_id VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (creation_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_community_creation_favorites_creation
  ON community_creation_favorites (creation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS community_creation_reports (
  id BIGSERIAL PRIMARY KEY,
  creation_id BIGINT NOT NULL REFERENCES creations(id) ON DELETE CASCADE,
  reporter_user_id VARCHAR(255) NOT NULL,
  reason VARCHAR(80) NOT NULL,
  details TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  reviewed_by VARCHAR(255),
  reviewed_at TIMESTAMPTZ,
  review_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT community_creation_reports_status_check
    CHECK (status IN ('pending', 'reviewed', 'dismissed'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_community_creation_reports_pending_user
  ON community_creation_reports (creation_id, reporter_user_id)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_community_creation_reports_queue
  ON community_creation_reports (status, created_at DESC);

CREATE TABLE IF NOT EXISTS community_creation_events (
  id BIGSERIAL PRIMARY KEY,
  creation_id BIGINT NOT NULL,
  actor_user_id VARCHAR(255),
  actor_role VARCHAR(16) NOT NULL DEFAULT 'user',
  event_type VARCHAR(80) NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT community_creation_events_role_check
    CHECK (actor_role IN ('system', 'user', 'admin', 'root'))
);
CREATE INDEX IF NOT EXISTS idx_community_creation_events_creation
  ON community_creation_events (creation_id, created_at DESC, id DESC);

COMMIT;
