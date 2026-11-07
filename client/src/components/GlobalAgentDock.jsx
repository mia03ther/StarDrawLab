import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useLanguage } from "../contexts/LanguageContext";
import { useStarDrawTheme } from "../utils/stardrawTheme";

const GlobalAgent = lazy(() => import("../pages/GlobalAgent"));

const WIDTH_STORAGE_KEY = "stardraw_global_agent_panel_width";

const widthBounds = () => {
  const viewportWidth = typeof window === "undefined" ? 1440 : window.innerWidth;
  const max = Math.max(280, Math.min(720, viewportWidth - 24));
  return { min: Math.min(360, max), max };
};

const clampWidth = (value) => {
  const { min, max } = widthBounds();
  return Math.min(max, Math.max(min, Number(value) || 420));
};

const readStoredWidth = () => {
  if (typeof window === "undefined") return 420;
  return clampWidth(window.localStorage.getItem(WIDTH_STORAGE_KEY));
};

const GlobalAgentDock = ({ open, onOpenChange, onActivityChange, showLauncher = false }) => {
  const { t } = useLanguage();
  const { ui } = useStarDrawTheme();
  const [width, setWidth] = useState(readStoredWidth);
  const [execution, setExecution] = useState({ active: false, status: "idle", progress: 0, label: "" });
  const [pendingRequest, setPendingRequest] = useState(null);
  const dragCleanupRef = useRef(null);

  const updateExecution = useCallback((active, detail = {}) => {
    const next = {
      active: Boolean(active),
      status: detail.status || "idle",
      progress: Number(detail.progress || 0),
      label: String(detail.label || ""),
    };
    setExecution(next);
    onActivityChange?.(next);
  }, [onActivityChange]);

  useEffect(() => {
    window.localStorage.setItem(WIDTH_STORAGE_KEY, String(Math.round(width)));
  }, [width]);

  useEffect(() => {
    const handleResize = () => setWidth((current) => clampWidth(current));
    const handleKeyDown = (event) => {
      if (event.key === "Escape" && open) onOpenChange(false);
    };
    window.addEventListener("resize", handleResize);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("keydown", handleKeyDown);
      dragCleanupRef.current?.();
    };
  }, [onOpenChange, open]);

  useEffect(() => {
    const handleSubmit = (event) => {
      const instruction = String(event?.detail?.instruction || "").trim();
      if (!instruction) return;
      setPendingRequest({
        ...event.detail,
        id: String(event.detail?.id || crypto.randomUUID()),
        instruction,
      });
      onOpenChange(true);
    };
    window.addEventListener("stardraw:global-agent-submit", handleSubmit);
    return () => window.removeEventListener("stardraw:global-agent-submit", handleSubmit);
  }, [onOpenChange]);

  const startResize = useCallback((event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    const previousCursor = document.body.style.cursor;
    const previousSelection = document.body.style.userSelect;
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";

    const handlePointerMove = (moveEvent) => {
      setWidth(clampWidth(startWidth + startX - moveEvent.clientX));
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", cleanup);
      window.removeEventListener("pointercancel", cleanup);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousSelection;
      dragCleanupRef.current = null;
    };

    dragCleanupRef.current?.();
    dragCleanupRef.current = cleanup;
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", cleanup, { once: true });
    window.addEventListener("pointercancel", cleanup, { once: true });
  }, [width]);

  const statusLabel = execution.status === "planning"
    ? t("正在规划", "Planning")
    : execution.status === "waiting_approval"
      ? t("等待确认", "Waiting for approval")
      : execution.status === "waiting_client"
        ? t("等待浏览器操作", "Waiting for browser")
        : execution.active
          ? t("正在执行", "Running")
          : t("随时待命", "Ready");

  return (
    <>
      {execution.active && <div className="agent-execution-glow" aria-hidden="true" />}

      {showLauncher && !open && (
        <button
          type="button"
          onClick={() => onOpenChange(true)}
          className={`global-agent-launcher ${execution.active ? "is-active" : ""}`}
          style={{ background: ui.surface, color: ui.primary, borderColor: execution.active ? ui.primary : ui.lineStrong, boxShadow: ui.shadow }}
          aria-label={t("打开全局 Agent", "Open Global Agent")}
          title={t("打开全局 Agent", "Open Global Agent")}
        >
          <span className="material-symbols-outlined text-[21px]">auto_awesome</span>
          {execution.active && <span className="global-agent-launcher-dot" aria-hidden="true" />}
        </button>
      )}

      <aside
        id="global-agent-panel"
        className={`global-agent-dock ${open ? "is-open" : ""}`}
        aria-hidden={!open}
        inert={open ? undefined : ""}
        style={{
          width,
          background: ui.surfaceAlt,
          color: ui.text,
          borderLeftColor: ui.lineStrong,
          boxShadow: open ? "-24px 0 64px rgba(0,0,0,0.28)" : "none",
          transform: open ? "translateX(0)" : "translateX(calc(100% + 28px))",
          pointerEvents: open ? "auto" : "none",
        }}
      >
        <button
          type="button"
          onPointerDown={startResize}
          className="global-agent-resize-handle"
          aria-label={t("拖动调整 Agent 面板宽度", "Drag to resize the Agent panel")}
          title={t("拖动调整宽度", "Drag to resize")}
        >
          <span style={{ background: ui.lineStrong }} />
        </button>

        <header className="flex h-[72px] flex-none items-center justify-between gap-3 px-5" style={{ background: ui.surface, borderBottom: `1px solid ${ui.line}` }}>
          <div className="flex min-w-0 items-center gap-3">
            <div className={`global-agent-orb ${execution.active ? "is-active" : ""}`} style={{ background: ui.primarySoft, color: ui.primary }}>
              <span className="material-symbols-outlined text-[20px]">auto_awesome</span>
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="truncate text-sm font-black" style={{ fontFamily: "Manrope, sans-serif" }}>{t("全局 Agent", "Global Agent")}</h2>
                <span className="rounded-full px-2 py-0.5 text-[9px] font-black" style={{ background: ui.primarySoft, color: ui.primary }}>GPT</span>
              </div>
              <p className="mt-1 flex items-center gap-1.5 truncate text-[10px] font-bold" style={{ color: execution.active ? ui.primary : ui.faint }}>
                <span className={`global-agent-status-dot ${execution.active ? "is-active" : ""}`} style={{ background: execution.active ? ui.primary : ui.faint, color: execution.active ? ui.primary : ui.faint }} />
                {execution.active && execution.label ? execution.label : statusLabel}{execution.active && execution.progress > 0 ? ` · ${execution.progress}%` : ""}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="flex h-9 w-9 flex-none items-center justify-center rounded-xl transition-transform active:scale-90"
            style={{ background: ui.surfaceHigh, color: ui.muted, border: `1px solid ${ui.line}` }}
            aria-label={t("收起全局 Agent", "Close Global Agent")}
            title={t("收起", "Close")}
          >
            <span className="material-symbols-outlined text-[19px]">right_panel_close</span>
          </button>
        </header>

        <div className="min-h-0 flex-1">
          <Suspense fallback={<div className="flex h-full items-center justify-center"><span className="h-6 w-6 animate-spin rounded-full border-2 border-current border-t-transparent" style={{ color: ui.primary }} /></div>}>
            <GlobalAgent
              embedded
              externalRequest={pendingRequest}
              onExternalRequestConsumed={(requestId) => {
                setPendingRequest((current) => current?.id === requestId ? null : current);
              }}
              onExecutionStateChange={updateExecution}
            />
          </Suspense>
        </div>
      </aside>
    </>
  );
};

export default GlobalAgentDock;
