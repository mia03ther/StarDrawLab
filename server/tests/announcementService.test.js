import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeAnnouncementInput,
  normalizeAnnouncementStatus,
} from "../services/announcementService.js";

test("announcement input trims and normalizes supported fields", () => {
  assert.deepEqual(normalizeAnnouncementInput({
    title: "  服务更新  ",
    content: "  新版本已上线。\n请查看更新说明。  ",
    status: "PUBLISHED",
    priority: "12",
  }), {
    title: "服务更新",
    content: "新版本已上线。\n请查看更新说明。",
    status: "published",
    priority: 12,
  });
});

test("announcement input rejects empty, invalid, and oversized values", () => {
  assert.throws(() => normalizeAnnouncementInput({ title: "", content: "正文" }), (error) => error.code === "INVALID_ANNOUNCEMENT");
  assert.throws(() => normalizeAnnouncementInput({ title: "标题", content: "正文", status: "archived" }), (error) => error.code === "INVALID_ANNOUNCEMENT_STATUS");
  assert.throws(() => normalizeAnnouncementInput({ title: "标题", content: "x".repeat(100001) }), (error) => error.code === "INVALID_ANNOUNCEMENT");
  assert.throws(() => normalizeAnnouncementInput({ title: "标题", content: "正文", priority: 1.5 }), (error) => error.code === "INVALID_ANNOUNCEMENT");
});

test("partial updates require at least one field", () => {
  assert.deepEqual(normalizeAnnouncementInput({ title: "新标题" }, { partial: true }), { title: "新标题" });
  assert.throws(() => normalizeAnnouncementInput({}, { partial: true }), (error) => error.code === "INVALID_ANNOUNCEMENT");
  assert.equal(normalizeAnnouncementStatus(undefined), "draft");
});
