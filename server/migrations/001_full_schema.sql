-- =============================================================
-- QuickAI-MVP 完整数据库迁移脚本
-- 执行顺序：在阿里云 ApsaraDB RDS for PostgreSQL 控制台或 psql 中运行
-- 幂等设计：所有语句均可重复执行
-- =============================================================

-- ─────────────────────────────────────────────
-- 1. 扩展 creations 表
-- ─────────────────────────────────────────────
ALTER TABLE creations
  ADD COLUMN IF NOT EXISTS provider                VARCHAR(50),
  ADD COLUMN IF NOT EXISTS model                   VARCHAR(100),
  ADD COLUMN IF NOT EXISTS scene_key               VARCHAR(50),
  ADD COLUMN IF NOT EXISTS scene_name              VARCHAR(100),
  ADD COLUMN IF NOT EXISTS status                  VARCHAR(20),
  ADD COLUMN IF NOT EXISTS provider_status         VARCHAR(50),
  ADD COLUMN IF NOT EXISTS task_id                 VARCHAR(255),
  ADD COLUMN IF NOT EXISTS request_idempotency_key VARCHAR(128),
  ADD COLUMN IF NOT EXISTS charge_status           VARCHAR(20) NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS points_reserved         INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS points_cost             INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS thumbnail_url           TEXT,
  ADD COLUMN IF NOT EXISTS content_object_key      VARCHAR(255),
  ADD COLUMN IF NOT EXISTS thumbnail_object_key    VARCHAR(255),
  ADD COLUMN IF NOT EXISTS generation_time_ms      INTEGER,
  ADD COLUMN IF NOT EXISTS error_message           TEXT,
  ADD COLUMN IF NOT EXISTS meta_info               JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS expires_at              TIMESTAMPTZ;

-- 兼容旧字段：若曾用 content_public_id，将数据迁移到新字段
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'creations' AND column_name = 'content_public_id'
  ) THEN
    UPDATE creations
    SET content_object_key   = content_public_id
    WHERE content_object_key IS NULL AND content_public_id IS NOT NULL;

    UPDATE creations
    SET thumbnail_object_key = thumbnail_public_id
    WHERE thumbnail_object_key IS NULL AND thumbnail_public_id IS NOT NULL;
  END IF;
END $$;

-- 旧记录回填 status = completed
UPDATE creations SET status = 'completed' WHERE status IS NULL;

-- 将 status 设为 NOT NULL，默认 pending（新建任务）
ALTER TABLE creations ALTER COLUMN status SET DEFAULT 'pending';
ALTER TABLE creations ALTER COLUMN status SET NOT NULL;

-- 旧记录回填 expires_at = created_at + 30 天
UPDATE creations
SET expires_at = created_at + INTERVAL '30 days'
WHERE expires_at IS NULL;

-- 索引
CREATE INDEX IF NOT EXISTS idx_creations_user_created_at
  ON creations (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_creations_status
  ON creations (status);

CREATE INDEX IF NOT EXISTS idx_creations_expires_at
  ON creations (expires_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_creations_provider_task_id
  ON creations (provider, task_id)
  WHERE task_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_creations_user_idempotency_key
  ON creations (user_id, request_idempotency_key)
  WHERE request_idempotency_key IS NOT NULL;

-- ─────────────────────────────────────────────
-- 2. prompt_templates 场景模板表
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS prompt_templates (
  id             BIGSERIAL PRIMARY KEY,
  scene_key      VARCHAR(50)  UNIQUE NOT NULL,
  scene_name     VARCHAR(100) NOT NULL,
  output_type    VARCHAR(20)  NOT NULL,   -- image / video
  target_provider VARCHAR(50) NOT NULL,
  default_model  VARCHAR(100),
  default_seconds INTEGER,
  default_size   VARCHAR(20),
  system_prompt  TEXT NOT NULL,
  display_order  INTEGER NOT NULL DEFAULT 0,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ─────────────────────────────────────────────
-- 3. user_point_accounts 用户积分账户
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_point_accounts (
  id                   BIGSERIAL PRIMARY KEY,
  user_id              VARCHAR(255) UNIQUE NOT NULL,
  balance_points       INTEGER NOT NULL DEFAULT 0,
  held_points          INTEGER NOT NULL DEFAULT 0,
  monthly_bonus_points INTEGER NOT NULL DEFAULT 0,
  membership_tier      VARCHAR(20) NOT NULL DEFAULT 'free',
  bonus_cycle_anchor   TIMESTAMPTZ,
  last_bonus_granted_at TIMESTAMPTZ,
  next_bonus_at        TIMESTAMPTZ,
  version              INTEGER NOT NULL DEFAULT 0,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (balance_points >= 0),
  CHECK (held_points    >= 0),
  CHECK (balance_points >= held_points)
);

-- ─────────────────────────────────────────────
-- 4. point_packages 积分套餐表
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS point_packages (
  id           BIGSERIAL PRIMARY KEY,
  package_key  VARCHAR(50)  UNIQUE NOT NULL,
  package_name VARCHAR(100) NOT NULL,
  price_cents  INTEGER NOT NULL,       -- 金额，单位：分
  points       INTEGER NOT NULL,
  bonus_points INTEGER NOT NULL DEFAULT 0,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ─────────────────────────────────────────────
-- 5. point_orders 积分订单表
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS point_orders (
  id                 BIGSERIAL PRIMARY KEY,
  user_id            VARCHAR(255) NOT NULL,
  order_no           VARCHAR(64)  UNIQUE NOT NULL,
  package_key        VARCHAR(50)  NOT NULL,
  package_name       VARCHAR(100) NOT NULL,
  amount_cents       INTEGER NOT NULL,
  points             INTEGER NOT NULL,
  bonus_points       INTEGER NOT NULL DEFAULT 0,
  total_points       INTEGER NOT NULL,
  status             VARCHAR(20)  NOT NULL DEFAULT 'pending',  -- pending / paid / cancelled / failed
  payment_method     VARCHAR(50)  NOT NULL DEFAULT 'mock',
  client_request_id  VARCHAR(64),
  confirm_request_id VARCHAR(64),
  payment_txn_id     VARCHAR(128),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_at            TIMESTAMPTZ,
  confirmed_at       TIMESTAMPTZ
);

-- 幂等键索引必须按 (user_id, xxx_request_id) 复合唯一，
-- 禁止全局唯一索引——否则不同用户可以互相命中对方的幂等记录。
-- 若旧全局索引存在，先删除再重建。
DROP INDEX IF EXISTS idx_point_orders_client_request_id;
DROP INDEX IF EXISTS idx_point_orders_confirm_request_id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_point_orders_user_client_request_id
  ON point_orders (user_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_point_orders_user_confirm_request_id
  ON point_orders (user_id, confirm_request_id)
  WHERE confirm_request_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_point_orders_payment_txn_id
  ON point_orders (payment_txn_id)
  WHERE payment_txn_id IS NOT NULL;

-- ─────────────────────────────────────────────
-- 6. point_ledger 积分流水表
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS point_ledger (
  id                 BIGSERIAL PRIMARY KEY,
  user_id            VARCHAR(255) NOT NULL,
  entry_type         VARCHAR(50)  NOT NULL,  -- recharge / membership_grant / reserve / charge / release / manual_adjustment / expire
  source_type        VARCHAR(50)  NOT NULL,  -- order / creation / membership_bonus_grant / admin / campaign
  source_id          VARCHAR(255) NOT NULL,
  idempotency_key    VARCHAR(128) NOT NULL,
  change_points      INTEGER NOT NULL,
  held_points_change INTEGER NOT NULL DEFAULT 0,
  balance_after      INTEGER NOT NULL,
  held_after         INTEGER NOT NULL,
  note               TEXT,
  metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_point_ledger_idempotency_key
  ON point_ledger (idempotency_key);

CREATE INDEX IF NOT EXISTS idx_point_ledger_user_created_at
  ON point_ledger (user_id, created_at DESC);

-- ─────────────────────────────────────────────
-- 7. membership_bonus_grants 会员月赠发放记录
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS membership_bonus_grants (
  id               BIGSERIAL PRIMARY KEY,
  user_id          VARCHAR(255) NOT NULL,
  membership_tier  VARCHAR(20)  NOT NULL,
  cycle_start_at   TIMESTAMPTZ  NOT NULL,
  cycle_end_at     TIMESTAMPTZ  NOT NULL,
  points_granted   INTEGER NOT NULL,
  idempotency_key  VARCHAR(128) NOT NULL,
  point_ledger_id  BIGINT,
  triggered_by     VARCHAR(20)  NOT NULL DEFAULT 'system',  -- system / admin
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_membership_bonus_grants_user_cycle
  ON membership_bonus_grants (user_id, cycle_start_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_membership_bonus_grants_idempotency_key
  ON membership_bonus_grants (idempotency_key);

-- ─────────────────────────────────────────────
-- 8. generation_charge_rules 计费规则表
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS generation_charge_rules (
  id          BIGSERIAL PRIMARY KEY,
  output_type VARCHAR(20)  NOT NULL,   -- image / video
  provider    VARCHAR(50)  NOT NULL,
  scene_key   VARCHAR(50),
  model       VARCHAR(100),
  seconds     INTEGER,
  size        VARCHAR(20),
  points_cost INTEGER NOT NULL,
  priority    INTEGER NOT NULL DEFAULT 100,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  meta_rule   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_generation_charge_rules_lookup
  ON generation_charge_rules (output_type, provider, scene_key, is_active, priority);

-- =============================================================
-- 初始化数据（ON CONFLICT DO NOTHING 保证幂等）
-- =============================================================

-- 场景模板
INSERT INTO prompt_templates
  (scene_key, scene_name, output_type, target_provider, default_model, default_seconds, default_size, system_prompt, display_order)
VALUES
  (
    'ecommerce_product_image',
    '商品主图生成',
    'image',
    'nano_banana2',
    'nano-banana-2',
    NULL,
    '1024x1024',
    'You are an expert product photographer and AI image director. Generate a highly realistic, commercial-grade product image suitable for e-commerce listings. The image should have clean background, professional lighting, and showcase the product''s key features clearly. Focus on: studio-quality lighting, clean composition, sharp product details, and a background that complements the product. Output should be suitable for major e-commerce platforms.',
    10
  ),
  (
    'ecommerce_promo_video',
    '电商推广短视频',
    'video',
    'sora2',
    'veo-3-1',
    8,
    '720x1280',
    'Create a short, high-impact promotional product video suitable for e-commerce advertising and social media. The video should: showcase the product attractively, use dynamic camera movements, feature professional lighting, and convey quality and desirability. Duration should feel energetic and engaging. Suitable for platforms like TikTok, Instagram Reels, and product detail pages.',
    20
  )
ON CONFLICT (scene_key) DO NOTHING;

-- 积分套餐
INSERT INTO point_packages (package_key, package_name, price_cents, points, bonus_points)
VALUES
  ('starter_1000',   '入门包', 1000,  1000,  0),
  ('standard_10000', '标准包', 10000, 10000, 0),
  ('growth_55000',   '增长包', 50000, 50000, 5000),
  ('pro_128000',     '专业包', 100000, 100000, 28000)
ON CONFLICT (package_key) DO NOTHING;

-- 计费规则
INSERT INTO generation_charge_rules
  (output_type, provider, scene_key, model, seconds, size, points_cost, priority)
VALUES
  -- 图片：按场景命中
  ('image', 'nano_banana2', 'ecommerce_product_image', NULL, NULL, NULL, 18, 10),
  -- 图片：默认兜底
  ('image', 'nano_banana2', NULL, NULL, NULL, NULL, 16, 100),
  -- 视频：按场景命中（8秒）— provider 必须与 prompt_templates.target_provider 一致
  ('video', 'sora2', 'ecommerce_promo_video', 'veo-3-1', 8, '720x1280', 160, 10),
  -- 视频：按时长兜底（5秒）
  ('video', 'sora2', NULL, NULL, 5, NULL, 150, 50),
  -- 视频：按时长兜底（10秒）
  ('video', 'sora2', NULL, NULL, 10, NULL, 150, 50),
  -- 视频：默认兜底
  ('video', 'sora2', NULL, NULL, NULL, NULL, 150, 100)
ON CONFLICT DO NOTHING;
