import assert from "node:assert/strict";
import test from "node:test";
import { getGenerationErrorMessage as message, getGenerationErrorDetail as detail } from "./generationErrors.js";

test("upstream 403 explains model access without blaming the user's website login", () => {
  assert.match(message({ message: "Canvas agent provider failed with HTTP 403" }), /模型服务授权失败/);
  assert.doesNotMatch(message({ response: { status: 403, data: { message: "Canvas agent provider failed with HTTP 403" } } }), /重新登录/);
  assert.match(message({ response: { status: 401, data: {} } }), /重新登录/);
  assert.match(message({ response: { status: 403, data: {} } }), /账号.*权限/);
});

test("known generator failures include an appropriate next action", () => {
  assert.match(message({ code: "MODEL_ROUTE_INCOMPATIBLE" }), /更换模型/);
  assert.match(message({ code: "INSUFFICIENT_POINTS" }), /积分不足/);
  assert.match(message("Video generation failed"), /积分记录/);
  assert.doesNotMatch(message("Video generation failed"), /已退回/);
  assert.match(message("Canvas Agent model returned invalid JSON after one repair attempt"), /简化要求/);
  assert.match(message({ code: "ETIMEDOUT" }), /任务中心.*避免重复/);
  assert.match(message({ response: { status: 429 } }), /稍后重试/);
});

test("nested stored errors, localization and unknown errors remain readable", () => {
  assert.equal(detail({ error_message: { message: "Video generation failed" } }), "Video generation failed");
  assert.match(message({ error_message: { message: "Video generation failed" } }), /视频生成失败/);
  assert.equal(message("参考图不能超过10MiB"), "参考图不能超过10MiB");
  assert.equal(message("internal SQL stack trace", undefined, "请联系管理员"), "请联系管理员");
  assert.doesNotMatch(message("internal SQL stack trace"), /SQL/);
  assert.match(message({ code: "MODEL_ROUTE_INCOMPATIBLE" }, (_zh, en) => en), /Choose another model/);
});
