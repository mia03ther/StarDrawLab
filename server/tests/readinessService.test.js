import assert from "node:assert/strict";
import test from "node:test";

import { checkDatabaseReadiness } from "../services/readinessService.js";

const scriptedSql = (...responses) => {
  let index = 0;
  return async () => structuredClone(responses[index++]);
};

test("readiness verifies durable tables, Agent constraints, active index, and migration ledger", async () => {
  const result = await checkDatabaseReadiness({
    sqlClient: scriptedSql(
      [{ database_name: "stardraw", schema_name: "public", agent_plan_runs: "agent_plan_runs", agent_plan_steps: "agent_plan_steps", persistent_jobs: "persistent_jobs", schema_migrations: "schema_migrations", canvas_agent_runs: "canvas_agent_runs", canvas_agent_steps: "canvas_agent_steps", canvas_workflows: "canvas_workflows", canvas_revisions: "canvas_revisions" }],
      [
        { conname: "agent_plan_runs_status_check", convalidated: true, definition: "CHECK status IN (waiting_client)" },
        { conname: "agent_plan_steps_status_check", convalidated: true, definition: "CHECK status IN (waiting_client)" },
        { conname: "persistent_jobs_max_attempts_check", convalidated: true, definition: "CHECK (((max_attempts >= 1) AND (max_attempts <= 1000)))" },
        { conname: "persistent_jobs_payload_object_check", convalidated: true, definition: "CHECK ((jsonb_typeof(payload) = 'object'::text))" },
        { conname: "persistent_jobs_input_refs_array_check", convalidated: true, definition: "CHECK ((jsonb_typeof(input_refs) = 'array'::text))" },
        { conname: "persistent_jobs_metadata_object_check", convalidated: true, definition: "CHECK ((jsonb_typeof(metadata) = 'object'::text))" },
      ],
      [{ indexdef: "CREATE INDEX ... WHERE status IN ('queued', 'waiting_client')" }],
      [{ version: 41, filename: "041_schema_migration_ledger.sql", sha256: "a".repeat(64), latest_version: 63 }],
    ),
  });

  assert.deepEqual(result, {
    database: "stardraw",
    schema: "public",
    migration: 63,
    requiredMigration: 63,
  });
});

test("readiness rejects a database below the configured release migration", async () => {
  await assert.rejects(
    checkDatabaseReadiness({
      sqlClient: scriptedSql(
        [{ database_name: "stardraw", schema_name: "public", agent_plan_runs: "agent_plan_runs", agent_plan_steps: "agent_plan_steps", persistent_jobs: "persistent_jobs", schema_migrations: "schema_migrations", canvas_agent_runs: "canvas_agent_runs", canvas_agent_steps: "canvas_agent_steps", canvas_workflows: "canvas_workflows", canvas_revisions: "canvas_revisions" }],
        [
          { conname: "agent_plan_runs_status_check", convalidated: true, definition: "CHECK status IN (waiting_client)" },
          { conname: "agent_plan_steps_status_check", convalidated: true, definition: "CHECK status IN (waiting_client)" },
          { conname: "persistent_jobs_max_attempts_check", convalidated: true, definition: "CHECK (((max_attempts >= 1) AND (max_attempts <= 1000)))" },
          { conname: "persistent_jobs_payload_object_check", convalidated: true, definition: "CHECK ((jsonb_typeof(payload) = 'object'::text))" },
          { conname: "persistent_jobs_input_refs_array_check", convalidated: true, definition: "CHECK ((jsonb_typeof(input_refs) = 'array'::text))" },
          { conname: "persistent_jobs_metadata_object_check", convalidated: true, definition: "CHECK ((jsonb_typeof(metadata) = 'object'::text))" },
        ],
        [{ indexdef: "CREATE INDEX ... WHERE status IN ('queued', 'waiting_client')" }],
        [{ version: 41, filename: "041_schema_migration_ledger.sql", sha256: "a".repeat(64), latest_version: 61 }],
      ),
    }),
    (error) => error.code === "DATABASE_MIGRATION_63_REQUIRED",
  );
});

test("readiness fails closed when migration 040 is not applied", async () => {
  await assert.rejects(
    checkDatabaseReadiness({
      sqlClient: scriptedSql(
        [{ database_name: "stardraw", schema_name: "public", agent_plan_runs: "agent_plan_runs", agent_plan_steps: "agent_plan_steps", persistent_jobs: "persistent_jobs", schema_migrations: null }],
        [
          { conname: "agent_plan_runs_status_check", convalidated: true, definition: "CHECK status IN (queued, running)" },
          { conname: "agent_plan_steps_status_check", convalidated: true, definition: "CHECK status IN (ready, running)" },
        ],
      ),
    }),
    (error) => error.code === "DATABASE_MIGRATION_040_REQUIRED",
  );
});

test("readiness fails closed when migration 041 is not recorded", async () => {
  await assert.rejects(
    checkDatabaseReadiness({
      sqlClient: scriptedSql(
        [{ database_name: "stardraw", schema_name: "public", agent_plan_runs: "agent_plan_runs", agent_plan_steps: "agent_plan_steps", persistent_jobs: "persistent_jobs", schema_migrations: null }],
        [
          { conname: "agent_plan_runs_status_check", convalidated: true, definition: "CHECK status IN (waiting_client)" },
          { conname: "agent_plan_steps_status_check", convalidated: true, definition: "CHECK status IN (waiting_client)" },
        ],
        [{ indexdef: "CREATE INDEX ... WHERE status IN ('queued', 'waiting_client')" }],
      ),
    }),
    (error) => error.code === "DATABASE_MIGRATION_041_REQUIRED",
  );
});
