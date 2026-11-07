import sql from "../configs/db.js";

const MAX_TITLE_LENGTH = 200;
const MAX_CONTENT_LENGTH = 100000;
const MAX_PRIORITY = 1_000_000;
const ANNOUNCEMENT_STATUSES = new Set(["draft", "published"]);

const fail = (message, status, code) => {
  throw Object.assign(new Error(message), { status, code });
};

const normalizeText = (value, field, maxLength) => {
  const text = String(value ?? "").trim();
  if (!text || text.length > maxLength || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    fail(`${field} is invalid`, 400, "INVALID_ANNOUNCEMENT");
  }
  return text;
};

const normalizePriority = (value) => {
  const priority = Number(value ?? 0);
  if (!Number.isSafeInteger(priority) || priority < -MAX_PRIORITY || priority > MAX_PRIORITY) {
    fail("priority must be a valid integer", 400, "INVALID_ANNOUNCEMENT");
  }
  return priority;
};

export const normalizeAnnouncementStatus = (value) => {
  const status = String(value ?? "draft").trim().toLowerCase();
  if (!ANNOUNCEMENT_STATUSES.has(status)) {
    fail("status must be draft or published", 400, "INVALID_ANNOUNCEMENT_STATUS");
  }
  return status;
};

export const normalizeAnnouncementInput = (input = {}, { partial = false } = {}) => {
  const result = {};
  if (!partial || Object.prototype.hasOwnProperty.call(input, "title")) {
    result.title = normalizeText(input.title, "title", MAX_TITLE_LENGTH);
  }
  if (!partial || Object.prototype.hasOwnProperty.call(input, "content")) {
    result.content = normalizeText(input.content, "content", MAX_CONTENT_LENGTH);
  }
  if (!partial || Object.prototype.hasOwnProperty.call(input, "status")) {
    result.status = normalizeAnnouncementStatus(input.status);
  }
  if (!partial || Object.prototype.hasOwnProperty.call(input, "priority")) {
    result.priority = normalizePriority(input.priority);
  }
  if (partial && Object.keys(result).length === 0) {
    fail("At least one announcement field is required", 400, "INVALID_ANNOUNCEMENT");
  }
  return result;
};

export const listPublishedAnnouncements = async ({ limit = 50, offset = 0 } = {}) => {
  const safeLimit = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 50));
  const safeOffset = Math.max(0, Number.parseInt(offset, 10) || 0);
  return sql`
    SELECT id, title, content, status, priority, published_at,
           created_by, created_at, updated_at, deleted_at, deleted_by
    FROM announcements
    WHERE status = 'published' AND deleted_at IS NULL
    ORDER BY priority DESC, published_at DESC, id DESC
    LIMIT ${safeLimit} OFFSET ${safeOffset}
  `;
};

export const listAnnouncements = async () => sql`
  SELECT id, title, content, status, priority, published_at,
         created_by, created_at, updated_at, deleted_at, deleted_by
  FROM announcements
  WHERE deleted_at IS NULL
  ORDER BY CASE WHEN status = 'published' THEN 0 ELSE 1 END,
           priority DESC, COALESCE(published_at, created_at) DESC, id DESC
`;

export const createAnnouncementTx = async (tx, { actorUserId, input }) => {
  const normalized = normalizeAnnouncementInput(input);
  const [row] = await tx`
    INSERT INTO announcements
      (title, content, status, priority, published_at, created_by)
    VALUES
      (${normalized.title}, ${normalized.content}, ${normalized.status}, ${normalized.priority},
       ${normalized.status === "published" ? new Date() : null}, ${actorUserId})
    RETURNING id, title, content, status, priority, published_at,
              created_by, created_at, updated_at, deleted_at, deleted_by
  `;
  return row;
};

export const updateAnnouncementTx = async (tx, { id, input }) => {
  const announcementId = Number(id);
  if (!Number.isSafeInteger(announcementId) || announcementId <= 0) {
    fail("Announcement id is invalid", 400, "INVALID_ANNOUNCEMENT_ID");
  }
  const [before] = await tx`
    SELECT id, title, content, status, priority, published_at,
           created_by, created_at, updated_at, deleted_at, deleted_by
    FROM announcements
    WHERE id = ${announcementId}
    FOR UPDATE
  `;
  if (!before || before.deleted_at) fail("Announcement was not found", 404, "ANNOUNCEMENT_NOT_FOUND");

  const normalized = normalizeAnnouncementInput(input, { partial: true });
  const next = {
    title: normalized.title ?? before.title,
    content: normalized.content ?? before.content,
    status: normalized.status ?? before.status,
    priority: normalized.priority ?? Number(before.priority || 0),
  };
  const publishedAt = next.status === "published"
    ? (before.status === "published" && before.published_at ? before.published_at : new Date())
    : null;
  const [after] = await tx`
    UPDATE announcements
    SET title = ${next.title}, content = ${next.content}, status = ${next.status},
        priority = ${next.priority}, published_at = ${publishedAt}, updated_at = NOW()
    WHERE id = ${announcementId} AND deleted_at IS NULL
    RETURNING id, title, content, status, priority, published_at,
              created_by, created_at, updated_at, deleted_at, deleted_by
  `;
  return { before, after };
};

export const deleteAnnouncementTx = async (tx, { id, actorUserId }) => {
  const announcementId = Number(id);
  if (!Number.isSafeInteger(announcementId) || announcementId <= 0) {
    fail("Announcement id is invalid", 400, "INVALID_ANNOUNCEMENT_ID");
  }
  const [before] = await tx`
    SELECT id, title, content, status, priority, published_at,
           created_by, created_at, updated_at, deleted_at, deleted_by
    FROM announcements
    WHERE id = ${announcementId}
    FOR UPDATE
  `;
  if (!before || before.deleted_at) fail("Announcement was not found", 404, "ANNOUNCEMENT_NOT_FOUND");
  const [after] = await tx`
    UPDATE announcements
    SET deleted_at = NOW(), deleted_by = ${actorUserId}, updated_at = NOW()
    WHERE id = ${announcementId} AND deleted_at IS NULL
    RETURNING id, title, content, status, priority, published_at,
              created_by, created_at, updated_at, deleted_at, deleted_by
  `;
  return { before, after };
};
