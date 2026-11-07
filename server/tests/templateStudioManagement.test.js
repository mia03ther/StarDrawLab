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
  ["../services/userOperationService.js", "admin-template-test:administrator-operation"],
  ["../controllers/aiController.js", "admin-template-test:ai-controller"],
  ["../services/modelConfigurationService.js", "admin-template-test:model-configuration"],
  ["../services/contentRecycleService.js", "admin-template-test:content-recycle"],
]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith("/routes/templateStudioRoutes.js") && MOCK_MODULES.has(specifier)) {
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
    if (url === "admin-template-test:ai-controller") return { format: "module", shortCircuit: true, source: "export const getScenes = async (_req,res) => res.json({success:true,data:[]});" };
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
          export const executeUserOperation = async ({ mutate }) => {
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
          export const deleteContentAsAdministrator = async () => ({}); export const deleteOwnContent = async () => ({});
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

await import("../routes/templateStudioRoutes.js");

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
    auth: { userId: "creator", role: "user" },
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

test("ordinary users cannot request marketplace administrator management", async () => {
  resetState();
  const result = await invokeRoute("GET", "/prompt-templates", { query: { manage: "all" } });
  assert.equal(result.statusCode, 403);
  assert.equal(state.queries.length, 0);
});

test("own management includes disabled templates and only provides owner capabilities", async () => {
  resetState(async () => [{ id: "1", owner_user_id: "creator", visibility: "public", approval_status: "rejected", is_active: false, output_type: "image", scene_key: "user_existing" }]);
  const result = await invokeRoute("GET", "/prompt-templates", { query: { manage: "mine" } });
  assert.equal(result.payload.data[0].can_edit, true);
  assert.equal(result.payload.data[0].can_manage_marketplace, false);
  assert.equal(result.payload.data[0].is_active, false);
  assert.equal(result.payload.data[0].points_cost, 18);
  assert.ok(state.queries[0].values.includes("creator"));
  assert.doesNotMatch(state.queries[0].text, /is_active = (?:true|TRUE)/);
});

test("simplified video template creation derives model defaults and publishes at the server price", async () => {
  resetState(async text => {
    if (text.includes("SELECT capabilities")) return [{ capabilities: { durations: [6, 10] }, resolutions: ["720x1280"] }];
    if (text.includes("INSERT INTO prompt_templates")) return [{ id: "5", owner_user_id: "creator", scene_key: "user_new", output_type: "video", target_provider: "test-video", visibility: "public", approval_status: "approved" }];
    return [];
  });
  const result = await invokeRoute("POST", "/prompt-templates", { headers: { "x-idempotency-key": "new-simple" }, body: { scene_name: "New template", output_type: "video", system_prompt: "Generate a scene", points_cost: 999, is_featured: true, target_provider: "untrusted" } });
  assert.equal(result.statusCode, 200);
  assert.equal(result.payload.data.points_cost, 18);
  const insert = state.queries.find(query => query.text.includes("INSERT INTO prompt_templates"));
  assert.match(insert.text, /'public', 'approved'/);
  assert.match(insert.text, /FALSE/);
  assert.ok(insert.values.includes("test-video"));
  assert.ok(insert.values.includes("test-model"));
  assert.ok(insert.values.includes("720x1280"));
  assert.ok(insert.values.includes(6));
  assert.ok(!insert.values.includes("untrusted"));
  assert.ok(!insert.values.includes(999));
  const priceInsert = state.queries.find(query => query.text.includes("INSERT INTO generation_charge_rules"));
  assert.ok(priceInsert.values.includes(18));
});

test("editing a taken-down own template preserves technical fields and cannot lift administrator moderation", async () => {
  const existing = { id: "6", owner_user_id: "creator", scene_key: "keep-key", output_type: "video", target_provider: "test-video", default_model: "keep-model", default_seconds: 8, default_size: "1280x720", scene_name: "Old name", system_prompt: "Keep prompt", starter_prompt: "Keep starter", placeholder_text: "Keep placeholder", requires_reference: true, tags: ["keep"], visibility: "public", approval_status: "rejected", is_active: false };
  resetState(async text => text.includes("SELECT * FROM prompt_templates") ? [existing] : text.includes("UPDATE prompt_templates") ? [{ ...existing, scene_name: "New name" }] : []);
  const result = await invokeRoute("PUT", "/prompt-templates/:id", { params: { id: "6" }, headers: { "x-idempotency-key": "blocked-edit" }, body: { scene_name: "New name", is_active: true, is_featured: true, approval_status: "approved", points_cost: 0 } });
  assert.equal(result.statusCode, 200);
  const update = state.queries.find(query => query.text.includes("UPDATE prompt_templates"));
  for (const value of ["keep-key", "Keep prompt", "keep-model", "1280x720", 8, "rejected", false, "Keep starter", "Keep placeholder"]) assert.ok(update.values.includes(value), String(value));
  assert.doesNotMatch(update.text, /is_featured\s*=/);
  assert.match(update.text, /WHERE id = \$\d+ AND owner_user_id =/);
});

test("owner endpoint cannot update another person's template", async () => {
  resetState(async () => []);
  await assert.rejects(invokeRoute("PUT", "/prompt-templates/:id", { params: { id: "other" }, headers: { "x-idempotency-key": "cross-owner" }, body: { scene_name: "Attempt" } }), error => error.status === 404);
  assert.equal(state.queries.length, 1);
  assert.match(state.queries[0].text, /owner_user_id =/);
  assert.ok(state.queries[0].values.includes("creator"));
});

test("the legacy publication action publishes immediately but cannot bypass administrator takedown", async () => {
  resetState(async text => text.includes("SELECT *") ? [{ id: "7", owner_user_id: "creator", visibility: "private", approval_status: "private", is_active: true }] : [{ id: "7", visibility: "public", approval_status: "approved", scene_key: "user_public", output_type: "image" }]);
  const result = await invokeRoute("POST", "/prompt-templates/:id/request-public", { params: { id: "7" }, headers: { "x-idempotency-key": "publish-now" } });
  assert.equal(result.statusCode, 200);
  assert.match(state.queries[1].text, /approval_status = 'approved'/);
  resetState(async () => [{ id: "7", owner_user_id: "creator", visibility: "private", approval_status: "rejected", is_active: true }]);
  await assert.rejects(invokeRoute("POST", "/prompt-templates/:id/request-public", { params: { id: "7" }, headers: { "x-idempotency-key": "bypass-hidden" } }), error => error.code === "TEMPLATE_ADMINISTRATOR_HIDDEN");
  assert.equal(state.queries.length, 1);
});


test("an ordinary edit keeps legacy private content private until explicit publication", async () => {
  const existing = { id: "8", owner_user_id: "creator", scene_key: "legacy-private", output_type: "image", target_provider: "test-image", default_model: "keep-model", default_size: "1024x1024", scene_name: "Private", system_prompt: "Private prompt", visibility: "private", approval_status: "private", publication_requested_at: null, is_active: true };
  resetState(async text => text.includes("SELECT * FROM prompt_templates") ? [existing] : text.includes("UPDATE prompt_templates") ? [{ ...existing, scene_name: "Renamed" }] : []);
  await invokeRoute("PUT", "/prompt-templates/:id", { params: { id: "8" }, headers: { "x-idempotency-key": "keep-private" }, body: { scene_name: "Renamed", visibility: "public", approval_status: "approved" } });
  const update = state.queries.find(query => query.text.includes("UPDATE prompt_templates"));
  assert.ok(update.values.filter(value => value === "private").length >= 2);
  assert.doesNotMatch(update.text, /visibility = 'public'|approval_status = 'approved'|publication_requested_at\s*=/);
});
