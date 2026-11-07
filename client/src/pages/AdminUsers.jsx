import { useCallback, useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { v4 as uuidv4 } from "uuid";
import useAuthAxios from "../hooks/useAuthAxios";
import { useAuthing } from "../contexts/AuthingContext";
import { useLanguage } from "../contexts/LanguageContext";
import { useStarDrawTheme } from "../utils/stardrawTheme";
import CanvasRoundedSelect from "../components/canvas/CanvasRoundedSelect";

const PAGE_SIZE = 20;

const extractCollection = (payload) => {
  const data = payload?.data ?? payload ?? {};
  const items = Array.isArray(data) ? data : (data.items || data.users || data.rows || []);
  return {
    items: Array.isArray(items) ? items : [],
    total: Number(data.total ?? data.pagination?.total ?? items.length) || 0,
  };
};

const normalizeUser = (row) => ({
  ...row,
  id: row.id || row.user_id || row.authing_user_id,
  name: row.display_name || row.full_name || row.name || row.nickname || "—",
  username: row.username || "",
  email: row.email || "",
  role: String(row.role || row.app_role || "user").toLowerCase(),
  accountStatus: String(row.account_status || row.status || "active").toLowerCase(),
  membershipTier: row.membership_tier || row.tier || "free",
  usage: row.total_usage ?? row.usage_total ?? row.total_points_spent ?? 0,
  lastLoginAt: row.last_login_at || row.last_seen_at || null,
  identityProvider: row.identity_provider || null,
  identitySubject: row.identity_subject || null,
  identityCount: Number(row.identity_count || 0),
  identityEmailVerified: Boolean(row.identity_email_verified_at),
});

const formatDateTime = (value, locale) => {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString(locale);
};

const StatusBadge = ({ value, ui, t }) => {
  const safeValue = value || "unknown";
  const isHealthy = safeValue === "active";
  return (
    <span
      className="inline-flex rounded-full px-2 py-1 text-[10px] font-black uppercase tracking-wider"
      style={{
        background: isHealthy ? ui.primarySoft : ui.dangerSoft,
        color: isHealthy ? ui.primary : ui.danger,
      }}
    >
      {{ active: t("正常", "active"), banned: t("已封禁", "banned"), suspended: t("已暂停", "suspended"), unknown: t("未知", "unknown") }[safeValue] || safeValue}
    </span>
  );
};

const AdminUsers = ({ roleManagementOnly = false }) => {
  const authAxios = useAuthAxios();
  const { isRoot } = useAuthing();
  const { locale, t } = useLanguage();
  const { ui } = useStarDrawTheme();
  const [users, setUsers] = useState([]);
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [workingId, setWorkingId] = useState(null);
  const [moderationDraft, setModerationDraft] = useState({
    ownerUserId: "",
    resourceType: "creation",
    resourceId: "",
    reason: "",
  });
  const [moderating, setModerating] = useState(false);

  const pageCount = useMemo(() => Math.max(1, Math.ceil(total / PAGE_SIZE)), [total]);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await authAxios.get("/api/admin/users", {
        params: {
          page,
          page_size: PAGE_SIZE,
          query: submittedQuery || undefined,
          status: status === "all" ? undefined : status,
        },
      });
      const collection = extractCollection(data);
      setUsers(collection.items.map(normalizeUser));
      setTotal(collection.total);
    } catch (requestError) {
      setUsers([]);
      setTotal(0);
      setError(requestError.response?.data?.message || t(
        "用户管理接口尚未就绪或当前请求被拒绝。",
        "The user administration API is not available or rejected this request.",
      ));
    } finally {
      setLoading(false);
    }
  }, [authAxios, page, status, submittedQuery, t]);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  const askReason = (message) => {
    const reason = window.prompt(message, "");
    return reason?.trim() || null;
  };

  const changeAccountStatus = async (targetUser, action) => {
    const isBan = action === "ban";
    const reason = askReason(isBan
      ? t("请输入封禁原因（必填）", "Enter a ban reason (required)")
      : t("请输入解封原因（必填）", "Enter an unban reason (required)"));
    if (!reason) return;

    setWorkingId(targetUser.id);
    try {
      await authAxios.post(`/api/admin/users/${encodeURIComponent(targetUser.id)}/${action}`, { reason });
      toast.success(isBan ? t("用户已封禁", "User banned") : t("用户已解封", "User unbanned"));
      await loadUsers();
    } catch (requestError) {
      toast.error(requestError.response?.data?.message || t("操作失败", "Operation failed"));
    } finally {
      setWorkingId(null);
    }
  };

  const changeRole = async (targetUser, nextRole) => {
    if (!isRoot || targetUser.role === "root") return;
    const reason = askReason(t(
      `请输入将 ${targetUser.id} 调整为 ${nextRole} 的原因（必填）`,
      `Enter the reason for changing ${targetUser.id} to ${nextRole} (required)`,
    ));
    if (!reason) return;
    if (!window.confirm(t(
      "角色变更将撤销该用户现有会话，并需要重新登录后生效。确定继续？",
      "This role change revokes the user's sessions and takes effect after they sign in again. Continue?",
    ))) return;

    setWorkingId(targetUser.id);
    try {
      await authAxios.patch(`/api/root/users/${encodeURIComponent(targetUser.id)}/role`, {
        role: nextRole,
        reason,
      });
      toast.success(t("角色已更新", "Role updated"));
      await loadUsers();
    } catch (requestError) {
      toast.error(requestError.response?.data?.message || t("角色更新失败", "Failed to update role"));
    } finally {
      setWorkingId(null);
    }
  };

  const handleSearch = (event) => {
    event.preventDefault();
    setPage(1);
    setSubmittedQuery(query.trim());
  };

  const moderateExactContent = async (event) => {
    event.preventDefault();
    const ownerUserId = moderationDraft.ownerUserId.trim();
    const resourceId = moderationDraft.resourceId.trim();
    const reason = moderationDraft.reason.trim();
    if (!ownerUserId || !resourceId || !reason) {
      toast.error(t("所有者、资源 ID 和删除原因均为必填", "Owner, resource ID, and removal reason are required"));
      return;
    }
    if (!window.confirm(t(
      "管理员删除会进入用户不可见的管理回收站，14 天内只能由管理员申请、root 审批恢复。确定继续？",
      "Administrator removal sends content to a hidden administrative recycle bin. Restore requires an admin request and root approval within 14 days. Continue?",
    ))) return;

    setModerating(true);
    try {
      await authAxios.delete(
        `/api/admin/content/users/${encodeURIComponent(ownerUserId)}/${encodeURIComponent(moderationDraft.resourceType)}/${encodeURIComponent(resourceId)}`,
        {
          data: { reason },
          headers: { "X-Idempotency-Key": uuidv4() },
        },
      );
      toast.success(t("内容已移入管理回收站", "Content moved to the administrative recycle bin"));
      setModerationDraft((current) => ({ ...current, resourceId: "", reason: "" }));
    } catch (requestError) {
      toast.error(requestError.response?.data?.message || t("内容移除失败", "Failed to remove content"));
    } finally {
      setModerating(false);
    }
  };

  return (
    <main className="mx-auto max-w-[1480px] p-8">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.24em]" style={{ color: ui.primary }}>
            {roleManagementOnly ? t("ROOT 管理员", "ROOT ADMIN") : t("管理员后台", "ADMIN CONSOLE")}
          </p>
          <h1 className="mt-2 text-4xl font-black" style={{ color: ui.text }}>
            {roleManagementOnly ? t("角色管理", "Role Management") : t("用户运营", "User Operations")}
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-6" style={{ color: ui.faint }}>
            {roleManagementOnly
              ? t("仅 root 可以授予或撤销管理员。单一 root 不可在此页面转移、禁用或删除。", "Only root can grant or revoke admin. The single root cannot be transferred, disabled, or deleted here.")
              : t("可查看基础运营信息并封禁或解封用户；私有内容、密钥、积分调整和角色操作不可用。", "View basic operations data and ban or unban users. Private content, secrets, point changes, and role actions are unavailable.")}
          </p>
        </div>
        <button
          type="button"
          onClick={loadUsers}
          className="rounded-xl px-4 py-2 text-sm font-bold"
          style={{ background: ui.surface, color: ui.primary, border: `1px solid ${ui.line}` }}
        >
          {t("刷新", "Refresh")}
        </button>
      </div>

      <section className="rounded-3xl p-5" style={{ background: ui.surface, border: `1px solid ${ui.line}`, boxShadow: ui.shadow }}>
        <form onSubmit={handleSearch} className="mb-5 flex flex-wrap gap-3">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("搜索用户 ID、昵称或邮箱", "Search user ID, name, or email")}
            className="min-w-[260px] flex-1 rounded-xl px-4 py-2.5 text-sm outline-none"
            style={{ background: ui.surfaceAlt, color: ui.text, border: `1px solid ${ui.lineStrong}` }}
          />
          <CanvasRoundedSelect label={t("状态", "Status")} value={status} onChange={(value) => { setStatus(value); setPage(1); }} options={[{ value: "all", label: t("全部状态", "All statuses") }, { value: "active", label: t("正常", "active") }, { value: "banned", label: t("已封禁", "banned") }, { value: "suspended", label: t("已暂停", "suspended") }]} ui={ui} className="min-w-[130px]" triggerClassName="h-10 w-full rounded-xl px-3 text-sm" menuMinWidth={180} />
          <button type="submit" className="rounded-xl px-5 py-2.5 text-sm font-black" style={{ background: ui.buttonGradient, color: ui.primaryText }}>
            {t("搜索", "Search")}
          </button>
        </form>

        {!roleManagementOnly && (
          <form onSubmit={moderateExactContent} className="mb-6 rounded-2xl p-4" style={{ background: ui.surfaceAlt, border: `1px solid ${ui.line}` }}>
            <div className="mb-3">
              <p className="text-sm font-black" style={{ color: ui.text }}>{t("按精确 ID 移除用户内容", "Remove user content by exact ID")}</p>
              <p className="mt-1 text-xs leading-5" style={{ color: ui.faint }}>{t("管理员无法浏览或预览用户私有内容。请仅根据举报或工单填写所有者、资源类型、资源 ID 和原因。", "Administrators cannot browse or preview private user content. Use owner, resource type, resource ID, and reason from a report or support case.")}</p>
            </div>
            <div className="grid gap-3 lg:grid-cols-4">
              <input
                value={moderationDraft.ownerUserId}
                onChange={(event) => setModerationDraft((current) => ({ ...current, ownerUserId: event.target.value }))}
                placeholder={t("所有者用户 ID", "Owner user ID")}
                className="rounded-xl px-3 py-2.5 text-sm outline-none"
                style={{ background: ui.surface, color: ui.text, border: `1px solid ${ui.lineStrong}` }}
              />
              <CanvasRoundedSelect label={t("资源类型", "Resource type")} value={moderationDraft.resourceType} onChange={(value) => setModerationDraft((current) => ({ ...current, resourceType: value }))} options={["creation", "canvas", "private_template", "digital_human", "upload"].map((value) => ({ value, label: t({ creation: "作品", canvas: "画布", private_template: "私有模板", digital_human: "数字人", upload: "上传文件" }[value], value) }))} ui={ui} className="w-full" triggerClassName="h-10 w-full rounded-xl px-3 text-sm" menuMinWidth={220} />
              <input
                value={moderationDraft.resourceId}
                onChange={(event) => setModerationDraft((current) => ({ ...current, resourceId: event.target.value }))}
                placeholder={t("资源 ID", "Resource ID")}
                className="rounded-xl px-3 py-2.5 text-sm outline-none"
                style={{ background: ui.surface, color: ui.text, border: `1px solid ${ui.lineStrong}` }}
              />
              <button type="submit" disabled={moderating} className="rounded-xl px-4 py-2.5 text-sm font-black disabled:opacity-50" style={{ background: ui.dangerSoft, color: ui.danger, border: `1px solid ${ui.danger}44` }}>
                {moderating ? t("处理中…", "Removing…") : t("移入管理回收站", "Move to admin recycle bin")}
              </button>
            </div>
            <textarea
              value={moderationDraft.reason}
              onChange={(event) => setModerationDraft((current) => ({ ...current, reason: event.target.value.slice(0, 2000) }))}
              rows={2}
              placeholder={t("删除原因（必填，最多 2000 字）", "Removal reason (required, max 2,000 characters)")}
              className="mt-3 w-full resize-y rounded-xl px-3 py-2.5 text-sm outline-none"
              style={{ background: ui.surface, color: ui.text, border: `1px solid ${ui.lineStrong}` }}
            />
          </form>
        )}

        {loading ? (
          <div className="p-10 text-center" style={{ color: ui.faint }}>{t("正在加载用户…", "Loading users…")}</div>
        ) : error ? (
          <div className="rounded-2xl p-8 text-center" style={{ background: ui.surfaceAlt, border: `1px dashed ${ui.lineStrong}` }}>
            <span className="material-symbols-outlined text-3xl" style={{ color: ui.faint }}>cloud_off</span>
            <p className="mt-3 text-sm" style={{ color: ui.muted }}>{error}</p>
            <button type="button" onClick={loadUsers} className="mt-4 rounded-xl px-4 py-2 text-sm font-bold" style={{ color: ui.primary, background: ui.primarySoft }}>
              {t("重试", "Retry")}
            </button>
          </div>
        ) : users.length === 0 ? (
          <div className="p-10 text-center" style={{ color: ui.faint }}>{t("没有匹配的用户。", "No matching users.")}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-left text-sm">
              <thead>
                <tr style={{ color: ui.faint }}>
                  <th className="p-3">{t("用户", "User")}</th>
                  <th className="p-3">{t("角色", "Role")}</th>
                  <th className="p-3">{t("会员", "Membership")}</th>
                  <th className="p-3">{t("状态", "Status")}</th>
                  <th className="p-3">{t("累计用量", "Usage")}</th>
                  <th className="p-3">{t("最近登录", "Last login")}</th>
                  <th className="p-3 text-right">{t("操作", "Actions")}</th>
                </tr>
              </thead>
              <tbody>
                {users.map((targetUser) => (
                  <tr key={targetUser.id} style={{ borderTop: `1px solid ${ui.line}`, color: ui.text }}>
                    <td className="p-3">
                      <p className="font-bold">{targetUser.name}</p>
                      {targetUser.username && <p className="mt-1 max-w-[250px] truncate text-xs" style={{ color: ui.primary }}>@{targetUser.username}</p>}
                      <p className="mt-1 max-w-[250px] truncate text-xs" style={{ color: ui.faint }}>{targetUser.email || targetUser.id}</p>
                      {targetUser.email && <p className="mt-0.5 max-w-[250px] truncate text-[10px]" style={{ color: ui.faint }}>{targetUser.id}</p>}
                      {targetUser.identitySubject && (
                        <p className="mt-0.5 max-w-[250px] truncate text-[10px]" style={{ color: ui.faint }}>
                          {targetUser.identityProvider || "OIDC"}: {targetUser.identitySubject}
                        </p>
                      )}
                    </td>
                    <td className="p-3 font-bold">{{ root: t("ROOT 管理员", "root"), admin: t("管理员", "admin"), user: t("用户", "user") }[targetUser.role] || targetUser.role}</td>
                    <td className="p-3">{{ free: t("免费版", "free"), basic: t("基础版", "basic"), pro: t("专业版", "pro"), max: t("高级版", "max"), enterprise: t("企业版", "enterprise") }[targetUser.membershipTier] || targetUser.membershipTier}</td>
                    <td className="p-3"><StatusBadge value={targetUser.accountStatus} ui={ui} t={t} /></td>
                    <td className="p-3">{Number(targetUser.usage || 0).toLocaleString(locale)}</td>
                    <td className="p-3 text-xs" style={{ color: ui.muted }}>{formatDateTime(targetUser.lastLoginAt, locale)}</td>
                    <td className="p-3 text-right">
                      {roleManagementOnly ? (
                        targetUser.role === "root" ? (
                          <span className="text-xs" style={{ color: ui.faint }}>{t("固定 root", "Fixed root")}</span>
                        ) : (
                          <button
                            type="button"
                            disabled={workingId === targetUser.id}
                            onClick={() => changeRole(targetUser, targetUser.role === "admin" ? "user" : "admin")}
                            className="rounded-lg px-3 py-1.5 text-xs font-bold disabled:opacity-50"
                            style={{ color: targetUser.role === "admin" ? ui.danger : ui.primary, background: targetUser.role === "admin" ? ui.dangerSoft : ui.primarySoft }}
                          >
                            {targetUser.role === "admin" ? t("撤销管理员", "Revoke admin") : t("设为管理员", "Make admin")}
                          </button>
                        )
                      ) : targetUser.role === "root" ? (
                        <span className="text-xs" style={{ color: ui.faint }}>{t("不可操作", "Protected")}</span>
                      ) : (
                        <div className="flex justify-end gap-2">
                          {targetUser.role === "user" && (
                            <button
                              type="button"
                              onClick={() => setModerationDraft((current) => ({ ...current, ownerUserId: targetUser.id }))}
                              className="rounded-lg px-3 py-1.5 text-xs font-bold"
                              style={{ color: ui.gold, background: ui.goldSoft }}
                            >
                              {t("内容处置", "Moderate content")}
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={workingId === targetUser.id}
                            onClick={() => changeAccountStatus(targetUser, targetUser.accountStatus === "active" ? "ban" : "unban")}
                            className="rounded-lg px-3 py-1.5 text-xs font-bold disabled:opacity-50"
                            style={{ color: targetUser.accountStatus === "active" ? ui.danger : ui.primary, background: targetUser.accountStatus === "active" ? ui.dangerSoft : ui.primarySoft }}
                          >
                            {targetUser.accountStatus === "active" ? t("封禁", "Ban") : t("解封", "Unban")}
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!loading && !error && total > 0 && (
          <div className="mt-5 flex items-center justify-between border-t pt-4" style={{ borderColor: ui.line, color: ui.faint }}>
            <span className="text-xs">{t(`共 ${total} 个用户`, `${total} users`)}</span>
            <div className="flex items-center gap-3">
              <button type="button" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))} className="rounded-lg px-3 py-1.5 text-xs font-bold disabled:opacity-40" style={{ background: ui.surfaceAlt, color: ui.muted }}>{t("上一页", "Previous")}</button>
              <span className="text-xs">{page} / {pageCount}</span>
              <button type="button" disabled={page >= pageCount} onClick={() => setPage((value) => Math.min(pageCount, value + 1))} className="rounded-lg px-3 py-1.5 text-xs font-bold disabled:opacity-40" style={{ background: ui.surfaceAlt, color: ui.muted }}>{t("下一页", "Next")}</button>
            </div>
          </div>
        )}
      </section>
    </main>
  );
};

export default AdminUsers;
