import { useCallback, useEffect, useState } from "react";

const EMPTY = { preferences: { textModel: "", imageModel: "", videoModel: "" }, catalogs: { text: [], image: [], video: [] } };

const useCanvasModelPreferences = ({ authAxios, enabled = true } = {}) => {
  const [data, setData] = useState(EMPTY);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const reload = useCallback(async () => {
    if (!enabled) return EMPTY;
    setLoading(true);
    try {
      const response = await authAxios.get("/api/canvas-agent/models");
      const next = response.data?.data || EMPTY;
      setData({ ...EMPTY, ...next, preferences: { ...EMPTY.preferences, ...(next.preferences || {}) }, catalogs: { ...EMPTY.catalogs, ...(next.catalogs || {}) } });
      setError(null);
      return next;
    } catch (requestError) {
      setError(requestError);
      throw requestError;
    } finally {
      setLoading(false);
    }
  }, [authAxios, enabled]);

  useEffect(() => {
    if (enabled) void reload().catch(() => {});
  }, [enabled, reload]);

  const save = useCallback(async (patch) => {
    setSaving(true);
    try {
      const response = await authAxios.put("/api/canvas-agent/models", patch);
      const next = response.data?.data || {};
      setData((current) => ({ ...current, ...next, preferences: { ...current.preferences, ...(next.preferences || {}) }, catalogs: next.catalogs || current.catalogs }));
      setError(null);
      return next;
    } catch (requestError) {
      setError(requestError);
      throw requestError;
    } finally {
      setSaving(false);
    }
  }, [authAxios]);

  const applyPreferences = useCallback((preferences) => {
    if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) return;
    setData((current) => ({
      ...current,
      preferences: { ...current.preferences, ...preferences },
    }));
  }, []);

  return { ...data, loading, saving, error, reload, save, applyPreferences };
};

export default useCanvasModelPreferences;
