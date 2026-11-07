import sql from "../configs/db.js";
import logger from "../configs/logger.js";
import { isIP } from "node:net";

const REDACTED_KEY = /(password|secret|private.?key|api.?key|authorization|signature|token|cookie|smtp|alipay.*key)/i;
const PRIVATE_KEY_PATTERN = /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/gi;
const SECRET_ASSIGNMENT_PATTERN = /(\b(?:authorization|api[-_ ]?key|secret|password|access[-_ ]?token|refresh[-_ ]?token|cookie|signature|smtp[-_ ]?password|alipay[-_ ]?(?:private|public)[-_ ]?key)\b\s*[:=]\s*)(?:Bearer\s+[A-Za-z0-9._~+/=-]+|"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&]+)/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const OPENAI_KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{16,}\b/g;
const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME_WITH_ZONE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/i;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE = 1_000_000;
const MAX_EXPORT_ROWS = 50_000;

const AUDIT_LOG_COLUMNS = [
  "id",
  "actor_user_id",
  "actor_role",
  "action",
  "target_type",
  "target_id",
  "request_id",
  "ip_address",
  "user_agent",
  "reason",
  "before_value",
  "after_value",
  "metadata",
  "created_at",
];

export const AUDIT_CSV_COLUMNS = [
  "id",
  "created_at",
  "actor_user_id",
  "actor_role",
  "action",
  "target_type",
  "target_id",
  "reason",
  "request_id",
  "ip_address",
];

const auditQueryError = (message) => Object.assign(new Error(message), {
  status: 400,
  code: "INVALID_AUDIT_FILTER",
});

const redactString = (value) => String(value)
  .replace(PRIVATE_KEY_PATTERN, "[REDACTED]")
  .replace(SECRET_ASSIGNMENT_PATTERN, "$1[REDACTED]")
  .replace(BEARER_PATTERN, "Bearer [REDACTED]")
  .replace(JWT_PATTERN, "[REDACTED]")
  .replace(OPENAI_KEY_PATTERN, "[REDACTED]");

const redact = (value, depth = 0) => {
  if (value == null) return value;
  if (depth > 6) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redact(item, depth + 1));
  if (typeof value === "string") {
    const safe = redactString(value);
    return safe.length > 4000 ? `${safe.slice(0, 4000)}…` : safe;
  }
  if (typeof value !== "object") return value;

  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    REDACTED_KEY.test(key) ? "[REDACTED]" : redact(item, depth + 1),
  ]));
};

const requestMetadata = (req) => {
  const candidateIp = String(req?.ip || req?.socket?.remoteAddress || "").trim();
  return {
    requestId: String(req?.headers?.["x-request-id"] || req?.headers?.["x-idempotency-key"] || "").slice(0, 128) || null,
    ipAddress: isIP(candidateIp) ? candidateIp : null,
    userAgent: String(req?.headers?.["user-agent"] || "").slice(0, 1000) || null,
  };
};

const scalar = (value, name) => {
  if (value == null || value === "") return null;
  if (Array.isArray(value) || typeof value === "object") {
    throw auditQueryError(`${name} must be a single value`);
  }
  return String(value).trim() || null;
};

const boundedFilter = (value, name, maxLength) => {
  const text = scalar(value, name);
  if (text == null) return null;
  if (text.length > maxLength) throw auditQueryError(`${name} is too long`);
  if (CONTROL_CHARACTER_PATTERN.test(text)) throw auditQueryError(`${name} contains invalid characters`);
  return text;
};

const positiveInteger = (value, fallback, maximum = Number.MAX_SAFE_INTEGER) => {
  const text = scalar(value, "pagination");
  if (text == null) return fallback;
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number < 1) return fallback;
  return Math.min(maximum, number);
};

const dateBoundary = (value, name, endOfDate) => {
  const text = boundedFilter(value, name, 64);
  if (text == null) return { inclusive: null, exclusive: null };

  const dateOnly = DATE_ONLY_PATTERN.exec(text);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    const timestamp = Date.UTC(year, month - 1, day);
    const parsed = new Date(timestamp);
    if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
      throw auditQueryError(`${name} is not a valid date`);
    }
    const normalized = new Date(timestamp + (endOfDate ? 86_400_000 : 0)).toISOString();
    return endOfDate ? { inclusive: null, exclusive: normalized } : { inclusive: normalized, exclusive: null };
  }

  if (!DATE_TIME_WITH_ZONE_PATTERN.test(text)) {
    throw auditQueryError(`${name} must be YYYY-MM-DD or an ISO-8601 timestamp with timezone`);
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) throw auditQueryError(`${name} is not a valid date`);
  return { inclusive: parsed.toISOString(), exclusive: null };
};

const firstDefined = (source, names) => {
  for (const name of names) {
    if (source[name] != null && source[name] !== "") return source[name];
  }
  return null;
};

/**
 * Normalize only supported audit fields. Unknown request properties are never
 * translated into SQL identifiers or clauses.
 */
export const normalizeAuditFilters = (input = {}) => {
  const from = dateBoundary(firstDefined(input, ["dateFrom", "date_from", "from"]), "from", false);
  const to = dateBoundary(firstDefined(input, ["dateTo", "date_to", "to"]), "to", true);
  const dateFrom = from.inclusive;
  const dateToInclusive = to.inclusive;
  const dateToExclusive = to.exclusive;
  const upperBoundary = dateToExclusive || dateToInclusive;

  if (dateFrom && upperBoundary) {
    const startsAt = new Date(dateFrom).getTime();
    const endsAt = new Date(upperBoundary).getTime();
    if (dateToExclusive ? startsAt >= endsAt : startsAt > endsAt) {
      throw auditQueryError("from must be earlier than to");
    }
  }

  return {
    page: positiveInteger(firstDefined(input, ["page"]), 1, MAX_PAGE),
    pageSize: positiveInteger(firstDefined(input, ["pageSize", "page_size"]), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
    actorUserId: boundedFilter(firstDefined(input, ["actorUserId", "actor_user_id", "actor"]), "actor", 255),
    action: boundedFilter(firstDefined(input, ["action"]), "action", 120),
    targetType: boundedFilter(firstDefined(input, ["targetType", "target_type"]), "target_type", 80),
    targetId: boundedFilter(firstDefined(input, ["targetId", "target_id"]), "target_id", 255),
    targetQuery: boundedFilter(firstDefined(input, ["targetQuery", "target"]), "target", 255),
    query: boundedFilter(firstDefined(input, ["query"]), "query", 255),
    dateFrom,
    dateToInclusive,
    dateToExclusive,
  };
};

const auditFilterSql = (db, filters) => db`
  (${filters.actorUserId}::text IS NULL OR actor_user_id = ${filters.actorUserId})
  AND (${filters.action}::text IS NULL OR action = ${filters.action})
  AND (${filters.targetType}::text IS NULL OR target_type = ${filters.targetType})
  AND (${filters.targetId}::text IS NULL OR target_id = ${filters.targetId})
  AND (
    ${filters.targetQuery}::text IS NULL
    OR POSITION(LOWER(${filters.targetQuery}) IN LOWER(CONCAT_WS(' ', target_type, target_id))) > 0
  )
  AND (
    ${filters.query}::text IS NULL
    OR POSITION(LOWER(${filters.query}) IN LOWER(CONCAT_WS(' ', actor_user_id, action, target_type, target_id, request_id))) > 0
  )
  AND (${filters.dateFrom}::text IS NULL OR created_at >= ${filters.dateFrom}::timestamptz)
  AND (${filters.dateToInclusive}::text IS NULL OR created_at <= ${filters.dateToInclusive}::timestamptz)
  AND (${filters.dateToExclusive}::text IS NULL OR created_at < ${filters.dateToExclusive}::timestamptz)
`;

const countAuditLogs = async (filters, db = sql) => {
  const [row] = await db`
    SELECT COUNT(*)::text AS total
    FROM administrator_audit_log
    WHERE ${auditFilterSql(db, filters)}
  `;
  const total = Number(row?.total || 0);
  return Number.isSafeInteger(total) && total >= 0 ? total : 0;
};

const fetchAuditLogs = async (filters, { limit, offset = 0 }, db = sql) => db`
  SELECT id, actor_user_id, actor_role, action, target_type, target_id,
         request_id, ip_address::text AS ip_address, user_agent, reason,
         before_value, after_value, metadata, created_at
  FROM administrator_audit_log
  WHERE ${auditFilterSql(db, filters)}
  ORDER BY created_at DESC, id DESC
  LIMIT ${limit} OFFSET ${offset}
`;

export const sanitizeAuditLogRow = (row = {}) => Object.fromEntries(
  AUDIT_LOG_COLUMNS.map((column) => [
    column,
    column === "created_at" ? row[column] : redact(row[column]),
  ]),
);

export const writeAuditLog = async ({
  req,
  actorUserId,
  actorRole,
  action,
  targetType = null,
  targetId = null,
  reason = null,
  before = null,
  after = null,
  metadata = {},
  tx = sql,
}) => {
  const request = requestMetadata(req);
  try {
    const [row] = await tx`
      INSERT INTO administrator_audit_log
        (actor_user_id, actor_role, action, target_type, target_id,
         request_id, ip_address, user_agent, reason, before_value,
         after_value, metadata)
      VALUES
        (${actorUserId}, ${actorRole}, ${String(action).slice(0, 120)},
         ${targetType}, ${targetId == null ? null : String(targetId).slice(0, 255)},
         ${request.requestId}, ${request.ipAddress || null}, ${request.userAgent},
         ${reason ? String(reason).slice(0, 4000) : null},
         ${before == null ? null : JSON.stringify(redact(before))}::jsonb,
         ${after == null ? null : JSON.stringify(redact(after))}::jsonb,
         ${JSON.stringify(redact(metadata || {}))}::jsonb)
      RETURNING id, created_at
    `;
    return row;
  } catch (error) {
    logger.error("administratorAudit.write.failed", { action, actorUserId, error: error.message });
    throw error;
  }
};

export const listAuditLogs = async (input = {}) => {
  const filters = normalizeAuditFilters(input);
  const offset = (filters.page - 1) * filters.pageSize;
  const [total, rows] = await Promise.all([
    countAuditLogs(filters),
    fetchAuditLogs(filters, { limit: filters.pageSize, offset }),
  ]);
  return {
    rows: rows.map(sanitizeAuditLogRow),
    total,
    page: filters.page,
    page_size: filters.pageSize,
  };
};

export const exportAuditLogs = async (input = {}) => {
  const filters = normalizeAuditFilters(input);
  const [total, rows] = await Promise.all([
    countAuditLogs(filters),
    fetchAuditLogs(filters, { limit: MAX_EXPORT_ROWS + 1 }),
  ]);
  const truncated = rows.length > MAX_EXPORT_ROWS;
  return {
    rows: rows.slice(0, MAX_EXPORT_ROWS).map(sanitizeAuditLogRow),
    total,
    truncated,
    limit: MAX_EXPORT_ROWS,
  };
};

export const escapeCsvCell = (value) => {
  let text;
  if (value instanceof Date) text = value.toISOString();
  else if (value != null && typeof value === "object") text = JSON.stringify(redact(value));
  else text = String(redact(value) ?? "");

  // Quoting alone does not stop spreadsheet formula evaluation.
  if (/^[\t\r\n]/.test(text) || /^[\u0000-\u0020]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
};

export const buildAuditCsv = (rows) => [
  AUDIT_CSV_COLUMNS.join(","),
  ...rows.map((row) => AUDIT_CSV_COLUMNS.map((column) => escapeCsvCell(row[column])).join(",")),
].join("\r\n");

export const auditAdministratorMutation = (namespace) => (req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const startedAt = Date.now();
  res.once("finish", () => {
    const role = req.auth?.role;
    if (!req.auth?.userId || !["root", "admin"].includes(role)) return;
    writeAuditLog({
      req,
      actorUserId: req.auth.userId,
      actorRole: role,
      action: `${namespace}.${req.method.toLowerCase()}`,
      targetType: namespace,
      targetId: req.params?.id
        || req.params?.userId
        || req.params?.ownerUserId
        || req.params?.entryId
        || req.params?.requestId
        || req.params?.resourceId
        || req.params?.orderNo
        || null,
      reason: req.body?.reason || req.body?.note || null,
      after: { request_body: req.body || null, response_status: res.statusCode },
      metadata: { path: req.originalUrl, duration_ms: Date.now() - startedAt },
    }).catch(() => {});
  });
  return next();
};

export { redact as redactAuditValue };
