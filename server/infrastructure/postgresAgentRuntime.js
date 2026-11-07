import { AgentApprovalStorePort } from "../ports/agentToolPort.js";

const MAX_METADATA_BYTES = 64 * 1024;

const safeJson = (value, label) => {
  const normalized = value && typeof value === "object" ? value : {};
  const serialized = JSON.stringify(normalized);
  if (Buffer.byteLength(serialized, "utf8") > MAX_METADATA_BYTES) {
    throw Object.assign(new Error(`${label} is too large`), {
      status: 400,
      code: "AGENT_METADATA_TOO_LARGE",
    });
  }
  return serialized;
};

const mapApproval = (row) => row ? ({
  id: String(row.id),
  userId: row.user_id,
  sessionId: row.session_id,
  toolKey: row.tool_key,
  parameterDigest: row.parameter_digest,
  tokenDigest: row.token_digest,
  status: row.status,
  reason: row.reason,
  metadata: row.metadata || {},
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  consumedAt: row.consumed_at,
  revokedAt: row.revoked_at,
}) : null;

const normalizeId = (value) => {
  const id = String(value ?? "").trim();
  if (!/^\d+$/.test(id)) return null;
  return id;
};

/**
 * PostgreSQL adapter for one-time Agent approval credentials.
 *
 * The application-facing approval module only sees create/consume/revoke.
 * Token material is never stored: the service passes this adapter a SHA-256
 * digest, and consume is protected by a row lock so concurrent requests
 * cannot spend one approval twice.
 */
export class PostgresAgentApprovalStore extends AgentApprovalStorePort {
  #sql;

  constructor({ sqlClient } = {}) {
    super();
    if (!sqlClient || typeof sqlClient.begin !== "function") {
      throw new TypeError("PostgresAgentApprovalStore requires a transactional SQL client");
    }
    this.#sql = sqlClient;
  }

  async createApproval(record) {
    const [row] = await this.#sql`
      INSERT INTO agent_approval_credentials
        (user_id, session_id, tool_key, parameter_digest, token_digest,
         status, reason, metadata, created_at, expires_at)
      VALUES
        (${record.userId}, ${record.sessionId}, ${record.toolKey}, ${record.parameterDigest},
         ${record.tokenDigest}, ${record.status || "issued"}, ${String(record.reason || "").slice(0, 500)},
         ${safeJson(record.metadata, "approval metadata")}::jsonb,
         ${record.createdAt}, ${record.expiresAt})
      RETURNING id, user_id, session_id, tool_key, parameter_digest, token_digest,
                status, reason, metadata, created_at, expires_at, consumed_at, revoked_at
    `;
    return mapApproval(row);
  }

  async consumeApproval({ tokenDigest, userId, sessionId, toolKey, parameterDigest, now }) {
    return this.#sql.begin(async (tx) => {
      const [row] = await tx`
        SELECT id, user_id, session_id, tool_key, parameter_digest, token_digest,
               status, reason, metadata, created_at, expires_at, consumed_at, revoked_at
        FROM agent_approval_credentials
        WHERE token_digest = ${tokenDigest}
        FOR UPDATE
      `;
      if (!row) return { status: "not_found", record: null };

      const record = mapApproval(row);
      if (record.status !== "issued") {
        return {
          status: record.status === "consumed" ? "already_consumed" : record.status,
          record,
        };
      }

      const nowDate = new Date(now);
      if (new Date(record.expiresAt).getTime() <= nowDate.getTime()) {
        const [expired] = await tx`
          UPDATE agent_approval_credentials
          SET status = 'expired', updated_at = NOW()
          WHERE id = ${row.id} AND status = 'issued'
          RETURNING id, user_id, session_id, tool_key, parameter_digest, token_digest,
                    status, reason, metadata, created_at, expires_at, consumed_at, revoked_at
        `;
        return { status: "expired", record: mapApproval(expired || row) };
      }

      if (record.userId !== userId || record.sessionId !== sessionId || record.toolKey !== toolKey) {
        return { status: "binding_mismatch", record };
      }
      if (record.parameterDigest !== parameterDigest) {
        return { status: "parameter_mismatch", record };
      }

      const [consumed] = await tx`
        UPDATE agent_approval_credentials
        SET status = 'consumed', consumed_at = ${nowDate}, updated_at = NOW()
        WHERE id = ${row.id} AND status = 'issued'
        RETURNING id, user_id, session_id, tool_key, parameter_digest, token_digest,
                  status, reason, metadata, created_at, expires_at, consumed_at, revoked_at
      `;
      if (!consumed) return { status: "already_consumed", record };
      return { status: "consumed", record: mapApproval(consumed) };
    });
  }

  async revokeApproval({ approvalId, tokenDigest, userId = null, now }) {
    const owner = userId == null ? null : String(userId);
    const id = normalizeId(approvalId);
    // Keep the two supported selectors explicit so values remain parameterized.
    if (id) {
      const [row] = await this.#sql`
        UPDATE agent_approval_credentials
        SET status = 'revoked', revoked_at = ${now}, updated_at = NOW()
        WHERE id = ${id} AND status = 'issued'
          AND (${owner}::varchar IS NULL OR user_id = ${owner})
        RETURNING id, user_id, session_id, tool_key, parameter_digest, token_digest,
                  status, reason, metadata, created_at, expires_at, consumed_at, revoked_at
      `;
      return mapApproval(row);
    }
    if (!tokenDigest) return null;
    const [row] = await this.#sql`
      UPDATE agent_approval_credentials
      SET status = 'revoked', revoked_at = ${now}, updated_at = NOW()
      WHERE token_digest = ${tokenDigest} AND status = 'issued'
        AND (${owner}::varchar IS NULL OR user_id = ${owner})
      RETURNING id, user_id, session_id, tool_key, parameter_digest, token_digest,
                status, reason, metadata, created_at, expires_at, consumed_at, revoked_at
    `;
    return mapApproval(row);
  }
}

/** Writes runtime events without ever persisting tool parameters or tokens. */
export class PostgresAgentAuditSink {
  #sql;

  constructor({ sqlClient } = {}) {
    if (!sqlClient) throw new TypeError("PostgresAgentAuditSink requires a SQL client");
    this.#sql = sqlClient;
  }

  async append(event) {
    const metadata = safeJson(event.metadata, "Agent audit metadata");
    const [row] = await this.#sql`
      INSERT INTO agent_tool_audit_events
        (event_type, outcome, actor_type, user_id, session_id, tool_key,
         approval_id, parameter_digest, reason_code, metadata, created_at)
      VALUES
        (${String(event.eventType || "agent.tool.unknown").slice(0, 80)},
         ${String(event.outcome || "failed").slice(0, 24)}, 'agent',
         ${event.userId}, ${event.sessionId}, ${event.toolKey},
         ${event.approvalId == null ? null : event.approvalId},
         ${event.parameterDigest || null}, ${event.reasonCode || null},
         ${metadata}::jsonb, ${event.occurredAt || new Date()})
      RETURNING id, created_at
    `;
    return row;
  }
}
