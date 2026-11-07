import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_REFERENCE_IMAGE_BYTES,
  isOversizedReferenceImage,
} from "./mediaUploadLimits.js";

test("allows a reference image exactly at the 10 MiB limit", () => {
  assert.equal(MAX_REFERENCE_IMAGE_BYTES, 10 * 1024 * 1024);
  assert.equal(isOversizedReferenceImage({ size: MAX_REFERENCE_IMAGE_BYTES }), false);
});

test("rejects a reference image larger than 10 MiB", () => {
  assert.equal(isOversizedReferenceImage({ size: MAX_REFERENCE_IMAGE_BYTES + 1 }), true);
});

test("does not reject empty or missing file sizes", () => {
  assert.equal(isOversizedReferenceImage({ size: 0 }), false);
  assert.equal(isOversizedReferenceImage(null), false);
});
