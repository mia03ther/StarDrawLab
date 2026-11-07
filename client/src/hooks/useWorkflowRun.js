import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuthing } from "../contexts/AuthingContext";

const API_BASE_URL = String(import.meta.env.VITE_BASE_URL || "").replace(/\/$/, "");
const STORAGE_PREFIX = "stardraw:workflow-run:";
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 15_000;

const EMPTY_PROGRESS = Object.freeze({
  completed: 0,
  total: 0,
  percent: 0,
  nodes: [],
  pointsCharged: 0,
  estimatedPoints: 0,
});

const makeError = (message, details = {}) => Object.assign(new Error(message), details);

const normalizeError = (error) => ({
  message: error?.message || "Workflow request failed",
  code: error?.code || "WORKFLOW_REQUEST_FAILED",
  ...(error?.status != null ? { status: error.status } : {}),
  ...(error?.available_points != null ? { availablePoints: error.available_points } : {}),
  ...(error?.required_points != null ? { requiredPoints: error.required_points } : {}),
});

const parseEventData = (value) => {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const createIdempotencyKey = () => {
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  return `workflow-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const progressFromSnapshot = ({ run, nodes = [] }) => {
  const completed = nodes.filter((node) => ["completed", "skipped"].includes(node.status)).length;
  const total = nodes.length;
  return {
    completed,
    total,
    percent: total > 0 ? Math.round((completed / total) * 100) : 0,
    nodes,
    pointsCharged: Number(run?.pointsCharged || 0),
    estimatedPoints: Number(run?.estimatedPoints || 0),
  };
};

const statusFromSnapshot = (snapshot) => {
  const status = snapshot?.run?.status || "running";
  const nodes = snapshot?.nodes || [];
  if (!TERMINAL_STATUSES.has(status) && nodes.length > 0 && nodes.every((node) => node.status === "completed")) {
    return "completed";
  }
  return status;
};

const responseError = async (response) => {
  let body = {};
  try {
    body = await response.json();
  } catch {
    // Some stream and proxy failures have no JSON response body.
  }
  return makeError(body.message || `Workflow request failed (${response.status})`, {
    ...body,
    status: response.status,
    code: body.code || "WORKFLOW_REQUEST_FAILED",
  });
};

const waitForReconnect = (milliseconds, signal) => new Promise((resolve, reject) => {
  const timer = window.setTimeout(resolve, milliseconds);
  signal.addEventListener("abort", () => {
    window.clearTimeout(timer);
    reject(makeError("Request aborted", { name: "AbortError" }));
  }, { once: true });
});

/** Parse an SSE response without EventSource so Authorization can be supplied. */
const consumeEventStream = async (body, onEvent, initialLastEventId = "") => {
  if (!body?.getReader) throw makeError("Streaming responses are not supported", { code: "SSE_UNSUPPORTED" });

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines = [];
  let eventType = "";
  let eventId = "";
  let lastEventId = initialLastEventId;
  let stopped = false;

  const dispatch = async () => {
    if (dataLines.length === 0) {
      eventType = "";
      eventId = "";
      return;
    }
    if (eventId && !eventId.includes("\0")) lastEventId = eventId;
    const shouldContinue = await onEvent({
      id: lastEventId,
      type: eventType || "message",
      data: parseEventData(dataLines.join("\n")),
    });
    dataLines = [];
    eventType = "";
    eventId = "";
    if (shouldContinue === false) stopped = true;
  };

  const processLine = async (line) => {
    if (line === "") return dispatch();
    if (line.startsWith(":")) return;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") dataLines.push(value);
    else if (field === "event") eventType = value;
    else if (field === "id") eventId = value;
  };

  const drainLines = async (flush = false) => {
    while (!stopped) {
      let lineEnd = -1;
      let lineBreakLength = 1;
      for (let index = 0; index < buffer.length; index += 1) {
        if (buffer[index] === "\n") {
          lineEnd = index;
          break;
        }
        if (buffer[index] === "\r") {
          if (!flush && index === buffer.length - 1) return;
          lineEnd = index;
          lineBreakLength = buffer[index + 1] === "\n" ? 2 : 1;
          break;
        }
      }
      if (lineEnd === -1) {
        if (flush && buffer) {
          const finalLine = buffer;
          buffer = "";
          await processLine(finalLine);
        }
        return;
      }
      const line = buffer.slice(0, lineEnd);
      buffer = buffer.slice(lineEnd + lineBreakLength);
      await processLine(line);
    }
  };

  try {
    while (!stopped) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      await drainLines();
    }
    buffer += decoder.decode();
    await drainLines(true);
    if (!stopped) await dispatch();
  } finally {
    if (stopped) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }

  return { lastEventId, stopped };
};

const useWorkflowRun = (canvasId) => {
  const { getToken } = useAuthing();
  const storageKey = canvasId == null || String(canvasId).trim() === ""
    ? null
    : `${STORAGE_PREFIX}${String(canvasId)}`;
  const [status, setStatus] = useState("idle");
  const [progress, setProgress] = useState(EMPTY_PROGRESS);
  const [events, setEvents] = useState([]);
  const [error, setError] = useState(null);
  const mountedRef = useRef(false);
  const runIdRef = useRef(null);
  const sessionRef = useRef(0);
  const controllersRef = useRef(new Set());
  const eventIdsRef = useRef(new Set());

  const isCurrent = useCallback((session) => mountedRef.current && sessionRef.current === session, []);

  const abortRequests = useCallback(() => {
    controllersRef.current.forEach((controller) => controller.abort());
    controllersRef.current.clear();
  }, []);

  const beginSession = useCallback(() => {
    sessionRef.current += 1;
    abortRequests();
    return sessionRef.current;
  }, [abortRequests]);

  const removeStoredRun = useCallback((runId) => {
    if (!storageKey) return;
    try {
      if (!runId || localStorage.getItem(storageKey) === String(runId)) localStorage.removeItem(storageKey);
    } catch {
      // Storage can be disabled without preventing workflow execution.
    }
  }, [storageKey]);

  const storeRun = useCallback((runId) => {
    if (!storageKey) return;
    try {
      localStorage.setItem(storageKey, String(runId));
    } catch {
      // Storage can be disabled without preventing workflow execution.
    }
  }, [storageKey]);

  const authorizedFetch = useCallback(async (path, options = {}) => {
    const controller = new AbortController();
    controllersRef.current.add(controller);
    try {
      const token = await getToken();
      if (controller.signal.aborted) throw makeError("Request aborted", { name: "AbortError" });
      if (!token) throw makeError("Authentication token is unavailable", {
        status: 401,
        code: "AUTHENTICATION_REQUIRED",
      });
      const response = await fetch(`${API_BASE_URL}${path}`, {
        ...options,
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          ...options.headers,
          Authorization: `Bearer ${token}`,
        },
      });
      return {
        response,
        controller,
        release: () => controllersRef.current.delete(controller),
      };
    } catch (fetchError) {
      controllersRef.current.delete(controller);
      throw fetchError;
    }
  }, [getToken]);

  const requestJson = useCallback(async (path, options = {}) => {
    const request = await authorizedFetch(path, options);
    try {
      if (!request.response.ok) throw await responseError(request.response);
      const body = await request.response.json();
      if (body?.success === false) throw makeError(body.message || "Workflow request failed", body);
      return body?.data;
    } finally {
      request.release();
    }
  }, [authorizedFetch]);

  const applySnapshot = useCallback((snapshot, runId, session) => {
    if (!isCurrent(session)) return null;
    const nextStatus = statusFromSnapshot(snapshot);
    setStatus(nextStatus);
    setProgress(progressFromSnapshot(snapshot));
    if (nextStatus === "failed") {
      setError(normalizeError({
        message: snapshot.run?.errorMessage || "Workflow failed",
        code: snapshot.run?.errorCode || "WORKFLOW_FAILED",
      }));
    } else {
      setError(null);
    }
    if (TERMINAL_STATUSES.has(nextStatus)) {
      runIdRef.current = null;
      removeStoredRun(runId);
    }
    return nextStatus;
  }, [isCurrent, removeStoredRun]);

  const loadSnapshot = useCallback(async (runId, session) => {
    const snapshot = await requestJson(`/api/workflows/runs/${encodeURIComponent(runId)}`);
    return { snapshot, status: applySnapshot(snapshot, runId, session) };
  }, [applySnapshot, requestJson]);

  const appendEvent = useCallback((nextEvent, session) => {
    if (!isCurrent(session)) return;
    if (nextEvent.id && eventIdsRef.current.has(nextEvent.id)) return;
    if (nextEvent.id) eventIdsRef.current.add(nextEvent.id);
    setEvents((current) => [...current, nextEvent]);
  }, [isCurrent]);

  const monitorRun = useCallback(async (runId, session) => {
    let lastEventId = "";
    let reconnectAttempt = 0;

    while (isCurrent(session) && runIdRef.current === runId) {
      try {
        const loaded = await loadSnapshot(runId, session);
        if (!isCurrent(session) || TERMINAL_STATUSES.has(loaded.status)) return;

        const after = Number(lastEventId);
        const query = Number.isSafeInteger(after) && after > 0 ? `?after=${after}` : "";
        const stream = await authorizedFetch(`/api/workflows/runs/${encodeURIComponent(runId)}/events${query}`, {
          headers: { Accept: "text/event-stream" },
        });
        try {
          if (!stream.response.ok) throw await responseError(stream.response);
          const connectedAt = Date.now();
          const consumed = await consumeEventStream(stream.response.body, async (nextEvent) => {
            reconnectAttempt = 0;
            appendEvent(nextEvent, session);
            const current = await loadSnapshot(runId, session);
            return isCurrent(session) && !TERMINAL_STATUSES.has(current.status);
          }, lastEventId);
          if (Date.now() - connectedAt >= 10_000) reconnectAttempt = 0;
          lastEventId = consumed.lastEventId;
          if (!isCurrent(session) || consumed.stopped) return;
        } finally {
          stream.release();
        }

        const current = await loadSnapshot(runId, session);
        if (!isCurrent(session) || TERMINAL_STATUSES.has(current.status)) return;
      } catch (streamError) {
        if (streamError?.name === "AbortError" || !isCurrent(session)) return;
        setError(normalizeError(streamError));
      }

      const delayController = new AbortController();
      controllersRef.current.add(delayController);
      try {
        const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * (2 ** reconnectAttempt));
        reconnectAttempt += 1;
        await waitForReconnect(delay, delayController.signal);
      } catch (delayError) {
        if (delayError?.name === "AbortError") return;
        throw delayError;
      } finally {
        controllersRef.current.delete(delayController);
      }
    }
  }, [appendEvent, authorizedFetch, isCurrent, loadSnapshot]);

  const resetState = useCallback(() => {
    runIdRef.current = null;
    eventIdsRef.current.clear();
    setStatus("idle");
    setProgress(EMPTY_PROGRESS);
    setEvents([]);
    setError(null);
  }, []);

  const estimate = useCallback(async (definition) => {
    setError(null);
    try {
      const data = await requestJson("/api/workflows/estimate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ definition }),
      });
      return data;
    } catch (requestError) {
      if (requestError?.name !== "AbortError") setError(normalizeError(requestError));
      throw requestError;
    }
  }, [requestJson]);

  const startRequest = useCallback(async ({ path, body }) => {
    const session = beginSession();
    runIdRef.current = null;
    eventIdsRef.current.clear();
    setStatus("starting");
    setProgress(EMPTY_PROGRESS);
    setEvents([]);
    setError(null);

    try {
      const data = await requestJson(path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Idempotency-Key": createIdempotencyKey(),
        },
        body: JSON.stringify(body || {}),
      });
      if (!isCurrent(session)) return data;
      const runId = String(data?.run?.id || "");
      if (!runId) throw makeError("Workflow response has no run id", { code: "INVALID_WORKFLOW_RESPONSE" });
      runIdRef.current = runId;
      storeRun(runId);
      setStatus(data.run.status || "queued");
      setProgress((current) => ({
        ...current,
        pointsCharged: Number(data.run.pointsCharged || 0),
        estimatedPoints: Number(data.run.estimatedPoints || data.estimated_points || 0),
      }));
      void monitorRun(runId, session);
      return data;
    } catch (requestError) {
      if (requestError?.name !== "AbortError" && isCurrent(session)) {
        setStatus("idle");
        setError(normalizeError(requestError));
      }
      throw requestError;
    }
  }, [beginSession, isCurrent, monitorRun, requestJson, storeRun]);

  const start = useCallback(async (input = {}, options = {}) => {
    const hasEnvelope = input && !Array.isArray(input) && Object.prototype.hasOwnProperty.call(input, "definition");
    const definition = hasEnvelope ? input.definition : input;
    const title = hasEnvelope ? input.title : options.title;
    const requestedCanvasId = hasEnvelope ? (input.canvasId ?? canvasId) : (options.canvasId ?? canvasId);
    const mcpApprovalConfirmed = hasEnvelope
      ? input.mcpApprovalConfirmed === true
      : options.mcpApprovalConfirmed === true;
    const variables = hasEnvelope ? input.variables : options.variables;
    const inputs = hasEnvelope ? input.inputs : options.inputs;
    return startRequest({
      path: "/api/workflows/runs",
      body: { definition, title, canvasId: requestedCanvasId || null, mcpApprovalConfirmed, variables, inputs },
    });
  }, [canvasId, startRequest]);

  const startNamed = useCallback(async (workflowId, options = {}) => {
    const normalizedId = String(workflowId || "").trim();
    if (!normalizedId) throw makeError("A saved workflow is required", { code: "CANVAS_WORKFLOW_REQUIRED" });
    return startRequest({
      path: `/api/workflows/definitions/${encodeURIComponent(normalizedId)}/run`,
      body: {
        mcpApprovalConfirmed: options.mcpApprovalConfirmed === true,
        variables: options.variables,
        inputs: options.inputs,
      },
    });
  }, [startRequest]);

  const resume = useCallback(async (requestedRunId) => {
    let runId = requestedRunId == null ? "" : String(requestedRunId).trim();
    if (!runId && storageKey) {
      try {
        runId = localStorage.getItem(storageKey) || "";
      } catch {
        runId = "";
      }
    }
    if (!runId) return null;

    const session = beginSession();
    runIdRef.current = runId;
    eventIdsRef.current.clear();
    setStatus("loading");
    setProgress(EMPTY_PROGRESS);
    setEvents([]);
    setError(null);
    storeRun(runId);
    try {
      const loaded = await loadSnapshot(runId, session);
      if (!isCurrent(session) || TERMINAL_STATUSES.has(loaded.status)) return loaded.snapshot;
      void monitorRun(runId, session);
      return loaded.snapshot;
    } catch (requestError) {
      if (requestError?.name !== "AbortError" && isCurrent(session)) {
        setStatus("idle");
        setError(normalizeError(requestError));
        if (requestError?.status === 404) {
          runIdRef.current = null;
          removeStoredRun(runId);
        }
      }
      throw requestError;
    }
  }, [beginSession, isCurrent, loadSnapshot, monitorRun, removeStoredRun, storageKey, storeRun]);

  const approve = useCallback(async (nodeKey) => {
    const runId = runIdRef.current;
    const normalizedNodeKey = String(nodeKey || "").trim();
    if (!runId || !normalizedNodeKey) {
      throw makeError("A workflow run and approval node are required", { code: "WORKFLOW_APPROVAL_REQUIRED" });
    }
    setError(null);
    try {
      const data = await requestJson(
        `/api/workflows/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(normalizedNodeKey)}/approve`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ confirmed: true }),
        },
      );
      await resume(runId);
      return data;
    } catch (requestError) {
      if (requestError?.name !== "AbortError") setError(normalizeError(requestError));
      throw requestError;
    }
  }, [requestJson, resume]);

  const retryNode = useCallback(async (nodeKey) => {
    const runId = runIdRef.current;
    const normalizedNodeKey = String(nodeKey || "").trim();
    if (!runId || !normalizedNodeKey) {
      throw makeError("A workflow run and node are required", { code: "WORKFLOW_NODE_RETRY_REQUIRED" });
    }
    setError(null);
    try {
      const data = await requestJson(
        `/api/workflows/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(normalizedNodeKey)}/retry`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      await resume(runId);
      return data;
    } catch (requestError) {
      if (requestError?.name !== "AbortError") setError(normalizeError(requestError));
      throw requestError;
    }
  }, [requestJson, resume]);

  const cancel = useCallback(async (reason = "Cancelled by user") => {
    const runId = runIdRef.current;
    if (!runId) return null;
    setError(null);
    try {
      const data = await requestJson(`/api/workflows/runs/${encodeURIComponent(runId)}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      beginSession();
      runIdRef.current = null;
      setStatus(data?.status || "cancelled");
      removeStoredRun(runId);
      return data;
    } catch (requestError) {
      if (requestError?.name !== "AbortError") setError(normalizeError(requestError));
      throw requestError;
    }
  }, [beginSession, removeStoredRun, requestJson]);

  const reset = useCallback(() => {
    const runId = runIdRef.current;
    beginSession();
    removeStoredRun(runId);
    resetState();
  }, [beginSession, removeStoredRun, resetState]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      sessionRef.current += 1;
      abortRequests();
    };
  }, [abortRequests]);

  useEffect(() => {
    const previousRunId = runIdRef.current;
    beginSession();
    if (previousRunId) runIdRef.current = null;
    eventIdsRef.current.clear();
    setStatus("idle");
    setProgress(EMPTY_PROGRESS);
    setEvents([]);
    setError(null);

    if (!storageKey) return;
    let storedRunId = "";
    try {
      storedRunId = localStorage.getItem(storageKey) || "";
    } catch {
      storedRunId = "";
    }
    if (storedRunId) void resume(storedRunId).catch(() => {});

    return () => {
      sessionRef.current += 1;
      abortRequests();
    };
  }, [abortRequests, beginSession, resume, storageKey]);

  return useMemo(() => ({
    status,
    progress,
    events,
    error,
    estimate,
    start,
    startNamed,
    cancel,
    approve,
    retryNode,
    resume,
    reset,
  }), [approve, cancel, error, estimate, events, progress, reset, resume, retryNode, start, startNamed, status]);
};

export default useWorkflowRun;
