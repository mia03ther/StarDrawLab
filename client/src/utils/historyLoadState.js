export const createHistoryLoadState = (scope = "all") => ({
  scope, items: [], total: 0, page: 1, requestedPage: 1,
  loading: false, error: null, hasLoaded: false, requestId: 0,
});

export const parseHistoryResponse = (payload) => {
  if (!payload || payload.success !== true || !Array.isArray(payload.creations)
      || !Number.isSafeInteger(payload.total) || payload.total < 0
      || payload.creations.some((item) => !item || typeof item !== "object"
        || Array.isArray(item) || item.id == null || !String(item.id).trim())) {
    throw Object.assign(new Error("Invalid creation history response"), { code: "INVALID_HISTORY_RESPONSE" });
  }
  return { items: payload.creations, total: payload.total };
};

export const isHistoryRequestCancelled = (error) => (
  error?.code === "ERR_CANCELED" || error?.name === "CanceledError" || error?.name === "AbortError"
);

export const historyLoadReducer = (state, action) => {
  if (action.type === "start") {
    const base = state.scope === action.scope ? state : createHistoryLoadState(action.scope);
    return { ...base, loading: true, error: null, requestId: action.requestId, requestedPage: action.page };
  }
  if (action.type === "patch") {
    if (action.scope !== state.scope) return state;
    return { ...state, items: state.items.map((item) => {
      const patch = action.updates.get(String(item.id));
      return patch ? { ...item, ...patch } : item;
    }) };
  }
  if (action.type === "remove") {
    return { ...state, items: state.items.filter((item) => String(item.id) !== String(action.id)), total: Math.max(0, state.total - 1) };
  }
  if (action.requestId !== state.requestId) return state;
  if (action.type === "success") {
    return { ...state, loading: false, error: null, hasLoaded: true,
      items: state.requestedPage === 1 ? action.items : [...state.items, ...action.items],
      total: action.total, page: state.requestedPage };
  }
  if (action.type === "failure") return { ...state, loading: false, error: action.error };
  if (action.type === "cancel") return { ...state, loading: false };
  return state;
};

export const getHistoryLoadErrorMessage = (error, t) => {
  const status = Number(error?.response?.status || 0);
  if (status === 401) return t("登录状态已失效，请重新登录后重试。", "Your session expired. Sign in again and retry.");
  if (status === 403) return t("暂时无法访问此账号的素材记录，请联系管理员检查访问权限。", "The account's asset history cannot be accessed. Ask an administrator to check its permissions.");
  if (error?.code === "INVALID_HISTORY_RESPONSE") return t("素材记录返回格式异常，请重试或联系管理员。", "The asset history response was invalid. Retry or contact an administrator.");
  return t("暂时无法读取素材记录，请检查网络后重试；这不表示作品已被删除。", "Asset history could not be loaded. Check your connection and retry; this does not mean your creations were deleted.");
};
