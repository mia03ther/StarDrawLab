CREATE TABLE IF NOT EXISTS canvases (
  id           VARCHAR(64) PRIMARY KEY,
  user_id      VARCHAR(255) NOT NULL,
  title        VARCHAR(120) NOT NULL,
  canvas_state JSONB NOT NULL DEFAULT '{"viewport":{"x":0,"y":0,"scale":1},"elements":[],"background":{"mode":"grid"}}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_canvases_user_updated_at
  ON canvases (user_id, updated_at DESC);
