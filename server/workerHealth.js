import fs from "node:fs/promises";
import path from "node:path";

const positiveInteger = (value, fallback, name) => {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return parsed;
};

const safeSnapshot = (snapshot) => {
  const value = typeof snapshot === "function" ? snapshot() : snapshot;
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
};

export const writeWorkerHeartbeat = async ({ filePath, snapshot = {}, now = Date.now(), pid = process.pid } = {}) => {
  if (!filePath || typeof filePath !== "string") throw new TypeError("filePath is required");
  const timestamp = positiveInteger(now, Date.now(), "now");
  const record = {
    ...safeSnapshot(snapshot),
    pid: positiveInteger(pid, process.pid, "pid"),
    timestamp,
    updatedAt: new Date(timestamp).toISOString(),
  };
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${record.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporaryPath, filePath);
  return record;
};

export const checkWorkerHeartbeat = async ({
  filePath,
  staleAfterMs = 60_000,
  now = Date.now(),
  checkProcess = true,
} = {}) => {
  if (!filePath || typeof filePath !== "string") throw new TypeError("filePath is required");
  const maximumAge = positiveInteger(staleAfterMs, 60_000, "staleAfterMs");
  const currentTime = positiveInteger(now, Date.now(), "now");
  let record;
  try {
    record = JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    throw Object.assign(new Error("Worker heartbeat is missing or invalid"), {
      code: "WORKER_HEARTBEAT_INVALID",
      cause: error,
    });
  }

  const timestamp = Number(record?.timestamp);
  const pid = Number(record?.pid);
  if (!Number.isSafeInteger(timestamp) || !Number.isSafeInteger(pid) || record?.status !== "running") {
    throw Object.assign(new Error("Worker heartbeat has an invalid state"), { code: "WORKER_HEARTBEAT_INVALID" });
  }
  const ageMs = currentTime - timestamp;
  if (ageMs < -5_000 || ageMs > maximumAge) {
    throw Object.assign(new Error("Worker heartbeat is stale"), { code: "WORKER_HEARTBEAT_STALE", ageMs });
  }
  if (checkProcess) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      throw Object.assign(new Error("Worker process is not running"), {
        code: "WORKER_PROCESS_NOT_RUNNING",
        cause: error,
      });
    }
  }
  return { healthy: true, ageMs, record };
};

export const createWorkerHeartbeat = ({ filePath, intervalMs = 15_000, snapshot = {}, logger = console } = {}) => {
  const interval = positiveInteger(intervalMs, 15_000, "intervalMs");
  let timer = null;
  let pendingWrite = null;

  const pulse = () => {
    if (pendingWrite) return pendingWrite;
    pendingWrite = writeWorkerHeartbeat({ filePath, snapshot })
      .catch((error) => {
        logger.error?.("job-worker.process-heartbeat-failed", {
          code: String(error?.code || "WORKER_HEARTBEAT_WRITE_FAILED").slice(0, 120),
          name: String(error?.name || "Error").slice(0, 80),
        });
        throw error;
      })
      .finally(() => {
        pendingWrite = null;
      });
    return pendingWrite;
  };

  return {
    async start() {
      if (timer) return;
      await pulse();
      timer = setInterval(() => void pulse().catch(() => {}), interval);
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      if (pendingWrite) await pendingWrite.catch(() => {});
    },
    pulse,
    get isRunning() {
      return Boolean(timer);
    },
  };
};
