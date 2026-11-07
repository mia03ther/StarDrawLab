import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useAuthAxios from "./useAuthAxios";
import { mergeAgentConversationSaveAcknowledgment } from "../utils/agentConversationSave.js";

const conversationTitle = (value) => String(value || "").replace(/\s+/g, " ").trim().slice(0, 160);

const useAgentConversationHistory = ({ surface, canvasId = "", enabled = true }) => {
  const authAxios = useAuthAxios();
  const [conversations, setConversations] = useState([]);
  const [activeConversation, setActiveConversation] = useState(null);
  const [loading, setLoading] = useState(Boolean(enabled));
  const requestVersionRef = useRef(0);
  const scopeKey = useMemo(() => `${surface}:${surface === "canvas" ? canvasId : "global"}`, [canvasId, surface]);

  const listUrl = useMemo(() => {
    const query = new URLSearchParams({ surface, limit: "30" });
    if (surface === "canvas" && canvasId) query.set("canvas_id", canvasId);
    return `/api/agent/conversations?${query.toString()}`;
  }, [canvasId, surface]);

  const mergeConversation = useCallback((conversation) => {
    if (!conversation?.id) return;
    setConversations((current) => [
      conversation,
      ...current.filter((item) => item.id !== conversation.id),
    ].sort((left, right) => Date.parse(right.updated_at || 0) - Date.parse(left.updated_at || 0)));
  }, []);

  const createConversation = useCallback(async ({ title = "New conversation" } = {}) => {
    const { data } = await authAxios.post("/api/agent/conversations", {
      surface,
      canvas_id: surface === "canvas" ? canvasId : undefined,
      title: conversationTitle(title) || "New conversation",
    });
    const conversation = data?.data || null;
    if (conversation) {
      setActiveConversation(conversation);
      mergeConversation(conversation);
    }
    return conversation;
  }, [authAxios, canvasId, mergeConversation, surface]);

  const openConversation = useCallback(async (conversationId) => {
    if (!conversationId) return null;
    const version = ++requestVersionRef.current;
    setLoading(true);
    try {
      const { data } = await authAxios.get(`/api/agent/conversations/${encodeURIComponent(conversationId)}`);
      const conversation = data?.data || null;
      if (version === requestVersionRef.current && conversation) {
        setActiveConversation(conversation);
        mergeConversation(conversation);
      }
      return conversation;
    } finally {
      if (version === requestVersionRef.current) setLoading(false);
    }
  }, [authAxios, mergeConversation]);

  const saveConversation = useCallback(async ({ title, messages = [], runtimeState = {} }) => {
    const conversationId = activeConversation?.id;
    if (!conversationId) return null;
    const { data } = await authAxios.put(`/api/agent/conversations/${encodeURIComponent(conversationId)}`, {
      title: conversationTitle(title) || "New conversation",
      messages,
      runtime_state: runtimeState,
    });
    const saved = data?.data || null;
    if (saved) {
      setActiveConversation((current) => mergeAgentConversationSaveAcknowledgment(current, saved));
      mergeConversation(saved);
    }
    return saved;
  }, [activeConversation?.id, authAxios, mergeConversation]);

  const deleteConversation = useCallback(async (conversationId) => {
    const targetId = String(conversationId || "");
    if (!targetId) return null;
    const { data } = await authAxios.delete(`/api/agent/conversations/${encodeURIComponent(targetId)}`);
    const remaining = conversations.filter((conversation) => conversation.id !== targetId);
    setConversations(remaining);
    if (activeConversation?.id !== targetId) return data?.data || null;

    if (remaining[0]?.id) {
      const detailResponse = await authAxios.get(`/api/agent/conversations/${encodeURIComponent(remaining[0].id)}`);
      const nextConversation = detailResponse.data?.data || null;
      setActiveConversation(nextConversation);
      return data?.data || null;
    }

    const createResponse = await authAxios.post("/api/agent/conversations", {
      surface,
      canvas_id: surface === "canvas" ? canvasId : undefined,
      title: "New conversation",
    });
    const created = createResponse.data?.data || null;
    setActiveConversation(created);
    setConversations(created ? [created] : []);
    return data?.data || null;
  }, [activeConversation?.id, authAxios, canvasId, conversations, surface]);

  useEffect(() => {
    const version = ++requestVersionRef.current;
    if (!enabled || (surface === "canvas" && !canvasId)) {
      setConversations([]);
      setActiveConversation(null);
      setLoading(false);
      return undefined;
    }
    setLoading(true);
    setConversations([]);
    setActiveConversation(null);
    const load = async () => {
      try {
        const { data } = await authAxios.get(listUrl);
        if (version !== requestVersionRef.current) return;
        const items = Array.isArray(data?.data) ? data.data : [];
        setConversations(items);
        if (items[0]?.id) {
          const detailResponse = await authAxios.get(`/api/agent/conversations/${encodeURIComponent(items[0].id)}`);
          if (version === requestVersionRef.current) setActiveConversation(detailResponse.data?.data || null);
          return;
        }
        const createResponse = await authAxios.post("/api/agent/conversations", {
          surface,
          canvas_id: surface === "canvas" ? canvasId : undefined,
          title: "New conversation",
        });
        if (version !== requestVersionRef.current) return;
        const created = createResponse.data?.data || null;
        setActiveConversation(created);
        setConversations(created ? [created] : []);
      } finally {
        if (version === requestVersionRef.current) setLoading(false);
      }
    };
    void load();
    return () => { requestVersionRef.current += 1; };
  }, [authAxios, canvasId, enabled, listUrl, scopeKey, surface]);

  return {
    conversations,
    activeConversation,
    loading,
    createConversation,
    openConversation,
    saveConversation,
    deleteConversation,
  };
};

export default useAgentConversationHistory;
