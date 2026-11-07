import { useCallback, useEffect, useRef, useState } from "react";

const EMPTY_DEFINITION = Object.freeze({
  schemaVersion: 2,
  version: 1,
  variables: {},
  nodes: [],
  edges: [],
  viewport: {},
});

const clone = (value) => {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
};

const definitionFrom = (value) => {
  const source = value && typeof value === "object" ? value : EMPTY_DEFINITION;
  return {
    ...clone(EMPTY_DEFINITION),
    ...clone(source),
    variables: source.variables && typeof source.variables === "object" ? clone(source.variables) : {},
    nodes: Array.isArray(source.nodes) ? clone(source.nodes) : [],
    edges: Array.isArray(source.edges) ? clone(source.edges) : [],
    viewport: source.viewport && typeof source.viewport === "object" ? clone(source.viewport) : {},
  };
};

const workflowError = (error) => ({
  message: error?.response?.data?.message || error?.message || "Workflow request failed",
  code: error?.response?.data?.code || error?.code || "WORKFLOW_REQUEST_FAILED",
  status: Number(error?.response?.status || error?.status || 0) || null,
  currentVersion: Number(error?.response?.data?.currentVersion || error?.response?.data?.current_version || 0) || null,
});

const replaceWorkflow = (rows, workflow) => [
  workflow,
  ...rows.filter((row) => row.id !== workflow.id),
];

const selectedStorageKey = (canvasId) => `stardraw:canvas-workflow:${String(canvasId)}`;

const useCanvasWorkflows = ({ authAxios, canvasId, legacyWorkflow, defaultName = "Canvas workflow" } = {}) => {
  const [workflows, setWorkflows] = useState([]);
  const [activeWorkflow, setActiveWorkflow] = useState(null);
  const [draft, setDraft] = useState(() => definitionFrom(legacyWorkflow));
  const [draftName, setDraftName] = useState(defaultName);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [conflict, setConflict] = useState(null);
  const [catalog, setCatalog] = useState([]);
  const requestVersionRef = useRef(0);
  const activeRef = useRef(null);
  const draftRef = useRef(draft);
  const draftNameRef = useRef(draftName);
  const legacyRef = useRef(legacyWorkflow);

  activeRef.current = activeWorkflow;
  draftRef.current = draft;
  draftNameRef.current = draftName;
  legacyRef.current = legacyWorkflow;

  const rememberSelection = useCallback((workflowId) => {
    if (!canvasId || typeof window === "undefined") return;
    try {
      if (workflowId) window.localStorage.setItem(selectedStorageKey(canvasId), workflowId);
      else window.localStorage.removeItem(selectedStorageKey(canvasId));
    } catch {
      // Selection memory is optional; persistence still lives in PostgreSQL.
    }
  }, [canvasId]);

  const activate = useCallback((workflow) => {
    const next = workflow || null;
    activeRef.current = next;
    setActiveWorkflow(next);
    setDraft(definitionFrom(next?.definition));
    setDraftName(next?.name || defaultName);
    setDirty(false);
    setConflict(null);
    setError(null);
    rememberSelection(next?.id || "");
  }, [defaultName, rememberSelection]);

  const beginUnsavedDraft = useCallback((definition = EMPTY_DEFINITION, name = defaultName, { changed = false } = {}) => {
    activeRef.current = null;
    setActiveWorkflow(null);
    setDraft(definitionFrom(definition));
    setDraftName(String(name || defaultName).slice(0, 160));
    setDirty(Boolean(changed));
    setConflict(null);
    setError(null);
    rememberSelection("");
  }, [defaultName, rememberSelection]);

  const load = useCallback(async ({ preferredId = "", preserveDraft = false } = {}) => {
    if (!canvasId) {
      setWorkflows([]);
      beginUnsavedDraft(EMPTY_DEFINITION, defaultName);
      return [];
    }
    const requestVersion = ++requestVersionRef.current;
    setLoading(true);
    try {
      const [definitionsResult, catalogResult] = await Promise.allSettled([
        authAxios.get("/api/workflows/definitions", { params: { canvas_id: canvasId } }),
        authAxios.get("/api/workflows/catalog"),
      ]);
      if (definitionsResult.status === "rejected") throw definitionsResult.reason;
      if (requestVersion !== requestVersionRef.current) return [];
      const definitionsResponse = definitionsResult.value;
      const rows = Array.isArray(definitionsResponse.data?.data) ? definitionsResponse.data.data : [];
      const catalogRows = catalogResult.status === "fulfilled" && Array.isArray(catalogResult.value.data?.data)
        ? catalogResult.value.data.data
        : [];
      setWorkflows(rows);
      setCatalog(catalogRows);
      setError(null);

      if (preserveDraft && activeRef.current) {
        const refreshed = rows.find((row) => row.id === activeRef.current.id);
        if (refreshed) {
          const merged = { ...activeRef.current, ...refreshed };
          activeRef.current = merged;
          setActiveWorkflow(merged);
        }
        return rows;
      }

      let rememberedId = preferredId;
      if (!rememberedId && typeof window !== "undefined") {
        try { rememberedId = window.localStorage.getItem(selectedStorageKey(canvasId)) || ""; } catch { rememberedId = ""; }
      }
      const selected = rows.find((row) => row.id === rememberedId) || rows[0] || null;
      if (selected) activate(selected);
      else {
        const legacy = definitionFrom(legacyRef.current);
        beginUnsavedDraft(legacy, defaultName, { changed: legacy.nodes.length > 0 || legacy.edges.length > 0 });
      }
      return rows;
    } catch (requestError) {
      if (requestVersion === requestVersionRef.current) setError(workflowError(requestError));
      throw requestError;
    } finally {
      if (requestVersion === requestVersionRef.current) setLoading(false);
    }
  }, [activate, authAxios, beginUnsavedDraft, canvasId, defaultName]);

  useEffect(() => {
    requestVersionRef.current += 1;
    setWorkflows([]);
    setCatalog([]);
    setError(null);
    setConflict(null);
    if (canvasId) void load().catch(() => {});
    else beginUnsavedDraft(EMPTY_DEFINITION, defaultName);
  }, [beginUnsavedDraft, canvasId, defaultName, load]);

  const select = useCallback(async (workflowId) => {
    const normalizedId = String(workflowId || "").trim();
    const found = workflows.find((row) => row.id === normalizedId);
    if (!found) return null;
    activate(found);
    return found;
  }, [activate, workflows]);

  const updateDraft = useCallback((nextDefinition) => {
    const next = definitionFrom(nextDefinition);
    draftRef.current = next;
    setDraft(next);
    setDirty(true);
    setConflict(null);
  }, []);

  const updateName = useCallback((nextName) => {
    const next = String(nextName || "").slice(0, 160);
    draftNameRef.current = next;
    setDraftName(next);
    setDirty(true);
    setConflict(null);
  }, []);

  const save = useCallback(async ({ definition } = {}) => {
    if (!canvasId) throw Object.assign(new Error("Canvas is required"), { code: "CANVAS_REQUIRED" });
    const current = activeRef.current;
    const candidate = definitionFrom(definition || draftRef.current);
    const name = String(draftNameRef.current || defaultName).trim() || defaultName;
    setSaving(true);
    setError(null);
    setConflict(null);
    try {
      const response = current?.id
        ? await authAxios.put(`/api/workflows/definitions/${encodeURIComponent(current.id)}`, {
          name,
          definition: candidate,
          expectedVersion: current.version,
        })
        : await authAxios.post("/api/workflows/definitions", { canvasId, name, definition: candidate });
      const saved = response.data?.data;
      if (!saved?.id) throw Object.assign(new Error("Workflow response has no id"), { code: "INVALID_WORKFLOW_RESPONSE" });
      setWorkflows((rows) => replaceWorkflow(rows, saved));
      activate(saved);
      return saved;
    } catch (requestError) {
      const normalized = workflowError(requestError);
      setError(normalized);
      if (normalized.code === "WORKFLOW_VERSION_CONFLICT") setConflict(normalized);
      throw requestError;
    } finally {
      setSaving(false);
    }
  }, [activate, authAxios, canvasId, defaultName]);

  const saveCopy = useCallback(async ({ name, definition } = {}) => {
    if (!canvasId) throw Object.assign(new Error("Canvas is required"), { code: "CANVAS_REQUIRED" });
    setSaving(true);
    setError(null);
    try {
      const copyName = String(name || `${draftNameRef.current || defaultName} copy`).trim().slice(0, 160);
      const response = await authAxios.post("/api/workflows/definitions", {
        canvasId,
        name: copyName,
        definition: definitionFrom(definition || draftRef.current),
      });
      const saved = response.data?.data;
      if (!saved?.id) throw Object.assign(new Error("Workflow response has no id"), { code: "INVALID_WORKFLOW_RESPONSE" });
      setWorkflows((rows) => replaceWorkflow(rows, saved));
      activate(saved);
      return saved;
    } catch (requestError) {
      setError(workflowError(requestError));
      throw requestError;
    } finally {
      setSaving(false);
    }
  }, [activate, authAxios, canvasId, defaultName]);

  const reloadCurrent = useCallback(async () => {
    const workflowId = activeRef.current?.id;
    if (!workflowId) return null;
    setLoading(true);
    try {
      const response = await authAxios.get(`/api/workflows/definitions/${encodeURIComponent(workflowId)}`);
      const current = response.data?.data;
      setWorkflows((rows) => replaceWorkflow(rows, current));
      activate(current);
      setError(null);
      return current;
    } catch (requestError) {
      setError(workflowError(requestError));
      throw requestError;
    } finally {
      setLoading(false);
    }
  }, [activate, authAxios]);

  const archive = useCallback(async () => {
    const current = activeRef.current;
    if (!current?.id) return null;
    setSaving(true);
    setError(null);
    try {
      const response = await authAxios.delete(`/api/workflows/definitions/${encodeURIComponent(current.id)}`);
      const remaining = workflows.filter((row) => row.id !== current.id);
      setWorkflows(remaining);
      if (remaining[0]) activate(remaining[0]);
      else beginUnsavedDraft(EMPTY_DEFINITION, defaultName);
      return response.data?.data || null;
    } catch (requestError) {
      setError(workflowError(requestError));
      throw requestError;
    } finally {
      setSaving(false);
    }
  }, [activate, authAxios, beginUnsavedDraft, defaultName, workflows]);

  const markLock = useCallback(({ locked, runId = null, status = null } = {}) => {
    const current = activeRef.current;
    if (!current) return;
    const next = { ...current, lock: locked ? { locked: true, runId: String(runId || ""), status: status || "running" } : { locked: false } };
    activeRef.current = next;
    setActiveWorkflow(next);
    setWorkflows((rows) => rows.map((row) => row.id === next.id ? next : row));
  }, []);

  return {
    workflows,
    activeWorkflow,
    draft,
    draftName,
    dirty,
    loading,
    saving,
    error,
    conflict,
    catalog,
    load,
    select,
    newDraft: beginUnsavedDraft,
    updateDraft,
    updateName,
    save,
    saveCopy,
    reloadCurrent,
    archive,
    markLock,
  };
};

export { EMPTY_DEFINITION, definitionFrom, workflowError };
export default useCanvasWorkflows;
