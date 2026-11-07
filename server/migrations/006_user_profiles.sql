CREATE TABLE IF NOT EXISTS user_profiles (
  user_id           VARCHAR(255) PRIMARY KEY,
  display_name      VARCHAR(40),
  avatar_url        TEXT,
  avatar_object_key VARCHAR(255),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
