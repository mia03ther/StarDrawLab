import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, Film, History, Image as ImageIcon, MessageSquarePlus, PanelRightClose, Paperclip, Settings2, ShieldCheck, Sparkles, Trash2, X } from "lucide-react";

import { getGenerationErrorMessage } from "../../utils/generationErrors";
import useCanvasAgentRuntime from "../../hooks/useCanvasAgentRuntime";
import useCanvasModelPreferences from "../../hooks/useCanvasModelPreferences";
import {
  mergeCanvasAgentReferences,
  serializeCanvasAgentReferences,
} from "../../utils/canvasAgentReferences";
import AgentTemplatePicker from "./AgentTemplatePicker";
import CanvasAgentComposer from "./CanvasAgentComposer";
import CanvasAgentRunTimeline from "./CanvasAgentRunTimeline";
import CanvasIconButton from "./CanvasIconButton";
import CanvasRoundedSelect from "./CanvasRoundedSelect";
import CanvasModelSettingsDialog from "./CanvasModelSettingsDialog";

const MODE_LABELS = {
  ask_for_approval: ["逐项确认", "Ask for approval"],
  approve_for_me: ["自动执行安全操作", "Approve for me"],
  full_access: ["完全自动执行", "Full access"],
};

const ACTIVE_STATUSES = new Set(["queued", "running", "waiting_external", "waiting_approval"]);
const isActive = (status) => ACTIVE_STATUSES.has(status);

const modelLabel = (catalog, modelKey) => catalog?.find((item) => item.model_key === modelKey)?.display_name || modelKey || "-";

const QuickModelSelect = ({ icon, label, value, options, onChange, disabled, ui }) => (
  <CanvasRoundedSelect
    label={label}
    value={value}
    options={options || []}
    onChange={onChange}
    disabled={disabled}
    ui={ui}
    icon={icon}
    compact
    className="flex-1"
    menuMinWidth={220}
    triggerClassName="w-full shadow-sm"
  />
);

const CanvasAgentPanel = ({ open, onClose, canvasId, authAxios, ui, t, language = "zh", width = 460, onCanvasChanged, selectedImageElements = [] }) => {
  const [mode, setMode] = useState(() => window.localStorage.getItem("stardraw_agent_access_mode") || "approve_for_me");
  const [brief, setBrief] = useState("");
  const [templateOpen, setTemplateOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [deletingConversationId, setDeletingConversationId] = useState("");
  const [selectedTemplate, setSelectedTemplate] = useState(null);
  const [referenceImages, setReferenceImages] = useState([]);
  const [notice, setNotice] = useState("");
  const [savingModel, setSavingModel] = useState(false);
  const notifiedRunRef = useRef("");
  const models = useCanvasModelPreferences({ authAxios, enabled: open });
  const runtime = useCanvasAgentRuntime({ authAxios, canvasId, enabled: open });
  const activeRun = isActive(runtime.run?.status);
  const currentMode = MODE_LABELS[mode] || MODE_LABELS.approve_for_me;
  const conversationModels = runtime.activeConversation?.model_preferences || models.preferences;

  useEffect(() => {
    setReferenceImages([]);
    setSelectedTemplate(null);
  }, [canvasId]);

  useEffect(() => {
    if (runtime.run?.status !== "completed" || !runtime.run?.id) return;
    const key = `${runtime.run.id}:completed`;
    if (notifiedRunRef.current === key) return;
    notifiedRunRef.current = key;
    onCanvasChanged?.();
  }, [onCanvasChanged, runtime.run?.id, runtime.run?.status]);

  const messages = useMemo(() => {
    const persisted = Array.isArray(runtime.activeConversation?.messages) ? runtime.activeConversation.messages : [];
    if (!runtime.run?.id || runtime.run.status === "completed") return persisted;
    return [...persisted, { id: `run-${runtime.run.id}`, role: "assistant", liveRun: runtime.run }];
  }, [runtime.activeConversation?.messages, runtime.run]);

  const saveMode = (value) => {
    setMode(value);
    window.localStorage.setItem("stardraw_agent_access_mode", value);
  };

  const saveModel = async (patch) => {
    setNotice("");
    setSavingModel(true);
    try {
      const currentPreferences = {
        ...models.preferences,
        ...(runtime.activeConversation?.model_preferences || {}),
      };
      const nextPreferences = { ...currentPreferences, ...patch };
      if (runtime.activeConversation?.id) {
        const savedConversation = await runtime.updateConversationModels(nextPreferences, { rememberModels: true });
        models.applyPreferences(savedConversation?.model_preferences || nextPreferences);
      } else {
        const saved = await models.save(patch);
        models.applyPreferences(saved.preferences);
      }
    } catch (error) {
      setNotice(error.response?.data?.message || t("模型设置保存失败", "Unable to save model settings"));
    } finally {
      setSavingModel(false);
    }
  };

  const selectTemplate = (template) => {
    setSelectedTemplate(template);
    setBrief((current) => current.trim() ? current : String(template.starter_prompt || template.placeholder_text || "").trim());
    setTemplateOpen(false);
  };

  const attachSelectedImages = () => {
    setReferenceImages((current) => mergeCanvasAgentReferences(current, selectedImageElements));
  };

  const submit = async () => {
    const instruction = brief.trim();
    if (!instruction || activeRun || runtime.sending) return;
    setNotice("");
    const submittedTemplate = selectedTemplate;
    const submittedReferences = referenceImages;
    try {
      const serializedReferences = serializeCanvasAgentReferences(submittedReferences);
      const context = {};
      if (submittedTemplate) {
        context.templates = [{
          kind: "template",
          id: submittedTemplate.id,
          sceneKey: submittedTemplate.scene_key,
          outputType: submittedTemplate.output_type,
          defaultModel: submittedTemplate.default_model,
          starterPrompt: submittedTemplate.starter_prompt,
          template: submittedTemplate,
        }];
        context.selectedTemplateId = submittedTemplate.id;
      }
      if (serializedReferences.length) context.referenceImages = serializedReferences;

      setBrief("");
      setSelectedTemplate(null);
      setReferenceImages([]);
      await runtime.send({
        instruction,
        mode,
        context,
      });
    } catch (error) {
      setBrief((current) => current.trim() ? current : instruction);
      setSelectedTemplate((current) => current || submittedTemplate);
      setReferenceImages((current) => current.length ? current : submittedReferences);
      setNotice(getGenerationErrorMessage(error, t));
    }
  };

  const createConversation = async () => {
    if (activeRun || runtime.sending) return;
    setNotice("");
    try {
      await runtime.createConversation();
      setHistoryOpen(false);
      setSelectedTemplate(null);
      setReferenceImages([]);
      setBrief("");
    } catch (error) {
      setNotice(error.response?.data?.message || t("新建对话失败", "Unable to create conversation"));
    }
  };

  const deleteConversation = async (conversation) => {
    if (!conversation?.id || activeRun || runtime.sending || deletingConversationId) return;
    const title = conversation.title || t("新对话", "New conversation");
    if (!window.confirm(t(
      `删除对话“${title}”？该对话将从历史记录中隐藏，已完成任务的审计记录仍会保留。`,
      `Delete “${title}”? It will be hidden from conversation history while completed run audit records remain available.`,
    ))) return;

    setNotice("");
    setDeletingConversationId(conversation.id);
    try {
      await runtime.deleteConversation(conversation.id);
    } catch (error) {
      const code = error.response?.data?.code || error.code;
      setNotice(code === "CANVAS_AGENT_CONVERSATION_ACTIVE"
        ? t("请先停止该对话中正在执行的任务，再删除对话。", "Stop the active run in this conversation before deleting it.")
        : error.response?.data?.message || t("删除对话失败", "Unable to delete conversation"));
    } finally {
      setDeletingConversationId("");
    }
  };

  if (!open) return null;
  return (
    <aside className={`relative z-40 flex h-full min-h-0 shrink-0 flex-col overflow-hidden rounded-[28px] ${activeRun ? "canvas-agent-running" : ""}`} style={{ width, background: ui.aiPanel || ui.panel, borderColor: ui.line, color: ui.text, boxShadow: ui.aiPanelShadow }} aria-label={t("画布 Agent", "Canvas Agent")}>
      <header className="flex h-[52px] shrink-0 items-center justify-between gap-2 border-b px-3" style={{ borderColor: ui.line }}>
        <div className="flex min-w-0 items-center gap-2">
          <span className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full" style={{ background: ui.goldSoft, color: ui.gold }}><Sparkles size={13} />{activeRun && <span className="absolute -right-0.5 -top-0.5 h-2 w-2 animate-pulse rounded-full border" style={{ background: "#35c981", borderColor: ui.panelStrong }} />}</span>
          <div className="min-w-0"><h2 className="truncate text-[11px] font-semibold">{t("画布 Agent", "Canvas Agent")}</h2><p className="truncate text-[9px]" style={{ color: ui.faint }}>{modelLabel(models.catalogs?.text, conversationModels?.textModel)}</p></div>
        </div>
        <div className="flex items-center gap-0.5">
          <CanvasIconButton label={t("新建对话", "New conversation")} tooltipSide="bottom" onClick={() => void createConversation()} disabled={activeRun || runtime.sending} style={{ color: ui.muted }}><MessageSquarePlus size={12} /></CanvasIconButton>
          <CanvasIconButton label={t("历史对话", "Conversation history")} tooltipSide="bottom" onClick={() => setHistoryOpen((value) => !value)} active={historyOpen} style={{ color: historyOpen ? ui.gold : ui.muted }}><History size={12} /></CanvasIconButton>
          <CanvasIconButton label={t("模型设置", "Model settings")} tooltipSide="bottom" onClick={() => setModelOpen(true)} active={modelOpen} style={{ color: modelOpen ? ui.gold : ui.muted }}><Settings2 size={12} /></CanvasIconButton>
          <CanvasIconButton label={t("关闭画布 Agent", "Close Canvas Agent")} tooltipSide="bottom" onClick={onClose} style={{ color: ui.muted }}><PanelRightClose size={12} /></CanvasIconButton>
        </div>
      </header>

      {historyOpen && (
        <div className="absolute left-2 right-2 top-[48px] z-50 max-h-80 overflow-hidden rounded-[18px] border shadow-2xl" style={{ background: ui.panelStrong, borderColor: ui.line }}>
          <div className="flex items-center justify-between border-b px-3 py-2 text-[10px] font-semibold" style={{ borderColor: ui.line }}>{t("画布对话历史", "Canvas conversation history")}<CanvasIconButton label={t("关闭", "Close")} onClick={() => setHistoryOpen(false)} style={{ color: ui.faint }}><X size={11} /></CanvasIconButton></div>
          <div className="max-h-64 overflow-y-auto p-1.5">
            {runtime.conversations.length === 0 && <p className="px-2 py-6 text-center text-[10px]" style={{ color: ui.faint }}>{t("暂无历史对话", "No conversations yet")}</p>}
            {runtime.conversations.map((conversation) => {
              const deleting = deletingConversationId === conversation.id;
              const active = conversation.id === runtime.activeConversation?.id;
              return (
                <div key={conversation.id} className="group flex items-center gap-1 rounded-xl px-1" style={{ background: active ? ui.soft : "transparent" }}>
                  <button type="button" onClick={() => { if (!activeRun) void runtime.selectConversation(conversation.id); setHistoryOpen(false); }} disabled={activeRun || deleting} className="min-w-0 flex-1 truncate rounded-xl px-1.5 py-2 text-left text-[10px] transition disabled:opacity-50" style={{ color: ui.text }}>{conversation.title || t("新对话", "New conversation")}</button>
                  <CanvasIconButton label={t("删除对话", "Delete conversation")} tooltipSide="left" onClick={() => void deleteConversation(conversation)} disabled={activeRun || runtime.sending || Boolean(deletingConversationId)} style={{ color: ui.danger }}>
                    {deleting ? <span className="h-3 w-3 animate-spin rounded-full border border-current border-t-transparent" /> : <Trash2 size={11} />}
                  </CanvasIconButton>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="shrink-0 space-y-2 border-b px-3 py-2" style={{ borderColor: ui.line }}>
        <div className="flex gap-1.5">
          <QuickModelSelect icon={<Bot size={10} />} label={t("文本模型", "Text model")} value={conversationModels?.textModel} options={models.catalogs?.text} disabled={models.saving || savingModel || activeRun} onChange={(value) => void saveModel({ textModel: value })} ui={ui} />
          <QuickModelSelect icon={<ImageIcon size={10} />} label={t("图片模型", "Image model")} value={conversationModels?.imageModel} options={models.catalogs?.image} disabled={models.saving || savingModel || activeRun} onChange={(value) => void saveModel({ imageModel: value })} ui={ui} />
          <QuickModelSelect icon={<Film size={10} />} label={t("视频模型", "Video model")} value={conversationModels?.videoModel} options={models.catalogs?.video} disabled={models.saving || savingModel || activeRun} onChange={(value) => void saveModel({ videoModel: value })} ui={ui} />
        </div>
        <div className="flex items-center gap-1.5">
          <CanvasRoundedSelect
            label={t("Agent 权限模式", "Agent access mode")}
            value={mode}
            options={Object.entries(MODE_LABELS).map(([key, labels]) => ({ value: key, label: language === "en" ? labels[1] : labels[0] }))}
            onChange={saveMode}
            disabled={activeRun}
            ui={ui}
            compact
            className="min-w-0 flex-1"
            triggerClassName="w-full"
            menuMinWidth={190}
          />
          <span className="inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[9px]" style={{ background: ui.soft, color: ui.faint }}><ShieldCheck size={10} />{currentMode[language === "en" ? 1 : 0]}</span>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {runtime.loading && <div className="py-8 text-center text-[10px]" style={{ color: ui.faint }}>{t("正在加载画布对话…", "Loading canvas conversation...")}</div>}
        {!runtime.loading && messages.length === 0 && (
          <div className="flex h-full min-h-[220px] flex-col items-center justify-center px-5 text-center">
            <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-full" style={{ background: ui.soft, color: ui.gold }}><Sparkles size={18} /></span>
            <p className="text-xs font-semibold">{t("从一句话开始", "Start with one request")}</p>
            <p className="mt-1.5 max-w-[280px] text-[10px] leading-[18px]" style={{ color: ui.faint }}>{t("创建或修改工作流、整理画布、选择模板，或生成图片和视频。每一步都会在这里实时显示。", "Create or edit workflows, arrange the canvas, use templates, or generate media. Every action appears here live.")}</p>
          </div>
        )}
        <div className="space-y-3">
          {messages.map((message) => {
            if (message.liveRun) return <CanvasAgentRunTimeline key={message.id} run={message.liveRun} onApprove={runtime.approve} onCancel={() => void runtime.cancel()} ui={ui} t={t} />;
            const isUser = message.role === "user";
            const attachments = Array.isArray(message.attachments) ? message.attachments : [];
            return <div key={message.id} className={`flex ${isUser ? "justify-end" : "justify-start"}`}><div className="max-w-[92%] rounded-[16px] px-3 py-2 text-[11px] leading-[18px] shadow-sm" style={{ background: isUser ? ui.accent : ui.soft, color: isUser ? ui.accentText : ui.text }}><p className="whitespace-pre-wrap">{message.content}</p>{attachments.length > 0 && <div className="mt-2 flex flex-wrap gap-1">{attachments.map((attachment, index) => <span key={`${attachment.kind || "attachment"}-${attachment.id || attachment.elementId || index}`} className="inline-flex max-w-full items-center gap-1 rounded-full border px-1.5 py-0.5 text-[8px]" style={{ borderColor: isUser ? "rgba(255,255,255,.24)" : ui.line, color: isUser ? "inherit" : ui.faint }}><Paperclip size={8} /><span className="truncate">{attachment.kind === "canvas_image" ? (attachment.title || t("画布参考图", "Canvas reference")) : (attachment.sceneKey || attachment.id || t("创作模板", "Template"))}</span></span>)}</div>}</div></div>;
          })}
        </div>
      </div>

      <CanvasAgentComposer brief={brief} onBriefChange={setBrief} onSubmit={() => void submit()} onCancel={() => void runtime.cancel()} onOpenTemplates={() => setTemplateOpen(true)} onOpenModels={() => setModelOpen(true)} selectedTemplate={selectedTemplate} onRemoveTemplate={() => setSelectedTemplate(null)} selectedReferences={referenceImages} selectedCanvasReferenceCount={selectedImageElements.length} onAttachSelectedReferences={attachSelectedImages} onRemoveReference={(elementId) => setReferenceImages((current) => current.filter((item) => item.elementId !== elementId))} models={conversationModels} activeRun={activeRun} sending={runtime.sending} error={notice || (runtime.error ? getGenerationErrorMessage(runtime.error, t) : "")} ui={ui} t={t} />

      <AgentTemplatePicker open={templateOpen} onClose={() => setTemplateOpen(false)} authAxios={authAxios} modelOptions={[...(models.catalogs?.image || []), ...(models.catalogs?.video || [])]} onSelect={selectTemplate} ui={ui} t={t} />
      <CanvasModelSettingsDialog open={modelOpen} onClose={() => setModelOpen(false)} preferences={conversationModels} catalogs={models.catalogs} onChange={(patch) => void saveModel(patch)} saving={models.saving || savingModel} ui={ui} t={t} />
    </aside>
  );
};

export default CanvasAgentPanel;
