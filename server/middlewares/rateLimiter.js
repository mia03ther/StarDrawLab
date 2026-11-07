import rateLimit from "express-rate-limit";

// These limiters are mounted after requireAuth(), so rate limits follow the
// verified account instead of a shared office/mobile IP address.
const authenticatedUserKey = (req) => String(req.auth?.userId || "unauthenticated");
const readPositiveInt = (name, fallback, { min = 1, max = 1_000_000 } = {}) => {
  const parsed = Number(process.env[name]);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
};

// Generation, Agent, workflow, and approval traffic use the same configurable
// 5000-request ceiling. Durable idempotency and provider retry/backoff remain
// responsible for duplicate work and upstream throttling.
const OPERATION_RATE_LIMIT = readPositiveInt("OPERATION_RATE_LIMIT_MAX", 5000);
const GLOBAL_RATE_LIMIT = readPositiveInt("HTTP_GLOBAL_RATE_LIMIT_MAX", 5000);
const BURST_WINDOW_MS = 10 * 1000;

const createBurstLimiter = ({ envName, fallback, message }) => rateLimit({
  windowMs: BURST_WINDOW_MS,
  max: readPositiveInt(envName, fallback, { max: 100_000 }),
  keyGenerator: authenticatedUserKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, code: "RATE_LIMITED", message },
});

const skipGlobalLimiter = (req) => {
  const path = String(req.path || "").split("?", 1)[0];
  return ["", "/", "/health", "/ready"].includes(path)
    || (req.method === "GET" || req.method === "HEAD") && path.startsWith("/api/proxy/oss/");
};

export const globalApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: GLOBAL_RATE_LIMIT,
  skip: skipGlobalLimiter,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, code: "RATE_LIMITED", message: "Too many requests." },
});

export const generateBurstLimiter = createBurstLimiter({
  envName: "GENERATION_BURST_LIMIT_MAX",
  fallback: 5000,
  message: "Generation request burst limit exceeded. Please wait a moment.",
});

export const agentBurstLimiter = createBurstLimiter({
  envName: "AGENT_BURST_LIMIT_MAX",
  fallback: 5000,
  message: "Agent request burst limit exceeded. Please wait a moment.",
});

export const workflowBurstLimiter = createBurstLimiter({
  envName: "WORKFLOW_BURST_LIMIT_MAX",
  fallback: 5000,
  message: "Workflow request burst limit exceeded. Please wait a moment.",
});

export const agentApprovalBurstLimiter = createBurstLimiter({
  envName: "AGENT_APPROVAL_BURST_LIMIT_MAX",
  fallback: 5000,
  message: "Approval request burst limit exceeded. Please wait a moment.",
});

/**
 * 生成接口专项限流：每分钟最多 5000 次
 * 在路由层直接挂载，保证执行顺序正确（Bug 3 修复）
 */
export const generateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: OPERATION_RATE_LIMIT,
  keyGenerator: authenticatedUserKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, code: "RATE_LIMITED", message: "Max 5000 generation requests per minute." },
});

export const agentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: OPERATION_RATE_LIMIT,
  keyGenerator: authenticatedUserKey,
  // Once migration 029 is enabled, the PostgreSQL governor is the shared
  // source of truth across API instances. Keep this process-local limiter as
  // a pre-migration fallback only, otherwise limits would be applied twice.
  skip: () => process.env.EXECUTION_GOVERNOR_ENABLED === "true",
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, code: "RATE_LIMITED", message: "Max 5000 Agent planning requests per minute." },
});

export const workflowLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: OPERATION_RATE_LIMIT,
  keyGenerator: authenticatedUserKey,
  skip: () => process.env.EXECUTION_GOVERNOR_ENABLED === "true",
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, code: "RATE_LIMITED", message: "Max 5000 workflow starts per minute." },
});

export const agentApprovalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: OPERATION_RATE_LIMIT,
  keyGenerator: authenticatedUserKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, code: "RATE_LIMITED", message: "Max 5000 Agent approval requests per minute." },
});

export const communityReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: readPositiveInt("COMMUNITY_READ_RATE_LIMIT_MAX", 180),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, code: "RATE_LIMITED", message: "Community browsing rate limit exceeded." },
});

export const communityWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: OPERATION_RATE_LIMIT,
  keyGenerator: authenticatedUserKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, code: "RATE_LIMITED", message: "Community action rate limit exceeded." },
});

export const mediaProxyReadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: readPositiveInt("MEDIA_PROXY_RATE_LIMIT_MAX", 3000),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, code: "RATE_LIMITED", message: "Media preview rate limit exceeded." },
});
