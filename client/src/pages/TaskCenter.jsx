import { useState } from "react";
import toast from "react-hot-toast";
import useAuthAxios from "../hooks/useAuthAxios";
import useTaskStream from "../hooks/useTaskStream";
import { useLanguage } from "../contexts/LanguageContext";
import { useStarDrawTheme } from "../utils/stardrawTheme";
import CanvasRoundedSelect from "../components/canvas/CanvasRoundedSelect";

const PAGE_SIZE = 20;

const statusLabel = (status, t) => ({
  queued: t("排队中", "Queued"),
  pending: t("等待中", "Pending"),
  running: t("执行中", "Running"),
  processing: t("处理中", "Processing"),
  paused: t("已暂停", "Paused"),
  waiting_approval: t("等待确认", "Waiting for approval"),
  waiting_client: t("等待浏览器执行", "Waiting for browser"),
  completed: t("已完成", "Completed"),
  failed: t("失败", "Failed"),
  cancelled: t("已取消", "Cancelled"),
}[status] || status);

const sourceLabel = (source, t) => ({
  persistent_job: t("持久任务", "Durable job"),
  workflow_run: t("工作流", "Workflow"),
  agent_plan_run: t("Agent 计划", "Agent plan"),
  creation: t("生成记录", "Creation"),
}[source] || source);

const taskTypeLabel = (type, t) => ({ image: t("图片", "image"), video: t("视频", "video"), image_generate: t("图片生成", "image_generate"), video_generate: t("视频生成", "video_generate"), workflow: t("工作流", "workflow"), agent: t("Agent", "agent") }[type] || type);

const statusTone = (status, ui) => {
  if (status === "completed") return { color: ui.success, background: `${ui.success}18` };
  if (["failed", "cancelled"].includes(status)) return { color: ui.danger, background: ui.dangerSoft };
  if (["running", "processing", "waiting_approval", "waiting_client"].includes(status)) return { color: ui.gold, background: ui.goldSoft };
  return { color: ui.muted, background: ui.surfaceHigh };
};

const formatTimestamp = (value, locale) => {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString(locale);
};

const TaskCard = ({ task, onCancel, cancellingId, ui, t, locale }) => {
  const tone = statusTone(task.status, ui);
  const isCancelling = cancellingId === task.id;
  const canCancel = task.cancellation?.supported === true && !isCancelling;
  const errorText = task.error?.message || task.error?.code;

  return (
    <article className="rounded-2xl p-5" style={{ background: ui.surface, border: `1px solid ${ui.line}`, boxShadow: ui.shadow }}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-black uppercase tracking-[0.18em]" style={{ color: ui.faint }}>
            {sourceLabel(task.source, t)} · {taskTypeLabel(task.type, t)}
          </p>
          <h2 className="mt-2 truncate text-base font-black" style={{ color: ui.text }}>{task.title}</h2>
          <p className="mt-1 break-all text-[10px] font-mono" style={{ color: ui.faint }}>{task.id}</p>
        </div>
        <span className="rounded-full px-3 py-1 text-[11px] font-black" style={{ color: tone.color, background: tone.background }}>
          {statusLabel(task.status, t)}
        </span>
      </div>

      <div className="mt-5">
        <div className="mb-2 flex items-center justify-between text-xs" style={{ color: ui.muted }}>
          <span>{t("进度", "Progress")}</span>
          <span>{task.progress}%</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full" style={{ background: ui.surfaceAlt }}>
          <div className="h-full rounded-full transition-all" style={{ width: `${task.progress}%`, background: tone.color }} />
        </div>
      </div>

      <div className="mt-4 grid gap-2 text-[11px] sm:grid-cols-2" style={{ color: ui.faint }}>
        <span>{t("创建", "Created")}: {formatTimestamp(task.timestamps?.createdAt, locale)}</span>
        <span>{t("更新", "Updated")}: {formatTimestamp(task.timestamps?.updatedAt, locale)}</span>
      </div>

      {errorText && (
        <p className="mt-4 rounded-xl px-3 py-2 text-xs" style={{ color: ui.danger, background: ui.dangerSoft }}>
          {errorText}
        </p>
      )}

      <div className="mt-5 flex items-center justify-between gap-3">
        <span className="text-[11px]" style={{ color: ui.faint }}>
          {task.cancellation?.supported
            ? t("可安全取消", "Safe to cancel")
            : task.cancellation?.reason || t("不可取消", "Cannot cancel")}
        </span>
        {task.cancellation?.supported && (
          <button
            type="button"
            onClick={() => onCancel(task)}
            disabled={!canCancel}
            className="rounded-xl px-3 py-2 text-xs font-black transition-opacity disabled:opacity-50"
            style={{ color: ui.danger, background: ui.dangerSoft, border: `1px solid ${ui.danger}44` }}
          >
            {isCancelling ? t("取消中…", "Cancelling…") : t("取消任务", "Cancel task")}
          </button>
        )}
      </div>
    </article>
  );
};

const TaskCenter = () => {
  const authAxios = useAuthAxios();
  const { t, isZh } = useLanguage();
  const { ui } = useStarDrawTheme();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const [type, setType] = useState("");
  const [cancellingId, setCancellingId] = useState(null);
  const locale = isZh ? "zh-CN" : "en-US";
  const { tasks, total, loading, error, connectionState, reload } = useTaskStream({
    page,
    pageSize: PAGE_SIZE,
    status,
    type,
  });

  const applyFilter = (setter) => (event) => {
    setter(event.target.value);
    setPage(1);
  };

  const cancelTask = async (task) => {
    if (!window.confirm(t(`确定取消“${task.title}”吗？`, `Cancel “${task.title}”?`))) return;
    setCancellingId(task.id);
    try {
      await authAxios.post(`/api/tasks/${encodeURIComponent(task.id)}/cancel`, {}, {
        headers: { "X-Idempotency-Key": `task-cancel:${crypto.randomUUID()}` },
      });
      toast.success(t("任务已取消", "Task cancelled"));
      await reload();
    } catch (requestError) {
      toast.error(requestError.response?.data?.message || t("任务取消失败", "Unable to cancel task"));
    } finally {
      setCancellingId(null);
    }
  };

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="min-h-[calc(100vh-4rem)] p-6 sm:p-8" style={{ background: ui.page }}>
      <div className="mx-auto max-w-6xl">
        <div className="flex flex-wrap items-end justify-between gap-5">
          <div>
            <div className="flex items-center gap-2">
              <p className="text-[10px] font-black uppercase tracking-[0.22em]" style={{ color: ui.primary }}>{t("运行状态", "Run status")}</p>
              <span className="flex items-center gap-1.5 text-[10px] font-bold" style={{ color: connectionState === "live" ? ui.success : ui.faint }}>
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: connectionState === "live" ? ui.success : ui.gold }} />
                {connectionState === "live"
                  ? t("实时同步", "Live")
                  : connectionState === "polling"
                    ? t("轮询同步", "Polling fallback")
                    : t("正在连接", "Connecting")}
              </span>
            </div>
            <h1 className="mt-2 text-3xl font-black" style={{ color: ui.text }}>{t("任务中心", "Task Center")}</h1>
            <p className="mt-2 text-sm" style={{ color: ui.faint }}>{t("查看当前账号的生成、工作流和持久任务。", "Track your generations, workflows, and durable jobs in one place.")}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <CanvasRoundedSelect label={t("状态", "Status")} value={status} onChange={applyFilter(setStatus)} options={[{ value: "", label: t("全部状态", "All statuses") }, { value: "queued", label: t("排队中", "Queued") }, { value: "running", label: t("执行中", "Running") }, { value: "paused", label: t("已暂停", "Paused") }, { value: "waiting_approval", label: t("等待确认", "Waiting for approval") }, { value: "waiting_client", label: t("等待浏览器执行", "Waiting for browser") }, { value: "completed", label: t("已完成", "Completed") }, { value: "failed", label: t("失败", "Failed") }, { value: "cancelled", label: t("已取消", "Cancelled") }]} ui={ui} className="min-w-[130px]" triggerClassName="h-10 w-full rounded-xl px-3 text-sm" menuMinWidth={220} />
            <CanvasRoundedSelect label={t("类型", "Type")} value={type} onChange={applyFilter(setType)} options={[{ value: "", label: t("全部类型", "All types") }, { value: "persistent_job", label: t("持久任务", "Durable jobs") }, { value: "workflow", label: t("工作流", "Workflows") }, { value: "agent_plan", label: t("Agent 计划", "Agent plans") }, { value: "image", label: t("图片", "Images") }, { value: "video", label: t("视频", "Videos") }]} ui={ui} className="min-w-[130px]" triggerClassName="h-10 w-full rounded-xl px-3 text-sm" menuMinWidth={220} />
          </div>
        </div>

        {error && <div className="mt-6 rounded-2xl px-4 py-3 text-sm" style={{ color: ui.danger, background: ui.dangerSoft }}>{error}</div>}
        {loading && tasks.length === 0 ? (
          <div className="mt-8 rounded-2xl p-10 text-center" style={{ background: ui.surface, border: `1px solid ${ui.line}`, color: ui.faint }}>
            {t("正在读取任务…", "Loading tasks…")}
          </div>
        ) : tasks.length === 0 ? (
          <div className="mt-8 rounded-2xl p-10 text-center" style={{ background: ui.surface, border: `1px solid ${ui.line}`, color: ui.faint }}>
            {t("暂无任务记录", "No tasks found")}
          </div>
        ) : (
          <div className="mt-8 grid gap-4 lg:grid-cols-2">
            {tasks.map((task) => <TaskCard key={task.id} task={task} onCancel={cancelTask} cancellingId={cancellingId} ui={ui} t={t} locale={locale} />)}
          </div>
        )}

        <div className="mt-8 flex items-center justify-between gap-4 text-sm" style={{ color: ui.faint }}>
          <span>{total} {t("个任务", "tasks")}</span>
          <div className="flex items-center gap-2">
            <button type="button" disabled={page <= 1 || loading} onClick={() => setPage((value) => value - 1)} className="rounded-xl px-3 py-2 font-bold disabled:opacity-40" style={{ background: ui.surface, border: `1px solid ${ui.line}`, color: ui.text }}>
              {t("上一页", "Previous")}
            </button>
            <span>{page} / {pageCount}</span>
            <button type="button" disabled={page >= pageCount || loading} onClick={() => setPage((value) => value + 1)} className="rounded-xl px-3 py-2 font-bold disabled:opacity-40" style={{ background: ui.surface, border: `1px solid ${ui.line}`, color: ui.text }}>
              {t("下一页", "Next")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TaskCenter;
