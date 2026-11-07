import assert from "node:assert/strict";
import test from "node:test";

import {
  mergeTemplatePages,
  shouldShowInitialTemplateLoading,
} from "./templateMarketplacePagination.js";

test("load more preserves existing rows and appends only new templates", () => {
  assert.deepEqual(
    mergeTemplatePages(
      [{ id: "1", title: "first" }, { id: "2", title: "old second" }],
      [{ id: "2", title: "updated second" }, { id: "3", title: "third" }],
    ),
    [{ id: "1", title: "first" }, { id: "2", title: "updated second" }, { id: "3", title: "third" }],
  );
});

test("loading another page never replaces an existing grid with the initial spinner", () => {
  assert.equal(shouldShowInitialTemplateLoading({ loading: true, itemCount: 0 }), true);
  assert.equal(shouldShowInitialTemplateLoading({ loading: true, itemCount: 48 }), false);
});
