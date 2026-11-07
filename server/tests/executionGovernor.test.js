import assert from "node:assert/strict";
import test from "node:test";

import { ExecutionGovernorPort } from "../ports/executionGovernorPort.js";
import { ExecutionGovernorService } from "../services/executionGovernorService.js";

class FakeGovernorStore extends ExecutionGovernorPort {
  constructor() {
    super();
    this.calls = [];
    this.nextLease = 1;
    this.active = new Set();
  }

  async admit(request) {
    this.calls.push(["admit", request]);
    const leaseId = `lease-${this.nextLease++}`;
    this.active.add(leaseId);
    return { admitted: true, leaseId, policy: { maxPerMinute: 5 } };
  }

  async heartbeat(input) {
    this.calls.push(["heartbeat", input]);
    return { leaseId: input.leaseId };
  }

  async complete(input) {
    this.calls.push(["complete", input]);
    this.active.delete(input.leaseId);
    return { leaseId: input.leaseId, state: "completed" };
  }

  async release(input) {
    this.calls.push(["release", input]);
    this.active.delete(input.leaseId);
    return { leaseId: input.leaseId, state: input.outcome };
  }
}

test("execution governor normalizes admission and keeps provider-independent inputs", async () => {
  const store = new FakeGovernorStore();
  const service = new ExecutionGovernorService({ store, clock: () => Date.parse("2026-08-06T12:00:00.000Z") });
  const admission = await service.admit({
    userId: "user-1",
    membershipTier: "PRO",
    operationKey: "mcp.call.external",
    queueName: "mcp",
    idempotencyKey: "mcp-call-123456",
  });

  assert.equal(admission.admitted, true);
  assert.equal(admission.replayed, false);
  assert.equal(store.calls[0][1].membershipTier, "pro");
  assert.equal(store.calls[0][1].state, "running");
  assert.equal(store.calls[0][1].now.toISOString(), "2026-08-06T12:00:00.000Z");
});

test("execution governor run releases failed work and preserves the original error", async () => {
  const store = new FakeGovernorStore();
  const service = new ExecutionGovernorService({ store });
  await assert.rejects(
    service.run({ userId: "user-1", operationKey: "workflow.node" }, async () => {
      throw Object.assign(new Error("provider down"), { code: "UPSTREAM_DOWN" });
    }),
    (error) => error.code === "UPSTREAM_DOWN",
  );
  assert.equal(store.calls.at(-1)[0], "release");
  assert.equal(store.calls.at(-1)[1].outcome, "failed");
  assert.equal(store.active.size, 0);
});

test("execution governor rejects malformed identities before touching the adapter", async () => {
  const store = new FakeGovernorStore();
  const service = new ExecutionGovernorService({ store });
  await assert.rejects(
    service.admit({ userId: "", operationKey: "canvas_agent_plan" }),
    (error) => error.code === "INVALID_USER_ID",
  );
  assert.equal(store.calls.length, 0);
});

test("generation execution forwards its idempotency key to admission", async () => {
  const admissions = [];
  const governor = {
    async admit(request) {
      admissions.push(request);
      return { admitted: true, leaseId: "lease-generation" };
    },
    async complete() {},
    async release() {},
  };
  const generationApplication = {
    async generateImage(request) {
      return { kind: "completed", request };
    },
    async generateVideo(request) {
      return { kind: "queued", request };
    },
  };
  const { GenerationExecutionService } = await import("../services/generationExecutionService.js");
  const service = new GenerationExecutionService({ generationApplication, governor });

  await service.generateImage({
    userId: "user-1",
    membershipTier: "free",
    idempotencyKey: "generation-request-123456",
    sceneKey: "freeform_image",
  });

  assert.equal(admissions[0].idempotencyKey, "generation-request-123456");
});
