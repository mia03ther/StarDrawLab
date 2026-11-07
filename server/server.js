import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import cron from "node-cron";
import "dotenv/config";

import aiRouter from "./routes/aiRoutes.js";
import userRouter from "./routes/userRoutes.js";
import announcementRouter from "./routes/announcementRoutes.js";
import pointsRouter from "./routes/pointsRoutes.js";
import subscriptionRouter, { publicSubscriptionRouter } from "./routes/subscriptionRoutes.js";
import adminRouter from "./routes/adminRoutes.js";
import adminAnnouncementRouter from "./routes/adminAnnouncementRoutes.js";
import adminSubscriptionRouter from "./routes/adminSubscriptionRoutes.js";
import templateStudioRouter from "./routes/templateStudioRoutes.js";
import digitalHumanRoleRouter, { publicDigitalHumanRoleRouter } from "./routes/digitalHumanRoleRoutes.js";
import proxyRouter from "./routes/proxyRoutes.js";
import canvasRouter from "./routes/canvasRoutes.js";
import agentRouter from "./routes/agentRoutes.js";
import workflowRouter from "./routes/workflowRoutes.js";
import canvasAgentRouter from "./modules/canvas-agent/routes.js";
import taskCenterRouter from "./routes/taskCenterRoutes.js";
import {
  adminMcpRouter,
  mcpRouter,
  publicMcpOAuthRouter,
  rootMcpRouter,
} from "./routes/mcpRoutes.js";
import { adminAccessRouter, authAccessRouter, rootAccessRouter } from "./routes/accessControlRoutes.js";
import {
  adminContentRecycleRouter,
  rootContentRecycleRouter,
  userContentRecycleRouter,
} from "./routes/contentRecycleRoutes.js";
import rootModelConfigurationRouter from "./routes/modelConfigurationRoutes.js";
import privateContentReviewRouter from "./routes/privateContentReviewRoutes.js";
import rootUserOperationsRouter from "./routes/rootUserOperationsRoutes.js";
import rootExecutionGovernorRouter from "./routes/rootExecutionGovernorRoutes.js";
import { adminVisualParameterRouter, publicVisualParameterRouter } from "./routes/visualParameterRoutes.js";
import { assertAuthConfiguration, requireAuth } from "./middlewares/auth.js";
import { requireAdmin } from "./middlewares/requireAdmin.js";
import { requireRoot } from "./middlewares/authorize.js";
import { createCsrfProtection } from "./middlewares/csrfProtection.js";
import sql from "./configs/db.js";
import logger from "./configs/logger.js";
import { compensationScan } from "./services/membershipService.js";
import { syncVideoCreationStatus } from "./services/videoStatusService.js";
import { processSubscriptionReminders, processSubscriptionRenewals } from "./services/subscriptionService.js";
import {
  expireUserContent,
  purgeExpiredMemberContent,
  retryContentObjectCleanupJobs,
} from "./services/contentRecycleService.js";
import { initializeFixedRootAdministrator } from "./services/accessControlService.js";
import { releasePoints } from "./services/pointsService.js";
import { processCreationSettlementNotifications } from "./services/creationSettlementNotification.js";
import { resolveTrustProxyHops } from "./configs/httpSecurity.js";
import { globalApiLimiter } from "./middlewares/rateLimiter.js";
import { purgeStaleTemporaryUploads } from "./infrastructure/safeMultipartUpload.js";
import { communityRouter, publicCommunityRouter, adminCommunityRouter } from "./routes/communityRoutes.js";
import adminAgentSkillRouter from "./routes/adminAgentSkillRoutes.js";
import { checkDatabaseReadiness } from "./services/readinessService.js";
import invitationRouter from "./routes/invitationRoutes.js";
import adminInvitationRouter from "./routes/adminInvitationRoutes.js";

const app = express();

// ── 反向代理信任 ─────────────────────────────
// Docker behind nginx: trust 2 levels of proxy
app.set("trust proxy", resolveTrustProxyHops());

// ── 安全头 ───────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https:"],
      imgSrc: ["'self'", "data:", "http:", "https:"],
      fontSrc: ["'self'", "https:", "data:"],
      connectSrc: ["'self'", "https:", "http:"],
      mediaSrc: ["'self'", "http:", "https:"],
      objectSrc: ["'none'"],
      frameSrc: ["'self'"],
      upgradeInsecureRequests: null,
    },
  },
  crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
  crossOriginResourcePolicy: { policy: "cross-origin" },
}));

// ── CORS 白名单 ──────────────────────────────────
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "http://localhost:5173")
  .split(",").map((o) => o.trim());

app.use(cors({
  origin: (origin, callback) => {
    if (!origin && process.env.NODE_ENV !== "production") return callback(null, true);
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
}));

// Bearer-authenticated browser mutations must originate from the configured
// frontend. Public provider callbacks do not carry Authorization and continue
// to rely on OAuth state or payment signatures.
app.use("/api", createCsrfProtection({ allowedOrigins }));

// ── HTTP 访问日志 ─────────────────────────────────
app.use(morgan("combined", {
  stream: { write: (msg) => logger.http(msg.trim()) },
  // Short-lived OSS grants are bearer credentials carried in the query string.
  // Never copy them into application access logs.
  skip: (req) => req.path.startsWith("/api/proxy/oss/")
    && typeof req.query?.resource_token === "string",
}));

app.use(express.json({ limit: "2mb" }));

// ── 全局限流 ─────────────────────────────────────
// Health probes and media reads have dedicated handling in the limiter module.
app.use(globalApiLimiter);

// ── 健康检查 ─────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "ok", service: "StarDraw API" }));
app.get("/health", (req, res) => res.json({
  status: "ok",
  uptime: process.uptime(),
  release: process.env.RELEASE_VERSION || "development",
}));
app.get("/ready", async (req, res) => {
  try {
    const database = await checkDatabaseReadiness({ sqlClient: sql });
    res.set("Cache-Control", "no-store");
    return res.json({
      status: "ready",
      release: process.env.RELEASE_VERSION || "development",
      database: {
        status: "ready",
        migration: database.migration,
      },
    });
  } catch (error) {
    logger.warn("readiness.failed", { code: error.code || "DATABASE_NOT_READY" });
    res.set("Cache-Control", "no-store");
    return res.status(503).json({
      status: "not_ready",
      code: error.code || "DATABASE_NOT_READY",
    });
  }
});

// ── OSS 资源代理（公开模板匿名；私有资源必须通过所有权校验或短期授权）
app.use("/api/proxy", proxyRouter);
app.use("/api/public", publicSubscriptionRouter);
app.use("/api/public/mcp", publicMcpOAuthRouter);
app.use("/api/public/community", publicCommunityRouter);

// ── 业务路由（生成接口限流已移至 aiRoutes.js 路由层）────────────────
app.use("/api/ai", requireAuth(), aiRouter);
app.use("/api/auth", requireAuth(), authAccessRouter);
app.use("/api/user", requireAuth(), userRouter);
app.use("/api/points", requireAuth(), pointsRouter);
app.use("/api/subscriptions", requireAuth(), subscriptionRouter);
app.use("/api/template-studio", requireAuth(), templateStudioRouter);
app.use("/api/digital-human", requireAuth(), digitalHumanRoleRouter);
app.use("/api/public", publicDigitalHumanRoleRouter);
app.use("/api/visual-parameters", requireAuth(), publicVisualParameterRouter);
app.use("/api/canvases", requireAuth(), canvasRouter);
app.use("/api/agent", requireAuth(), agentRouter);
app.use("/api/workflows", requireAuth(), workflowRouter);
app.use("/api/canvas-agent", requireAuth(), canvasAgentRouter);
app.use("/api/tasks", requireAuth(), taskCenterRouter);
app.use("/api/mcp", requireAuth(), mcpRouter);
app.use("/api/content", requireAuth(), userContentRecycleRouter);
app.use("/api/community", requireAuth(), communityRouter);
app.use("/api/invitations", requireAuth(), invitationRouter);
app.use("/api/announcements", requireAuth(), announcementRouter);
const adminApiRouter = express.Router();
// Privileged access requires a valid configured identity-provider login plus database-backed RBAC.
// MFA is intentionally not a prerequisite because the Authing plan in use does
// not provide it; dangerous mutations retain their own reason/confirmation,
// idempotency and audit checks.
adminApiRouter.use(requireAuth(), requireAdmin());
adminApiRouter.use("/subscriptions", adminSubscriptionRouter);
adminApiRouter.use("/content", adminContentRecycleRouter);
adminApiRouter.use("/community", adminCommunityRouter);
adminApiRouter.use("/mcp", adminMcpRouter);
adminApiRouter.use("/visual-parameters", adminVisualParameterRouter);
adminApiRouter.use("/agent-skills", adminAgentSkillRouter);
adminApiRouter.use("/invitations", adminInvitationRouter);
adminApiRouter.use("/announcements", adminAnnouncementRouter);
adminApiRouter.use(adminAccessRouter);
adminApiRouter.use(adminRouter);
app.use("/api/admin", adminApiRouter);

const rootApiRouter = express.Router();
rootApiRouter.use(requireAuth(), requireRoot());
rootApiRouter.use("/content", rootContentRecycleRouter);
rootApiRouter.use("/mcp", rootMcpRouter);
rootApiRouter.use(rootModelConfigurationRouter);
rootApiRouter.use(privateContentReviewRouter);
rootApiRouter.use(rootUserOperationsRouter);
rootApiRouter.use(rootExecutionGovernorRouter);
rootApiRouter.use(rootAccessRouter);
app.use("/api/root", rootApiRouter);

// ── 全局错误处理 ─────────────────────────────────
app.use((err, req, res, _next) => {
  const databaseConflict = err.code === "23505";
  const status = Number(err.status) || (databaseConflict ? 409 : 500);
  logger[status >= 500 ? "error" : "warn"]("unhandledError", {
    method: req.method,
    path: req.path,
    code: err.code,
    message: err.message,
  });

  const multerCodeMessages = {
    LIMIT_FILE_SIZE: "Uploaded file is too large. Limits are 10 MiB for references, 12 MiB for preview images, 50 MiB for audio, and 200 MiB for video.",
    LIMIT_FILE_COUNT: "Too many files uploaded. Max 4 reference images or 1 template preview asset.",
    LIMIT_UNEXPECTED_FILE: "Unexpected upload field. Use images for references or preview for template preview uploads.",
  };

  if (err.code && multerCodeMessages[err.code]) {
    return res.status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({
      success: false,
      message: multerCodeMessages[err.code],
    });
  }

  res.status(status).json({
    success: false,
    code: databaseConflict
      ? "RESOURCE_CONFLICT"
      : err.code || (status >= 500 ? "INTERNAL_SERVER_ERROR" : "REQUEST_FAILED"),
    message: databaseConflict
      ? "A resource with the same identifier already exists"
      : process.env.NODE_ENV === "production" && status >= 500
        ? "Internal server error"
        : err.message,
  });
});

// ═══════════════════════════════════════════════
// 定时任务
// ═══════════════════════════════════════════════

// 1. 生成内容到期后统一进入内容生命周期服务（每天凌晨 3:00）。
cron.schedule("0 3 * * *", async () => {
  logger.info("cron.cleanup.start");
  try {
    const expired = await sql`
      SELECT id, user_id
      FROM creations WHERE expires_at < NOW() LIMIT 200
    `;

    let deleted = 0;
    for (const row of expired) {
      try {
        await expireUserContent({ userId: row.user_id, resourceType: "creation", resourceId: row.id });
        deleted++;
      } catch (itemErr) {
        logger.error("cron.cleanup.item.error", { id: row.id, error: itemErr.message });
      }
    }

    logger.info("cron.cleanup.done", { scanned: expired.length, deleted });
  } catch (err) {
    logger.error("cron.cleanup.error", { error: err.message });
  }
});

// 1.5. 重试事务后 OSS 清理任务（每 15 分钟）。
cron.schedule("*/15 * * * *", async () => {
  try {
    const result = await retryContentObjectCleanupJobs();
    if (result.claimed > 0) logger.info("cron.contentObjectCleanup.done", result);
  } catch (err) {
    logger.error("cron.contentObjectCleanup.error", { error: err.message });
  }
});

// 2. 视频任务超时补偿（每 30 分钟）
cron.schedule("*/30 * * * *", async () => {
  try {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const stuckTasks = await sql`
      SELECT id, user_id, points_reserved, scene_name
      FROM creations
      WHERE type = 'video' AND status IN ('pending', 'running')
        AND created_at < ${twoHoursAgo}
    `;

    for (const task of stuckTasks) {
      try {
        const released = await sql.begin(async (tx) => {
          const [locked] = await tx`
            SELECT id, user_id, points_reserved, charge_status, status
            FROM creations
            WHERE id = ${task.id}
            FOR UPDATE
          `;
          if (!locked || locked.charge_status !== "reserved"
              || !["pending", "running"].includes(locked.status)) return false;
          await releasePoints({
            userId: locked.user_id,
            amount: Number(locked.points_reserved || 0),
            creationId: locked.id,
            idempotencyKey: `release:creation:${locked.id}`,
            note: "返还：视频任务超时",
            tx,
          });
          const [updated] = await tx`
            UPDATE creations
            SET status = 'failed', charge_status = 'released',
                points_reserved = 0, error_message = 'Task timed out after 2 hours'
            WHERE id = ${locked.id} AND charge_status = 'reserved'
            RETURNING id
          `;
          if (!updated) throw new Error("Video timeout release state changed unexpectedly");
          return true;
        });
        if (released) logger.info("cron.videoTimeout.released", { creationId: task.id });
      } catch (err) {
        logger.error("cron.videoTimeout.error", { id: task.id, error: err.message });
      }
    }
  } catch (err) {
    logger.error("cron.videoTimeout.scan.error", { error: err.message });
  }
});

// 2.5. 视频状态后台同步（每 5 分钟）
cron.schedule("*/5 * * * *", async () => {
  try {
    const candidates = await sql`
      SELECT id, user_id, scene_name, type, status, provider_status, task_id,
             charge_status, content, content_object_key,
             thumbnail_url, thumbnail_object_key,
             points_reserved, points_cost, expires_at
      FROM creations
      WHERE type = 'video'
        AND task_id IS NOT NULL
        AND (
          status IN ('pending', 'running')
          OR (
            status = 'completed'
            AND (
              charge_status <> 'charged'
              OR points_reserved > 0
              OR content_object_key IS NULL
              OR thumbnail_url IS NULL
              OR content NOT LIKE '/oss-proxy/%'
            )
          )
        )
      ORDER BY created_at DESC
      LIMIT 50
    `;

    let synced = 0;
    for (const creation of candidates) {
      try {
        const result = await syncVideoCreationStatus(creation);
        if (result.success && result.creation.status !== creation.status) {
          synced++;
        }
      } catch (itemErr) {
        logger.error("cron.videoSync.item.error", {
          creationId: creation.id,
          error: itemErr.message,
        });
      }
    }

    logger.info("cron.videoSync.done", { scanned: candidates.length, synced });
  } catch (err) {
    logger.error("cron.videoSync.error", { error: err.message });
  }
});

// Direct image/video/digital-human generations do not pass through the
// durable workflow queue, so scan their terminal creation states separately.
// Keep this disabled until migration 034 is applied on the target database.
if (process.env.CREATION_NOTIFICATION_ENABLED === "true") {
  cron.schedule("*/5 * * * *", async () => {
    try {
      const result = await processCreationSettlementNotifications({
        retryAfterMs: Number(process.env.CREATION_NOTIFICATION_RETRY_MS || 300_000),
        limit: Number(process.env.CREATION_NOTIFICATION_BATCH_LIMIT || 100),
      });
      if (result.claimed > 0) logger.info("creation.notification.done", result);
    } catch (error) {
      logger.error("creation.notification.error", { error: error.message });
    }
  });
}

// 3. 会员月赠补偿扫描（每天凌晨 1:00）
cron.schedule("0 1 * * *", async () => {
  logger.info("cron.membershipBonus.start");
  await compensationScan();
});

// 4. 到期前两天主动续费邮件提醒（每小时扫描，幂等由 last_reminder_at 保护）
cron.schedule("0 * * * *", async () => {
  try {
    const result = await processSubscriptionReminders();
    logger.info("cron.subscriptionReminder.done", result);
  } catch (err) {
    logger.error("cron.subscriptionReminder.error", { error: err.message });
  }
});

// 5. 到期订阅续订/到期降级（每 10 分钟）。只有已签署支付宝周期扣款协议
// 的订阅才会发起自动扣款；其余订阅安全到期，不会被模拟扣款。
cron.schedule("*/10 * * * *", async () => {
  try {
    const result = await processSubscriptionRenewals();
    logger.info("cron.subscriptionRenewal.done", result);
  } catch (err) {
    logger.error("cron.subscriptionRenewal.error", { error: err.message });
  }
});

// 6. 会员内容回收站到期清理（每小时）。管理员删除的内容只能由 root 永久删除。
cron.schedule("17 * * * *", async () => {
  try {
    const result = await purgeExpiredMemberContent();
    logger.info("cron.contentRecycle.done", result);
  } catch (err) {
    logger.error("cron.contentRecycle.error", { error: err.message });
  }
});

// ── 启动 ─────────────────────────────────────────
const PORT = process.env.PORT || 5000;
let httpServer = null;
let shuttingDown = false;

const bootstrap = async () => {
  assertAuthConfiguration();
  await purgeStaleTemporaryUploads({
    maxAgeMs: Number(process.env.UPLOAD_TEMP_MAX_AGE_MS || 24 * 60 * 60 * 1000),
  }).catch((error) => {
    logger.warn("upload.temp_cleanup.failed", { error: error.message });
  });
  await initializeFixedRootAdministrator();

  httpServer = app.listen(PORT, process.env.HOST || undefined, () => {
    logger.info("StarDraw server started", {
      port: PORT,
      env: process.env.NODE_ENV || "development",
      release: process.env.RELEASE_VERSION || "development",
    });
  });
};

const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("server.stopping", { signal });
  const forceTimer = setTimeout(() => process.exit(1), 25_000);
  forceTimer.unref();
  if (httpServer) {
    await new Promise((resolve) => httpServer.close(resolve));
  }
  await sql.end({ timeout: 5 }).catch((error) => {
    logger.warn("server.database_close_failed", { error: error.message });
  });
  clearTimeout(forceTimer);
  process.exit(0);
};

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

bootstrap().catch((err) => {
  logger.error("bootstrap.error", { error: err.message });
  process.exit(1);
});
