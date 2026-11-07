import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkWorkerHeartbeat, createWorkerHeartbeat, writeWorkerHeartbeat } from "../workerHealth.js";

const withTemporaryFile = async (run) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "stardraw-worker-health-"));
  try {
    return await run(path.join(directory, "heartbeat.json"));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
};

test("worker heartbeat is written atomically and accepted while fresh", async () => {
  await withTemporaryFile(async (filePath) => {
    await writeWorkerHeartbeat({
      filePath,
      now: 10_000,
      pid: process.pid,
      snapshot: { status: "running", workerId: "worker-test", queueName: "workflow" },
    });
    const result = await checkWorkerHeartbeat({ filePath, now: 12_000, staleAfterMs: 5_000, checkProcess: false });
    assert.equal(result.healthy, true);
    assert.equal(result.ageMs, 2_000);
    assert.equal(result.record.workerId, "worker-test");
    assert.equal(result.record.queueName, "workflow");
  });
});

test("worker health rejects stale and non-running heartbeat records", async () => {
  await withTemporaryFile(async (filePath) => {
    await writeWorkerHeartbeat({ filePath, now: 10_000, snapshot: { status: "running" } });
    await assert.rejects(
      checkWorkerHeartbeat({ filePath, now: 20_001, staleAfterMs: 10_000, checkProcess: false }),
      (error) => error.code === "WORKER_HEARTBEAT_STALE",
    );

    await writeWorkerHeartbeat({ filePath, now: 20_000, snapshot: { status: "stopping" } });
    await assert.rejects(
      checkWorkerHeartbeat({ filePath, now: 20_100, staleAfterMs: 10_000, checkProcess: false }),
      (error) => error.code === "WORKER_HEARTBEAT_INVALID",
    );
  });
});

test("managed heartbeat emits a running snapshot", async () => {
  await withTemporaryFile(async (filePath) => {
    const heartbeat = createWorkerHeartbeat({
      filePath,
      intervalMs: 60_000,
      snapshot: () => ({ status: "running", release: "test" }),
      logger: { error() {} },
    });
    await heartbeat.start();
    assert.equal(heartbeat.isRunning, true);
    const result = await checkWorkerHeartbeat({ filePath, staleAfterMs: 5_000, checkProcess: false });
    assert.equal(result.record.release, "test");
    await heartbeat.stop();
    assert.equal(heartbeat.isRunning, false);
  });
});
