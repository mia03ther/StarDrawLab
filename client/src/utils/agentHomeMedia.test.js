import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanAgentReply,
  createReferenceAsset,
  getAgentReferenceContext,
  getAgentReferenceTitle,
  getGridMediaUrl,
  parseReferenceDragPayload,
  serializeReferenceDragPayload,
} from "./agentHomeMedia.js";

test("Agent replies hide internal media object keys", () => {
  assert.equal(
    cleanAgentReply("已生成：[查看图片](/oss-proxy/user/image_123.png)"),
    "已生成：查看图片",
  );
  assert.equal(
    cleanAgentReply("已生成图片：/oss-proxy/quickai/user/image_123.png"),
    "已生成图片：",
  );
  assert.equal(
    cleanAgentReply("已生成：https://stardrawai.com/oss-proxy/quickai/user/image_123.png。"),
    "已生成：。",
  );
  assert.equal(
    cleanAgentReply("已生成：[打开](https://stardrawai.com/oss-proxy/quickai/user/image_123.png)"),
    "已生成：打开",
  );
  assert.equal(cleanAgentReply("已生成：image_1787074002152_d42b5384436040f9.png"), "已生成：");
  assert.equal(cleanAgentReply("结果已放在下方。"), "结果已放在下方。");
});

test("reference context tells the Agent that an attached image is ready without exposing its URL", () => {
  const context = getAgentReferenceContext({
    title: "image_123.png",
    previewUrl: "/oss-proxy/private/image_123.png",
    uploadId: "upload-123",
  });

  assert.deepEqual(context, [{
    type: "image",
    title: "image_123.png",
    source: "upload",
  }]);
  assert.doesNotMatch(JSON.stringify(context), /oss-proxy|upload-123/);
});

test("reference context preserves up to four unique attached images", () => {
  const context = getAgentReferenceContext([1, 2, 3, 4, 5].map((number) => ({
    id: `upload-${number}`,
    title: `参考图 ${number}`,
    previewUrl: `/oss-proxy/private/reference-${number}.png`,
    uploadId: String(number),
  })));

  assert.equal(context.length, 4);
  assert.deepEqual(context.map((item) => item.title), ["参考图 1", "参考图 2", "参考图 3", "参考图 4"]);
  assert.doesNotMatch(JSON.stringify(context), /oss-proxy|upload-/);
});

test("internal provider filenames are not shown as reference titles", () => {
  assert.equal(
    createReferenceAsset({
      id: "creation-123",
      title: "image_1787074002152_d42b5384436040f9.png",
      content: "/oss-proxy/quickai/image_1787074002152_d42b5384436040f9.png",
    }).title,
    "参考图",
  );
  assert.equal(getAgentReferenceTitle("image_1787074002152_d42b5384436040f9.png"), "参考图");
  assert.equal(getAgentReferenceTitle("我的猫.jpg"), "我的猫.jpg");
});

test("home cards prefer thumbnails while references retain the creation identity", () => {
  const item = {
    id: "42",
    type: "image",
    content: "/oss-proxy/original.png",
    thumbnail_url: "/oss-proxy/thumb.jpg",
    title: "海报",
  };

  assert.equal(getGridMediaUrl(item), "/oss-proxy/thumb.jpg");
  assert.deepEqual(createReferenceAsset(item), {
    id: "42",
    title: "海报",
    previewUrl: "/oss-proxy/original.png",
    creationId: "42",
    templateId: "",
  });
});

test("reference drag payload round-trips without carrying image bytes", () => {
  const item = {
    id: "template-7",
    templateId: "7",
    type: "image",
    content: "/oss-proxy/template-preview.png",
    title: "产品海报",
  };
  const payload = serializeReferenceDragPayload(item);
  const parsed = parseReferenceDragPayload(payload);

  assert.equal(payload.includes("base64"), false);
  assert.deepEqual(parsed, {
    id: "template-7",
    title: "产品海报",
    previewUrl: "/oss-proxy/template-preview.png",
    creationId: "",
    templateId: "7",
  });
});
