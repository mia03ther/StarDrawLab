-- Administrator-managed announcements visible to authenticated users.
-- Deletion is deliberately soft so audit history and published content remain
-- recoverable by database operators when required.

BEGIN;

CREATE TABLE IF NOT EXISTS announcements (
  id           BIGSERIAL PRIMARY KEY,
  title        VARCHAR(200) NOT NULL,
  content      TEXT NOT NULL,
  status       VARCHAR(16) NOT NULL DEFAULT 'draft',
  priority     INTEGER NOT NULL DEFAULT 0,
  published_at TIMESTAMPTZ,
  created_by   VARCHAR(255) NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at   TIMESTAMPTZ,
  deleted_by   VARCHAR(255),
  CONSTRAINT announcements_status_check CHECK (status IN ('draft', 'published')),
  CONSTRAINT announcements_title_check CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  CONSTRAINT announcements_content_check CHECK (char_length(btrim(content)) BETWEEN 1 AND 100000),
  CONSTRAINT announcements_priority_check CHECK (priority BETWEEN -1000000 AND 1000000)
);

CREATE INDEX IF NOT EXISTS idx_announcements_published
  ON announcements (priority DESC, published_at DESC, id DESC)
  WHERE status = 'published' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_announcements_admin_list
  ON announcements (deleted_at, status, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_announcements_created_by
  ON announcements (created_by, created_at DESC, id DESC);

COMMENT ON TABLE announcements IS 'Administrator-managed announcements with soft deletion.';

COMMIT;
