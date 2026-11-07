import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  createTaskSnapshotEvent,
  createTaskSseService,
  formatTaskSseEvent,
} from "../services/taskSseService.js";

const snapshot = (status = "running") => ({
  tasks: [{ id: "persistent_job:1", status }],
  page: 1,
  pageSize: 20,
  total: 1,
  hasNextPage: false,
});

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.headersSent = false;
    this.writableEnded = false;
    this.destroyed = false;
    this.chunks = [];
  }

  writeHead(status, headers) {
    this.status = status;
    this.headers = headers;
    this.headersSent = true;
  }

  write(chunk) {
    this.chunks.push(String(chunk));
    return true;
  }

  end() {
    this.writableEnded = true;
  }
}

const fakeTimers = () => {
  const intervals = [];
  const timeouts = [];
  return {
    intervals,
    timeouts,
    setIntervalFn: (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      intervals.push(timer);
      return timer;
    },
    clearIntervalFn: (timer) => { timer.cleared = true; },
    setTimeoutFn: (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      timeouts.push(timer);
      return timer;
    },
    clearTimeoutFn: (timer) => { timer.cleared = true; },
  };
};

test("creates deterministic SSE snapshot IDs and valid event frames", () => {
  const first = createTaskSnapshotEvent(snapshot());
  const duplicate = createTaskSnapshotEvent(snapshot());
  const completed = createTaskSnapshotEvent(snapshot("completed"));

  assert.equal(first.id, duplicate.id);
  assert.notEqual(first.id, completed.id);
  assert.match(first.id, /^snapshot-[a-f0-9]{64}$/);
  assert.equal(
    formatTaskSseEvent(first),
    `id: ${first.id}\nevent: snapshot\ndata: ${JSON.stringify(first.data)}\n\n`,
  );
});

test("streams only the signed-in user's current aggregate and emits changed snapshots", async () => {
  const req = new EventEmitter();
  const res = new FakeResponse();
  const timers = fakeTimers();
  let current = snapshot();
  const calls = [];
  const service = createTaskSseService({
    taskCenter: {
      listForUser: async (input) => {
        calls.push(input);
        return current;
      },
    },
    env: {},
    ...timers,
  });

  const stream = await service.streamForUser({
    req,
    res,
    userId: "owner-1",
    page: "1",
    pageSize: "20",
    status: "running",
    type: "workflow",
  });

  assert.equal(res.status, 200);
  assert.equal(res.headers["Content-Type"], "text/event-stream; charset=utf-8");
  assert.match(res.chunks.join(""), /event: snapshot/);
  assert.deepEqual(calls[0], {
    userId: "owner-1",
    page: "1",
    pageSize: "20",
    status: "running",
    type: "workflow",
  });

  const before = res.chunks.length;
  await stream.poll();
  assert.equal(res.chunks.length, before);

  current = snapshot("completed");
  await stream.poll();
  assert.equal(res.chunks.length, before + 1);
  assert.match(res.chunks.at(-1), /"status":"completed"/);

  req.emit("close");
  assert.equal(res.writableEnded, true);
  assert.ok(timers.intervals.every((timer) => timer.cleared));
  assert.ok(timers.timeouts.every((timer) => timer.cleared));
});

test("honors Last-Event-ID and avoids replaying an unchanged snapshot", async () => {
  const req = new EventEmitter();
  const res = new FakeResponse();
  const timers = fakeTimers();
  const current = snapshot();
  const lastEventId = createTaskSnapshotEvent(current).id;
  const service = createTaskSseService({
    taskCenter: { listForUser: async () => current },
    env: {},
    ...timers,
  });

  const stream = await service.streamForUser({ req, res, userId: "owner-1", lastEventId });
  assert.doesNotMatch(res.chunks.join(""), /event: snapshot/);

  stream.heartbeat();
  assert.match(res.chunks.at(-1), /: heartbeat/);
  res.emit("close");
  assert.equal(res.writableEnded, true);
});
