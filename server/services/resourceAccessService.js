import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "crypto";
import sql from "../configs/db.js";

const DEFAULT_GRANT_TTL_SECONDS = 300;
const MAX_GRANT_TTL_SECONDS = 900;
const MAX_OBJECT_KEY_LENGTH = 1024;
const TOKEN_VERSION = 1;

const CREATION_META_SINGLE_KEY_FIELDS = [
  "referenceImageObjectKey",
  "reference_image_object_key",
  "previewObjectKey",
  "preview_object_key",
  "previewVideoObjectKey",
  "preview_video_object_key",
];

const CREATION_META_LIST_KEY_FIELDS = [
  "referenceImageObjectKeys",
  "reference_image_object_keys",
  "extraObjectKeys",
  "extra_object_keys",
];

const base64UrlEncode = (value) => Buffer.from(value).toString("base64url");

const getGrantSecret = () => {
  const configuredSecret = String(process.env.RESOURCE_ACCESS_SECRET || "").trim();
  const baseSecret = configuredSecret || String(process.env.OSS_ACCESS_KEY_SECRET || "").trim();
  if (baseSecret.length < 32) {
    throw Object.assign(new Error("Resource access signing secret is not configured"), {
      code: "RESOURCE_ACCESS_SECRET_MISSING",
      status: 503,
    });
  }

  // Domain separation prevents a fallback OSS secret from being used directly as
  // the HMAC key. A dedicated RESOURCE_ACCESS_SECRET is still preferred.
  return createHash("sha256")
    .update("stardraw-resource-access-v1\0")
    .update(baseSecret)
    .digest();
};

const decodePathComponentOnce = (value) => {
  if (!/%[0-9a-f]{2}/i.test(value)) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    throw Object.assign(new Error("Malformed object key encoding"), { status: 400 });
  }
};

export const normalizeObjectKey = (value) => {
  const raw = String(value || "").trim();
  if (/%2f|%5c/i.test(raw)) {
    throw Object.assign(new Error("Invalid object key"), { status: 400 });
  }
  const decoded = decodePathComponentOnce(raw);

  if (!decoded || decoded.length > MAX_OBJECT_KEY_LENGTH) {
    throw Object.assign(new Error("Invalid object key"), { status: 400 });
  }
  if (
    decoded.startsWith("/")
    || decoded.includes("\\")
    || decoded.includes("\0")
    || decoded.includes("?")
    || decoded.includes("#")
    || /(?:^|\/)\.\.?($|\/)/.test(decoded)
    || /%2f|%5c/i.test(decoded)
  ) {
    throw Object.assign(new Error("Invalid object key"), { status: 400 });
  }

  return decoded;
};

const extractObjectKeyFromAssetUrl = (value) => {
  if (typeof value !== "string" || !value.trim()) return null;
  let pathname = value.trim();
  try {
    pathname = new URL(pathname, "https://resource-access.invalid").pathname;
  } catch {
    [pathname] = pathname.split("?");
  }

  const prefixes = ["/oss-proxy/", "/api/proxy/oss/"];
  for (const prefix of prefixes) {
    if (!pathname.startsWith(prefix)) continue;
    try {
      return normalizeObjectKey(pathname.slice(prefix.length));
    } catch {
      return null;
    }
  }

  return null;
};

const assetValueReferencesObjectKey = (value, objectKey) =>
  value === objectKey || extractObjectKeyFromAssetUrl(value) === objectKey;

const templateRowReferencesObjectKey = (row, objectKey) =>
  row?.preview_object_key === objectKey
  || row?.preview_video_object_key === objectKey
  || assetValueReferencesObjectKey(row?.preview_image_url, objectKey)
  || assetValueReferencesObjectKey(row?.preview_video_url, objectKey);

const creationMetaReferencesObjectKey = (metaInfo, objectKey) => {
  const meta = metaInfo && typeof metaInfo === "object" && !Array.isArray(metaInfo)
    ? metaInfo
    : {};

  for (const field of CREATION_META_SINGLE_KEY_FIELDS) {
    if (meta[field] === objectKey) return true;
  }
  for (const field of CREATION_META_LIST_KEY_FIELDS) {
    if (Array.isArray(meta[field]) && meta[field].includes(objectKey)) return true;
  }
  return false;
};

const findPublicTemplate = async (objectKey) => {
  const rows = await sql`
    SELECT id, preview_object_key, preview_video_object_key,
           preview_image_url, preview_video_url
    FROM prompt_templates
    WHERE is_active = true
      AND visibility = 'public'
      AND approval_status = 'approved'
      AND (
        preview_object_key = ${objectKey}
        OR preview_video_object_key = ${objectKey}
        OR POSITION(${objectKey} IN COALESCE(preview_image_url, '')) > 0
        OR POSITION(${objectKey} IN COALESCE(preview_video_url, '')) > 0
      )
    LIMIT 5
  `;
  return rows.find((row) => templateRowReferencesObjectKey(row, objectKey)) || null;
};

const findPrivateTemplate = async (objectKey, userId) => {
  const rows = await sql`
    SELECT id, preview_object_key, preview_video_object_key,
           preview_image_url, preview_video_url
    FROM prompt_templates
    WHERE owner_user_id = ${userId}
      AND (
        preview_object_key = ${objectKey}
        OR preview_video_object_key = ${objectKey}
        OR POSITION(${objectKey} IN COALESCE(preview_image_url, '')) > 0
        OR POSITION(${objectKey} IN COALESCE(preview_video_url, '')) > 0
      )
    LIMIT 5
  `;
  return rows.find((row) => templateRowReferencesObjectKey(row, objectKey)) || null;
};

const findTemplateAwaitingModeration = async (objectKey) => {
  const rows = await sql`
    SELECT id, owner_user_id, preview_object_key, preview_video_object_key,
           preview_image_url, preview_video_url
    FROM prompt_templates
    WHERE owner_user_id IS NOT NULL
      AND visibility = 'private'
      AND approval_status = 'pending'
      AND publication_requested_at IS NOT NULL
      AND (
        preview_object_key = ${objectKey}
        OR preview_video_object_key = ${objectKey}
        OR POSITION(${objectKey} IN COALESCE(preview_image_url, '')) > 0
        OR POSITION(${objectKey} IN COALESCE(preview_video_url, '')) > 0
      )
    LIMIT 5
  `;
  return rows.find((row) => templateRowReferencesObjectKey(row, objectKey)) || null;
};

const findOwnedCreation = async (objectKey, userId) => {
  const directRows = await sql`
    SELECT id, meta_info
    FROM creations
    WHERE user_id = ${userId}
      AND (content_object_key = ${objectKey} OR thumbnail_object_key = ${objectKey})
    LIMIT 1
  `;
  if (directRows[0]) return directRows[0];

  // Restrict metadata checks to fields that the application itself uses for
  // persisted resource keys. Arbitrary JSON strings are not trusted as ACLs.
  const candidateRows = await sql`
    SELECT id, meta_info
    FROM creations
    WHERE user_id = ${userId}
      AND POSITION(${objectKey} IN COALESCE(meta_info, '{}'::jsonb)::text) > 0
    LIMIT 20
  `;
  return candidateRows.find((row) => creationMetaReferencesObjectKey(row.meta_info, objectKey)) || null;
};

const findPublicCreation = async (objectKey) => {
  const rows = await sql`
    SELECT id
    FROM creations
    WHERE status = 'completed'
      AND community_status = 'public'
      AND community_hidden = FALSE
      AND (content_object_key = ${objectKey} OR thumbnail_object_key = ${objectKey})
    LIMIT 1
  `;
  return rows[0] || null;
};

export const authorizeResourceAccess = async ({ objectKey: inputObjectKey, userId = null, role = "user" }) => {
  const objectKey = normalizeObjectKey(inputObjectKey);
  const publicTemplate = await findPublicTemplate(objectKey);
  if (publicTemplate) {
    return { allowed: true, visibility: "public", resourceType: "template", resourceId: publicTemplate.id };
  }
  const publicCreation = await findPublicCreation(objectKey);
  if (publicCreation) {
    return { allowed: true, visibility: "public", resourceType: "creation", resourceId: publicCreation.id };
  }

  const normalizedUserId = String(userId || "").trim();
  if (!normalizedUserId || normalizedUserId.length > 255) {
    return { allowed: false, reason: "authentication_required" };
  }

  if (["admin", "root"].includes(String(role || "").toLowerCase())) {
    const moderatedTemplate = await findTemplateAwaitingModeration(objectKey);
    if (moderatedTemplate) {
      return {
        allowed: true,
        visibility: "moderation",
        resourceType: "template",
        resourceId: moderatedTemplate.id,
        ownerUserId: moderatedTemplate.owner_user_id,
      };
    }
  }

  const [template, profileRows, roleRows, uploadRows, creation] = await Promise.all([
    findPrivateTemplate(objectKey, normalizedUserId),
    sql`
      SELECT user_id FROM user_profiles
      WHERE user_id = ${normalizedUserId} AND avatar_object_key = ${objectKey}
      LIMIT 1
    `,
    sql`
      SELECT id FROM digital_human_roles
      WHERE user_id = ${normalizedUserId}
        AND (avatar_object_key = ${objectKey} OR demo_video_object_key = ${objectKey})
      LIMIT 1
    `,
    sql`
      SELECT id FROM user_content_uploads
      WHERE user_id = ${normalizedUserId} AND object_key = ${objectKey}
      LIMIT 1
    `,
    findOwnedCreation(objectKey, normalizedUserId),
  ]);

  if (template) return { allowed: true, visibility: "private", resourceType: "template", resourceId: template.id };
  if (profileRows[0]) return { allowed: true, visibility: "private", resourceType: "profile", resourceId: normalizedUserId };
  if (roleRows[0]) return { allowed: true, visibility: "private", resourceType: "digital_human_role", resourceId: roleRows[0].id };
  if (uploadRows[0]) return { allowed: true, visibility: "private", resourceType: "upload", resourceId: uploadRows[0].id };
  if (creation) return { allowed: true, visibility: "private", resourceType: "creation", resourceId: creation.id };
  return { allowed: false, reason: "not_found_or_not_owned" };
};

const objectKeyHash = (objectKey) => createHash("sha256").update(objectKey).digest("base64url");

export const issueResourceGrant = ({ objectKey: inputObjectKey, userId, ttlSeconds = DEFAULT_GRANT_TTL_SECONDS }) => {
  const objectKey = normalizeObjectKey(inputObjectKey);
  const normalizedUserId = String(userId || "").trim();
  if (!normalizedUserId || normalizedUserId.length > 255) {
    throw Object.assign(new Error("A valid resource owner is required"), { status: 400 });
  }

  const ttl = Math.min(MAX_GRANT_TTL_SECONDS, Math.max(30, Number(ttlSeconds) || DEFAULT_GRANT_TTL_SECONDS));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64UrlEncode(JSON.stringify({
    v: TOKEN_VERSION,
    sub: normalizedUserId,
    key: objectKeyHash(objectKey),
    iat: now,
    exp: now + ttl,
    nonce: randomBytes(12).toString("base64url"),
  }));
  const signature = createHmac("sha256", getGrantSecret()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
};

export const verifyResourceGrant = ({ token, objectKey: inputObjectKey }) => {
  const objectKey = normalizeObjectKey(inputObjectKey);
  const rawToken = String(token || "").trim();
  if (!rawToken || rawToken.length > 2048) return null;

  const [payloadPart, signaturePart, extraPart] = rawToken.split(".");
  if (!payloadPart || !signaturePart || extraPart) return null;

  const expectedSignature = createHmac("sha256", getGrantSecret()).update(payloadPart).digest();
  let suppliedSignature;
  try {
    suppliedSignature = Buffer.from(signaturePart, "base64url");
  } catch {
    return null;
  }
  if (suppliedSignature.length !== expectedSignature.length || !timingSafeEqual(suppliedSignature, expectedSignature)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
    const now = Math.floor(Date.now() / 1000);
    if (
      payload.v !== TOKEN_VERSION
      || typeof payload.sub !== "string"
      || !payload.sub
      || payload.key !== objectKeyHash(objectKey)
      || !Number.isInteger(payload.iat)
      || !Number.isInteger(payload.exp)
      || payload.iat > now + 30
      || payload.exp <= now
      || payload.exp - payload.iat > MAX_GRANT_TTL_SECONDS
    ) {
      return null;
    }
    return { userId: payload.sub, expiresAt: new Date(payload.exp * 1000) };
  } catch {
    return null;
  }
};

const encodeObjectKeyPath = (objectKey) =>
  objectKey.split("/").map((segment) => encodeURIComponent(segment)).join("/");

export const buildGrantedProxyUrl = ({ objectKey: inputObjectKey, userId, ttlSeconds, process = null }) => {
  const objectKey = normalizeObjectKey(inputObjectKey);
  const resourceToken = issueResourceGrant({ objectKey, userId, ttlSeconds });
  const query = new URLSearchParams({ resource_token: resourceToken });
  if (process) query.set("x-oss-process", String(process));
  return `/oss-proxy/${encodeObjectKeyPath(objectKey)}?${query.toString()}`;
};
