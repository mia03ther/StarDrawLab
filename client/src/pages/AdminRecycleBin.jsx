import { useCallback, useEffect, useState } from "react";
import toast from "react-hot-toast";
import { v4 as uuidv4 } from "uuid";
import useAuthAxios from "../hooks/useAuthAxios";
import { useAuthing } from "../contexts/AuthingContext";
import { useLanguage } from "../contexts/LanguageContext";
import { useStarDrawTheme } from "../utils/stardrawTheme";

const PAGE_SIZE = 50;
const PERMANENT_DELETE_CONFIRMATION = "PERMANENT_DELETE";

const extractRows = (payload) => {
  const data = payload?.data ?? payload ?? [];
  if (Array.isArray(data)) return data;
  const rows = data.items || data.rows || data.entries || [];
  return Array.isArray(rows) ? rows : [];
};

const formatDateTime = (value, locale) => {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString(locale);
};

const retentionExpired = (value) => {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && timestamp <= Date.now();
};

const mutationHeaders = () => ({ "X-Idempotency-Key": uuidv4() });

const AdminRecycleBin = () => {
  const authAxios = useAuthAxios();
  const { role, isRoot } = useAuthing();
  const { locale, t } = useLanguage();
  const { ui } = useStarDrawTheme();
  const [entries, setEntries] = useState([]);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [workingKey, setWorkingKey] = useState(null);
  const [restoreReasons, setRestoreReasons] = useState({});
  const [reviewNotes, setReviewNotes] = useState({});
  const [purgeConfirmations, setPurgeConfirmations] = useState({});
  const isAdministrator = role === "admin";

  const loadEntries = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await authAxios.get("/api/admin/content/recycle-bin", {
        params: { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE },
      });
      setEntries(extractRows(data));
    } catch (requestError) {
      setEntries([]);
      setError(requestError.response?.data?.message || t(
        "管理回收站加载失败。",
        "Failed to load the administrative recycle bin.",
      ));
    } finally {
      setLoading(false);
    }
  }, [authAxios, page, t]);

  useEffect(() => {
    loadEntries();
  }, [loadEntries]);

  const runMutation = async ({ key, request, successMessage, clear }) => {
    setWorkingKey(key);
    try {
      await request();
      clear?.();
      toast.success(successMessage);
      await loadEntries();
    } catch (requestError) {
      toast.error(requestError.response?.data?.message || t("操作失败", "Operation failed"));
    } finally {
      setWorkingKey(null);
    }
  };

  const requestRestore = async (entry) => {
    const reason = String(restoreReasons[entry.id] || "").trim();
    if (!reason) {
      toast.error(t("请填写恢复申请原因", "Enter a reason for the restore request"));
      return;
    }
    await runMutation({
      key: `request:${entry.id}`,
      request: () => authAxios.post(
        `/api/admin/content/recycle-bin/${encodeURIComponent(entry.id)}/restore-requests`,
        { reason },
        { headers: mutationHeaders() },
      ),
      successMessage: t("恢复申请已提交，等待 root 审批", "Restore request submitted for root review"),
      clear: () => setRestoreReasons((current) => ({ ...current, [entry.id]: "" })),
    });
  };

  const reviewRestore = async (entry, action) => {
    const requestId = entry.restore_request_id;
    if (!requestId) return;
    const note = String(reviewNotes[entry.id] || "").trim();
    if (action === "reject" && !note) {
      toast.error(t("驳回恢复申请时必须填写审批备注", "A review note is required when rejecting"));
      return;
    }
    await runMutation({
      key: `${action}:${entry.id}`,
      request: () => authAxios.post(
        `/api/root/content/restore-requests/${encodeURIComponent(requestId)}/${action}`,
        { note: note || null },
        { headers: mutationHeaders() },
      ),
      successMessage: action === "approve"
        ? t("内容已恢复", "Content restored")
        : t("恢复申请已驳回", "Restore request rejected"),
      clear: () => setReviewNotes((current) => ({ ...current, [entry.id]: "" })),
    });
  };

  const permanentlyDelete = async (entry) => {
    if (!retentionExpired(entry.purge_after)) return;
    const confirmation = String(purgeConfirmations[entry.id] || "").trim();
    if (confirmation !== PERMANENT_DELETE_CONFIRMATION) {
      toast.error(t(
        `请输入 ${PERMANENT_DELETE_CONFIRMATION} 进行确认`,
        `Type ${PERMANENT_DELETE_CONFIRMATION} to confirm`,
      ));
      return;
    }
    if (!window.confirm(t(
      "永久清理不可由用户恢复，并且服务端会再次校验 root 权限。确定继续？",
      "Permanent deletion cannot be restored by the user. The server will re-check root access. Continue?",
    ))) return;

    await runMutation({
      key: `purge:${entry.id}`,
      request: () => authAxios.delete(
        `/api/root/content/recycle-bin/${encodeURIComponent(entry.id)}/permanent`,
        {
          data: { confirmation: PERMANENT_DELETE_CONFIRMATION },
          headers: mutationHeaders(),
        },
      ),
      successMessage: t("内容已永久清理", "Content permanently deleted"),
      clear: () => setPurgeConfirmations((current) => ({ ...current, [entry.id]: "" })),
    });
  };

  return (
    <main className="mx-auto max-w-[1480px] p-8">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.24em]" style={{ color: ui.primary }}>
            {isRoot ? t("ROOT 管理台", "ROOT CONSOLE") : t("管理员后台", "ADMIN CONSOLE")}
          </p>
          <h1 className="mt-2 text-4xl font-black" style={{ color: ui.text }}>
            {t("管理回收站", "Administrative Recycle Bin")}
          </h1>
          <p className="mt-2 max-w-4xl text-sm leading-6" style={{ color: ui.faint }}>
            {t(
              "这里只显示管理员移除内容的安全元数据，不展示资源快照或任何私有媒体。管理员可申请恢复，root 负责审批及保留期结束后的永久清理。",
              "Only safe metadata for administrator-removed content is shown. Resource snapshots and private media are never displayed. Admins request restores; root reviews them and handles deletion after retention expires.",
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={loadEntries}
          disabled={loading}
          className="rounded-xl px-4 py-2 text-sm font-bold disabled:opacity-50"
          style={{ background: ui.surface, color: ui.primary, border: `1px solid ${ui.line}` }}
        >
          {t("刷新", "Refresh")}
        </button>
      </div>

      {loading ? (
        <div className="rounded-3xl p-12 text-center" style={{ background: ui.surface, color: ui.faint, border: `1px solid ${ui.line}` }}>
          {t("正在加载管理回收站…", "Loading administrative recycle bin…")}
        </div>
      ) : error ? (
        <div className="rounded-3xl p-10 text-center" style={{ background: ui.surface, border: `1px dashed ${ui.lineStrong}` }}>
          <span className="material-symbols-outlined text-3xl" style={{ color: ui.danger }}>error</span>
          <p className="mt-3 text-sm" style={{ color: ui.muted }}>{error}</p>
          <button type="button" onClick={loadEntries} className="mt-4 rounded-xl px-4 py-2 text-sm font-bold" style={{ color: ui.primary, background: ui.primarySoft }}>
            {t("重试", "Retry")}
          </button>
        </div>
      ) : entries.length === 0 ? (
        <div className="rounded-3xl p-12 text-center" style={{ background: ui.surface, color: ui.faint, border: `1px dashed ${ui.lineStrong}` }}>
          {t("管理回收站为空", "The administrative recycle bin is empty")}
        </div>
      ) : (
        <div className="space-y-5">
          {entries.map((entry) => {
            const expired = retentionExpired(entry.purge_after);
            const busy = workingKey?.endsWith(`:${entry.id}`);
            return (
              <article key={entry.id} className="rounded-3xl p-6" style={{ background: ui.surface, border: `1px solid ${ui.line}`, boxShadow: ui.shadow }}>
                <div className="flex flex-wrap items-start justify-between gap-5">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="max-w-2xl truncate text-xl font-black" style={{ color: ui.text }}>
                        {entry.resource_label || t("未命名内容", "Untitled content")}
                      </h2>
                      <span className="rounded-full px-2 py-1 text-[10px] font-black uppercase tracking-wider" style={{ color: ui.primary, background: ui.primarySoft }}>
                        {entry.resource_type || "unknown"}
                      </span>
                      <span className="rounded-full px-2 py-1 text-[10px] font-black uppercase tracking-wider" style={{ color: expired ? ui.danger : ui.gold, background: expired ? ui.dangerSoft : ui.goldSoft }}>
                        {expired ? t("保留期已结束", "Retention expired") : t("保留中", "Retained")}
                      </span>
                    </div>
                    <dl className="mt-4 grid gap-x-8 gap-y-3 text-xs sm:grid-cols-2 xl:grid-cols-4">
                      <div><dt style={{ color: ui.faint }}>{t("所有者", "Owner")}</dt><dd className="mt-1 break-all font-bold" style={{ color: ui.muted }}>{entry.owner_user_id || "—"}</dd></div>
                      <div><dt style={{ color: ui.faint }}>{t("资源 ID", "Resource ID")}</dt><dd className="mt-1 break-all font-bold" style={{ color: ui.muted }}>{entry.resource_id || "—"}</dd></div>
                      <div><dt style={{ color: ui.faint }}>{t("删除时间", "Deleted at")}</dt><dd className="mt-1 font-bold" style={{ color: ui.muted }}>{formatDateTime(entry.deleted_at, locale)}</dd></div>
                      <div><dt style={{ color: ui.faint }}>{t("永久清理可用时间", "Purge available at")}</dt><dd className="mt-1 font-bold" style={{ color: expired ? ui.danger : ui.muted }}>{formatDateTime(entry.purge_after, locale)}</dd></div>
                    </dl>
                    <div className="mt-4 rounded-2xl p-4" style={{ background: ui.surfaceAlt, border: `1px solid ${ui.line}` }}>
                      <p className="text-[10px] font-black uppercase tracking-wider" style={{ color: ui.faint }}>{t("管理员删除原因", "Administrative removal reason")}</p>
                      <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6" style={{ color: ui.muted }}>{entry.deletion_reason || "—"}</p>
                    </div>
                  </div>
                </div>

                {isAdministrator && (
                  <div className="mt-5 border-t pt-5" style={{ borderColor: ui.line }}>
                    {entry.restore_request_id ? (
                      <div className="rounded-2xl p-4" style={{ background: ui.goldSoft, border: `1px solid ${ui.line}` }}>
                        <p className="text-sm font-bold" style={{ color: ui.gold }}>{t("恢复申请等待 root 审批", "Restore request awaiting root review")}</p>
                        <p className="mt-2 text-xs leading-5" style={{ color: ui.muted }}>{entry.restore_request_reason || "—"}</p>
                      </div>
                    ) : (
                      <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
                        <label className="min-w-0 flex-1 text-xs font-bold" style={{ color: ui.text }}>
                          {t("恢复申请原因（必填）", "Restore request reason (required)")}
                          <textarea
                            value={restoreReasons[entry.id] || ""}
                            onChange={(event) => setRestoreReasons((current) => ({ ...current, [entry.id]: event.target.value.slice(0, 2000) }))}
                            disabled={expired || busy}
                            rows={2}
                            className="mt-2 w-full resize-y rounded-xl px-3 py-2 text-sm font-normal outline-none disabled:opacity-50"
                            style={{ background: ui.surfaceAlt, color: ui.text, border: `1px solid ${ui.lineStrong}` }}
                            placeholder={expired ? t("保留期已结束，无法申请恢复", "Retention expired; restore is unavailable") : t("说明申请恢复的原因", "Explain why this content should be restored")}
                          />
                        </label>
                        <button
                          type="button"
                          disabled={expired || busy || !String(restoreReasons[entry.id] || "").trim()}
                          onClick={() => requestRestore(entry)}
                          className="rounded-xl px-5 py-2.5 text-sm font-black disabled:opacity-40"
                          style={{ background: ui.buttonGradient, color: ui.primaryText }}
                        >
                          {t("提交恢复申请", "Request restore")}
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {isRoot && (
                  <div className="mt-5 space-y-4 border-t pt-5" style={{ borderColor: ui.line }}>
                    {entry.restore_request_id && (
                      <div className="rounded-2xl p-4" style={{ background: ui.surfaceAlt, border: `1px solid ${ui.line}` }}>
                        <div className="grid gap-4 lg:grid-cols-[1fr,1fr]">
                          <div>
                            <p className="text-[10px] font-black uppercase tracking-wider" style={{ color: ui.faint }}>{t("恢复申请", "Restore request")}</p>
                            <p className="mt-2 text-sm leading-6" style={{ color: ui.muted }}>{entry.restore_request_reason || "—"}</p>
                            <p className="mt-2 break-all text-xs" style={{ color: ui.faint }}>{t("申请人", "Requested by")}: {entry.restore_requested_by_user_id || "—"} · {formatDateTime(entry.restore_requested_at, locale)}</p>
                          </div>
                          <label className="text-xs font-bold" style={{ color: ui.text }}>
                            {t("审批备注（驳回时必填）", "Review note (required for rejection)")}
                            <textarea
                              value={reviewNotes[entry.id] || ""}
                              onChange={(event) => setReviewNotes((current) => ({ ...current, [entry.id]: event.target.value.slice(0, 2000) }))}
                              disabled={busy}
                              rows={3}
                              className="mt-2 w-full resize-y rounded-xl px-3 py-2 text-sm font-normal outline-none disabled:opacity-50"
                              style={{ background: ui.surface, color: ui.text, border: `1px solid ${ui.lineStrong}` }}
                            />
                          </label>
                        </div>
                        <div className="mt-4 flex justify-end gap-3">
                          <button type="button" disabled={busy || !String(reviewNotes[entry.id] || "").trim()} onClick={() => reviewRestore(entry, "reject")} className="rounded-xl px-4 py-2 text-sm font-bold disabled:opacity-40" style={{ color: ui.danger, background: ui.dangerSoft }}>
                            {t("驳回申请", "Reject")}
                          </button>
                          <button type="button" disabled={busy || expired} onClick={() => reviewRestore(entry, "approve")} className="rounded-xl px-4 py-2 text-sm font-black disabled:opacity-40" style={{ color: ui.primaryText, background: ui.buttonGradient }}>
                            {expired ? t("保留期已结束", "Retention expired") : t("批准并恢复", "Approve and restore")}
                          </button>
                        </div>
                      </div>
                    )}

                    <div className="rounded-2xl p-4" style={{ background: expired ? ui.dangerSoft : ui.surfaceAlt, border: `1px solid ${expired ? ui.danger : ui.line}` }}>
                      <p className="text-sm font-black" style={{ color: expired ? ui.danger : ui.faint }}>{t("永久清理", "Permanent deletion")}</p>
                      <p className="mt-1 text-xs leading-5" style={{ color: ui.muted }}>
                        {expired
                          ? t("输入确认短语后才可永久清理；服务端仍会校验 root 权限。", "Enter the confirmation phrase to enable permanent deletion. Root access is still verified by the server.")
                          : t("保留期结束前不允许永久清理。", "Permanent deletion is unavailable until retention expires.")}
                      </p>
                      <div className="mt-3 flex flex-col gap-3 lg:flex-row">
                        <input
                          value={purgeConfirmations[entry.id] || ""}
                          onChange={(event) => setPurgeConfirmations((current) => ({ ...current, [entry.id]: event.target.value }))}
                          disabled={!expired || busy}
                          autoComplete="off"
                          spellCheck="false"
                          className="min-w-0 flex-1 rounded-xl px-3 py-2 text-sm outline-none disabled:opacity-50"
                          style={{ background: ui.surface, color: ui.text, border: `1px solid ${ui.lineStrong}` }}
                          placeholder={PERMANENT_DELETE_CONFIRMATION}
                          aria-label={t("永久清理确认短语", "Permanent deletion confirmation phrase")}
                        />
                        <button
                          type="button"
                          disabled={!expired || busy || String(purgeConfirmations[entry.id] || "").trim() !== PERMANENT_DELETE_CONFIRMATION}
                          onClick={() => permanentlyDelete(entry)}
                          className="rounded-xl px-5 py-2 text-sm font-black disabled:opacity-40"
                          style={{ color: ui.danger, background: ui.surface, border: `1px solid ${ui.danger}` }}
                        >
                          {t("永久清理", "Permanently delete")}
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}

      {!loading && !error && (page > 1 || entries.length === PAGE_SIZE) && (
        <div className="mt-6 flex items-center justify-between" style={{ color: ui.faint }}>
          <button type="button" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))} className="rounded-xl px-4 py-2 text-sm font-bold disabled:opacity-40" style={{ background: ui.surface, color: ui.muted, border: `1px solid ${ui.line}` }}>
            {t("上一页", "Previous")}
          </button>
          <span className="text-xs">{t(`第 ${page} 页`, `Page ${page}`)}</span>
          <button type="button" disabled={entries.length < PAGE_SIZE} onClick={() => setPage((value) => value + 1)} className="rounded-xl px-4 py-2 text-sm font-bold disabled:opacity-40" style={{ background: ui.surface, color: ui.muted, border: `1px solid ${ui.line}` }}>
            {t("下一页", "Next")}
          </button>
        </div>
      )}
    </main>
  );
};

export default AdminRecycleBin;
