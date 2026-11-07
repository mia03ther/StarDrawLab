import dotenv from "dotenv";

dotenv.config({ quiet: true });
process.env.LOG_DIR = process.env.RELEASE_CHECK_LOG_DIR || "/tmp/stardraw-release-check-logs";

const [{ default: sql }, { checkDatabaseReadiness }] = await Promise.all([
  import("../configs/db.js"),
  import("../services/readinessService.js"),
]);

try {
  const result = await checkDatabaseReadiness({ sqlClient: sql });
  console.log(
    `Database ready: ${result.database}/${result.schema}, migration capability ${result.migration}/${result.requiredMigration}`,
  );
} catch (error) {
  console.error(`Database not ready: ${error.code || "DATABASE_NOT_READY"}`);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
