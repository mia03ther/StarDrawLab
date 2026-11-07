import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  AgentApprovalStorePort,
  requireNonEmptyIdentifier,
} from "../ports/agentToolPort.js";

const DEFAULT_TTL_SECONDS = 300;
const MAX_TTL_SECONDS = 3600;

const fail = (message, { code = "INVALID_AGENT_APPROVAL", status = 400, ...extra } = {}) => Object.assign(new Error(message), {
  status,
  code,
  ...extra,
});

const toDate = (value, name) => {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw fail(`${name} must be a valid date`);
  return date;
};

const safeString = (value, name, maxLength = 255) => {
  const result = requireNonEmptyIdentifier(value, name);
  if (result.length > maxLength) throw fail(`${name} is too long`);
  return result;
};

const canonicalize = (value) => {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") return null;
  return value;
};

export const hashAgentToolParameters = (parameters) => createHash("sha256")
  .update(JSON.stringify(canonicalize(parameters ?? null)))
  .digest("hex");

const hashApprovalToken = (token) => createHash("sha256").update(String(token)).digest("hex");

const auditEvent = ({ eventType, outcome, approvalId = null, userId, sessionId, toolKey, parameterDigest, reasonCode = null, occurredAt, metadata = {} }) => ({
  eventType,
  outcome,
  actorType: "agent",
  userId,
  sessionId,
  toolKey,
  approvalId,
  parameterDigest,
  reasonCode,
  occurredAt: new Date(occurredAt).toISOString(),
  metadata: structuredClone(metadata),
});

const emit = async (sink, event) => {
  if (!sink) return;
  if (typeof sink === "function") return sink(event);
  if (typeof sink.append === "function") return sink.append(event);
  throw new TypeError("Agent approval audit sink must be a function or expose append(event)");
};

export class InMemoryAgentApprovalStore extends AgentApprovalStorePort {
  #records = new Map();
  #nextId = 1;

  createApproval(record) {
    const stored = { ...structuredClone(record), id: record.id ?? String(this.#nextId++) };
    this.#records.set(stored.tokenDigest, stored);
    return structuredClone(stored);
  }

  consumeApproval({ tokenDigest, userId, sessionId, toolKey, parameterDigest, now }) {
    const record = this.#records.get(tokenDigest);
    if (!record) return { status: "not_found", record: null };
    if (record.status !== "issued") return { status: record.status === "consumed" ? "already_consumed" : record.status, record: structuredClone(record) };
    if (new Date(now).getTime() >= new Date(record.expiresAt).getTime()) {
      record.status = "expired";
      return { status: "expired", record: structuredClone(record) };
    }
    if (record.userId !== userId || record.sessionId !== sessionId || record.toolKey !== toolKey) {
      return { status: "binding_mismatch", record: structuredClone(record) };
    }
    if (!timingSafeEqual(Buffer.from(record.parameterDigest, "hex"), Buffer.from(parameterDigest, "hex"))) {
      return { status: "parameter_mismatch", record: structuredClone(record) };
    }
    record.status = "consumed";
    record.consumedAt = new Date(now).toISOString();
    return { status: "consumed", record: structuredClone(record) };
  }

  revokeApproval({ approvalId, tokenDigest, userId = null, now }) {
    const record = approvalId != null
      ? [...this.#records.values()].find((item) => String(item.id) === String(approvalId))
      : this.#records.get(tokenDigest);
    if (!record || record.status !== "issued") return null;
    if (userId != null && record.userId !== userId) return null;
    record.status = "revoked";
    record.revokedAt = new Date(now).toISOString();
    return structuredClone(record);
  }
}

export class AgentApprovalService {
  #store;
  #clock;
  #tokenGenerator;
  #auditSink;

  constructor({ store = new InMemoryAgentApprovalStore(), clock = () => new Date(), tokenGenerator = () => randomBytes(32).toString("base64url"), auditSink = null } = {}) {
    if (!store || typeof store.createApproval !== "function" || typeof store.consumeApproval !== "function") {
      throw new TypeError("AgentApprovalService requires an AgentApprovalStorePort");
    }
    this.#store = store;
    this.#clock = clock;
    this.#tokenGenerator = tokenGenerator;
    this.#auditSink = auditSink;
  }

  async issueApproval({ userId, sessionId, toolKey, parameters, reason = "", expiresInSeconds = DEFAULT_TTL_SECONDS, metadata = {} } = {}) {
    const normalizedUserId = safeString(userId, "userId");
    const normalizedSessionId = safeString(sessionId, "sessionId");
    const normalizedToolKey = safeString(toolKey, "toolKey").toLowerCase();
    const ttl = Number(expiresInSeconds);
    if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > MAX_TTL_SECONDS) {
      throw fail(`expiresInSeconds must be an integer between 1 and ${MAX_TTL_SECONDS}`);
    }
    const now = toDate(this.#clock(), "clock");
    const expiresAt = new Date(now.getTime() + ttl * 1000);
    const parameterDigest = hashAgentToolParameters(parameters);
    const approvalToken = String(this.#tokenGenerator());
    if (!approvalToken || approvalToken.length < 16) throw fail("Approval token generator returned an unsafe token", { code: "INVALID_APPROVAL_TOKEN" });
    const record = await this.#store.createApproval({
      userId: normalizedUserId,
      sessionId: normalizedSessionId,
      toolKey: normalizedToolKey,
      parameterDigest,
      tokenDigest: hashApprovalToken(approvalToken),
      status: "issued",
      reason: String(reason || "").trim().slice(0, 500),
      metadata: structuredClone(metadata && typeof metadata === "object" ? metadata : {}),
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });
    const event = auditEvent({
      eventType: "agent.approval.issued",
      outcome: "issued",
      approvalId: record.id,
      userId: normalizedUserId,
      sessionId: normalizedSessionId,
      toolKey: normalizedToolKey,
      parameterDigest,
      occurredAt: now,
      metadata: { expiresAt: expiresAt.toISOString() },
    });
    await emit(this.#auditSink, event);
    return {
      approvalId: record.id,
      approvalToken,
      parameterDigest,
      expiresAt: expiresAt.toISOString(),
      auditEvent: event,
    };
  }

  createApprovalCredential(input) {
    return this.issueApproval(input);
  }

  async consumeApproval({ approvalToken, token, userId, sessionId, toolKey, parameters } = {}) {
    const rawToken = approvalToken || token;
    const normalizedUserId = safeString(userId, "userId");
    const normalizedSessionId = safeString(sessionId, "sessionId");
    const normalizedToolKey = safeString(toolKey, "toolKey").toLowerCase();
    if (!rawToken || String(rawToken).length < 16) throw fail("A valid approval token is required", { code: "APPROVAL_REQUIRED", status: 403 });
    const now = toDate(this.#clock(), "clock");
    const parameterDigest = hashAgentToolParameters(parameters);
    const result = await this.#store.consumeApproval({
      tokenDigest: hashApprovalToken(rawToken),
      userId: normalizedUserId,
      sessionId: normalizedSessionId,
      toolKey: normalizedToolKey,
      parameterDigest,
      now: now.toISOString(),
    });
    if (!result || result.status !== "consumed") {
      const record = result?.record;
      const reasonCode = {
        not_found: "APPROVAL_INVALID",
        already_consumed: "APPROVAL_ALREADY_USED",
        expired: "APPROVAL_EXPIRED",
        revoked: "APPROVAL_REVOKED",
        binding_mismatch: "APPROVAL_BINDING_MISMATCH",
        parameter_mismatch: "APPROVAL_PARAMETER_MISMATCH",
      }[result?.status] || "APPROVAL_INVALID";
      const event = auditEvent({
        eventType: "agent.approval.denied",
        outcome: "denied",
        approvalId: record?.id || null,
        userId: normalizedUserId,
        sessionId: normalizedSessionId,
        toolKey: normalizedToolKey,
        parameterDigest,
        reasonCode,
        occurredAt: now,
      });
      await emit(this.#auditSink, event);
      throw fail("Agent approval credential is invalid or cannot be used", { code: reasonCode, status: 403, auditEvent: event });
    }
    const event = auditEvent({
      eventType: "agent.approval.consumed",
      outcome: "approved",
      approvalId: result.record.id,
      userId: normalizedUserId,
      sessionId: normalizedSessionId,
      toolKey: normalizedToolKey,
      parameterDigest,
      occurredAt: now,
    });
    await emit(this.#auditSink, event);
    return { approved: true, approvalId: result.record.id, consumedAt: result.record.consumedAt, auditEvent: event };
  }

  consumeApprovalCredential(input) {
    return this.consumeApproval(input);
  }

  async revokeApproval({ approvalId, approvalToken, token, userId } = {}) {
    if (approvalId == null && !(approvalToken || token)) throw fail("approvalId or approvalToken is required");
    const now = toDate(this.#clock(), "clock");
    const result = await this.#store.revokeApproval({
      approvalId,
      tokenDigest: approvalToken || token ? hashApprovalToken(approvalToken || token) : null,
      userId: userId == null ? null : safeString(userId, "userId"),
      now: now.toISOString(),
    });
    if (!result) return { revoked: false };
    await emit(this.#auditSink, auditEvent({
      eventType: "agent.approval.revoked",
      outcome: "denied",
      approvalId: result.id,
      userId: result.userId,
      sessionId: result.sessionId,
      toolKey: result.toolKey,
      parameterDigest: result.parameterDigest,
      reasonCode: "APPROVAL_REVOKED",
      occurredAt: now,
    }));
    return { revoked: true, approvalId: result.id };
  }
}
