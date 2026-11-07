import { createHash } from "node:crypto";

const DEFAULT_POLL_INTERVAL_MS = 1_500;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_CONNECTION_LIFETIME_MS = 55_000;

const boundedInteger = (value, fallback, { min, max }) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
};

const sanitizeEventId = (value) => String(value || "")
  .replace(/[\r\n\0]/g, "")
  .trim()
  .slice(0, 200);

const eventData = (value) => JSON.stringify(value ?? null).replace(/[\u2028\u2029]/g, (character) => (
  character === "\u2028" ? "\\u2028" : "\\u2029"
));

export const createTaskSnapshotEvent = (snapshot) => {
  const payload = {
    tasks: Array.isArray(snapshot?.tasks) ? snapshot.tasks : [],
    page: Number(snapshot?.page || 1),
    pageSize: Number(snapshot?.pageSize || 0),
    total: Number(snapshot?.total || 0),
    hasNextPage: snapshot?.hasNextPage === true,
  };
  const serialized = JSON.stringify(payload);
  const id = `snapshot-${createHash("sha256").update(serialized).digest("hex")}`;
  return Object.freeze({ id, type: "snapshot", data: payload });
};

export const formatTaskSseEvent = ({ id, type = "message", data }) => {
  const lines = [];
  const safeId = sanitizeEventId(id);
  if (safeId) lines.push(`id: ${safeId}`);
  lines.push(`event: ${sanitizeEventId(type) || "message"}`);
  for (const line of eventData(data).split("\n")) lines.push(`data: ${line}`);
  return `${lines.join("\n")}\n\n`;
};

export const createTaskSseService = ({
  taskCenter,
  env = process.env,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) => {
  if (!taskCenter || typeof taskCenter.listForUser !== "function") {
    throw new TypeError("taskCenter.listForUser is required");
  }

  const pollIntervalMs = boundedInteger(env.TASK_SSE_POLL_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS, {
    min: 500,
    max: 30_000,
  });
  const heartbeatIntervalMs = boundedInteger(env.TASK_SSE_HEARTBEAT_INTERVAL_MS, DEFAULT_HEARTBEAT_INTERVAL_MS, {
    min: 5_000,
    max: 60_000,
  });
  const connectionLifetimeMs = boundedInteger(env.TASK_SSE_CONNECTION_LIFETIME_MS, DEFAULT_CONNECTION_LIFETIME_MS, {
    min: 15_000,
    max: 5 * 60_000,
  });

  const streamForUser = async ({
    req,
    res,
    userId,
    page,
    pageSize,
    status,
    type,
    lastEventId,
  }) => {
    const listInput = { userId, page, pageSize, status, type };
    const initialSnapshot = await taskCenter.listForUser(listInput);
    let currentEvent = createTaskSnapshotEvent(initialSnapshot);
    let lastSentId = sanitizeEventId(lastEventId);
    let closed = false;
    let polling = false;
    let pollTimer;
    let heartbeatTimer;
    let lifetimeTimer;

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 3000\n: connected\n\n");

    const writeEvent = (event) => {
      if (closed || res.destroyed || res.writableEnded) return false;
      res.write(formatTaskSseEvent(event));
      lastSentId = event.id;
      return true;
    };

    if (currentEvent.id !== lastSentId) writeEvent(currentEvent);

    const poll = async () => {
      if (closed || polling) return;
      polling = true;
      try {
        const snapshot = await taskCenter.listForUser(listInput);
        currentEvent = createTaskSnapshotEvent(snapshot);
        if (currentEvent.id !== lastSentId) writeEvent(currentEvent);
      } catch (error) {
        if (!closed && !res.destroyed && !res.writableEnded) {
          res.write(formatTaskSseEvent({
            type: "stream_error",
            data: { code: error?.code || "TASK_STREAM_REFRESH_FAILED" },
          }));
        }
      } finally {
        polling = false;
      }
    };

    const heartbeat = () => {
      if (!closed && !res.destroyed && !res.writableEnded) res.write(": heartbeat\n\n");
    };

    const close = () => {
      if (closed) return;
      closed = true;
      if (pollTimer) clearIntervalFn(pollTimer);
      if (heartbeatTimer) clearIntervalFn(heartbeatTimer);
      if (lifetimeTimer) clearTimeoutFn(lifetimeTimer);
      if (!res.writableEnded) res.end();
    };

    pollTimer = setIntervalFn(() => void poll(), pollIntervalMs);
    heartbeatTimer = setIntervalFn(heartbeat, heartbeatIntervalMs);
    lifetimeTimer = setTimeoutFn(close, connectionLifetimeMs);
    req.once("close", close);
    res.once("close", close);

    return { close, poll, heartbeat, currentEvent };
  };

  return Object.freeze({ streamForUser });
};

export {
  DEFAULT_CONNECTION_LIFETIME_MS,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_POLL_INTERVAL_MS,
  sanitizeEventId,
};
