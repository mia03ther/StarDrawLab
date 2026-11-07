import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const MOCK_MODULES = new Map([
  ["express", "admin-template-test:express"],
  ["multer", "admin-template-test:multer"],
  ["../configs/db.js", "admin-template-test:db"],
  ["../configs/logger.js", "admin-template-test:logger"],
  ["../services/pointsService.js", "admin-template-test:points"],
  ["../services/objectStorageComposition.js", "admin-template-test:object-storage"],
  ["../utils/imageUpload.js", "admin-template-test:image-upload"],
  ["../middlewares/authorize.js", "admin-template-test:authorize"],
  ["../services/accessControlService.js", "admin-template-test:access-control"],
  ["../services/auditService.js", "admin-template-test:audit"],
  ["../services/administratorOperationService.js", "admin-template-test:administrator-operation"],
  ["../services/modelConfigurationService.js", "admin-template-test:model-configuration"],
  ["../services/contentRecycleService.js", "admin-template-test:content-recycle"],
]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith("/routes/adminRoutes.js") && MOCK_MODULES.has(specifier)) {
      return { shortCircuit: true, url: MOCK_MODULES.get(specifier) };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "admin-template-test:express") {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          const register = (router, method) => (path, ...handlers) => {
            globalThis.__adminTemplateRouteTest.routes.push({ method, path, handlers });
            return router;
          };
          const Router = () => {
            const router = { use() { return router; } };
            router.get = register(router, "GET");
            router.post = register(router, "POST");
            router.put = register(router, "PUT");
            router.delete = register(router, "DELETE");
            return router;
          };
          export default { Router };
        `,
      };
    }
    if (url === "admin-template-test:multer") {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          const multer = () => ({ single: () => (_req, _res, next) => next() });
          multer.memoryStorage = () => ({});
          export default multer;
        `,
      };
    }
    if (url === "admin-template-test:db") {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          const sql = async (strings, ...values) => {
            const text = strings.reduce(
              (query, part, index) => query + part + (index < values.length ? "$" + (index + 1) : ""),
              "",
            );
            const state = globalThis.__adminTemplateRouteTest;
            state.events.push("query");
            state.queries.push({ text, values });
            return state.queryResult(text, values);
          };
          sql.begin = async (callback) => callback(sql);
          sql.json = (value) => value;
          export default sql;
        `,
      };
    }
    if (url === "admin-template-test:logger") {
      return { format: "module", shortCircuit: true, source: "export default { error() {}, warn() {}, info() {} };" };
    }
    if (url === "admin-template-test:points") {
      return { format: "module", shortCircuit: true, source: "export const rechargePoints = async () => ({});" };
    }
    if (url === "admin-template-test:object-storage") {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          export const getObjectStorage = () => ({
            uploadBuffer: async () => {
              globalThis.__adminTemplateRouteTest.events.push("upload");
              globalThis.__adminTemplateRouteTest.uploadCount += 1;
              return { url: "https://assets.invalid/preview.mp4", objectKey: "test/preview.mp4" };
            },
          });
          export const setObjectStorageForTests = () => {};
          export const resetObjectStorage = () => {};
        `,
      };
    }
    if (url === "admin-template-test:image-upload") {
      return { format: "module", shortCircuit: true, source: "export const normalizeUploadedImage = async (file) => file;" };
    }
    if (url === "admin-template-test:authorize") {
      return { format: "module", shortCircuit: true, source: "export const requirePermission = () => (_req, _res, next) => next();" };
    }
    if (url === "admin-template-test:access-control") {
      return {
        format: "module",
        shortCircuit: true,
        source: "export const PERMISSIONS = new Proxy({}, { get: (_target, key) => String(key) });",
      };
    }
    if (url === "admin-template-test:audit") {
      return {
        format: "module",
        shortCircuit: true,
        source: "export const writeAuditLog = async () => ({});",
      };
    }
    if (url === "admin-template-test:administrator-operation") {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          import sql from "admin-template-test:db";
          export const executeAdministratorOperation = async ({ mutate }) => {
            globalThis.__adminTemplateRouteTest.events.push("operation");
            return mutate(sql);
          };
        `,
      };
    }
    if (url === "admin-template-test:model-configuration") {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          export const resolveTemplateModelSelection = async ({ modelKey, outputType }) => ({
            modelKey: modelKey || "test-model",
            targetProvider: outputType === "video" ? "test-video" : "test-image",
          });
        `,
      };
    }
    if (url === "admin-template-test:content-recycle") {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          export const cleanupUnreferencedObjects = async () => ({});
          export const deleteContentAsAdministrator = async () => ({});
        `,
      };
    }
    return nextLoad(url, context);
  },
});

const state = {
  routes: [],
  queries: [],
  events: [],
  uploadCount: 0,
  queryResult: async () => [],
};
globalThis.__adminTemplateRouteTest = state;

await import("../routes/adminRoutes.js");

const resetState = (queryResult = async () => []) => {
  state.queries = [];
  state.events = [];
  state.uploadCount = 0;
  state.queryResult = queryResult;
};

const compactSql = (text) => text.replace(/\s+/g, " ").trim();

const invokeRoute = async (method, path, request = {}) => {
  const route = state.routes.find((candidate) => candidate.method === method && candidate.path === path);
  assert.ok(route, `${method} ${path} route is registered`);

  const req = {
    auth: { userId: "admin-user", role: "admin" },
    body: {},
    headers: {},
    params: {},
    query: {},
    ...request,
  };
  const res = {
    statusCode: 200,
    payload: undefined,
    once() {
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };

  const dispatch = async (index) => {
    const handler = route.handlers[index];
    if (!handler) return;

    let continuation;
    const next = (error) => {
      if (error) return Promise.reject(error);
      continuation = dispatch(index + 1);
      return continuation;
    };
    await handler(req, res, next);
    if (continuation) await continuation;
  };
  await dispatch(0);
  return res;
};

test("administrator template list includes marketplace templates but only explicitly submitted private drafts", async () => {
  resetState();

  const response = await invokeRoute("GET", "/prompt-templates");

  assert.equal(response.statusCode, 200);
  assert.equal(state.queries.length, 1);
  const query = compactSql(state.queries[0].text);
  assert.match(query, /pt\.owner_user_id IS NULL OR pt\.visibility = 'public'/);
  assert.match(query, /pt\.visibility = 'private' AND pt\.approval_status = 'pending' AND pt\.publication_requested_at IS NOT NULL/);
});

test("publication request list only exposes explicitly submitted private user templates", async () => {
  resetState();

  const response = await invokeRoute("GET", "/prompt-templates/publication-requests");

  assert.equal(response.statusCode, 200);
  const query = compactSql(state.queries[0].text);
  assert.match(query, /pt\.owner_user_id IS NOT NULL/);
  assert.match(query, /pt\.visibility = 'private'/);
  assert.match(query, /pt\.approval_status = 'pending'/);
  assert.match(query, /pt\.publication_requested_at IS NOT NULL/);
});

test("administrator PUT retains a platform template identity and omitted technical fields", async () => {
  let queryNumber = 0;
  resetState(async () => {
    queryNumber += 1;
    if (queryNumber === 1) {
      return [{ id: "42", scene_key: "original-key", scene_name: "Old name", system_prompt: "Keep this prompt", output_type: "image", default_model: "test-model", default_size: "1024x1024", required_membership_tier: "free" }];
    }
    return [{ id: "42", scene_key: "platform-template", tags: [] }];
  });

  const response = await invokeRoute("PUT", "/prompt-templates/:id", {
    params: { id: "42" },
    headers: { "x-idempotency-key": "put-platform-template" },
    body: { scene_name: "Platform template", output_type: "image", default_model: "test-model" },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(state.queries.length, 2);
  assert.match(compactSql(state.queries[0].text), /owner_user_id IS NULL OR visibility = 'public'/);
  assert.match(compactSql(state.queries[1].text), /WHERE id = \$\d+ AND \(owner_user_id IS NULL OR visibility = 'public'/);
  assert.ok(state.queries[1].values.includes("original-key"));
  assert.ok(state.queries[1].values.includes("Keep this prompt"));
  assert.ok(state.queries[1].values.includes("1024x1024"));
});

test("administrator preview upload rejects private drafts before object upload", async () => {
  resetState();
  await assert.rejects(
    invokeRoute("POST", "/prompt-templates/:id/preview", {
      params: { id: "99" },
      headers: { "x-idempotency-key": "preview-user-template" },
      file: { buffer: Buffer.from("preview"), mimetype: "video/mp4", originalname: "preview.mp4" },
    }),
    (error) => error.status === 404,
  );

  assert.equal(state.uploadCount, 0);
  assert.equal(state.queries.length, 1);
  assert.deepEqual(state.events, ["operation", "query"]);
  assert.match(compactSql(state.queries[0].text), /owner_user_id IS NULL OR visibility = 'public'/);
});

test("administrator preview writes stay constrained to editable marketplace templates", async () => {
  let queryNumber = 0;
  resetState(async () => {
    queryNumber += 1;
    if (queryNumber === 1) {
      return [{ id: "7", scene_key: "platform-scene", preview_object_key: null, preview_video_object_key: null }];
    }
    return [{ id: "7", scene_key: "platform-scene", tags: [] }];
  });
  const response = await invokeRoute("POST", "/prompt-templates/:id/preview", {
    params: { id: "7" },
    headers: { "x-idempotency-key": "preview-platform-template" },
    file: { buffer: Buffer.from("preview"), mimetype: "video/mp4", originalname: "preview.mp4" },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(state.uploadCount, 1);
  assert.equal(state.queries.length, 2);
  assert.deepEqual(state.events.slice(0, 3), ["operation", "query", "upload"]);
  assert.match(compactSql(state.queries[0].text), /owner_user_id IS NULL OR visibility = 'public'/);
  assert.match(compactSql(state.queries[1].text), /WHERE id = \$\d+ AND \(owner_user_id IS NULL OR visibility = 'public'/);
});

for (const action of ["approve-public", "reject-public"]) {
  test(`${action} only processes pending publication requests from users`, async () => {
    resetState(async () => [{
      id: "13",
      owner_user_id: "user-13",
      visibility: "public",
      approval_status: "approved",
      publication_requested_at: null,
    }]);

    await assert.rejects(
      invokeRoute("POST", `/prompt-templates/:id/${action}`, {
        params: { id: "13" },
        headers: { "x-idempotency-key": `${action}-user-template` },
        body: { note: "reviewed" },
      }),
      (error) => error.status === 404,
    );
    const query = compactSql(state.queries[0].text);
    assert.match(query, /owner_user_id IS NOT NULL/);
    assert.match(query, /FOR UPDATE/);
  });
}

test("administrator can feature an existing user's public template without replacing its owner or route defaults", async () => {
  resetState(async (text) => text.includes("SELECT * FROM prompt_templates") ? [{
    id: "81", owner_user_id: "creator", visibility: "public", approval_status: "approved", is_active: true,
    scene_key: "user_existing", scene_name: "Existing", output_type: "video", default_model: "video-model", default_seconds: 8, default_size: "1280x720", system_prompt: "Existing prompt", tags: ["existing"],
  }] : [{ id: "81", owner_user_id: "creator", visibility: "public", output_type: "video", scene_key: "user_existing" }]);
  const response = await invokeRoute("PUT", "/prompt-templates/:id", {
    params: { id: "81" }, headers: { "x-idempotency-key": "feature-public" },
    body: { is_featured: true, featured_order: 4, points_cost: 1 },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.data.points_cost, 18);
  const update = state.queries.find(query => /UPDATE prompt_templates/.test(query.text));
  assert.doesNotMatch(update.text, /SET[\s\S]*owner_user_id\s*=/);
  assert.ok(update.values.includes("user_existing"));
  assert.ok(update.values.includes("Existing prompt"));
  assert.ok(update.values.includes(8));
  assert.ok(update.values.includes("1280x720"));
});

test("administrator cannot edit a user's unsubmitted private draft", async () => {
  resetState(async () => [{ id: "99", owner_user_id: "other", visibility: "private", approval_status: "private" }]);
  await assert.rejects(invokeRoute("PUT", "/prompt-templates/:id", { params: { id: "99" }, headers: { "x-idempotency-key": "private-edit" }, body: { scene_name: "Unauthorized edit" } }), error => error.status === 404);
  assert.equal(state.queries.length, 1);
});

test("administrator preview rejects a private row even if the store mistakenly returns it", async () => {
  resetState(async () => [{ id: "99", owner_user_id: "other", visibility: "private", approval_status: "private" }]);
  await assert.rejects(invokeRoute("POST", "/prompt-templates/:id/preview", { params: { id: "99" }, headers: { "x-idempotency-key": "private-preview" }, file: { buffer: Buffer.from("preview"), mimetype: "video/mp4", originalname: "preview.mp4" } }), error => error.status === 404);
  assert.equal(state.uploadCount, 0);
});

test("taking down a public user template preserves the content instead of recycling or deleting it", async () => {
  resetState(async (text) => text.includes("SELECT *") ? [{ id: "81", owner_user_id: "creator", visibility: "public", approval_status: "approved" }] : [{ id: "81", is_active: false, approval_status: "rejected" }]);
  const response = await invokeRoute("DELETE", "/prompt-templates/:id", { params: { id: "81" }, headers: { "x-idempotency-key": "hide-public" }, body: { reason: "Needs correction" } });
  assert.equal(response.statusCode, 200);
  const update = state.queries.find(query => /UPDATE prompt_templates/.test(query.text));
  assert.match(update.text, /is_active = FALSE/);
  assert.match(update.text, /approval_status = 'rejected'/);
  assert.doesNotMatch(update.text, /DELETE|content\s*=/);
});
