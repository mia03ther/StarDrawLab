-- Digital human roles and mobile capture flow.

CREATE TABLE IF NOT EXISTS digital_human_roles (
  id                    BIGSERIAL PRIMARY KEY,
  user_id               VARCHAR(255) NOT NULL,
  role_name             VARCHAR(120) NOT NULL,
  role_description      TEXT,
  prompt_text           TEXT,
  status                VARCHAR(20) NOT NULL DEFAULT 'collecting',
  qr_token              VARCHAR(80) NOT NULL UNIQUE,
  avatar_url            TEXT,
  avatar_object_key     VARCHAR(255),
  demo_video_url        TEXT,
  demo_video_object_key  VARCHAR(255),
  ready_at              TIMESTAMPTZ,
  meta_info             JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_digital_human_roles_user_created_at
  ON digital_human_roles (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_digital_human_roles_status
  ON digital_human_roles (status);
