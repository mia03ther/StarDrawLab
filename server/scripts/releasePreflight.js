import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(serverRoot, "..");
const envPath = path.join(serverRoot, ".env");

// This is deliberately an explicit, local dotenv load. The preflight must
// inspect the server configuration even when it is launched from the repo
// root, and it must never open a database connection.
dotenv.config({ path: envPath, quiet: true });

let failures = 0;
let warnings = 0;

const report = (level, label, detail) => {
  const prefix = level === "FAIL" ? "✖" : level === "WARN" ? "!" : "✓";
  console.log(`${prefix} ${level} ${label}${detail ? ` — ${detail}` : ""}`);
  if (level === "FAIL") failures += 1;
  if (level === "WARN") warnings += 1;
};

const valueOf = (name) => String(process.env[name] || "").trim();
const isPlaceholder = (value) => /^(your_|replace_with|change_me|example|test[_-]?)/i.test(value);
const isSet = (name) => {
  const value = valueOf(name);
  return value.length > 0 && !isPlaceholder(value);
};
const isTrue = (name) => ["1", "true", "yes", "on"].includes(valueOf(name).toLowerCase());
const authProvider = valueOf("AUTH_PROVIDER").toLowerCase() || "authing";

// Release checks must fail on a local preview environment even when its
// database and mock services are reachable. This does not load any dev entry.
if (process.env.NODE_ENV !== "production") {
  report("FAIL", "NODE_ENV", "发布检查只接受 production，不能使用本地开发配置");
} else {
  report("PASS", "NODE_ENV", "生产环境");
}
for (const name of ["LOCAL_DEVELOPMENT_MODE", "PROVIDER_MOCKS_ENABLED", "ALLOW_DEV_AUTH_HEADERS", "VITE_LOCAL_DEVELOPMENT"]) {
  if (isTrue(name)) report("FAIL", name, "发布时必须关闭本地测试、模拟服务与开发身份入口");
  else report("PASS", name, "已关闭");
}

if (!["authing", "oidc", "logto"].includes(authProvider)) {
  report("FAIL", "AUTH_PROVIDER", "只支持 authing、oidc 或 logto");
}

const required = [
  ...(authProvider === "authing"
    ? ["AUTHING_APP_ID", "AUTHING_APP_HOST"]
    : ["OIDC_ISSUER", "OIDC_AUDIENCE", "OIDC_JWKS_URI"]),
  "ROOT_ADMIN_USER_ID",
  "DATABASE_URL",
  "OSS_REGION",
  "OSS_ENDPOINT",
  "OSS_BUCKET",
  "OSS_ACCESS_KEY_ID",
  "OSS_ACCESS_KEY_SECRET",
  "RESOURCE_ACCESS_SECRET",
  "IMAGE_PROVIDER_KEY",
  "IMAGE_PROVIDER_BASE_URL",
  "SORA_API_KEY",
  "SORA_BASE_URL",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASSWORD",
  "SMTP_FROM",
  "OPERATIONAL_ALERT_EMAILS",
  "MCP_CREDENTIAL_MASTER_KEY",
  "MCP_OAUTH_REDIRECT_URI",
  "MCP_OAUTH_SUCCESS_REDIRECT",
  "MCP_OAUTH_ERROR_REDIRECT",
  "ALLOWED_ORIGINS",
  "APP_BASE_URL",
];

for (const name of required) {
  if (!isSet(name)) report("FAIL", name, "未配置或仍是示例值");
  else report("PASS", name, "已配置");
}

for (const name of ["AUTHING_APP_HOST", "OIDC_ISSUER", "OIDC_JWKS_URI", "IMAGE_PROVIDER_BASE_URL", "SORA_BASE_URL", "APP_BASE_URL", "ALLOWED_ORIGINS"]) {
  if (!isSet(name)) continue;
  try {
    const values = name === "ALLOWED_ORIGINS" ? valueOf(name).split(",") : [valueOf(name)];
    for (const item of values) {
      const url = new URL(item.trim());
      if (url.protocol !== "https:" && process.env.NODE_ENV === "production") {
        report("FAIL", `${name} URL`, "生产环境必须使用 HTTPS");
      }
    }
  } catch {
    report("FAIL", `${name} URL`, "URL 格式无效");
  }
}

const resourceSecret = valueOf("RESOURCE_ACCESS_SECRET");
if (resourceSecret && Buffer.byteLength(resourceSecret, "utf8") < 32) {
  report("FAIL", "RESOURCE_ACCESS_SECRET", "长度必须至少为 32 字节");
}

const masterKey = valueOf("MCP_CREDENTIAL_MASTER_KEY");
if (masterKey) {
  const decoded = /^[0-9a-f]{64}$/i.test(masterKey)
    ? Buffer.from(masterKey, "hex")
    : Buffer.from(masterKey, "base64");
  if (decoded.length !== 32) report("FAIL", "MCP_CREDENTIAL_MASTER_KEY", "必须编码为恰好 32 字节");
  else report("PASS", "MCP_CREDENTIAL_MASTER_KEY", "长度格式正确");
}

if (isTrue("ALIPAY_PERIODIC_ENABLED")) {
  report("FAIL", "ALIPAY_PERIODIC_ENABLED", "当前产品策略要求保持关闭，商家扣款尚未启用");
} else {
  report("PASS", "ALIPAY_PERIODIC_ENABLED", "已关闭，使用主动续费提醒");
}

if (isTrue("EXECUTION_GOVERNOR_ENABLED")) {
  report("PASS", "EXECUTION_GOVERNOR_ENABLED", "已启用 PostgreSQL 跨实例执行治理");
} else {
  report("FAIL", "EXECUTION_GOVERNOR_ENABLED", "必须在迁移 029 已验证后启用，防止多实例绕过并发与每日额度");
}

if (isTrue("METERED_SETTLEMENT_RECONCILIATION_ENABLED")) {
  report("PASS", "METERED_SETTLEMENT_RECONCILIATION_ENABLED", "Worker 将补偿 Agent 计费不确定状态");
} else {
  report("FAIL", "METERED_SETTLEMENT_RECONCILIATION_ENABLED", "迁移 031 已要求启用计费补偿 Worker");
}

if (isTrue("AUTH_REQUIRE_VERIFIED_EMAIL")) {
  report("PASS", "AUTH_REQUIRE_VERIFIED_EMAIL", "服务端强制已验证邮箱 claim");
} else {
  report("WARN", "AUTH_REQUIRE_VERIFIED_EMAIL", "确认身份供应商 Token 已包含 email_verified 后再启用");
}

if (valueOf("DB_SSL").toLowerCase() === "false") {
  report("WARN", "DB_SSL", "仅适用于未发布端口的 Docker 私有数据库网络");
} else if (!isTrue("DB_SSL_VERIFY")) {
  report("FAIL", "DB_SSL_VERIFY", "启用 PostgreSQL TLS 时必须验证服务端证书");
} else {
  report("PASS", "DB_SSL_VERIFY", "PostgreSQL TLS 证书验证已启用");
}

if (isTrue("SUBSCRIPTION_PURCHASES_ENABLED")) {
  for (const name of ["ALIPAY_APP_ID", "ALIPAY_SELLER_ID", "ALIPAY_PRIVATE_KEY", "ALIPAY_PUBLIC_KEY", "ALIPAY_GATEWAY", "ALIPAY_NOTIFY_URL", "ALIPAY_RETURN_URL"]) {
    if (!isSet(name)) report("FAIL", name, "支付已打开但配置不完整");
  }
} else {
  report("WARN", "SUBSCRIPTION_PURCHASES_ENABLED", "当前关闭；完成迁移和支付宝小额验收后再打开");
}

if (!isSet("HEYGEN_API_KEY")) {
  if (isTrue("DIGITAL_HUMAN_OFFLINE_RENDER")) report("WARN", "HEYGEN_API_KEY", "未配置，当前使用离线数字人渲染");
  else report("FAIL", "HEYGEN_API_KEY", "未配置，外部数字人视频不可用；或明确开启离线渲染");
} else {
  report("PASS", "HEYGEN_API_KEY", "已配置");
}

const skillRootFromEnv = valueOf("AGENT_SKILL_ROOT");
const skillRoot = skillRootFromEnv && fs.existsSync(skillRootFromEnv)
  ? skillRootFromEnv
  : path.join(repositoryRoot, "skills");
if (!fs.existsSync(skillRoot)) {
  report("FAIL", "AGENT_SKILL_ROOT", "Skill 根目录不存在");
} else {
  const skillFiles = [];
  const entries = fs.readdirSync(skillRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(skillRoot, entry.name, "SKILL.md");
    if (fs.existsSync(skillFile)) skillFiles.push(skillFile);
  }
  if (skillFiles.length === 0) report("WARN", "AGENT_SKILL_ROOT", "目录可读但没有 SKILL.md");
  else report("PASS", "AGENT_SKILL_ROOT", `${skillFiles.length} 个 Skill 可读`);
}

const migrationDirectory = path.join(serverRoot, "migrations");
const expectedLatestMigration = 63;
const migrationNames = fs.readdirSync(migrationDirectory)
  .map((name) => /^([0-9]{3})_.*\.sql$/.exec(name))
  .filter(Boolean)
  .map((match) => Number(match[1]));
const missingMigrations = [];
for (let number = 1; number <= expectedLatestMigration; number += 1) {
  if (!migrationNames.includes(number)) missingMigrations.push(String(number).padStart(3, "0"));
}
if (missingMigrations.length > 0) report("FAIL", "数据库迁移文件", `缺少 ${missingMigrations.join(", ")}`);
else report("PASS", "数据库迁移文件", `001–${String(expectedLatestMigration).padStart(3, "0")} 连续存在（未连接数据库验证是否已应用）`);

const browserActionMigration = fs.readFileSync(path.join(migrationDirectory, "040_agent_browser_actions.sql"), "utf8");
if (!browserActionMigration.includes("waiting_client") || !browserActionMigration.includes("CREATE INDEX CONCURRENTLY")) {
  report("FAIL", "迁移 040", "缺少 waiting_client 或并发索引构建保护");
} else {
  report("PASS", "迁移 040", "包含 waiting_client 与并发索引构建");
}

const ledgerMigration = fs.readFileSync(path.join(migrationDirectory, "041_schema_migration_ledger.sql"), "utf8");
if (!ledgerMigration.includes("CREATE TABLE IF NOT EXISTS schema_migrations")
  || !ledgerMigration.includes("execution_duration_ms")
  || !ledgerMigration.includes("sha256")) {
  report("FAIL", "迁移 041", "缺少迁移账本、摘要或执行耗时字段");
} else {
  report("PASS", "迁移 041", "包含不可变迁移账本字段");
}

const agentModelMigration = fs.readFileSync(path.join(migrationDirectory, "042_agent_gpt54_mini.sql"), "utf8");
if (!agentModelMigration.includes("gpt-5.4-mini") || !agentModelMigration.includes("model_routes")) {
  report("FAIL", "迁移 042", "缺少 Agent gpt-5.4-mini 路由切换");
} else {
  report("PASS", "迁移 042", "包含 Agent gpt-5.4-mini 路由切换");
}

const mediaProviderMigration = fs.readFileSync(path.join(migrationDirectory, "043_media_provider_catalog_switch.sql"), "utf8");
if (!mediaProviderMigration.includes("gpt-image-2") || !mediaProviderMigration.includes("reference_images")) {
  report("FAIL", "迁移 043", "缺少 GPT Image 2 模型目录与能力切换");
} else {
  report("PASS", "迁移 043", "包含 GPT Image 2 模型目录与模板切换");
}

const dualBillingMigration = fs.readFileSync(path.join(migrationDirectory, "044_dual_billing_products.sql"), "utf8");
if (!dualBillingMigration.includes("point_package_refunds")
  || !dualBillingMigration.includes("product_order_type")
  || !dualBillingMigration.includes("payment_reconciliation_state")) {
  report("FAIL", "迁移 044", "缺少双体系商品、订单补偿或积分批次归属字段");
} else {
  report("PASS", "迁移 044", "包含永久积分包、支付补偿与积分批次归属");
}

const creativeLlmMigration = fs.readFileSync(path.join(migrationDirectory, "047_creative_llm_and_prompt_optimizer.sql"), "utf8");
if (!creativeLlmMigration.includes("gpt-5.6-sol")
  || !creativeLlmMigration.includes("generation_prompt_optimizer")
  || !creativeLlmMigration.includes("reasoning_effort")) {
  report("FAIL", "迁移 047", "缺少 Creative LLM 路由、提示词优化或思考强度配置");
} else {
  report("PASS", "迁移 047", "包含 gpt-5.6-sol 路由与提示词优化计费");
}

for (const [filename, requiredText] of [
  ["048_canvas_agent_runtime.sql", ["canvas_agent_runs", "canvas_agent_events", "waiting_approval"]],
  ["049_canvas_workflows_v2.sql", ["canvas_workflows", "canvas_revisions", "workflow_loop_iterations"]],
  ["050_template_fuzzy_search.sql", ["pg_trgm", "gin_trgm_ops"]],
  ["051_workflow_media_polling.sql", ["persistent_jobs_max_attempts_check", "BETWEEN 1 AND 1000", "workflow.node"]],
  ["052_persistent_job_json_objects.sql", ["persistent_jobs_payload_object_check", "persistent_jobs_input_refs_array_check", "persistent_jobs_metadata_object_check"]],
  ["053_agent_conversation_soft_delete.sql", ["deleted_at", "idx_agent_conversations_active_history"]],
  ["054_global_agent_preferences.sql", ["global_agent_preferences", "access_mode", "preferences"]],
  ["055_agent_text_model_provider_ranai.sql", ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.4-mini", "step-3.7-flash", "minimax-m3", "model_routes", "generation_charge_rules"]],
  ["056_invitation_system.sql", ["invitation_settings", "invitation_codes", "invitation_redemptions", "invitation_redemptions_invitee_unique"]],
  ["057_generation_pricing_modes.sql", ["generation_mode", "freeform", "template", "generation_charge_rules"]],
  ["058_identity_provider_links.sql", ["identity_links", "idx_identity_links_external", "stardraw_user_id"]],
  ["059_image_quality_pricing.sql", ["image_quality_prices", "image_quality", "059_image_quality_pricing", "Image quality pricing rules are incomplete"]],
  ["060_logto_profile_attributes.sql", ["identity_links", "username", "phone_number", "full_name", "gender", "birthdate"]],
  ["061_announcement_system.sql", ["CREATE TABLE IF NOT EXISTS announcements", "announcements_status_check", "idx_announcements_published"]],
  ["062_agent_token_usage_pricing.sql", ["metered_agent_operations", "usage_snapshot", "pricing_snapshot", "Agent token pricing rules are incomplete"]],
]) {
  const source = fs.readFileSync(path.join(migrationDirectory, filename), "utf8");
  if (requiredText.some((text) => !source.includes(text))) report("FAIL", `迁移 ${filename.slice(0, 3)}`, `缺少 ${requiredText.join("、")}`);
  else report("PASS", `迁移 ${filename.slice(0, 3)}`, "包含 Canvas Agent、工作流或持久队列所需结构");
}

if (isTrue("IDENTITY_LINKS_ENABLED") && Number(valueOf("REQUIRED_MIGRATION_VERSION") || 0) < 58) {
  report("FAIL", "IDENTITY_LINKS_ENABLED", "启用身份映射前 REQUIRED_MIGRATION_VERSION 必须至少为 58");
}

const serverEnvStat = fs.statSync(envPath);
if ((serverEnvStat.mode & 0o007) !== 0 || (serverEnvStat.mode & 0o020) !== 0) {
  report("FAIL", "server/.env 权限", "禁止其他用户读取，且不应允许组写入");
} else {
  report("PASS", "server/.env 权限", "其他用户不可读");
}

if (isTrue("JOB_WORKER_ENABLED")) report("WARN", "JOB_WORKER_ENABLED", "API 配置不应在主进程内运行 Worker");
else report("PASS", "JOB_WORKER_ENABLED", "API 默认关闭，Worker 应使用 worker profile 单独启动");

console.log(`发布前检查结束：${failures} 个失败，${warnings} 个警告。未连接数据库、未调用外部 Provider、未修改线上服务。`);
process.exitCode = failures > 0 ? 1 : 0;
