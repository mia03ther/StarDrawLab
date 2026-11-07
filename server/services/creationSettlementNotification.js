import sql from "../configs/db.js";
import { sendJobSettlementNotification } from "./emailService.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const DEFAULT_RETRY_AFTER_MS = 5 * 60 * 1_000;

const bounded = (value, max) => String(value ?? "").trim().slice(0, max);
const validEmail = (value) => {
  const candidate = bounded(value, 320).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate) ? candidate : null;
};

const rows = async (client, query, values = []) => {
  if (typeof client?.unsafe === "function") {
    const result = await client.unsafe(query, values);
    return Array.isArray(result) ? result : result?.rows || [];
  }
  if (typeof client?.query === "function") {
    const result = await client.query(query, values);
    return result?.rows || result || [];
  }
  throw new TypeError("A postgres-compatible SQL client is required");
};

const limitValue = (value) => Math.min(MAX_LIMIT, Math.max(1, Number(value) || DEFAULT_LIMIT));
const retryValue = (value) => Math.max(1_000, Number(value) || DEFAULT_RETRY_AFTER_MS);

const claim = async (sqlClient, creationId, retryAfterMs) => {
  if (typeof sqlClient?.begin !== "function") throw new TypeError("Creation notifications require transactions");
  return sqlClient.begin(async (tx) => {
    const [row] = await rows(tx, `/* creation-notification:claim */
      SELECT creations.id, creations.user_id, creations.type, creations.scene_name,
             creations.status, user_profiles.email, user_profiles.display_name
      FROM creations
      LEFT JOIN user_profiles ON user_profiles.user_id = creations.user_id
      WHERE creations.id = $1
        AND creations.status IN ('completed', 'failed')
        AND creations.completion_notification_sent_at IS NULL
        AND creations.completion_notification_skipped_at IS NULL
        AND (creations.completion_notification_claimed_at IS NULL
          OR creations.completion_notification_claimed_at <= NOW() - ($2 * INTERVAL '1 millisecond'))
      FOR UPDATE OF creations`, [creationId, retryAfterMs]);
    if (!row) return null;
    const [claimed] = await rows(tx, `/* creation-notification:mark-claimed */
      UPDATE creations
      SET completion_notification_claimed_at = NOW(), updated_at = updated_at
      WHERE id = $1 AND completion_notification_sent_at IS NULL
      RETURNING id`, [creationId]);
    return claimed ? row : null;
  });
};

const finish = async (sqlClient, creationId, { sent = false, skipped = false, error = null } = {}) => {
  const safeError = error ? bounded(error, 500) : null;
  await rows(sqlClient, `/* creation-notification:finish */
    UPDATE creations
    SET completion_notification_sent_at = CASE WHEN $2::boolean THEN NOW() ELSE completion_notification_sent_at END,
        completion_notification_skipped_at = CASE WHEN $3::boolean THEN NOW() ELSE completion_notification_skipped_at END,
        completion_notification_claimed_at = CASE WHEN $2::boolean OR $3::boolean THEN NULL ELSE NOW() END,
        completion_notification_last_error = $4,
        updated_at = updated_at
    WHERE id = $1`, [creationId, sent, skipped, safeError]);
};

/**
 * Sends one completion/failure email per direct generation. Claims are short
 * leases so multiple API processes cannot send duplicates, while SMTP errors
 * leave the creation state untouched and make the notification retryable.
 */
export const processCreationSettlementNotifications = async ({
  sqlClient = sql,
  limit = DEFAULT_LIMIT,
  retryAfterMs = DEFAULT_RETRY_AFTER_MS,
  sendNotification = sendJobSettlementNotification,
} = {}) => {
  const safeLimit = limitValue(limit);
  const safeRetryAfterMs = retryValue(retryAfterMs);
  const candidates = await rows(sqlClient, `/* creation-notification:pending */
    SELECT id
    FROM creations
    WHERE status IN ('completed', 'failed')
      AND completion_notification_sent_at IS NULL
      AND completion_notification_skipped_at IS NULL
      AND (completion_notification_claimed_at IS NULL
        OR completion_notification_claimed_at <= NOW() - ($1 * INTERVAL '1 millisecond'))
    ORDER BY updated_at ASC, id ASC
    LIMIT $2`, [safeRetryAfterMs, safeLimit]);

  const summary = { scanned: candidates.length, claimed: 0, sent: 0, skipped: 0, failed: 0 };
  for (const candidate of candidates) {
    const creation = await claim(sqlClient, candidate.id, safeRetryAfterMs);
    if (!creation) continue;
    summary.claimed += 1;
    const recipient = validEmail(creation.email);
    if (!recipient) {
      await finish(sqlClient, creation.id, { skipped: true, error: "missing_database_recipient" });
      summary.skipped += 1;
      continue;
    }
    try {
      const result = await sendNotification({
        to: recipient,
        displayName: creation.display_name,
        taskId: `creation:${creation.id}`,
        jobType: `creation.${bounded(creation.type, 40) || "generation"}`,
        outcome: creation.status,
      });
      if (result?.sent) {
        await finish(sqlClient, creation.id, { sent: true });
        summary.sent += 1;
      } else {
        await finish(sqlClient, creation.id, { skipped: true, error: result?.reason || "delivery_unavailable" });
        summary.skipped += 1;
      }
    } catch (error) {
      await finish(sqlClient, creation.id, { error: error?.code || "delivery_failed" });
      summary.failed += 1;
    }
  }
  return summary;
};

export { DEFAULT_LIMIT, MAX_LIMIT };
