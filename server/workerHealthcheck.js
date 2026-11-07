import "dotenv/config";

import { checkWorkerHeartbeat } from "./workerHealth.js";

try {
  const result = await checkWorkerHeartbeat({
    filePath: process.env.WORKER_HEALTH_FILE || "/app/tmp/worker-health.json",
    staleAfterMs: Number(process.env.WORKER_HEALTH_STALE_MS || 60_000),
  });
  console.log(`worker healthy (${result.ageMs}ms)`);
} catch (error) {
  console.error(String(error?.code || "WORKER_UNHEALTHY"));
  process.exitCode = 1;
}
