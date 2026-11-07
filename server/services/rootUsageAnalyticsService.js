import sql from "../configs/db.js";

const VALID_RECORD_TYPES = new Set(["points", "generation", "agent"]);
const VALID_OUTPUT_TYPES = new Set(["image", "video", "agent"]);
const VALID_DATE = /^\d{4}-\d{2}-\d{2}$/;

const positiveInteger = (value, fallback, max) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? Math.min(max, Math.max(1, parsed)) : fallback;
};

const optionalText = (value, maxLength = 255) => {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, maxLength) : null;
};

const dateBoundary = (value, endOfDay = false) => {
  const text = optionalText(value, 10);
  if (!text) return null;
  if (!VALID_DATE.test(text)) {
    throw Object.assign(new Error("Date filters must use YYYY-MM-DD"), { status: 400, code: "INVALID_DATE_FILTER" });
  }
  return `${text}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`;
};

export const normalizeRootUsageFilters = (input = {}) => {
  const recordType = optionalText(input.recordType ?? input.record_type, 24);
  const outputType = optionalText(input.outputType ?? input.output_type, 24);
  return {
    page: positiveInteger(input.page, 1, 1_000_000),
    pageSize: positiveInteger(input.pageSize ?? input.page_size, 50, 100),
    query: optionalText(input.query, 160),
    userId: optionalText(input.userId ?? input.user_id, 255),
    recordType: VALID_RECORD_TYPES.has(recordType) ? recordType : null,
    outputType: VALID_OUTPUT_TYPES.has(outputType) ? outputType : null,
    model: optionalText(input.model, 120),
    status: optionalText(input.status, 48),
    entryType: optionalText(input.entryType ?? input.entry_type, 50),
    sourceType: optionalText(input.sourceType ?? input.source_type, 50),
    dateFrom: dateBoundary(input.dateFrom ?? input.date_from),
    dateTo: dateBoundary(input.dateTo ?? input.date_to, true),
  };
};

const parseJson = (value, fallback) => {
  if (value && typeof value === "object") return value;
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  return fallback;
};

/**
 * Root-only operational view. It deliberately combines immutable point
 * ledger rows with generation and Agent rows, while keeping each event type
 * distinguishable so statistics never double-count a charge.
 */
export const getRootUsageAnalytics = async (input = {}, { db = sql } = {}) => {
  const filters = normalizeRootUsageFilters(input);
  const pattern = filters.query ? `%${filters.query}%` : null;
  const offset = (filters.page - 1) * filters.pageSize;

  const [row] = await db`
    WITH directory AS (
      SELECT up.user_id, up.display_name, up.full_name,
             COALESCE(up.email, identity.email) AS email,
             identity.username
      FROM user_profiles up
      LEFT JOIN LATERAL (
        SELECT il.email, il.username
        FROM identity_links il
        WHERE il.stardraw_user_id = up.user_id
        ORDER BY il.last_seen_at DESC NULLS LAST, il.id DESC
        LIMIT 1
      ) identity ON TRUE
    ),
    activity AS (
      SELECT
        'points'::text AS record_type,
        pl.id::text AS record_id,
        pl.user_id,
        pl.created_at AS occurred_at,
        pl.entry_type AS action,
        pl.source_type,
        COALESCE(c.model, mao.model_key) AS model,
        COALESCE(c.type, CASE WHEN mao.id IS NOT NULL THEN 'agent' END) AS output_type,
        COALESCE(c.status, mao.status) AS status,
        pl.change_points,
        pl.held_points_change,
        CASE WHEN pl.entry_type = 'charge' THEN GREATEST(0, -pl.change_points) ELSE 0 END AS charged_points,
        CASE WHEN pl.entry_type = 'release' THEN GREATEST(0, -pl.held_points_change) ELSE 0 END AS released_points,
        0::bigint AS reserved_points,
        0::bigint AS input_tokens,
        0::bigint AS output_tokens,
        0::bigint AS cache_read_tokens,
        0::bigint AS cache_write_tokens,
        jsonb_build_object(
          'ledger_id', pl.id,
          'source_id', pl.source_id,
          'balance_after', pl.balance_after,
          'held_after', pl.held_after,
          'lot_id', pl.lot_id,
          'note', pl.note,
          'metadata', pl.metadata
        ) AS details
      FROM point_ledger pl
      LEFT JOIN creations c
        ON pl.source_type = 'creation' AND c.id::text = pl.source_id
      LEFT JOIN metered_agent_operations mao
        ON pl.source_type = 'metered_agent_operation' AND mao.id::text = pl.source_id

      UNION ALL

      SELECT
        'generation'::text,
        c.id::text,
        c.user_id,
        c.created_at,
        COALESCE(c.scene_key, c.type, 'generation'),
        c.provider,
        c.model,
        c.type,
        c.status,
        0::integer,
        0::integer,
        GREATEST(0, COALESCE(c.points_cost, 0)),
        0::integer,
        GREATEST(0, COALESCE(c.points_reserved, 0)),
        0::bigint,
        0::bigint,
        0::bigint,
        0::bigint,
        jsonb_build_object(
          'creation_id', c.id,
          'scene_key', c.scene_key,
          'scene_name', c.scene_name,
          'provider_status', c.provider_status,
          'task_id', c.task_id,
          'charge_status', c.charge_status,
          'generation_time_ms', c.generation_time_ms,
          'error_message', c.error_message,
          'size', c.meta_info->>'size',
          'seconds', c.meta_info->>'seconds'
        )
      FROM creations c

      UNION ALL

      SELECT
        'agent'::text,
        mao.id::text,
        mao.user_id,
        mao.created_at,
        mao.operation_type,
        'metered_agent_operation'::text,
        mao.model_key,
        'agent'::text,
        mao.status,
        0::integer,
        0::integer,
        GREATEST(0, COALESCE(mao.charged_points, 0)),
        0::integer,
        GREATEST(0, COALESCE(mao.reserved_points, mao.points_cost, 0)),
        GREATEST(0, COALESCE((mao.usage_snapshot->>'inputTokens')::bigint, 0)),
        GREATEST(0, COALESCE((mao.usage_snapshot->>'outputTokens')::bigint, 0)),
        GREATEST(0, COALESCE((mao.usage_snapshot->>'cacheReadTokens')::bigint, 0)),
        GREATEST(0, COALESCE((mao.usage_snapshot->>'cacheWriteTokens')::bigint, 0)),
        jsonb_build_object(
          'operation_id', mao.id,
          'request_idempotency_key', mao.request_idempotency_key,
          'operation_type', mao.operation_type,
          'error_code', mao.error_code,
          'error_message', mao.error_message,
          'usage', mao.usage_snapshot,
          'pricing', mao.pricing_snapshot
        )
      FROM metered_agent_operations mao
    ),
    filtered AS (
      SELECT activity.*, directory.display_name, directory.full_name,
             directory.email, directory.username
      FROM activity
      LEFT JOIN directory ON directory.user_id = activity.user_id
      WHERE (${filters.userId}::text IS NULL OR activity.user_id = ${filters.userId})
        AND (${filters.recordType}::text IS NULL OR activity.record_type = ${filters.recordType})
        AND (${filters.outputType}::text IS NULL OR activity.output_type = ${filters.outputType})
        AND (${filters.model}::text IS NULL OR activity.model = ${filters.model})
        AND (${filters.status}::text IS NULL OR activity.status = ${filters.status})
        AND (${filters.entryType}::text IS NULL OR activity.action = ${filters.entryType})
        AND (${filters.sourceType}::text IS NULL OR activity.source_type = ${filters.sourceType})
        AND (${filters.dateFrom}::timestamptz IS NULL OR activity.occurred_at >= ${filters.dateFrom})
        AND (${filters.dateTo}::timestamptz IS NULL OR activity.occurred_at <= ${filters.dateTo})
        AND (
          ${pattern}::text IS NULL
          OR activity.user_id ILIKE ${pattern}
          OR COALESCE(directory.display_name, '') ILIKE ${pattern}
          OR COALESCE(directory.full_name, '') ILIKE ${pattern}
          OR COALESCE(directory.email, '') ILIKE ${pattern}
          OR COALESCE(directory.username, '') ILIKE ${pattern}
          OR COALESCE(activity.record_id, '') ILIKE ${pattern}
          OR COALESCE(activity.model, '') ILIKE ${pattern}
          OR COALESCE(activity.action, '') ILIKE ${pattern}
          OR COALESCE(activity.source_type, '') ILIKE ${pattern}
        )
    ),
    daily AS (
      SELECT DATE_TRUNC('day', occurred_at)::date AS day,
             COUNT(*)::int AS events,
             COUNT(*) FILTER (WHERE record_type = 'generation')::int AS generations,
             COUNT(*) FILTER (WHERE record_type = 'agent')::int AS agent_calls,
             COALESCE(SUM(charged_points) FILTER (WHERE record_type = 'points' AND action = 'charge'), 0)::bigint AS charged_points,
             COALESCE(SUM(released_points) FILTER (WHERE record_type = 'points' AND action = 'release'), 0)::bigint AS released_points
      FROM filtered
      GROUP BY DATE_TRUNC('day', occurred_at)::date
      ORDER BY day ASC
    )
    SELECT
      COUNT(*)::int AS total,
      jsonb_build_object(
        'total_events', COUNT(*),
        'active_users', COUNT(DISTINCT user_id),
        'generation_events', COUNT(*) FILTER (WHERE record_type = 'generation'),
        'agent_calls', COUNT(*) FILTER (WHERE record_type = 'agent'),
        'completed_events', COUNT(*) FILTER (WHERE status IN ('completed', 'success', 'paid')),
        'failed_events', COUNT(*) FILTER (WHERE status IN ('failed', 'error', 'cancelled')),
        'points_charged', COALESCE(SUM(charged_points) FILTER (WHERE record_type = 'points' AND action = 'charge'), 0),
        'points_released', COALESCE(SUM(released_points) FILTER (WHERE record_type = 'points' AND action = 'release'), 0),
        'points_recharged', COALESCE(SUM(change_points) FILTER (WHERE record_type = 'points' AND change_points > 0), 0),
        'input_tokens', COALESCE(SUM(input_tokens), 0),
        'output_tokens', COALESCE(SUM(output_tokens), 0),
        'cache_read_tokens', COALESCE(SUM(cache_read_tokens), 0),
        'cache_write_tokens', COALESCE(SUM(cache_write_tokens), 0)
      ) AS summary,
      COALESCE((
        SELECT jsonb_agg(to_jsonb(page_row) ORDER BY page_row.occurred_at DESC, page_row.record_id DESC)
        FROM (
          SELECT * FROM filtered
          ORDER BY occurred_at DESC, record_id DESC
          LIMIT ${filters.pageSize} OFFSET ${offset}
        ) page_row
      ), '[]'::jsonb) AS records,
      COALESCE((SELECT jsonb_agg(to_jsonb(daily_row) ORDER BY daily_row.day ASC) FROM daily daily_row), '[]'::jsonb) AS trend
    FROM filtered
  `;

  return {
    records: parseJson(row?.records, []),
    trend: parseJson(row?.trend, []),
    summary: parseJson(row?.summary, {}),
    total: Number(row?.total || 0),
    page: filters.page,
    page_size: filters.pageSize,
    filters,
  };
};
