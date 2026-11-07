import assert from "node:assert/strict";
import test from "node:test";
import axios from "axios";

process.env.NODE_ENV = "test";
process.env.SORA_API_KEY = "contract-fixture-not-a-real-key";
process.env.VIDEO_MODEL = "veo-3-1";
let moduleNumber = 0;

const withProvider = async (baseUrl, responses, run) => {
  const requests = [];
  const previous = axios.defaults.adapter;
  process.env.SORA_BASE_URL = baseUrl;
  axios.defaults.adapter = async (config) => {
    requests.push({ url: axios.getUri(config), method: config.method, headers: config.headers, body: config.data && JSON.parse(config.data) });
    assert.ok(responses.length, "Unexpected provider request");
    const data = responses.shift();
    return { status: 200, statusText: "OK", headers: {}, config, data };
  };
  try {
    const provider = await import(`../providers/soraAPI.js?contract=${++moduleNumber}`);
    await run(provider, requests);
  } finally {
    axios.defaults.adapter = previous;
  }
};

test("documented gateway base and an explicit v1 base address the same video endpoints once", async () => {
  for (const base of ["https://provider.invalid/agent/openapi/fpbrowser2api", " https://provider.invalid/agent/openapi/fpbrowser2api/v1/// "]) {
    await withProvider(base, [{ id: "task-1", status: "queued" }, { id: "task-1", status: "in_progress" }], async (provider, requests) => {
      const submitted = await provider.submitSoraVideoTask("Local contract test", "veo-3-1", 8, "720x1280");
      assert.equal(submitted.success, true);
      assert.equal(submitted.taskId, "task-1");
      await provider.checkSoraVideoStatus(submitted.taskId);
      assert.equal(requests[0].url, "https://provider.invalid/agent/openapi/fpbrowser2api/v1/videos");
      assert.equal(requests[1].url, "https://provider.invalid/agent/openapi/fpbrowser2api/v1/videos/task-1");
      assert.equal(requests[0].headers["x-api-key"], "contract-fixture-not-a-real-key");
      assert.equal(requests[0].headers.Authorization, "Bearer contract-fixture-not-a-real-key");
      assert.equal(requests[0].body.n_frames, 240);
      assert.equal(requests[0].body.duration, undefined);
    });
  }
});

test("wrapped submitted tasks and completed status documents retain identity, media and status", async () => {
  await withProvider("https://provider.invalid/v1", [
    { success: true, status: "success", data: { task_id: "wrapped-1", status: "processing" } },
    { success: true, data: { task_id: "wrapped-1", status: " COMPLETED ", progress: 100, result: { watermark_free_url: "https://media.invalid/video.mp4", thumb_url: "https://media.invalid/preview.jpg" } } },
  ], async (provider) => {
    const submitted = await provider.submitSoraVideoTask("Local contract test", "veo-3-1", 8);
    assert.equal(submitted.taskId, "wrapped-1");
    assert.equal(submitted.providerStatus, "processing");
    const completed = await provider.checkSoraVideoStatus(submitted.taskId);
    assert.equal(completed.success, true);
    assert.equal(completed.status, "completed");
    assert.equal(completed.url, "https://media.invalid/video.mp4");
    assert.equal(completed.thumbUrl, "https://media.invalid/preview.jpg");
    assert.equal(completed.progress, 100);
    assert.equal(completed.raw.task_id, "wrapped-1");
  });
});

test("an explicit provider rejection in a successful HTTP envelope is not a running task", async () => {
  await withProvider("https://provider.invalid", [
    { success: false, error: { code: "fixture_rejected", message: "Fixture provider rejected the request" } },
  ], async (provider) => {
    const result = await provider.checkSoraVideoStatus("task-1");
    assert.equal(result.success, false);
    assert.equal(result.providerCode, "fixture_rejected");
    assert.match(result.message, /Fixture provider rejected/);
  });
});

test("task IDs remain one encoded path segment and invalid IDs never send a request", async () => {
  await withProvider("https://provider.invalid/v1", [{ status: "processing" }, { status: "processing" }], async (provider, requests) => {
    assert.equal((await provider.checkSoraVideoStatus("task/with?characters#1")).success, true);
    assert.equal(requests[0].url, "https://provider.invalid/v1/videos/task%2Fwith%3Fcharacters%231");
    assert.equal((await provider.checkSoraVideoStatus(42)).success, true);
    assert.equal(requests[1].url, "https://provider.invalid/v1/videos/42");
    for (const bad of [null, undefined, {}, NaN, Infinity, "", " ", ".", "..", "task\nnewline"]) {
      assert.equal((await provider.checkSoraVideoStatus(bad)).code, "VIDEO_TASK_ID_INVALID");
    }
    assert.equal(requests.length, 2);
  });
});

test("top-level task documents and legacy output arrays preserve their existing contract", async () => {
  await withProvider("https://provider.invalid", [], async (provider) => {
    const task = { id: "top-level", status: "queued", data: { id: "unrelated" } };
    assert.equal(provider.normalizeSoraTaskResponse(task), task);
    const output = { data: [{ url: "https://media.invalid/video.mp4" }] };
    assert.equal(provider.normalizeSoraTaskResponse(output), output);
    for (const value of [null, undefined, "text", []]) assert.deepEqual(provider.normalizeSoraTaskResponse(value), {});
  });
});

test("missing or malformed status documents are not silently reported as running", async () => {
  for (const response of ["<html>gateway unavailable</html>", null, {}, { message: "Task lookup failed" }, { status: {} }]) {
    await withProvider("https://provider.invalid/v1", [response], async (provider) => {
      const result = await provider.checkSoraVideoStatus("task-1");
      assert.equal(result.success, false);
      assert.equal(result.status, 502);
      assert.equal(result.message, response?.message || "Video provider returned an invalid task response");
    });
  }
});

test("explicit Sora2 and Veo model choices are never replaced by VIDEO_MODEL", async () => {
  await withProvider("https://provider.invalid/v1", [], async provider => {
    assert.equal(provider.normalizeVideoProviderModel("sora2"),"sora2");
    assert.equal(provider.normalizeVideoProviderModel("sora-2"),"sora2");
    assert.equal(provider.normalizeVideoProviderModel("veo3.1"),"veo-3-1");
    const payload=provider.buildSoraVideoPayload({prompt:"test",model:"sora2",seconds:12,size:"1280x720"});
    assert.equal(payload.duration,12); assert.equal(payload.n_frames,undefined);
  });
});
test("Grok official protocol submits generations and resolves request_id, done and video.url", async () => {
  await withProvider("https://api.x.ai/v1", [{request_id:"grok-task"},{status:"done",video:{url:"https://media.invalid/grok.mp4"}}], async (provider,requests) => {
    const task=await provider.submitSoraVideoTask("test","grok-imagine-video",10,"1280x720");
    assert.equal(task.success,true); assert.equal(task.taskId,"grok-task");
    assert.equal(requests[0].url,"https://api.x.ai/v1/videos/generations");
    assert.equal(requests[0].body.duration,10); assert.equal(requests[0].body.aspect_ratio,"16:9");
    assert.equal(requests[0].body.n_frames,undefined); assert.equal(requests[0].body.size,undefined);
    const result=await provider.checkSoraVideoStatus(task.taskId);
    assert.equal(result.status,"completed"); assert.equal(result.url,"https://media.invalid/grok.mp4"); assert.equal(result.progress,100);
  });
});
test("Grok references use image.url, invalid inputs never submit, and image-only output is not a video", async () => {
  await withProvider("https://api.x.ai/v1", [{status:"completed",output:[{type:"image",url:"https://media.invalid/image.png"}]}],async(provider,requests)=>{
    const payload=provider.buildSoraVideoPayload({prompt:"test",model:"grok-imagine-video",seconds:10,size:"720x1280",imageUrl:"https://media.invalid/ref.png"});
    assert.deepEqual(payload.image,{url:"https://media.invalid/ref.png"}); assert.equal(payload.aspect_ratio,"9:16");
    assert.equal((await provider.submitSoraVideoTask("test","grok-imagine-video",30)).success,false);
    assert.equal((await provider.submitSoraVideoTask("test","grok-imagine-video",10,"1280x720",null,["https://media.invalid/a.png","https://media.invalid/b.png"])).success,false);
    assert.equal(requests.length,0);
    assert.equal((await provider.checkSoraVideoStatus("task")).url,null);
  });
});

test("Mirrmart and unknown gateways never receive guessed xAI Grok creation requests", async () => {
  for (const base of ["https://www.aimh8.com/agent/openapi/fpbrowser2api/v1", "https://gateway.invalid/v1"]) {
    await withProvider(base, [], async (provider, requests) => {
      const result = await provider.submitSoraVideoTask("test", "grok-imagine-video", 10);
      assert.equal(result.success, false);
      assert.equal(result.code, "VIDEO_PROVIDER_PROTOCOL_UNVERIFIED");
      assert.equal(result.status, 422);
      assert.equal(requests.length, 0);
      assert.equal(provider.resolveVideoSubmitPath("veo-3-1"), "/videos");
      assert.equal(provider.resolveVideoSubmitPath("sora2"), "/videos");
    });
  }
});
