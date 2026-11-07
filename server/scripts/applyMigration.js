import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import postgres from "postgres";
import { resolveDatabaseSsl } from "../configs/databaseSecurity.js";
import {
  normalizeMigrationMetadata,
  parseMigrationFilename,
  sha256Migration,
} from "../domain/migrations/migrationManifest.js";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(serverRoot, ".env"), quiet: true });

const option = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
};

const requestedFile = option("file");
if (!requestedFile) throw new Error("--file is required");
const migrationPath = path.resolve(serverRoot, requestedFile);
const migrationRoot = `${path.join(serverRoot, "migrations")}${path.sep}`;
if (!migrationPath.startsWith(migrationRoot)) {
  throw Object.assign(new Error("Migration file must be inside server/migrations"), { code: "INVALID_MIGRATION_PATH" });
}
const stat = fs.statSync(migrationPath);
if (!stat.isFile()) throw new Error("Migration path is not a file");

const { version, filename } = parseMigrationFilename(migrationPath);
const source = fs.readFileSync(migrationPath, "utf8");
const sha256 = sha256Migration(source);
const { appliedBy, releaseVersion } = normalizeMigrationMetadata({
  appliedBy: option("applied-by") || process.env.MIGRATION_APPLIED_BY,
  releaseVersion: option("release-version") || process.env.RELEASE_VERSION,
});
const databaseUrl = String(process.env.DATABASE_URL || "").trim();
if (!databaseUrl) throw Object.assign(new Error("DATABASE_URL is required"), { code: "DATABASE_URL_REQUIRED" });

// prepare:false uses PostgreSQL's simple-query protocol, which supports the
// controlled migration files containing multiple statements and migration
// 040's CREATE INDEX CONCURRENTLY outside an enclosing transaction.
const client = postgres(databaseUrl, {
  max: 1,
  prepare: false,
  connect_timeout: 10,
  idle_timeout: 5,
  ssl: resolveDatabaseSsl(),
});

const ledgerExists = async () => {
  const [row] = await client`SELECT to_regclass('schema_migrations')::text AS ledger`;
  return Boolean(row?.ledger);
};

try {
  await client`SELECT pg_advisory_lock(hashtextextended('stardraw:schema-migration', 0))`;
  if (await ledgerExists()) {
    const [existing] = await client`
      SELECT version, filename, sha256
      FROM schema_migrations
      WHERE version = ${version} OR filename = ${filename}
      LIMIT 1
    `;
    if (existing) {
      if (Number(existing.version) !== version || existing.filename !== filename || existing.sha256 !== sha256) {
        throw Object.assign(new Error("Applied migration checksum or identity does not match the local file"), {
          code: "MIGRATION_INTEGRITY_MISMATCH",
        });
      }
      console.log(`Migration ${filename} already recorded with matching SHA-256; no changes made.`);
      process.exitCode = 0;
    } else {
      const [latest] = await client`SELECT COALESCE(MAX(version), 0)::int AS version FROM schema_migrations`;
      if (Number(latest?.version || 0) >= version) {
        throw Object.assign(new Error("Migration must be applied in strictly increasing version order"), {
          code: "MIGRATION_ORDER_INVALID",
        });
      }
    }
    if (existing) {
      // Skip execution after a verified idempotent replay.
    } else {
      const startedAt = process.hrtime.bigint();
      await client.unsafe(source);
      const durationMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
      await client`
        INSERT INTO schema_migrations
          (version, filename, sha256, applied_by, release_version, execution_duration_ms)
        VALUES
          (${version}, ${filename}, ${sha256}, ${appliedBy}, ${releaseVersion}, ${durationMs})
      `;
      console.log(`Applied ${filename}; SHA-256 ${sha256}; duration ${durationMs} ms.`);
    }
  } else {
    if (version !== 41) {
      throw Object.assign(new Error("Migration ledger is missing; bootstrap migration 041 must be applied first"), {
        code: "MIGRATION_LEDGER_REQUIRED",
      });
    }
    const startedAt = process.hrtime.bigint();
    await client.unsafe(source);
    const durationMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
    await client`
      INSERT INTO schema_migrations
        (version, filename, sha256, applied_by, release_version, execution_duration_ms)
      VALUES
        (${version}, ${filename}, ${sha256}, ${appliedBy}, ${releaseVersion}, ${durationMs})
    `;
    console.log(`Bootstrapped migration ledger with ${filename}; SHA-256 ${sha256}; duration ${durationMs} ms.`);
  }
} finally {
  await client`SELECT pg_advisory_unlock(hashtextextended('stardraw:schema-migration', 0))`.catch(() => {});
  await client.end({ timeout: 5 });
}
