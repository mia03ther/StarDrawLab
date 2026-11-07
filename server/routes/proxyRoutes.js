import express from "express";
import { Readable } from "stream";
import { getObjectStorage } from "../services/objectStorageComposition.js";
import logger from "../configs/logger.js";
import { requireAuth } from "../middlewares/auth.js";
import { mediaProxyReadLimiter } from "../middlewares/rateLimiter.js";
import {
  authorizeResourceAccess,
  buildGrantedProxyUrl,
  normalizeObjectKey,
  verifyResourceGrant,
} from "../services/resourceAccessService.js";

const proxyRouter = express.Router();
const objectStorage = getObjectStorage();
const authenticate = requireAuth();
const VIDEO_SNAPSHOT_PROCESS = /^video\/snapshot,t_\d{1,10},f_(?:jpg|png)(?:,w_(?:[1-9]\d{0,3}|4096))?(?:,h_(?:[1-9]\d{0,3}|4096))?(?:,m_fast)?$/;

const authenticateRequest = (req) => new Promise((resolve) => {
  let statusCode = 401;
  const authResponse = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      resolve({ ok: false, status: statusCode, body });
      return this;
    },
  };

  Promise.resolve(authenticate(req, authResponse, () => resolve({ ok: true })))
    .catch((error) => resolve({
      ok: false,
      status: error?.status || 401,
      body: { success: false, message: "Authentication failed" },
    }));
});

const parseOssProcess = (value) => {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !VIDEO_SNAPSHOT_PROCESS.test(value)) {
    throw Object.assign(new Error("Unsupported OSS processing operation"), { status: 400 });
  }
  return value;
};

const denyUnknownResource = (res) => res.status(404).json({
  success: false,
  code: "RESOURCE_NOT_FOUND",
  message: "Resource not found",
});

// POST /api/proxy/oss/grant
// Exchanges an authenticated, owner-authorized request for a short-lived URL
// that remains usable by browser media elements which cannot attach Bearer headers.
proxyRouter.post("/oss/grant", async (req, res) => {
  try {
    const authResult = await authenticateRequest(req);
    if (!authResult.ok) return res.status(authResult.status).json(authResult.body);

    const objectKey = normalizeObjectKey(req.body?.object_key);
    const processValue = parseOssProcess(req.body?.["x-oss-process"]);
    const access = await authorizeResourceAccess({ objectKey, userId: req.auth.userId, role: req.auth.role });
    if (!access.allowed || access.visibility === "public") {
      // Public community assets and template previews do not need bearer URLs.
      if (access.allowed) {
        const suffix = processValue ? `?x-oss-process=${encodeURIComponent(processValue)}` : "";
        return res.json({ success: true, data: { url: `/oss-proxy/${objectKey}${suffix}`, expires_in_seconds: null } });
      }
      return denyUnknownResource(res);
    }

    const url = buildGrantedProxyUrl({
      objectKey,
      userId: access.visibility === "moderation" ? access.ownerUserId : req.auth.userId,
      ttlSeconds: 300,
      process: processValue,
    });
    res.set("Cache-Control", "no-store");
    return res.json({ success: true, data: { url, expires_in_seconds: 300 } });
  } catch (err) {
    const status = err.status || 500;
    logger.warn("oss.grant.error", { status, error: err.message, userId: req.auth?.userId || null });
    return res.status(status).json({
      success: false,
      message: status >= 500 ? "Failed to create resource access grant" : err.message,
    });
  }
});

// GET /api/proxy/oss/:objectKey(*) - 代理 OSS 对象下载
// 例：GET /api/proxy/oss/quickai%2FuserId%2Fimage_123.jpg
proxyRouter.get(/^\/oss\/(.+)/, mediaProxyReadLimiter, async (req, res) => {
  try {
    const objectKey = normalizeObjectKey(req.params[0]);
    const processValue = parseOssProcess(req.query["x-oss-process"]);
    const publicAccess = await authorizeResourceAccess({ objectKey });
    let access = publicAccess;

    if (!publicAccess.allowed) {
      let grant = null;
      const grantToken = typeof req.query.resource_token === "string" ? req.query.resource_token : "";
      if (grantToken) {
        grant = verifyResourceGrant({ token: grantToken, objectKey });
      }

      let userId = grant?.userId || null;
      if (!userId && req.headers.authorization) {
        const authResult = await authenticateRequest(req);
        if (!authResult.ok) return res.status(authResult.status).json(authResult.body);
        userId = req.auth.userId;
      }

      if (!userId) {
        return res.status(401).json({
          success: false,
          code: grantToken ? "RESOURCE_TOKEN_INVALID" : "AUTHENTICATION_REQUIRED",
          message: grantToken ? "Resource access token is invalid or expired" : "Authentication required",
        });
      }

      access = await authorizeResourceAccess({ objectKey, userId, role: req.auth?.role || "user" });
      if (!access.allowed || !["private", "moderation"].includes(access.visibility)) return denyUnknownResource(res);
    }

    // 生成签名 URL（内部使用），处理视频快照等 x-oss-process 参数。
    const signedUrl = objectStorage.getSignedDownloadUrl(objectKey, 60, processValue);

    const upstreamHeaders = {};
    if (req.headers.range) {
      upstreamHeaders.Range = req.headers.range;
    }

    // 从 OSS 下载并转发，支持视频 Range 请求
    const response = await fetch(signedUrl, {
      headers: upstreamHeaders,
    });
    if (!response.ok) {
      if (response.status === 403 || response.status === 404) return denyUnknownResource(res);
      return res.status(502).json({ error: "Failed to fetch object" });
    }

    const contentType = response.headers.get("content-type") || "application/octet-stream";
    const contentLength = response.headers.get("content-length");
    const contentRange = response.headers.get("content-range");
    const acceptRanges = response.headers.get("accept-ranges");

    res.status(response.status);
    res.set({
      "Content-Type": contentType,
      "Cache-Control": access.visibility === "public" ? "public, max-age=300" : "private, no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Vary": "Authorization",
    });

    if (contentLength) {
      res.set("Content-Length", contentLength);
    }
    if (contentRange) {
      res.set("Content-Range", contentRange);
    }
    if (acceptRanges) {
      res.set("Accept-Ranges", acceptRanges);
    }

    if (!response.body) {
      const buffer = await response.arrayBuffer();
      return res.send(Buffer.from(buffer));
    }

    const stream = Readable.fromWeb(response.body);
    stream.on("error", (streamErr) => {
      logger.warn("oss.proxy.stream.error", { error: streamErr.message, resourceType: access.resourceType });
      if (!res.headersSent) res.status(502).end();
      else res.destroy(streamErr);
    });
    stream.pipe(res);
  } catch (err) {
    const status = err.status || 500;
    logger.error("oss.proxy.error", { status, error: err.message });
    if (!res.headersSent) {
      res.status(status).json({ error: status >= 500 ? "Failed to fetch object" : err.message });
    }
  }
});

export default proxyRouter;
