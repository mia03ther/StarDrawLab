import { useCallback, useEffect, useRef, useState } from "react";

const ACTIVE_STATUSES = new Set(["queued", "running", "waiting_approval", "waiting_external"]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

const randomKey = (prefix) => {
  const suffix = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}:${suffix}`;
};

const useCanvasAgentRuntime = ({ authAxios, canvasId, enabled = true } = {}) => {
  const [conversations, setConversations] = useState([]);
  const [activeConversation, setActiveConversation] = useState(null);
  const [run, setRun] = useState(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const pollRef = useRef(null);
  const pollRunRef = useRef(null);
  const activeConversationRef = useRef(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) window.clearTimeout(pollRef.current);
    pollRef.current = null;
  }, []);

  const readConversation = useCallback(async (conversationId) => {
    const response = await authAxios.get(`/api/canvas-agent/conversations/${encodeURIComponent(conversationId)}`);
    const next = response.data?.data || null;
    setActiveConversation(next);
    activeConversationRef.current = next;
    return next;
  }, [authAxios]);

  const ensureConversation = useCallback(async () => {
    if (activeConversationRef.current?.id) return activeConversationRef.current;
    const response = await authAxios.post("/api/canvas-agent/conversations", { canvasId, title: "New conversation" });
    const next = response.data?.data;
    setConversations((current) => [next, ...current.filter((item) => item.id !== next.id)]);
    setActiveConversation(next);
    activeConversationRef.current = next;
    return next;
  }, [authAxios, canvasId]);

  const loadConversations = useCallback(async () => {
    if (!enabled || !canvasId) return;
    setLoading(true);
    try {
      const response = await authAxios.get("/api/canvas-agent/conversations", { params: { canvas_id: canvasId, limit: 40 } });
      const rows = response.data?.data || [];
      setConversations(rows);
      const current = activeConversationRef.current;
      const selected = rows.find((item) => item.id === current?.id) || rows[0] || null;
      if (selected) {
        const loadedConversation = await readConversation(selected.id);
        const persistedRunId = String(loadedConversation?.runtime_state?.activeRunId || loadedConversation?.runtime_state?.active_run_id || "").trim();
        if (persistedRunId) void pollRunRef.current?.(persistedRunId);
      } else await ensureConversation();
      setError(null);
    } catch (requestError) {
      setError(requestError);
    } finally {
      setLoading(false);
    }
  }, [authAxios, canvasId, enabled, ensureConversation, readConversation]);

  useEffect(() => {
    stopPolling();
    setRun(null);
    setActiveConversation(null);
    activeConversationRef.current = null;
    if (enabled && canvasId) void loadConversations();
    return stopPolling;
  }, [canvasId, enabled, loadConversations, stopPolling]);

  const pollRun = useCallback(async (runId) => {
    stopPolling();
    const poll = async () => {
      try {
        const response = await authAxios.get(`/api/canvas-agent/runs/${encodeURIComponent(runId)}`);
        const next = response.data?.data || null;
        setRun(next);
        if (!next || TERMINAL_STATUSES.has(next.status)) {
          if (activeConversationRef.current?.id) await readConversation(activeConversationRef.current.id);
          return;
        }
        pollRef.current = window.setTimeout(poll, next.status === "waiting_approval" ? 1800 : 950);
      } catch (requestError) {
        setError(requestError);
        pollRef.current = window.setTimeout(poll, 1800);
      }
    };
    await poll();
  }, [authAxios, readConversation, stopPolling]);
  pollRunRef.current = pollRun;

  const send = useCallback(async ({ instruction, mode = "approve_for_me", context = {} } = {}) => {
    const text = String(instruction || "").trim();
    if (!text || sending || (run && ACTIVE_STATUSES.has(run.status))) return null;
    setSending(true);
    setError(null);
    try {
      const conversation = await ensureConversation();
      const response = await authAxios.post("/api/canvas-agent/runs", {
        canvasId,
        conversationId: conversation.id,
        agentMode: mode,
        instruction: text,
        language: document?.documentElement?.lang === "en" ? "en" : "zh",
        context,
      }, { headers: { "X-Idempotency-Key": randomKey("canvas-ui") } });
      const next = response.data?.data || null;
      setRun(next);
      await readConversation(conversation.id);
      if (next?.id) void pollRun(next.id);
      return next;
    } catch (requestError) {
      setError(requestError);
      throw requestError;
    } finally {
      setSending(false);
    }
  }, [authAxios, canvasId, ensureConversation, pollRun, readConversation, run, sending]);

  const approve = useCallback(async (stepId) => {
    if (!run?.id) return null;
    const response = await authAxios.post(`/api/canvas-agent/runs/${encodeURIComponent(run.id)}/steps/${encodeURIComponent(stepId)}/approve`, { confirmed: true });
    const next = response.data?.data || null;
    setRun(next);
    if (next?.id) void pollRun(next.id);
    return next;
  }, [authAxios, pollRun, run?.id]);

  const cancel = useCallback(async () => {
    if (!run?.id) return null;
    stopPolling();
    const response = await authAxios.post(`/api/canvas-agent/runs/${encodeURIComponent(run.id)}/cancel`, { reason: "Cancelled by user" });
    const next = response.data?.data || null;
    setRun(next);
    return next;
  }, [authAxios, run?.id, stopPolling]);

  const selectConversation = useCallback(async (conversationId) => {
    stopPolling();
    setRun(null);
    const next = await readConversation(conversationId);
    const persistedRunId = String(next?.runtime_state?.activeRunId || next?.runtime_state?.active_run_id || "").trim();
    if (persistedRunId) void pollRun(persistedRunId);
    return next;
  }, [pollRun, readConversation, stopPolling]);

  const createConversation = useCallback(async () => {
    stopPolling();
    const response = await authAxios.post("/api/canvas-agent/conversations", { canvasId, title: "New conversation" });
    const next = response.data?.data;
    setConversations((current) => [next, ...current]);
    setActiveConversation(next);
    activeConversationRef.current = next;
    setRun(null);
    return next;
  }, [authAxios, canvasId, stopPolling]);

  const deleteConversation = useCallback(async (conversationId) => {
    const targetId = String(conversationId || "").trim();
    if (!targetId) return null;
    if (activeConversationRef.current?.id === targetId && run && ACTIVE_STATUSES.has(run.status)) {
      throw Object.assign(new Error("Stop the active Canvas Agent run before deleting this conversation"), {
        code: "CANVAS_AGENT_CONVERSATION_ACTIVE",
      });
    }

    const response = await authAxios.delete(`/api/canvas-agent/conversations/${encodeURIComponent(targetId)}`);
    const remaining = conversations.filter((conversation) => conversation.id !== targetId);
    setConversations(remaining);

    if (activeConversationRef.current?.id !== targetId) return response.data?.data || null;

    stopPolling();
    setRun(null);
    setActiveConversation(null);
    activeConversationRef.current = null;

    if (remaining[0]?.id) {
      const next = await readConversation(remaining[0].id);
      const persistedRunId = String(next?.runtime_state?.activeRunId || next?.runtime_state?.active_run_id || "").trim();
      if (persistedRunId) void pollRun(persistedRunId);
    } else {
      await createConversation();
    }
    return response.data?.data || null;
  }, [authAxios, conversations, createConversation, pollRun, readConversation, run, stopPolling]);

  const updateConversationModels = useCallback(async (models, { rememberModels = true } = {}) => {
    const previous = activeConversationRef.current;
    if (!previous?.id) return null;

    // Keep the selector responsive while the durable conversation/account write
    // is in flight. Restore the previous value if the request fails.
    const optimistic = { ...previous, model_preferences: models };
    setActiveConversation(optimistic);
    activeConversationRef.current = optimistic;
    try {
      const response = await authAxios.put(`/api/canvas-agent/conversations/${encodeURIComponent(previous.id)}`, {
        model_preferences: models,
        messages: previous.messages || [],
        runtime_state: previous.runtime_state || {},
        remember_models: rememberModels,
      });
      const next = response.data?.data;
      setActiveConversation(next);
      activeConversationRef.current = next;
      return next;
    } catch (error) {
      setActiveConversation(previous);
      activeConversationRef.current = previous;
      throw error;
    }
  }, [authAxios]);

  return {
    conversations,
    activeConversation,
    run,
    loading,
    sending,
    error,
    loadConversations,
    selectConversation,
    createConversation,
    deleteConversation,
    send,
    approve,
    cancel,
    updateConversationModels,
  };
};

export default useCanvasAgentRuntime;
