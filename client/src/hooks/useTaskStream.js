import { useCallback, useEffect, useRef, useState } from "react";
import { useAuthing } from "../contexts/AuthingContext";
import useAuthAxios from "./useAuthAxios";

const API_BASE_URL = import.meta.env.VITE_BASE_URL || "";
const FALLBACK_POLL_INTERVAL_MS = 10_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 15_000;

const readErrorResponse = async (response) => {
  let body = null;
  try { body = await response.json(); } catch { /* The response may not be JSON. */ }
  const error = new Error(body?.message || `Task stream request failed (${response.status})`);
  error.status = response.status;
  error.code = body?.code || "TASK_STREAM_REQUEST_FAILED";
  return error;
};

const wait = (milliseconds, signal) => new Promise((resolve, reject) => {
  const timer = window.setTimeout(resolve, milliseconds);
  signal.addEventListener("abort", () => {
    window.clearTimeout(timer);
    const error = new Error("Task stream stopped");
    error.name = "AbortError";
    reject(error);
  }, { once: true });
});

export const consumeTaskEventStream = async (body, onEvent, signal) => {
  if (!body?.getReader) {
    const error = new Error("Streaming responses are not supported by this browser");
    error.code = "SSE_UNSUPPORTED";
    throw error;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventType = "message";
  let eventId = "";
  let dataLines = [];

  const dispatch = () => {
    if (dataLines.length === 0) {
      eventType = "message";
      eventId = "";
      return;
    }
    const rawData = dataLines.join("\n");
    let data = rawData;
    try { data = JSON.parse(rawData); } catch { /* Keep non-JSON event data intact. */ }
    onEvent({ id: eventId, type: eventType || "message", data });
    eventType = "message";
    eventId = "";
    dataLines = [];
  };

  const processLine = (line) => {
    if (line === "") return dispatch();
    if (line.startsWith(":")) return;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") eventType = value;
    else if (field === "id" && !value.includes("\0")) eventId = value;
    else if (field === "data") dataLines.push(value);
  };

  const drain = (flush = false) => {
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) break;
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      processLine(line);
    }
    if (flush && buffer) {
      processLine(buffer.replace(/\r$/, ""));
      buffer = "";
    }
  };

  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      drain();
    }
    buffer += decoder.decode();
    drain(true);
    dispatch();
  } finally {
    reader.releaseLock();
  }
};

const useTaskStream = ({ page, pageSize, status, type, enabled = true }) => {
  const authAxios = useAuthAxios();
  const { getToken, handleAuthorizationFailure } = useAuthing();
  const [tasks, setTasks] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [connectionState, setConnectionState] = useState("connecting");
  const mountedRef = useRef(false);
  const sessionRef = useRef(0);
  const lastEventIdRef = useRef("");
  const fallbackTimerRef = useRef(null);

  const buildParams = useCallback(() => {
    const params = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
    if (status) params.set("status", status);
    if (type) params.set("type", type);
    return params;
  }, [page, pageSize, status, type]);

  const applySnapshot = useCallback((data) => {
    setTasks(Array.isArray(data?.tasks) ? data.tasks : []);
    setTotal(Number(data?.total || 0));
    setError("");
    setLoading(false);
  }, []);

  const load = useCallback(async ({ background = false } = {}) => {
    if (!background) setLoading(true);
    try {
      const response = await authAxios.get(`/api/tasks?${buildParams().toString()}`);
      applySnapshot(response.data?.data || {});
      return true;
    } catch (requestError) {
      if (mountedRef.current) {
        setError(requestError.response?.data?.message || requestError.message || "Unable to load tasks");
        if (!background) setLoading(false);
      }
      return false;
    }
  }, [applySnapshot, authAxios, buildParams]);

  useEffect(() => {
    mountedRef.current = true;
    const session = sessionRef.current + 1;
    sessionRef.current = session;
    lastEventIdRef.current = "";
    const stopFallbackPolling = () => {
      if (fallbackTimerRef.current) window.clearInterval(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    };

    if (!enabled) {
      stopFallbackPolling();
      setTasks([]);
      setTotal(0);
      setLoading(false);
      setError("");
      setConnectionState("idle");
      return () => {
        sessionRef.current += 1;
        stopFallbackPolling();
      };
    }

    const controller = new AbortController();
    let reconnectAttempt = 0;

    const isCurrent = () => mountedRef.current && sessionRef.current === session && !controller.signal.aborted;
    const startFallbackPolling = () => {
      if (fallbackTimerRef.current || !isCurrent()) return;
      setConnectionState("polling");
      void load({ background: true });
      fallbackTimerRef.current = window.setInterval(() => {
        if (isCurrent()) void load({ background: true });
      }, FALLBACK_POLL_INTERVAL_MS);
    };

    void load().then(() => {
      if (!isCurrent()) return;
      const connect = async () => {
        while (isCurrent()) {
          try {
            setConnectionState("connecting");
            const token = await getToken();
            if (!token) {
              const authError = new Error("Authentication token is unavailable");
              authError.status = 401;
              authError.code = "AUTHENTICATION_REQUIRED";
              throw authError;
            }
            const headers = {
              Accept: "text/event-stream",
              Authorization: `Bearer ${token}`,
            };
            if (lastEventIdRef.current) headers["Last-Event-ID"] = lastEventIdRef.current;
            const response = await fetch(`${API_BASE_URL}/api/tasks/events?${buildParams().toString()}`, {
              headers,
              cache: "no-store",
              signal: controller.signal,
            });
            if (!response.ok) throw await readErrorResponse(response);

            stopFallbackPolling();
            setConnectionState("live");
            reconnectAttempt = 0;
            await consumeTaskEventStream(response.body, (event) => {
              if (!isCurrent()) return;
              if (event.id) lastEventIdRef.current = event.id;
              if (event.type === "snapshot") applySnapshot(event.data);
              if (event.type === "stream_error") {
                setError(event.data?.message || "Task stream refresh failed; retrying automatically");
              }
            }, controller.signal);
            if (!isCurrent()) return;
          } catch (streamError) {
            if (streamError?.name === "AbortError" || !isCurrent()) return;
            if ([401, 403].includes(streamError?.status)) {
              handleAuthorizationFailure({
                status: streamError.status,
                code: streamError.code,
                message: streamError.message,
              });
            }
            startFallbackPolling();
          }

          try {
            const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * (2 ** reconnectAttempt));
            reconnectAttempt += 1;
            await wait(delay, controller.signal);
          } catch (waitError) {
            if (waitError?.name === "AbortError") return;
          }
        }
      };
      void connect();
    });

    return () => {
      sessionRef.current += 1;
      controller.abort();
      stopFallbackPolling();
    };
  }, [applySnapshot, buildParams, enabled, getToken, handleAuthorizationFailure, load]);

  useEffect(() => () => { mountedRef.current = false; }, []);

  return {
    tasks,
    total,
    loading,
    error,
    connectionState,
    reload: load,
  };
};

export default useTaskStream;
