import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

globalThis.__meteredAgentSql = () => { throw new Error("database access is not expected"); };

const stubbedSpecifiers = new Map([
  ["../configs/db.js", "metered-agent-test:db"],
  ["../configs/logger.js", "metered-agent-test:logger"],
  ["./membershipService.js", "metered-agent-test:membership"],
  ["./modelConfigurationService.js", "metered-agent-test:model"],
  ["./pointsService.js", "metered-agent-test:points"],
]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const url = stubbedSpecifiers.get(specifier);
    return url ? { shortCircuit: true, url } : nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "metered-agent-test:db") {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          const sql = (...args) => globalThis.__meteredAgentSql(...args);
          sql.begin = async (operation) => operation(sql);
          export default sql;
        `,
      };
    }
    if (url === "metered-agent-test:logger") {
      return { format: "module", shortCircuit: true, source: "export default { error() {}, warn() {}, info() {} };" };
    }
    if (url === "metered-agent-test:membership") {
      return { format: "module", shortCircuit: true, source: "export const checkAndGrantBonus = async () => {};" };
    }
    if (url === "metered-agent-test:model") {
      return {
        format: "module",
        shortCircuit: true,
        source: "export const resolveActiveModelRoute = async () => ({ id: 8, model_key: 'gpt-5.6-sol', provider_key: 'canvas_agent', upstream_model_id: 'gpt-5.6-sol' });",
      };
    }
    if (url === "metered-agent-test:points") {
      return {
        format: "module",
        shortCircuit: true,
        source: "export const chargePoints = async () => {}; export const releasePoints = async () => {}; export const reservePoints = async () => {}; export const resolveCharge = async () => 1;",
      };
    }
    return nextLoad(url, context);
  },
});

const {
  executeMeteredAgentOperation,
  hashMeteredAgentRequest,
  normalizeMeteredAgentIdempotencyKey,
} = await import(
  "../services/meteredAgentOperationService.js"
);

test("metered Agent request hashes are canonical across object key ordering", () => {
  const left = hashMeteredAgentRequest({ instruction: "draw", canvas: { id: "1", title: "A" }, ids: ["x", "y"] });
  const right = hashMeteredAgentRequest({ ids: ["x", "y"], canvas: { title: "A", id: "1" }, instruction: "draw" });
  const changed = hashMeteredAgentRequest({ instruction: "draw again", canvas: { id: "1", title: "A" }, ids: ["x", "y"] });

  assert.equal(left, right);
  assert.notEqual(left, changed);
  assert.match(left, /^[0-9a-f]{64}$/);
});

test("metered Agent idempotency keys use a bounded safe character set", () => {
  assert.equal(normalizeMeteredAgentIdempotencyKey(" canvas-agent:abc_123 "), "canvas-agent:abc_123");
  for (const key of ["short", "contains space", "包含中文字符", "x".repeat(129)]) {
    assert.throws(
      () => normalizeMeteredAgentIdempotencyKey(key),
      (error) => error?.code === "INVALID_IDEMPOTENCY_KEY" && error?.status === 400,
    );
  }
});

test("a duplicate Agent request waits for the original operation and replays its result", async () => {
  const previousWait = process.env.AGENT_IDEMPOTENCY_WAIT_MS;
  const previousPoll = process.env.AGENT_IDEMPOTENCY_POLL_MS;
  process.env.AGENT_IDEMPOTENCY_WAIT_MS = "250";
  process.env.AGENT_IDEMPOTENCY_POLL_MS = "5";
  const requestPayload = { instruction: "生成个视频", language: "zh" };
  const requestHash = hashMeteredAgentRequest(requestPayload);
  let reads = 0;
  let invokes = 0;
  globalThis.__meteredAgentSql = async (strings) => {
    const statement = strings.join("?").replace(/\s+/g, " ").trim();
    assert.match(statement, /FROM metered_agent_operations/);
    reads += 1;
    return [{
      id: 20,
      operation_type: "global_agent_plan",
      request_hash: requestHash,
      status: reads < 3 ? "reserved" : "completed",
      points_cost: 1,
      response_snapshot: { summary: "Plan ready", calls: [{ toolKey: "media.generate.video" }] },
      error_code: null,
      error_message: null,
    }];
  };
  const governor = {
    async admit() {
      throw Object.assign(new Error("This execution is already in progress"), {
        status: 409,
        code: "EXECUTION_IN_PROGRESS",
        leaseId: "29",
      });
    },
  };

  try {
    const result = await executeMeteredAgentOperation({
      userId: "user-1",
      membershipTier: "free",
      operationType: "global_agent_plan",
      idempotencyKey: "global-agent-plan:duplicate-1",
      requestPayload,
      governor,
      invoke: async () => {
        invokes += 1;
        return { summary: "must not run" };
      },
    });

    assert.equal(reads, 3);
    assert.equal(invokes, 0);
    assert.equal(result.replayed, true);
    assert.equal(result.operationId, 20);
    assert.equal(result.result.calls[0].toolKey, "media.generate.video");
  } finally {
    globalThis.__meteredAgentSql = () => { throw new Error("database access is not expected"); };
    if (previousWait == null) delete process.env.AGENT_IDEMPOTENCY_WAIT_MS;
    else process.env.AGENT_IDEMPOTENCY_WAIT_MS = previousWait;
    if (previousPoll == null) delete process.env.AGENT_IDEMPOTENCY_POLL_MS;
    else process.env.AGENT_IDEMPOTENCY_POLL_MS = previousPoll;
  }
});
