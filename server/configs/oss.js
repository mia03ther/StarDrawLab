/**
 * 阿里云 OSS 配置与工具函数
 * 替代原 Cloudinary 方案
 *
 * 环境变量：
 *   OSS_REGION            e.g. oss-cn-hangzhou
 *   OSS_ENDPOINT          e.g. oss-cn-hangzhou.aliyuncs.com （或 VPC 内网端点）
 *   OSS_BUCKET            bucket 名称
 *   OSS_ACCESS_KEY_ID     阿里云 AccessKey ID
 *   OSS_ACCESS_KEY_SECRET 阿里云 AccessKey Secret
 *   OSS_BASE_URL          可选，CDN 或公网访问域名，如 https://cdn.example.com
 */
import OSS from "ali-oss";
import axios from "axios";
import { randomUUID } from "crypto";
import logger from "./logger.js";
import { fetchRemoteAssetStream } from "../infrastructure/secureRemoteAssetFetch.js";

let client;

export const getOSSClient = () => {
  if (!client) {
    client = new OSS({
      region:          process.env.OSS_REGION          || "oss-cn-hangzhou",

      endpoint:        process.env.OSS_ENDPOINT        || undefined,
      bucket:          process.env.OSS_BUCKET          || "quickai",
      accessKeyId:     process.env.OSS_ACCESS_KEY_ID,
      accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
      timeout:         60_000,
    });
  }
  return client;
};

/**
 * 从远程 URL 下载后上传到 OSS
 * @param {string} remoteUrl   Provider 返回的临时 URL
 * @param {string} objectKey   OSS 存储路径，如 quickai/userId/image_123.jpg
 * @param {string} contentType MIME type
 * @returns {{ objectKey, url }}  objectKey 用于存库；url 用于展示（CDN/公网）
 */
export const uploadFromUrl = async (remoteUrl, objectKey, contentType = "image/jpeg") => {
  const oss = getOSSClient();
  const remoteHost = (() => {
    try {
      return new URL(remoteUrl).host;
    } catch {
      return null;
    }
  })();
  let fetched;

  try {
    fetched = await fetchRemoteAssetStream({ remoteUrl, httpClient: axios });
  } catch (err) {
    logger.warn("oss.uploadFromUrl.fetch.failed", {
      objectKey,
      remoteHost,
      code: err.code,
      status: err.response?.status,
      message: err.message,
    });
    throw new Error(`Failed to fetch remote asset from ${remoteHost || "upstream"}: ${err.code || err.message}`);
  }

  const contentLength = fetched.contentLength;
  const stream = fetched.stream;

  try {
    await oss.putStream(objectKey, stream, {
      timeout: 300_000,
      contentLength: contentLength || undefined,
      mime: contentType,
      headers: { "Content-Type": contentType },
    });
  } catch (err) {
    if (stream && typeof stream.destroy === "function") {
      stream.destroy(err);
    }
    logger.warn("oss.uploadFromUrl.put.failed", {
      objectKey,
      remoteHost,
      code: err.code,
      message: err.message,
    });
    throw err;
  }

  const url = `/oss-proxy/${objectKey}`;
  logger.info("oss.upload.success", {
    objectKey,
    size: contentLength,
    sourceHost: fetched.sourceHost || remoteHost,
    url,
  });

  return { objectKey, url };
};

/**
 * 直接上传内存中的二进制内容到 OSS
 * @param {Buffer} buffer
 * @param {string} objectKey
 * @param {string} contentType
 * @returns {{ objectKey, url }}
 */
export const uploadBuffer = async (buffer, objectKey, contentType = "image/png") => {
  const oss = getOSSClient();

  await oss.put(objectKey, buffer, {
    headers: { "Content-Type": contentType },
  });

  const url = `/oss-proxy/${objectKey}`;
  logger.info("oss.uploadBuffer.success", { objectKey, size: buffer.length, url });

  return { objectKey, url };
};

/** Read object metadata without buffering potentially large videos in memory. */
export const getObjectMetadata = async (objectKey) => {
  const normalized = String(objectKey || "").trim();
  if (!normalized || normalized.startsWith("/") || normalized.includes("\\") || /(^|\/)\.\.?($|\/)/.test(normalized)) {
    throw new Error("Invalid OSS object key");
  }
  try {
    const result = await getOSSClient().head(normalized);
    const headers = result?.res?.headers || {};
    const rawSize = headers["content-length"];
    const sizeBytes = rawSize == null || String(rawSize).trim() === "" ? null : Number(rawSize);
    return {
      exists: true,
      sizeBytes: Number.isSafeInteger(sizeBytes) && sizeBytes >= 0 ? sizeBytes : null,
      contentType: String(headers["content-type"] || "application/octet-stream"),
    };
  } catch (error) {
    if (Number(error?.status || error?.res?.status) === 404 || error?.code === "NoSuchKey") {
      return { exists: false, sizeBytes: null, contentType: null };
    }
    // Permission errors and temporary outages must not look like missing files.
    throw error;
  }
};

/** Read an application-owned object for server-side workflow composition. */
export const downloadBuffer = async (objectKey) => {
  const normalized = String(objectKey || "").trim();
  if (!normalized || normalized.startsWith("/") || normalized.includes("\\") || /(^|\/)\.\.?($|\/)/.test(normalized)) {
    throw new Error("Invalid OSS object key");
  }
  const result = await getOSSClient().get(normalized);
  const content = Buffer.isBuffer(result?.content) ? result.content : Buffer.from(result?.content || "");
  if (!content.length) throw new Error("OSS object is empty");
  return {
    buffer: content,
    contentType: String(result?.res?.headers?.["content-type"] || "application/octet-stream"),
  };
};

/**
 * 生成 OSS 短时效签名下载 URL（默认 5 分钟）
 * @param {string} objectKey
 * @param {number} expiresSeconds
 */
export const getSignedDownloadUrl = (objectKey, expiresSeconds = 300, process = null) => {
  const oss = getOSSClient();
  const url = oss.signatureUrl(objectKey, {
    expires: expiresSeconds,
    ...(process ? { process } : {}),
  });
  return url;
};

/**
 * 删除 OSS 对象（清理任务用）
 * @param {string} objectKey
 */
export const deleteObject = async (objectKey) => {
  if (!objectKey) return;
  try {
    const oss = getOSSClient();
    await oss.delete(objectKey);
    logger.info("oss.delete.success", { objectKey });
  } catch (err) {
    logger.warn("oss.delete.failed", { objectKey, error: err.message });
  }
};

/**
 * 批量删除 OSS 对象
 * @param {string[]} objectKeys
 */
export const deleteObjects = async (objectKeys) => {
  const validKeys = objectKeys.filter(Boolean);
  if (validKeys.length === 0) return;
  try {
    const oss = getOSSClient();
    await oss.deleteMulti(validKeys, { quiet: true });
    logger.info("oss.deleteMulti.success", { count: validKeys.length });
  } catch (err) {
    logger.warn("oss.deleteMulti.failed", { error: err.message });
  }
};

/**
 * Batch deletion variant for durable cleanup workers. Unlike deleteObjects,
 * this function propagates failures so the caller can keep and retry its job.
 */
export const deleteObjectsStrict = async (objectKeys) => {
  const validKeys = objectKeys.filter(Boolean);
  if (validKeys.length === 0) return;
  const oss = getOSSClient();
  await oss.deleteMulti(validKeys, { quiet: true });
  logger.info("oss.deleteMulti.strict.success", { count: validKeys.length });
};

/**
 * 生成 OSS 对象 Key
 * 格式：quickai/{userId}/{type}_{timestamp}.{ext}
 */
export const buildObjectKey = (userId, type, ext = "jpg") => {
  const nonce = randomUUID().replace(/-/g, "").slice(0, 16);
  return `quickai/${userId}/${type}_${Date.now()}_${nonce}.${ext}`;
};
