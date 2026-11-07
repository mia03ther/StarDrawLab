import sql from "../configs/db.js";
import { executeAdministratorOperation } from "./administratorOperationService.js";
import { executeUserOperation } from "./userOperationService.js";
import { writeAuditLog } from "./auditService.js";

const MAX_PAGE_SIZE = 40;
const MEMBERSHIP_TIERS = ["free", "basic", "pro", "max", "enterprise"];
const COMMUNITY_TYPES = new Set(["image", "video"]);
const REPORT_REASONS = new Set(["copyright", "unsafe", "spam", "privacy", "other"]);

const fail = (message, status = 400, code = "COMMUNITY_REQUEST_INVALID") => {
  throw Object.assign(new Error(message), { status, code });
};

const normalizeId = (value, name = "id") => {
  const normalized = String(value ?? "").trim();
  if (!/^[1-9]\d{0,18}$/.test(normalized) || BigInt(normalized) > 9223372036854775807n) fail(`${name} is invalid`, 400, "INVALID_CREATION_ID");
  return normalized;
};

const normalizeUserId = (value) => {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > 255) fail("Authenticated user is required", 401, "AUTHENTICATION_REQUIRED");
  return normalized;
};

const normalizeText = (value, max, fallback = null) => {
  const normalized = String(value ?? "").trim();
  if (!normalized) return fallback;
  if (normalized.length > max) fail("Text value is too long", 400, "COMMUNITY_TEXT_TOO_LONG");
  return normalized;
};

const normalizeTags = (value) => {
  const source = Array.isArray(value)
    ? value
    : String(value || "").split(",");
  const tags = [...new Set(source
    .map((tag) => String(tag || "").trim().replace(/^#/, ""))
    .filter(Boolean))].slice(0, 12);
  if (tags.some((tag) => tag.length > 32 || /[\u0000-\u001f\u007f]/.test(tag))) {
    fail("Each community tag must be 32 characters or fewer", 400, "COMMUNITY_TAG_INVALID");
  }
  return tags;
};

const normalizePublicVisualParameters = (value) => {
  if (value == null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("Public visual parameters must be an object", 400, "COMMUNITY_VISUAL_PARAMETERS_INVALID");
  }
  const result = {};
  for (const [rawKey, rawValue] of Object.entries(value).slice(0, 16)) {
    const key = String(rawKey).trim();
    if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(key)) continue;
    if (typeof rawValue === "string") {
      const normalized = rawValue.trim();
      if (normalized && normalized.length <= 160) result[key] = normalized;
    } else if (Array.isArray(rawValue)) {
      const values = rawValue.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 8);
      if (values.every((item) => item.length <= 80)) result[key] = values;
    }
  }
  return result;
};

const parseJson = (value, fallback) => {
  if (value == null) return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
};

const encodeCursor = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const decodeCursor = (value) => {
  if (!value) return null;
  try {
    const decoded = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
    if (!decoded || !/^[1-9]\d{0,18}$/.test(String(decoded.id)) || !decoded.publishedAt) return null;
    return { id: String(decoded.id), publishedAt: new Date(decoded.publishedAt).toISOString(), likes: Number(decoded.likes || 0), featured: Boolean(decoded.featured) };
  } catch { return null; }
};

export const normalizeCommunityListInput = ({ cursor, limit, type, sort, query }) => {
  const normalizedType = String(type || "").trim().toLowerCase();
  if (normalizedType && !COMMUNITY_TYPES.has(normalizedType)) fail("type must be image or video", 400, "COMMUNITY_TYPE_INVALID");
  const normalizedSort = ["featured", "latest", "popular"].includes(String(sort || "").trim().toLowerCase())
    ? String(sort).trim().toLowerCase() : "latest";
  const normalizedQuery = normalizeText(query, 100, null);
  return {
    cursor: decodeCursor(cursor),
    limit: Math.min(MAX_PAGE_SIZE, Math.max(1, Number.parseInt(limit, 10) || 24)),
    type: normalizedType || null,
    sort: normalizedSort,
    query: normalizedQuery,
  };
};

const safeMeta = (row) => {
  const meta = parseJson(row.meta_info, {});
  const publicVisuals = row.community_visual_parameters && typeof row.community_visual_parameters === "object"
    ? row.community_visual_parameters
    : {};
  return {
    model: row.model || meta.model || null,
    size: meta.size || null,
    aspect_ratio: meta.aspect_ratio || meta.aspectRatio || null,
    visual_parameters: publicVisuals,
  };
};

const publicCreation = (row) => ({
  id: String(row.id),
  type: row.type,
  scene_key: row.scene_key || null,
  title: row.community_title || row.scene_name || (row.type === "video" ? "AI Video" : "AI Image"),
  tags: normalizeTags(parseJson(row.community_tags, [])),
  content: row.content || (row.content_object_key ? `/oss-proxy/${row.content_object_key}` : null),
  thumbnail_url: row.thumbnail_url || (row.thumbnail_object_key ? `/oss-proxy/${row.thumbnail_object_key}` : null),
  author: {
    id: String(row.user_id),
    name: row.display_name || "StarDraw creator",
    avatar_url: row.avatar_url || null,
  },
  likes_count: Number(row.likes_count || 0),
  favorites_count: Number(row.favorites_count || 0),
  liked: Boolean(row.liked),
  favorited: Boolean(row.favorited),
  featured: Boolean(row.community_featured),
  published_at: row.community_published_at,
  prompt: row.community_prompt_public ? row.prompt || null : null,
  prompt_public: Boolean(row.community_prompt_public),
  public_parameters: safeMeta(row),
});

const creationSelect = (db, userId = null) => db`
  SELECT c.id, c.user_id, c.type, c.scene_key, c.scene_name, c.model, c.prompt,
         c.content, c.content_object_key, c.thumbnail_url, c.thumbnail_object_key,
         c.meta_info, c.community_title, c.community_tags,
         c.community_prompt_public, c.community_visual_parameters,
         c.community_published_at, c.community_featured,
         COUNT(DISTINCT l.user_id)::int AS likes_count,
         COUNT(DISTINCT f.user_id)::int AS favorites_count,
         ${userId ? db`EXISTS (SELECT 1 FROM community_creation_likes ul WHERE ul.creation_id = c.id AND ul.user_id = ${userId})` : db`FALSE`} AS liked,
         ${userId ? db`EXISTS (SELECT 1 FROM community_creation_favorites uf WHERE uf.creation_id = c.id AND uf.user_id = ${userId})` : db`FALSE`} AS favorited,
         COALESCE(up.display_name, '') AS display_name, up.avatar_url
  FROM creations c
  LEFT JOIN user_profiles up ON up.user_id = c.user_id
  LEFT JOIN community_creation_likes l ON l.creation_id = c.id
  LEFT JOIN community_creation_favorites f ON f.creation_id = c.id
`;

const feedWhere = (db, input) => db`
  c.status = 'completed'
  AND c.community_status = 'public'
  AND c.community_hidden = FALSE
  AND c.content_object_key IS NOT NULL
  AND (${input.type}::text IS NULL OR c.type = ${input.type})
  AND (${input.query}::text IS NULL OR POSITION(LOWER(${input.query}) IN LOWER(CONCAT_WS(' ', c.community_title, c.scene_name, c.community_tags::text))) > 0)
`;

const loadRows = async ({ input, userId }) => {
  const db = sql;
  const order = input.sort === "popular"
    ? db`ORDER BY COUNT(DISTINCT l.user_id) DESC, c.community_featured DESC, c.community_published_at DESC, c.id DESC`
    : input.sort === "featured"
      ? db`ORDER BY c.community_featured DESC, c.community_published_at DESC, c.id DESC`
      : db`ORDER BY c.community_published_at DESC, c.id DESC`;
  const cursorWhere = input.cursor && input.sort === "featured"
    ? db`AND (c.community_featured, c.community_published_at, c.id) < (${Boolean(input.cursor.featured)}, ${input.cursor.publishedAt}::timestamptz, ${input.cursor.id}::bigint)`
    : input.cursor && input.sort === "latest"
      ? db`AND (c.community_published_at, c.id) < (${input.cursor.publishedAt}::timestamptz, ${input.cursor.id}::bigint)`
      : db``;
  const cursorHaving = input.cursor && input.sort === "popular"
    ? db`HAVING (COUNT(DISTINCT l.user_id), c.community_featured, c.community_published_at, c.id) < (${input.cursor.likes}, ${Boolean(input.cursor.featured)}, ${input.cursor.publishedAt}::timestamptz, ${input.cursor.id}::bigint)`
    : db``;
  const rows = await db`
    ${creationSelect(db, userId)}
    WHERE ${feedWhere(db, input)} ${cursorWhere}
    GROUP BY c.id, up.display_name, up.avatar_url
    ${cursorHaving}
    ${order}
    LIMIT ${input.limit + 1}
  `;
  const hasMore = rows.length > input.limit;
  const items = rows.slice(0, input.limit).map(publicCreation);
  const last = rows[input.limit - 1];
  return {
    items,
    next_cursor: hasMore && last ? encodeCursor({
      id: String(last.id),
      publishedAt: last.community_published_at,
      likes: Number(last.likes_count || 0),
      featured: Boolean(last.community_featured),
    }) : null,
  };
};

export const listPublicCreations = async ({ userId = null, ...options } = {}) => loadRows({
  input: normalizeCommunityListInput(options),
  userId: userId ? normalizeUserId(userId) : null,
});

export const getPublicCreation = async ({ creationId, userId = null }) => {
  const id = normalizeId(creationId, "creationId");
  const rows = await sql`
    ${creationSelect(sql, userId ? normalizeUserId(userId) : null)}
    WHERE c.id = ${id}
      AND c.status = 'completed' AND c.community_status = 'public'
      AND c.community_hidden = FALSE AND c.content_object_key IS NOT NULL
    GROUP BY c.id, up.display_name, up.avatar_url
    LIMIT 1
  `;
  return rows[0] ? publicCreation(rows[0]) : null;
};

export const getCommunityBootstrap = async () => {
  const [templates, models] = await Promise.all([
    sql`
      SELECT id, scene_key, scene_name, output_type, default_model, default_seconds,
             default_size, is_featured, featured_order, preview_title,
             preview_description, preview_image_url, preview_video_url,
             starter_prompt, placeholder_text, requires_reference, tags,
             required_membership_tier, owner_user_id, visibility, approval_status
      FROM prompt_templates
      WHERE is_active = TRUE AND visibility = 'public' AND approval_status = 'approved'
      ORDER BY is_featured DESC, featured_order ASC NULLS LAST, display_order ASC, id ASC
      LIMIT 60
    `,
    sql`
      SELECT m.model_key, m.display_name, m.output_type, m.description,
             m.capabilities, m.resolutions, m.aspect_ratios,
             m.minimum_membership_tier
      FROM model_catalog m
      WHERE m.is_active = TRUE AND m.minimum_membership_tier = 'free'
        AND EXISTS (SELECT 1 FROM model_routes r WHERE r.model_key = m.model_key AND r.is_active = TRUE)
      ORDER BY m.output_type, m.display_order, m.model_key
    `,
  ]);
  return { templates, models };
};

const loadOwnedCreation = async (tx, id, userId, { lock = true } = {}) => {
  const rows = await tx`
    SELECT * FROM creations
    WHERE id = ${id} AND user_id = ${userId}
    ${lock ? tx`FOR UPDATE` : tx``}
    LIMIT 1
  `;
  return rows[0] || null;
};

const loadCommunityCreation = async (tx, id, { lock = true } = {}) => {
  const rows = await tx`
    SELECT * FROM creations WHERE id = ${id}
    ${lock ? tx`FOR UPDATE` : tx``}
    LIMIT 1
  `;
  return rows[0] || null;
};

const appendEvent = async (tx, { creationId, actorUserId, actorRole = "user", eventType, payload = {} }) => {
  await tx`
    INSERT INTO community_creation_events (creation_id, actor_user_id, actor_role, event_type, payload)
    VALUES (${creationId}, ${actorUserId || null}, ${actorRole}, ${eventType}, ${tx.json(payload)})
  `;
};

export const publishCreation = async ({ userId, creationId, body = {}, idempotencyKey }) => {
  const ownerId = normalizeUserId(userId);
  const id = normalizeId(creationId, "creationId");
  const input = {
    title: normalizeText(body.title, 160, null),
    tags: normalizeTags(body.tags),
    promptPublic: Boolean(body.prompt_public),
    visualParameters: normalizePublicVisualParameters(body.visual_parameters),
  };
  return executeUserOperation({
    userId: ownerId, idempotencyKey, action: "community.creation.published",
    targetType: "creation", targetId: id, requestPayload: input,
    mutate: async (tx) => {
      const creation = await loadOwnedCreation(tx, id, ownerId);
      if (!creation) fail("Creation not found", 404, "CREATION_NOT_FOUND");
      if (creation.status !== "completed" || !creation.content_object_key) fail("Only completed creations with stored media can be published", 409, "CREATION_NOT_PUBLISHABLE");
      const title = input.title || creation.scene_name || (creation.type === "video" ? "AI Video" : "AI Image");
      const [updated] = await tx`
        UPDATE creations
        SET community_status = 'public', community_title = ${title},
            community_tags = ${tx.json(input.tags)}, community_prompt_public = ${input.promptPublic},
            community_visual_parameters = ${tx.json(input.visualParameters)},
            community_published_at = COALESCE(community_published_at, NOW()),
            community_hidden = FALSE, community_hidden_reason = NULL,
            community_hidden_at = NULL, community_hidden_by = NULL
        WHERE id = ${id} AND user_id = ${ownerId}
        RETURNING id, community_status, community_title, community_tags, community_prompt_public, community_published_at
      `;
      await appendEvent(tx, { creationId: id, actorUserId: ownerId, eventType: "published", payload: input });
      return updated;
    },
  });
};

export const unpublishCreation = async ({ userId, creationId, idempotencyKey }) => {
  const ownerId = normalizeUserId(userId);
  const id = normalizeId(creationId, "creationId");
  return executeUserOperation({
    userId: ownerId, idempotencyKey, action: "community.creation.unpublished",
    targetType: "creation", targetId: id, requestPayload: { creation_id: id },
    mutate: async (tx) => {
      const creation = await loadOwnedCreation(tx, id, ownerId);
      if (!creation) fail("Creation not found", 404, "CREATION_NOT_FOUND");
      const [updated] = await tx`
        UPDATE creations SET community_status = 'private', community_featured = FALSE
        WHERE id = ${id} AND user_id = ${ownerId}
        RETURNING id, community_status
      `;
      await appendEvent(tx, { creationId: id, actorUserId: ownerId, eventType: "unpublished" });
      return updated;
    },
  });
};

export const getOwnedCommunityState = async ({ userId, creationId }) => {
  const ownerId = normalizeUserId(userId);
  const id = normalizeId(creationId, "creationId");
  const [row] = await sql`
    SELECT id, community_status, community_title, community_tags,
           community_prompt_public, community_visual_parameters,
           community_published_at, community_featured, community_hidden
    FROM creations
    WHERE id = ${id} AND user_id = ${ownerId}
    LIMIT 1
  `;
  if (!row) fail("Creation not found", 404, "CREATION_NOT_FOUND");
  return row;
};

const toggleRelation = async ({ userId, creationId, idempotencyKey, relation, enabled }) => {
  const ownerId = normalizeUserId(userId);
  const id = normalizeId(creationId, "creationId");
  const table = relation === "like" ? "community_creation_likes" : "community_creation_favorites";
  const action = enabled ? `community.creation.${relation}d` : `community.creation.un${relation}d`;
  return executeUserOperation({
    userId: ownerId, idempotencyKey, action, targetType: "creation", targetId: id,
    requestPayload: { creation_id: id, enabled: Boolean(enabled) },
    mutate: async (tx) => {
      const creation = await loadCommunityCreation(tx, id);
      if (!creation || creation.status !== "completed" || creation.community_status !== "public" || creation.community_hidden) fail("Public creation not found", 404, "CREATION_NOT_FOUND");
      if (enabled) {
        if (relation === "like") {
          await tx`INSERT INTO community_creation_likes (creation_id, user_id) VALUES (${id}, ${ownerId}) ON CONFLICT DO NOTHING`;
        } else {
          await tx`INSERT INTO community_creation_favorites (creation_id, user_id) VALUES (${id}, ${ownerId}) ON CONFLICT DO NOTHING`;
        }
      } else {
        if (relation === "like") {
          await tx`DELETE FROM community_creation_likes WHERE creation_id = ${id} AND user_id = ${ownerId}`;
        } else {
          await tx`DELETE FROM community_creation_favorites WHERE creation_id = ${id} AND user_id = ${ownerId}`;
        }
      }
      await appendEvent(tx, { creationId: id, actorUserId: ownerId, eventType: enabled ? `${relation}d` : `un${relation}d` });
      const [counts] = await tx`
        SELECT
          (SELECT COUNT(*)::int FROM community_creation_likes WHERE creation_id = ${id}) AS likes_count,
          (SELECT COUNT(*)::int FROM community_creation_favorites WHERE creation_id = ${id}) AS favorites_count
      `;
      return { creation_id: id, enabled: Boolean(enabled), ...counts };
    },
  });
};

export const setCreationLike = (args) => toggleRelation({ ...args, relation: "like" });
export const setCreationFavorite = (args) => toggleRelation({ ...args, relation: "favorite" });

export const reportCreation = async ({ userId, creationId, reason, details, idempotencyKey }) => {
  const reporterId = normalizeUserId(userId);
  const id = normalizeId(creationId, "creationId");
  const normalizedReason = String(reason || "other").trim().toLowerCase();
  if (!REPORT_REASONS.has(normalizedReason)) fail("Unsupported report reason", 400, "REPORT_REASON_INVALID");
  const normalizedDetails = normalizeText(details, 1000, null);
  return executeUserOperation({
    userId: reporterId, idempotencyKey, action: "community.creation.reported",
    targetType: "creation", targetId: id, requestPayload: { reason: normalizedReason, details: normalizedDetails },
    mutate: async (tx) => {
      const creation = await loadCommunityCreation(tx, id);
      if (!creation || creation.community_status !== "public" || creation.community_hidden) fail("Public creation not found", 404, "CREATION_NOT_FOUND");
      const [report] = await tx`
        INSERT INTO community_creation_reports (creation_id, reporter_user_id, reason, details)
        VALUES (${id}, ${reporterId}, ${normalizedReason}, ${normalizedDetails})
        ON CONFLICT (creation_id, reporter_user_id) WHERE status = 'pending' DO UPDATE
          SET reason = EXCLUDED.reason, details = EXCLUDED.details
        RETURNING id, creation_id, status, created_at
      `;
      await appendEvent(tx, { creationId: id, actorUserId: reporterId, eventType: "reported", payload: { reason: normalizedReason } });
      return report;
    },
  });
};

const adminModerate = async ({ actor, creationId, hidden, reason, idempotencyKey, req }) => {
  const id = normalizeId(creationId, "creationId");
  const normalizedReason = normalizeText(reason, 2000, null);
  if (hidden && !normalizedReason) fail("A reason is required when hiding a creation", 400, "REASON_REQUIRED");
  return executeAdministratorOperation({
    actor, idempotencyKey, action: hidden ? "community.creation.hidden" : "community.creation.restored",
    targetType: "creation", targetId: id, requestPayload: { hidden, reason: normalizedReason },
    mutate: async (tx) => {
      const creation = await loadCommunityCreation(tx, id);
      if (!creation || creation.community_status !== "public") fail("Public creation not found", 404, "CREATION_NOT_FOUND");
      const [updated] = await tx`
        UPDATE creations
        SET community_hidden = ${Boolean(hidden)},
            community_hidden_reason = ${hidden ? normalizedReason : null},
            community_hidden_at = ${hidden ? sql`NOW()` : sql`NULL`},
            community_hidden_by = ${hidden ? actor.userId : null}
        WHERE id = ${id} AND community_status = 'public'
        RETURNING id, community_hidden, community_hidden_reason
      `;
      await appendEvent(tx, { creationId: id, actorUserId: actor.userId, actorRole: actor.role, eventType: hidden ? "moderated_hidden" : "moderated_restored", payload: { reason: normalizedReason } });
      await writeAuditLog({ req, actorUserId: actor.userId, actorRole: actor.role, action: hidden ? "community.creation.hidden" : "community.creation.restored", targetType: "creation", targetId: id, reason: normalizedReason, before: { community_hidden: creation.community_hidden }, after: updated, tx });
      return updated;
    },
  });
};

export const hideCreationAsAdministrator = (args) => adminModerate({ ...args, hidden: true });
export const restoreCreationAsAdministrator = (args) => adminModerate({ ...args, hidden: false });

export const setCreationFeaturedAsAdministrator = async ({ actor, creationId, featured, idempotencyKey, req }) => {
  const id = normalizeId(creationId, "creationId");
  return executeAdministratorOperation({
    actor, idempotencyKey, action: featured ? "community.creation.featured" : "community.creation.unfeatured",
    targetType: "creation", targetId: id, requestPayload: { featured: Boolean(featured) },
    mutate: async (tx) => {
      const creation = await loadCommunityCreation(tx, id);
      if (!creation || creation.status !== "completed" || creation.community_status !== "public" || creation.community_hidden) fail("Public creation not found", 404, "CREATION_NOT_FOUND");
      const [updated] = await tx`
        UPDATE creations SET community_featured = ${Boolean(featured)}
        WHERE id = ${id} AND community_status = 'public' AND community_hidden = FALSE
        RETURNING id, community_featured
      `;
      await appendEvent(tx, { creationId: id, actorUserId: actor.userId, actorRole: actor.role, eventType: featured ? "featured" : "unfeatured" });
      await writeAuditLog({ req, actorUserId: actor.userId, actorRole: actor.role, action: featured ? "community.creation.featured" : "community.creation.unfeatured", targetType: "creation", targetId: id, after: updated, tx });
      return updated;
    },
  });
};

export const resolveCommunityReport = async ({ actor, reportId, status, note, idempotencyKey, req }) => {
  const id = normalizeId(reportId, "reportId");
  const nextStatus = String(status || "").trim().toLowerCase();
  if (!["reviewed", "dismissed"].includes(nextStatus)) fail("Report status is invalid", 400, "REPORT_STATUS_INVALID");
  const normalizedNote = normalizeText(note, 2000, null);
  return executeAdministratorOperation({
    actor, idempotencyKey, action: "community.report.resolved", targetType: "community_report", targetId: id,
    requestPayload: { status: nextStatus, note: normalizedNote },
    mutate: async (tx) => {
      const [report] = await tx`SELECT * FROM community_creation_reports WHERE id = ${id} FOR UPDATE`;
      if (!report) fail("Report not found", 404, "REPORT_NOT_FOUND");
      const [updated] = await tx`
        UPDATE community_creation_reports SET status = ${nextStatus}, reviewed_by = ${actor.userId}, reviewed_at = NOW(), review_note = ${normalizedNote}
        WHERE id = ${id} RETURNING id, creation_id, status, reviewed_at, review_note
      `;
      await appendEvent(tx, { creationId: report.creation_id, actorUserId: actor.userId, actorRole: actor.role, eventType: "report_resolved", payload: { report_id: id, status: nextStatus } });
      await writeAuditLog({ req, actorUserId: actor.userId, actorRole: actor.role, action: "community.report.resolved", targetType: "community_report", targetId: id, reason: normalizedNote, before: { status: report.status }, after: updated, tx });
      return updated;
    },
  });
};

export const listCommunityReports = async ({ status = "pending", limit = 50 } = {}) => sql`
  SELECT r.id, r.creation_id, r.reporter_user_id, r.reason, r.details, r.status,
         r.created_at, c.community_title, c.type
  FROM community_creation_reports r
  JOIN creations c ON c.id = r.creation_id
  WHERE r.status = ${String(status || "pending").trim()}
  ORDER BY r.created_at ASC, r.id ASC
  LIMIT ${Math.min(100, Math.max(1, Number(limit) || 50))}
`;
