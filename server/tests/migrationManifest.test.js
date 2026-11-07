import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeMigrationMetadata,
  parseMigrationFilename,
  sha256Migration,
} from "../domain/migrations/migrationManifest.js";

test("migration manifests bind a strict versioned filename and stable checksum", () => {
  assert.deepEqual(parseMigrationFilename("/srv/migrations/041_schema_migration_ledger.sql"), {
    version: 41,
    filename: "041_schema_migration_ledger.sql",
  });
  assert.equal(sha256Migration("SELECT 1;"), "17db4fd369edb9244b9f91d9aeed145c3d04ad8ba6e95d06247f07a63527d11a");
  assert.throws(() => parseMigrationFilename("../041-BAD.sql"), (error) => error.code === "INVALID_MIGRATION_FILENAME");
});

test("migration audit metadata is required and shell/SQL metacharacters are rejected", () => {
  assert.deepEqual(normalizeMigrationMetadata({
    appliedBy: "authing:root-user",
    releaseVersion: "20260808-ledger",
  }), {
    appliedBy: "authing:root-user",
    releaseVersion: "20260808-ledger",
  });
  assert.throws(
    () => normalizeMigrationMetadata({ appliedBy: "root'; DROP TABLE users;--", releaseVersion: "release" }),
    (error) => error.code === "INVALID_APPLIED_BY",
  );
});
