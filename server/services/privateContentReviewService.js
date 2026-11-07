import sql from "../configs/db.js";
import { buildGrantedProxyUrl } from "./resourceAccessService.js";
import { writeAuditLog } from "./auditService.js";

const ALIASES = new Map([
  ["creation", "creation"],
  ["canvas", "canvas"],
  ["private_template", "private_template"],
  ["private-template", "private_template"],
  ["digital_human", "digital_human"],
  ["digital-human", "digital_human"],
  ["upload", "upload"],
]);

const fail = (message, status = 400, code = "PRIVATE_CONTENT_REVIEW_ERROR") => {
  throw Object.assign(new Error(message), { status, code });
};

const normalize = (value, field, max = 255) => {
  const text = String(value ?? "").trim();
  if (!text || text.length > max) fail(`${field} is invalid`, 400, "INVALID_REVIEW_TARGET");
  return text;
};

const parseObject = (value) => {
  if (!value) return {};
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return {}; }
};

const collectObjectKeys = (value, keys = new Set(), depth = 0) => {
  if (depth > 20 || value == null) return keys;
  if (Array.isArray(value)) {
    value.forEach((item) => collectObjectKeys(item, keys, depth + 1));
    return keys;
  }
  if (typeof value !== "object") return keys;
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string" && /object_?key$/i.test(key) && child) keys.add(child);
    else collectObjectKeys(child, keys, depth + 1);
  }
  return keys;
};

const grantMap = (ownerUserId, snapshot) => Object.fromEntries(
  [...collectObjectKeys(snapshot)].map((objectKey) => [
    objectKey,
    buildGrantedProxyUrl({ objectKey, userId: ownerUserId, ttlSeconds: 300 }),
  ]),
);

const loadTarget = async ({ ownerUserId, resourceType, resourceId }) => {
  if (resourceType === "creation") {
    const [row] = await sql`
      SELECT id, user_id, scene_key, scene_name, type, status, content_object_key,
             thumbnail_object_key, meta_info, created_at, updated_at
      FROM creations WHERE id::text = ${resourceId} AND user_id = ${ownerUserId}
    `;
    return row ? { ...row, meta_info: parseObject(row.meta_info) } : null;
  }
  if (resourceType === "canvas") {
    const [row] = await sql`
      SELECT id, user_id, title, canvas_state, created_at, updated_at
      FROM canvases WHERE id::text = ${resourceId} AND user_id = ${ownerUserId}
    `;
    return row ? { ...row, canvas_state: parseObject(row.canvas_state) } : null;
  }
  if (resourceType === "private_template") {
    const [row] = await sql`
      SELECT id, owner_user_id, scene_key, scene_name, output_type, system_prompt,
             preview_title, preview_description, starter_prompt, placeholder_text,
             preview_object_key, preview_video_object_key, visibility,
             approval_status, created_at, updated_at
      FROM prompt_templates
      WHERE id::text = ${resourceId} AND owner_user_id = ${ownerUserId}
        AND visibility = 'private'
    `;
    return row || null;
  }
  if (resourceType === "digital_human") {
    const [row] = await sql`
      SELECT id, user_id, role_name, role_description, prompt_text, status,
             avatar_object_key, demo_video_object_key, ready_at, meta_info,
             created_at, updated_at
      FROM digital_human_roles WHERE id::text = ${resourceId} AND user_id = ${ownerUserId}
    `;
    return row ? { ...row, meta_info: parseObject(row.meta_info) } : null;
  }
  const [row] = await sql`
    SELECT id, user_id, object_key, media_type, mime_type, original_name,
           source_type, source_resource_id, metadata, created_at, updated_at
    FROM user_content_uploads
    WHERE user_id = ${ownerUserId} AND (id::text = ${resourceId} OR object_key = ${resourceId})
  `;
  return row ? { ...row, metadata: parseObject(row.metadata) } : null;
};

export const reviewPrivateContent = async ({ actor, ownerUserId, resourceType: rawType, resourceId, reason, req }) => {
  const owner = normalize(ownerUserId, "owner_user_id");
  const id = normalize(resourceId, "resource_id");
  const type = ALIASES.get(String(rawType || "").trim().toLowerCase());
  if (!type) fail("Unsupported resource_type", 400, "UNSUPPORTED_REVIEW_TARGET");
  const cleanReason = normalize(reason, "reason", 2000);
  const snapshot = await loadTarget({ ownerUserId: owner, resourceType: type, resourceId: id });
  if (!snapshot) fail("Private content was not found", 404, "PRIVATE_CONTENT_NOT_FOUND");

  await writeAuditLog({
    req,
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: "private_content.reviewed",
    targetType: type,
    targetId: id,
    reason: cleanReason,
    metadata: { owner_user_id: owner, access_mode: "read_only", grant_ttl_seconds: 300 },
  });

  return {
    resource_type: type,
    resource_id: id,
    owner_user_id: owner,
    access_mode: "read_only",
    asset_grants: grantMap(owner, snapshot),
    snapshot,
  };
};
