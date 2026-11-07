import assert from "node:assert/strict";
import test from "node:test";

import { normalizeCommunityListInput } from "../services/communityService.js";

test("community feed preserves explicit featured, latest, and popular sort modes", () => {
  assert.equal(normalizeCommunityListInput({ sort: "featured" }).sort, "featured");
  assert.equal(normalizeCommunityListInput({ sort: "latest" }).sort, "latest");
  assert.equal(normalizeCommunityListInput({ sort: "popular" }).sort, "popular");
  assert.equal(normalizeCommunityListInput({ sort: "unknown" }).sort, "latest");
});

test("community feed bounds page size and validates media type", () => {
  assert.equal(normalizeCommunityListInput({ limit: 999 }).limit, 40);
  assert.throws(
    () => normalizeCommunityListInput({ type: "audio" }),
    (error) => error.code === "COMMUNITY_TYPE_INVALID",
  );
});
