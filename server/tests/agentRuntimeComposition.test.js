import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!context.parentURL?.endsWith("/services/agentRuntimeComposition.js")) {
      return nextResolve(specifier, context);
    }
    const modules = new Map([
      ["../configs/db.js", "agent-composition-test:db"],
      ["./contentRecycleService.js", "agent-composition-test:content"],
      ["./executionGovernorComposition.js", "agent-composition-test:governor"],
      ["./generationApplicationService.js", "agent-composition-test:generation"],
      ["./mcpRuntimeComposition.js", "agent-composition-test:mcp"],
      ["./subscriptionService.js", "agent-composition-test:subscription"],
      ["./userOperationService.js", "agent-composition-test:user-operation"],
      ["./workflowRuntimeComposition.js", "agent-composition-test:workflow"],
    ]);
    const url = modules.get(specifier);
    return url ? { shortCircuit: true, url } : nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const unavailable = (exports) => ({
      format: "module",
      shortCircuit: true,
      source: exports,
    });
    if (url === "agent-composition-test:db") {
      return unavailable(`
        const sql = () => { throw new Error("database access forbidden"); };
        sql.begin = () => { throw new Error("database access forbidden"); };
        export default sql;
      `);
    }
    if (url === "agent-composition-test:content") {
      return unavailable("export const deleteOwnContent = async () => { throw new Error('default content dependency used'); };");
    }
    if (url === "agent-composition-test:governor") {
      return unavailable("export const getExecutionGovernor = () => { throw new Error('default governor dependency used'); };");
    }
    if (url === "agent-composition-test:generation") {
      return unavailable("export const getGenerationApplication = () => { throw new Error('default generation dependency used'); };");
    }
    if (url === "agent-composition-test:mcp") {
      return unavailable("export const getMcpToolRuntime = () => { throw new Error('default MCP dependency used'); };");
    }
    if (url === "agent-composition-test:subscription") {
      return unavailable(`
        export const createSubscriptionOrder = async () => { throw new Error("default payment dependency used"); };
        export const refundSubscriptionOrder = async () => { throw new Error("default refund dependency used"); };
      `);
    }
    if (url === "agent-composition-test:user-operation") {
      return unavailable("export const executeUserOperation = async () => { throw new Error('default user operation dependency used'); };");
    }
    if (url === "agent-composition-test:workflow") {
      return unavailable("export const getWorkflowRuntime = () => { throw new Error('default workflow dependency used'); };");
    }
    return nextLoad(url, context);
  },
});

const {
  AGENT_RUNTIME_TOOLS,
  buildRuntime,
  createDefaultAgentToolHandlers,
} = await import("../services/agentRuntimeComposition.js");

const compactSql = (strings) => strings.join("?").replace(/\s+/g, " ").trim();

const templateRow = (ownerUserId = "runtime-user", outputType = "image") => ({
  id: "template-1",
  scene_key: outputType === "video" ? "product-video" : "product-photo",
  scene_name: outputType === "video" ? "Product video" : "Product photo",
  output_type: outputType,
  target_provider: "image_provider",
  default_model: outputType === "video" ? "veo-3" : "nano-banana-2",
  default_seconds: outputType === "video" ? 8 : null,
  default_size: outputType === "video" ? "16:9" : "1024x1024",
  system_prompt: "Create a product photograph.",
  starter_prompt: "A watch on marble",
  placeholder_text: "Describe the product",
  requires_reference: false,
  tags: ["product"],
  visibility: "private",
  approval_status: "draft",
  required_membership_tier: "free",
  owner_user_id: ownerUserId,
  version: 2,
});

const createOfflineSql = ({ ownerUserId = "runtime-user", uploadRow = null } = {}) => {
  const calls = [];
  let canvas = {
    id: "canvas-1",
    title: "Storyboard",
    canvas_state: { elements: [], storyboard: { shots: [] } },
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
  };

  const query = async (strings, ...values) => {
    const statement = compactSql(strings);
    calls.push({ statement, values });
    if (statement.includes("FROM prompt_templates")) {
      return values.includes(ownerUserId)
        ? [templateRow(ownerUserId, values.includes("product-video") ? "video" : "image")]
        : [];
    }
    if (statement.includes("FROM user_content_uploads")) {
      return uploadRow && uploadRow.user_id === ownerUserId && values.includes(ownerUserId) ? [uploadRow] : [];
    }
    if (statement.includes("FROM canvases")) {
      return values.includes(ownerUserId) ? [{ ...canvas }] : [];
    }
    throw new Error(`Unexpected offline query: ${statement}`);
  };

  const tx = async (strings, ...values) => {
    const statement = compactSql(strings);
    calls.push({ statement, values });
    if (statement.startsWith("SELECT") && statement.includes("FROM canvases")) {
      return values.at(-1) === ownerUserId ? [{ ...canvas }] : [];
    }
    if (statement.startsWith("UPDATE canvases")) {
      assert.equal(values.at(-1), ownerUserId);
      const serializedState = statement.includes("SET title") ? values[1] : values[0];
      canvas = {
        ...canvas,
        title: statement.includes("SET title") ? values[0] : canvas.title,
        canvas_state: JSON.parse(serializedState),
        updated_at: "2026-08-07T00:00:00.000Z",
      };
      return [{ ...canvas }];
    }
    if (statement.startsWith("UPDATE prompt_templates")) {
      assert.equal(values[1], ownerUserId);
      return [{ ...templateRow(ownerUserId), approval_status: "pending" }];
    }
    throw new Error(`Unexpected offline transaction query: ${statement}`);
  };

  query.begin = async (operation) => operation(tx);
  return { sql: query, calls, getCanvas: () => canvas };
};

const approvalService = {
  async issueApproval() { return { approvalId: "approval-1" }; },
  async consumeApproval() { return { approved: true, approvalId: "approval-1" }; },
};

const handlerKeys = [
  "account.balance",
  "account.ledger.list",
  "billing.pay",
  "billing.refund",
  "canvas.asset.attach_creation",
  "canvas.asset.upload",
  "canvas.create",
  "canvas.edit",
  "canvas.export.image",
  "canvas.list",
  "canvas.patch",
  "canvas.read",
  "community.favorite",
  "community.get",
  "community.like",
  "community.list",
  "community.publication.get",
  "community.publish",
  "community.report",
  "community.unpublish",
  "content.delete",
  "content.notification.list",
  "content.notification.mark-read",
  "content.publish",
  "content.recycle.list",
  "content.recycle.restore",
  "creation.download",
  "creation.download.batch",
  "creation.export.csv",
  "creation.failed.delete",
  "creation.get",
  "creation.history",
  "digital-human.role.asset.upload",
  "digital-human.role.attach-creation",
  "digital-human.role.capture-link.get",
  "digital-human.role.capture-link.revoke",
  "digital-human.role.capture-link.rotate",
  "digital-human.role.create",
  "digital-human.role.list",
  "digital-human.script.optimize",
  "director3d.edit",
  "mcp.call.external",
  "mcp.connection.list",
  "mcp.connection.revoke",
  "mcp.connection.start",
  "mcp.server.list",
  "mcp.tool.list",
  "media.estimate",
  "media.generate.image",
  "media.generate.video",
  "media.remove-background",
  "media.remove-object",
  "model.list",
  "profile.avatar.upload",
  "profile.read",
  "profile.update",
  "storyboard.edit",
  "storyboard.patch",
  "subscription.order.get",
  "subscription.overview",
  "subscription.plan.list",
  "subscription.renewal.cancel",
  "task.cancel",
  "task.get",
  "task.list",
  "template.create",
  "template.delete",
  "template.export",
  "template.import",
  "template.preview.upload",
  "template.search",
  "template.update",
  "template.use",
  "timeline.edit",
  "timeline.render",
  "visual-parameter.list",
  "workflow.estimate",
  "workflow.events",
  "workflow.get",
  "workflow.run",
];

test("composition registers every supported built-in handler and excludes recharge", async () => {
  const { sql } = createOfflineSql();
  const handlers = createDefaultAgentToolHandlers({
    sqlClient: sql,
    workflowRuntimeFactory: () => ({ start: async () => ({}) }),
    generationApplicationFactory: () => ({ generateImage: async () => ({}), generateVideo: async () => ({}) }),
    mcpRuntimeFactory: () => ({ callTool: async () => ({}) }),
    deleteContent: async () => ({}),
    runUserOperation: async () => ({}),
    createOrder: async () => ({}),
    refundOrder: async () => ({}),
    purchasesEnabled: () => true,
  });

  const registeredToolKeys = AGENT_RUNTIME_TOOLS.map((tool) => tool.toolKey).sort();
  assert.deepEqual([...handlers.keys()].sort(), registeredToolKeys);
  assert.equal(handlers.has("billing.recharge"), false);
  assert.ok(registeredToolKeys.length > handlerKeys.length, "privileged Agent tools must extend the legacy user-only matrix");

  const runtime = buildRuntime({
    sqlClient: sql,
    handlers,
    approvalService,
    auditSink: null,
    governor: null,
  });
  assert.deepEqual(runtime.listTools().map((tool) => tool.toolKey).sort(), registeredToolKeys);

  const listedCanvases = await handlers.get("canvas.list")({ userId: "runtime-user", parameters: {} });
  assert.ok(Array.isArray(listedCanvases.canvases));
  assert.equal(listedCanvases.canvases[0].id, "canvas-1");

  const payment = runtime.assess({
    userId: "runtime-user",
    userRole: "user",
    agentMode: "full_access",
    sessionId: "session-1",
    toolKey: "billing.pay",
    parameters: { planKey: "pro-monthly" },
  });
  assert.equal(payment.requiresApproval, true);
  assert.equal(payment.reasonCode, "FULL_MODE_PAYMENT_REQUIRES_APPROVAL");

  const refund = runtime.assess({
    userId: "runtime-root",
    userRole: "root",
    agentMode: "full_access",
    sessionId: "session-1",
    toolKey: "billing.refund",
    parameters: { orderNo: "SO100" },
  });
  assert.equal(refund.requiresApproval, true);
  assert.equal(refund.reasonCode, "FULL_MODE_PAYMENT_REQUIRES_APPROVAL");

  const deleteAssessment = runtime.assess({
    userId: "runtime-user",
    userRole: "user",
    agentMode: "full_access",
    sessionId: "session-1",
    toolKey: "content.delete",
    parameters: { resourceType: "canvas", resourceId: "canvas-1" },
  });
  assert.equal(deleteAssessment.decision, "allow");

  const renewalCancellation = runtime.assess({
    userId: "runtime-user",
    userRole: "user",
    agentMode: "full_access",
    sessionId: "session-1",
    toolKey: "subscription.renewal.cancel",
    parameters: {},
  });
  assert.equal(renewalCancellation.decision, "allow");
  assert.equal(renewalCancellation.operationClass, "destructive");
});

test("privileged tool catalogs are filtered by the authenticated RBAC role", async () => {
  const { sql } = createOfflineSql();
  const handlers = createDefaultAgentToolHandlers({ sqlClient: sql });
  const runtime = buildRuntime({ sqlClient: sql, handlers, approvalService, auditSink: null, governor: null });
  const userKeys = new Set(runtime.listTools({ userRole: "user" }).map((tool) => tool.toolKey));
  const adminKeys = new Set(runtime.listTools({ userRole: "admin" }).map((tool) => tool.toolKey));
  const rootKeys = new Set(runtime.listTools({ userRole: "root" }).map((tool) => tool.toolKey));

  assert.equal([...userKeys].some((key) => key.startsWith("admin.") || key.startsWith("root.")), false);
  assert.equal(adminKeys.has("admin.user.list"), true);
  assert.equal(adminKeys.has("root.user.role.set"), false);
  assert.equal(rootKeys.has("admin.user.list"), true);
  assert.equal(rootKeys.has("root.user.role.set"), true);

  const forged = runtime.assess({
    userId: "runtime-user", userRole: "user", agentMode: "full_access", sessionId: "session-rbac",
    toolKey: "admin.user.list", parameters: {},
  });
  assert.equal(forged.decision, "deny");
  assert.equal(forged.reasonCode, "USER_RBAC_DENIED");
});

test("administrator handlers re-check permissions and bind actor identity to runtime context", async () => {
  const calls = [];
  const administratorRuntimeFactory = async () => ({
    access: {
      async listManagedUsers(input) { calls.push(["list", input]); return { rows: [], total: 0, page: 1, page_size: 50 }; },
      async setUserSuspension(input) { calls.push(["suspend", input]); return { user_id: input.targetUserId }; },
      async setUserRole(input) { calls.push(["role", input]); return { user_id: input.targetUserId, app_role: input.role }; },
    },
  });
  const handlers = createDefaultAgentToolHandlers({ sqlClient: async () => [], administratorRuntimeFactory });

  await assert.rejects(
    handlers.get("admin.user.list")({ userId: "ordinary", userRole: "user", parameters: {} }),
    (error) => error.code === "USER_RBAC_DENIED" && error.status === 403,
  );
  await handlers.get("admin.user.suspend")({
    userId: "admin-actor", userRole: "admin",
    parameters: { targetUserId: "target-user", reason: "Incident response" },
    context: { idempotencyKey: "agent-admin-suspend-0001" },
  });
  await assert.rejects(
    handlers.get("root.user.role.set")({
      userId: "admin-actor", userRole: "admin",
      parameters: { targetUserId: "target-user", role: "admin", reason: "Escalate" },
      context: { idempotencyKey: "agent-role-change-0001" },
    }),
    (error) => error.code === "USER_RBAC_DENIED" && error.status === 403,
  );
  await handlers.get("root.user.role.set")({
    userId: "root-actor", userRole: "root",
    parameters: { targetUserId: "target-user", role: "admin", reason: "Approved role change" },
    context: { idempotencyKey: "agent-role-change-0002" },
  });

  const suspension = calls.find(([name]) => name === "suspend")[1];
  assert.deepEqual(suspension.actor, { userId: "admin-actor", role: "admin" });
  assert.equal(suspension.targetUserId, "target-user");
  assert.equal(suspension.idempotencyKey, "agent-admin-suspend-0001");
  const roleChange = calls.find(([name]) => name === "role")[1];
  assert.deepEqual(roleChange.actor, { userId: "root-actor", role: "root" });
});

test("handlers bind application calls to runtime identity instead of parameter identity", async () => {
  const { sql, calls, getCanvas } = createOfflineSql();
  const delegated = [];
  const capture = (name) => async (input) => {
    delegated.push([name, input]);
    return { delegated: name };
  };
  const runUserOperation = async (input) => {
    delegated.push(["publish", {
      userId: input.userId,
      idempotencyKey: input.idempotencyKey,
      action: input.action,
      targetId: input.targetId,
    }]);
    return sql.begin((tx) => input.mutate(tx));
  };
  const workflow = { start: capture("workflow") };
  const generation = {
    generateImage: capture("image"),
    generateVideo: capture("video"),
  };
  const mcp = { callTool: capture("mcp") };
  const handlers = createDefaultAgentToolHandlers({
    sqlClient: sql,
    workflowRuntimeFactory: () => workflow,
    generationApplicationFactory: () => generation,
    mcpRuntimeFactory: () => mcp,
    deleteContent: capture("delete"),
    runUserOperation,
    createOrder: capture("pay"),
    refundOrder: capture("refund"),
    purchasesEnabled: () => true,
    subscriptionReturnUrl: () => "https://app.example/ai/billing",
  });
  const forgedIdentity = {
    userId: "victim-user",
    user_id: "victim-user",
    userRole: "root",
    user_role: "root",
    actor: { userId: "victim-user", role: "root" },
  };
  const trustedContext = { idempotencyKey: "trusted-operation-0001" };

  await handlers.get("canvas.read")({
    userId: "runtime-user",
    parameters: { ...forgedIdentity, canvasId: "canvas-1" },
  });
  await handlers.get("canvas.edit")({
    userId: "runtime-user",
    parameters: { ...forgedIdentity, canvasId: "canvas-1", expectedUpdatedAt: "2026-08-01T00:00:00.000Z", state: { elements: [] } },
  });
  await handlers.get("storyboard.edit")({
    userId: "runtime-user",
    parameters: {
      ...forgedIdentity,
      canvasId: "canvas-1",
      expectedUpdatedAt: "2026-08-07T00:00:00.000Z",
      storyboard: { shots: [{ id: "shot-1", title: "Opening" }] },
    },
  });
  await handlers.get("template.use")({
    userId: "runtime-user",
    parameters: { ...forgedIdentity, templateId: "template-1" },
  });
  await handlers.get("workflow.run")({
    userId: "runtime-user",
    parameters: { ...forgedIdentity, definition: { nodes: [{ id: "node-1", type: "prompt", config: {} }] }, idempotencyKey: "forged-operation" },
    context: trustedContext,
  });
  await handlers.get("media.generate.image")({
    userId: "runtime-user",
    parameters: { ...forgedIdentity, sceneKey: "product-photo", userPrompt: "A watch" },
    context: trustedContext,
  });
  await handlers.get("media.generate.video")({
    userId: "runtime-user",
    parameters: { ...forgedIdentity, sceneKey: "product-video", userPrompt: "A watch" },
    context: trustedContext,
  });
  await handlers.get("content.delete")({
    userId: "runtime-user",
    parameters: { ...forgedIdentity, resourceType: "canvas", resourceId: "canvas-1" },
    context: trustedContext,
  });
  await handlers.get("content.publish")({
    userId: "runtime-user",
    parameters: { ...forgedIdentity, resourceType: "private_template", resourceId: "template-1" },
    context: trustedContext,
  });
  await handlers.get("mcp.call.external")({
    userId: "runtime-user",
    userRole: "admin",
    agentMode: "full_access",
    approvalId: "approval-1",
    parameters: { ...forgedIdentity, connectionId: "connection-1", toolName: "pages.read" },
  });
  await handlers.get("billing.pay")({
    userId: "runtime-user",
    parameters: { ...forgedIdentity, planKey: "pro-monthly" },
    context: trustedContext,
  });
  await handlers.get("billing.refund")({
    userId: "runtime-root",
    userRole: "root",
    parameters: { ...forgedIdentity, orderNo: "SO100" },
    context: trustedContext,
  });

  for (const operation of ["workflow", "image", "video", "delete", "pay"]) {
    assert.equal(delegated.find(([name]) => name === operation)[1].userId, "runtime-user");
  }
  assert.equal(delegated.find(([name]) => name === "workflow")[1].idempotencyKey, "trusted-operation-0001");
  assert.equal(delegated.find(([name]) => name === "publish")[1].userId, "runtime-user");
  assert.equal(delegated.find(([name]) => name === "publish")[1].idempotencyKey, "trusted-operation-0001");
  assert.deepEqual(delegated.find(([name]) => name === "mcp")[1], {
    userId: "runtime-user",
    userRole: "admin",
    agentMode: "full_access",
    connectionId: "connection-1",
    serverKey: null,
    toolName: "pages.read",
    arguments: {},
    approvalId: "approval-1",
  });
  assert.deepEqual(delegated.find(([name]) => name === "refund")[1].actor, {
    userId: "runtime-root",
    role: "root",
  });
  assert.equal(getCanvas().canvas_state.storyboard.shots[0].id, "shot-1");
  assert.equal(calls.some(({ statement, values }) => (
    statement.includes("FROM canvases") && values.at(-1) === "runtime-user"
  )), true);
  assert.equal(calls.some(({ statement, values }) => (
    statement.startsWith("UPDATE prompt_templates") && values[1] === "runtime-user"
  )), true);
});

test("unsupported unsafe inputs fail with stable error codes", async () => {
  const { sql } = createOfflineSql();
  const handlers = createDefaultAgentToolHandlers({ sqlClient: sql });

  await assert.rejects(
    handlers.get("media.generate.image")({
      userId: "runtime-user",
      parameters: {
        sceneKey: "product-photo",
        userPrompt: "A watch",
        referenceImages: [{ url: "https://attacker.example/image.png" }],
      },
    }),
    (error) => error.code === "AGENT_REFERENCE_IMAGES_UNSUPPORTED" && error.status === 422,
  );
  await assert.rejects(
    handlers.get("content.publish")({
      userId: "runtime-user",
      parameters: { resourceType: "canvas", resourceId: "canvas-1" },
    }),
    (error) => error.code === "CONTENT_PUBLISH_UNSUPPORTED" && error.status === 422,
  );
});

test("owned local reference uploads are resolved for generation and cannot cross users", async () => {
  const uploadRow = {
    id: "upload-1",
    user_id: "runtime-user",
    object_key: "quickai/runtime-user/canvas_image.png",
    mime_type: "image/png",
  };
  const generated = [];
  const { sql } = createOfflineSql({ uploadRow });
  const handlers = createDefaultAgentToolHandlers({
    sqlClient: sql,
    objectStorageFactory: async () => ({
      downloadBuffer: async (objectKey) => ({ buffer: Buffer.from(objectKey), contentType: "image/png" }),
    }),
    generationApplicationFactory: async () => ({
      generateImage: async (input) => {
        generated.push(input);
        return { creationId: "creation-1", status: "queued" };
      },
    }),
  });

  await handlers.get("media.generate.image")({
    userId: "runtime-user",
    parameters: {
      sceneKey: "product-photo",
      userModification: "Use the uploaded product photo as the reference.",
      referenceUploadIds: ["upload-1"],
    },
    context: { idempotencyKey: "reference-upload-test" },
  });
  assert.equal(generated[0].referenceImages.length, 1);
  assert.deepEqual(generated[0].referenceImages[0], {
    buffer: Buffer.from(uploadRow.object_key),
    mimetype: "image/png",
  });

  const { sql: otherUserSql } = createOfflineSql({ ownerUserId: "other-user", uploadRow });
  const otherUserHandlers = createDefaultAgentToolHandlers({
    sqlClient: otherUserSql,
    objectStorageFactory: async () => ({ downloadBuffer: async () => ({ buffer: Buffer.from("should-not-read") }) }),
  });
  await assert.rejects(
    otherUserHandlers.get("media.generate.image")({
      userId: "other-user",
      parameters: { sceneKey: "product-photo", userModification: "Use this image", referenceUploadIds: ["upload-1"] },
    }),
    (error) => error.code === "AGENT_REFERENCE_UPLOAD_UNAVAILABLE" && error.status === 404,
  );
});

test("canvas mutations reject stale optimistic concurrency versions", async () => {
  const { sql } = createOfflineSql();
  const handlers = createDefaultAgentToolHandlers({ sqlClient: sql });

  await assert.rejects(
    handlers.get("canvas.patch")({
      userId: "runtime-user",
      parameters: {
        canvasId: "canvas-1",
        expectedUpdatedAt: "2026-08-02T00:00:00.000Z",
        patch: { viewport: { x: 10, y: 20, scale: 1 } },
      },
    }),
    (error) => error.code === "CANVAS_VERSION_CONFLICT" && error.status === 409,
  );
});

test("creation history and single download are paginated and bound to the runtime user", async () => {
  const calls = [];
  const sqlClient = async (strings, ...values) => {
    const statement = compactSql(strings);
    calls.push({ statement, values });
    if (statement.includes("FROM creations")) assert.equal(statement.includes("completed_at"), false);
    if (statement.startsWith("SELECT COUNT(*)")) return [{ count: 1 }];
    if (statement.includes("community_title") && statement.includes("FROM creations")) {
      return [{ id: "42", type: "image", status: "completed", scene_name: "Owned result" }];
    }
    if (statement.startsWith("SELECT id, type, status, expires_at")) {
      return values.includes("runtime-user")
        ? [{ id: "42", type: "image", status: "completed", expires_at: null }]
        : [];
    }
    throw new Error(`Unexpected query: ${statement}`);
  };
  const handlers = createDefaultAgentToolHandlers({ sqlClient });
  const history = await handlers.get("creation.history")({
    userId: "runtime-user",
    parameters: { page: 2, pageSize: 5, type: "image", status: "completed", query: "owned" },
  });
  assert.equal(history.page, 2);
  assert.equal(history.pageSize, 5);
  assert.equal(history.total, 1);
  assert.equal(history.items[0].id, "42");

  const download = await handlers.get("creation.download")({
    userId: "runtime-user",
    parameters: { creationId: "42", userId: "victim-user" },
  });
  assert.deepEqual(download.clientAction, {
    type: "creation.download",
    creationId: "42",
    filename: "creation_42.png",
  });
  assert.equal(calls.every(({ values }) => !values.includes("victim-user")), true);
});

test("creation status reconciliation starts from an owned row and does not expose storage metadata", async () => {
  let reads = 0;
  const reconciled = [];
  const sqlClient = async (strings, ...values) => {
    const statement = compactSql(strings);
    if (!statement.includes("FROM creations")) throw new Error(`Unexpected query: ${statement}`);
    assert.equal(statement.includes("completed_at"), false);
    assert.deepEqual(values, ["42", "runtime-user"]);
    reads += 1;
    return [{
      id: "42",
      user_id: "runtime-user",
      type: "video",
      status: reads === 1 ? "running" : "completed",
      task_id: "provider-task-42",
      meta_info: { providerRaw: { secret: "not-public" } },
      content_object_key: "private/video.mp4",
      thumbnail_object_key: "private/thumb.jpg",
      content: "/oss-proxy/private/video.mp4",
    }];
  };
  const handlers = createDefaultAgentToolHandlers({
    sqlClient,
    reconcileVideoCreation: async (creation) => {
      reconciled.push(creation);
      return { success: true, creation: { ...creation, status: "completed" } };
    },
  });
  const result = await handlers.get("creation.get")({
    userId: "runtime-user",
    parameters: { creationId: "42", userId: "victim-user" },
  });
  assert.equal(reconciled[0].user_id, "runtime-user");
  assert.equal(result.status, "completed");
  assert.equal("user_id" in result, false);
  assert.equal("meta_info" in result, false);
  assert.equal("content_object_key" in result, false);
});

test("failed creation deletion releases reserved points and deletes in one idempotent transaction", async () => {
  const calls = [];
  const tx = async (strings, ...values) => {
    const statement = compactSql(strings);
    calls.push({ statement, values });
    if (statement.startsWith("SELECT id, status, charge_status")) {
      assert.deepEqual(values, ["42", "runtime-user"]);
      return [{ id: "42", status: "failed", charge_status: "reserved", points_reserved: 18 }];
    }
    if (statement.startsWith("UPDATE creations")) return [{ id: "42" }];
    throw new Error(`Unexpected transaction query: ${statement}`);
  };
  const operations = [];
  const releases = [];
  const deletions = [];
  const handlers = createDefaultAgentToolHandlers({
    sqlClient: async () => [],
    runUserOperation: async (operation) => {
      operations.push(operation);
      return operation.mutate(tx);
    },
    releasePointsOperation: async (input) => {
      releases.push(input);
      return { ledger: { held_points_change: -18 } };
    },
    deleteContent: async (input) => {
      deletions.push(input);
      return { mode: "recycle_bin", entry: { id: "91" } };
    },
  });

  const result = await handlers.get("creation.failed.delete")({
    userId: "runtime-user",
    parameters: { creationId: "42", userId: "victim-user", reason: "Remove failed result" },
    context: { idempotencyKey: "agent-delete-failed-0042" },
  });
  assert.equal(result.deletedId, "42");
  assert.equal(operations[0].userId, "runtime-user");
  assert.equal(operations[0].idempotencyKey, "agent-delete-failed-0042");
  assert.equal(releases[0].userId, "runtime-user");
  assert.equal(releases[0].amount, 18);
  assert.equal(releases[0].tx, tx);
  assert.equal(deletions[0].userId, "runtime-user");
  assert.equal(deletions[0].resourceId, "42");
  assert.equal(deletions[0].tx, tx);
});

test("owned publication state and renewal cancellation cannot be redirected to another user", async () => {
  const delegated = [];
  const tx = { marker: "transaction" };
  const handlers = createDefaultAgentToolHandlers({
    sqlClient: async () => [],
    communityServiceFactory: async () => ({
      async getOwnedCommunityState(input) {
        delegated.push(["publication", input]);
        return { id: input.creationId, community_status: "private" };
      },
    }),
    runUserOperation: async (operation) => {
      delegated.push(["operation", operation]);
      return operation.mutate(tx);
    },
    cancelRenewal: async (input) => {
      delegated.push(["cancel", input]);
      return {
        id: "subscription-1",
        status: "active",
        membership_tier: "pro",
        billing_interval: "month",
        current_period_end: "2026-09-08T12:00:00.000Z",
        auto_renew: false,
        cancel_at_period_end: true,
        cancelled_at: "2026-08-08T12:00:00.000Z",
      };
    },
  });

  await handlers.get("community.publication.get")({
    userId: "runtime-user",
    parameters: { creationId: "42", userId: "victim-user" },
  });
  const cancelled = await handlers.get("subscription.renewal.cancel")({
    userId: "runtime-user",
    parameters: { userId: "victim-user", reason: "Do not renew" },
    context: { idempotencyKey: "agent-cancel-renewal-0001" },
  });

  assert.deepEqual(delegated.find(([name]) => name === "publication")[1], {
    userId: "runtime-user",
    creationId: "42",
  });
  assert.equal(delegated.find(([name]) => name === "operation")[1].userId, "runtime-user");
  assert.equal(delegated.find(([name]) => name === "operation")[1].idempotencyKey, "agent-cancel-renewal-0001");
  assert.deepEqual(delegated.find(([name]) => name === "cancel")[1], {
    userId: "runtime-user",
    db: tx,
  });
  assert.equal(cancelled.autoRenew, false);
  assert.equal(cancelled.cancelAtPeriodEnd, true);
});
