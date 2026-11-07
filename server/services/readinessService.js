const REQUIRED_AGENT_STATUS = "waiting_client";
const DEFAULT_REQUIRED_MIGRATION_VERSION = 63;

const normalizeDefinition = (value) => String(value || "").toLowerCase().replace(/\s+/g, " ");

const fail = (message, code) => {
  throw Object.assign(new Error(message), { code });
};

export const resolveRequiredMigrationVersion = (value = process.env.REQUIRED_MIGRATION_VERSION) => {
  const parsed = Number(value ?? DEFAULT_REQUIRED_MIGRATION_VERSION);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new TypeError("REQUIRED_MIGRATION_VERSION must be a positive integer");
  }
  return parsed;
};

/**
 * Database-aware readiness for the API/Worker release unit.
 *
 * This intentionally checks schema capabilities instead of trusting migration
 * filenames on disk: production may contain the file without having applied it.
 */
export const checkDatabaseReadiness = async ({
  sqlClient,
  requiredMigrationVersion = resolveRequiredMigrationVersion(),
}) => {
  if (typeof sqlClient !== "function") throw new TypeError("sqlClient is required");
  const requiredVersion = resolveRequiredMigrationVersion(requiredMigrationVersion);

  const [catalog] = await sqlClient`
    SELECT current_database() AS database_name,
           current_schema() AS schema_name,
           to_regclass('agent_plan_runs')::text AS agent_plan_runs,
           to_regclass('agent_plan_steps')::text AS agent_plan_steps,
           to_regclass('persistent_jobs')::text AS persistent_jobs,
           to_regclass('schema_migrations')::text AS schema_migrations,
           to_regclass('canvas_agent_runs')::text AS canvas_agent_runs,
           to_regclass('canvas_agent_steps')::text AS canvas_agent_steps,
           to_regclass('canvas_workflows')::text AS canvas_workflows,
           to_regclass('canvas_revisions')::text AS canvas_revisions
  `;
  if (!catalog?.agent_plan_runs || !catalog?.agent_plan_steps || !catalog?.persistent_jobs) {
    fail("Required durable runtime tables are missing", "DATABASE_SCHEMA_NOT_READY");
  }
  // The explicit columns are present in every real PostgreSQL row returned by
  // the query above. Older injected readiness adapters may not know about the
  // Canvas Agent additions at all; keep those adapters compatible while still
  // failing closed when PostgreSQL explicitly reports a missing table.
  const canvasCapabilityKeys = [
    "canvas_agent_runs", "canvas_agent_steps", "canvas_workflows", "canvas_revisions",
  ];
  const canvasCapabilityWasQueried = canvasCapabilityKeys.some((key) =>
    Object.prototype.hasOwnProperty.call(catalog || {}, key));
  if (canvasCapabilityWasQueried && canvasCapabilityKeys.some((key) => !catalog[key])) {
    fail("Canvas Agent and workflow runtime tables are missing", "DATABASE_MIGRATION_049_REQUIRED");
  }

  const constraints = await sqlClient`
    SELECT conname, convalidated, pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE conname IN (
      'agent_plan_runs_status_check',
      'agent_plan_steps_status_check',
      'persistent_jobs_max_attempts_check',
      'persistent_jobs_payload_object_check',
      'persistent_jobs_input_refs_array_check',
      'persistent_jobs_metadata_object_check'
    )
  `;
  const constraintMap = new Map(constraints.map((row) => [row.conname, row]));
  for (const name of ["agent_plan_runs_status_check", "agent_plan_steps_status_check"]) {
    const constraint = constraintMap.get(name);
    if (!constraint?.convalidated || !normalizeDefinition(constraint.definition).includes(REQUIRED_AGENT_STATUS)) {
      fail(`${name} does not admit waiting_client`, "DATABASE_MIGRATION_040_REQUIRED");
    }
  }

  const [activeIndex] = await sqlClient`
    SELECT indexdef
    FROM pg_indexes
    WHERE schemaname = current_schema()
      AND indexname = 'idx_agent_plan_runs_active'
    LIMIT 1
  `;
  if (!normalizeDefinition(activeIndex?.indexdef).includes(REQUIRED_AGENT_STATUS)) {
    fail("Active Agent plan index does not admit waiting_client", "DATABASE_MIGRATION_040_REQUIRED");
  }

  if (!catalog.schema_migrations) {
    fail("Migration ledger is missing", "DATABASE_MIGRATION_041_REQUIRED");
  }
  const [ledger] = await sqlClient`
    SELECT version, filename, sha256,
           (SELECT COALESCE(MAX(version), 0)::int FROM schema_migrations) AS latest_version
    FROM schema_migrations
    WHERE version = 41
    LIMIT 1
  `;
  if (
    Number(ledger?.version) !== 41
    || ledger?.filename !== "041_schema_migration_ledger.sql"
    || !/^[0-9a-f]{64}$/.test(String(ledger?.sha256 || ""))
    || Number(ledger?.latest_version || 0) < 44
  ) {
    fail("Dual billing product migration is missing", "DATABASE_MIGRATION_044_REQUIRED");
  }
  if (Number(ledger?.latest_version || 0) < 47) {
    fail("Creative LLM route migration is missing", "DATABASE_MIGRATION_047_REQUIRED");
  }
  if (canvasCapabilityWasQueried && Number(ledger?.latest_version || 0) < 50) {
    fail("Canvas Agent/workflow/template search migrations are missing", "DATABASE_MIGRATION_050_REQUIRED");
  }
  if (requiredVersion >= 51) {
    const retryConstraint = constraintMap.get("persistent_jobs_max_attempts_check");
    const retryDefinition = normalizeDefinition(retryConstraint?.definition);
    const admitsLongPollingRetries = retryDefinition.includes("between 1 and 1000")
      || (
        retryDefinition.includes("max_attempts >= 1")
        && retryDefinition.includes("max_attempts <= 1000")
      );
    if (
      !retryConstraint?.convalidated
      || !admitsLongPollingRetries
    ) {
      fail("Workflow media polling retry capability is missing", "DATABASE_MIGRATION_051_REQUIRED");
    }
  }
  if (requiredVersion >= 52) {
    for (const [name, expression, expectedType] of [
      ["persistent_jobs_payload_object_check", "jsonb_typeof(payload)", "object"],
      ["persistent_jobs_input_refs_array_check", "jsonb_typeof(input_refs)", "array"],
      ["persistent_jobs_metadata_object_check", "jsonb_typeof(metadata)", "object"],
    ]) {
      const constraint = constraintMap.get(name);
      const definition = normalizeDefinition(constraint?.definition);
      if (!constraint?.convalidated || !definition.includes(expression) || !definition.includes(`'${expectedType}'`)) {
        fail("Persistent job JSON columns are not structurally constrained", "DATABASE_MIGRATION_052_REQUIRED");
      }
    }
  }
  if (Number(ledger?.latest_version || 0) < requiredVersion) {
    fail(
      `Database migration ${requiredVersion} is required`,
      `DATABASE_MIGRATION_${requiredVersion}_REQUIRED`,
    );
  }

  return {
    database: catalog.database_name,
    schema: catalog.schema_name,
    migration: Number(ledger.latest_version),
    requiredMigration: requiredVersion,
  };
};

export default checkDatabaseReadiness;
