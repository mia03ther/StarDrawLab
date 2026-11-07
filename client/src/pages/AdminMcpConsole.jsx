import { useCallback, useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import useAuthAxios from "../hooks/useAuthAxios";
import { useAuthing } from "../contexts/AuthingContext";
import { useLanguage } from "../contexts/LanguageContext";
import { useStarDrawTheme } from "../utils/stardrawTheme";
import CanvasRoundedSelect from "../components/canvas/CanvasRoundedSelect";

const emptyServer = {
  serverKey: "",
  displayName: "",
  canonicalUrl: "",
  providerAdapter: "notion",
  transport: "streamable_http",
  allowedDomains: "",
  allowedScopes: "",
};

const emptyTool = {
  toolName: "",
  description: "",
  operationClass: "external_mcp",
  requiredRoles: "user,admin,root",
  approvalPolicy: "policy",
  inputSchema: "",
  enabled: false,
};

const Field = ({ label, value, onChange, type = "text", placeholder = "" }) => (
  <label className="block text-xs font-bold">
    <span className="mb-1.5 block" style={{ color: "inherit", opacity: 0.72 }}>{label}</span>
    <input type={type} value={value ?? ""} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} className="w-full rounded-xl px-3 py-2.5 text-sm outline-none" style={{ background: "var(--mcp-input-bg)", color: "inherit", border: "1px solid var(--mcp-input-line)" }} />
  </label>
);

const Select = ({ label, value, onChange, options, ui }) => (
  <label className="block text-xs font-bold">
    <span className="mb-1.5 block" style={{ opacity: 0.72 }}>{label}</span>
    <CanvasRoundedSelect label={label} value={value} onChange={onChange} options={options.map((option) => typeof option === "string" ? ({ value: option, label: option }) : option)} ui={ui} className="w-full" triggerClassName="h-10 w-full rounded-xl px-3 text-sm" style={{ background: "var(--mcp-input-bg)", borderColor: "var(--mcp-input-line)" }} menuMinWidth={240} />
  </label>
);

const splitList = (value) => [...new Set(String(value || "").split(",").map((item) => item.trim()).filter(Boolean))];

const mcpStatusLabel = (status, t) => ({ enabled: t("已启用", "enabled"), disabled: t("已停用", "disabled"), draft: t("草稿", "draft") }[status] || status || "—");
const approvalPolicyLabel = (policy, t) => ({ policy: t("按权限确认", "policy"), always: t("始终确认", "always") }[policy] || policy || "—");
const operationClassLabel = (value, t) => ({ external_mcp: t("外部 MCP", "external_mcp"), builtin: t("内置工具", "builtin") }[value] || value || "—");
const outcomeLabel = (value, t) => ({ succeeded: t("成功", "succeeded"), failed: t("失败", "failed"), pending: t("处理中", "pending") }[value] || value || "—");

const AdminMcpConsole = () => {
  const authAxios = useAuthAxios();
  const { isRoot } = useAuthing();
  const { t, locale } = useLanguage();
  const { ui } = useStarDrawTheme();
  const [servers, setServers] = useState([]);
  const [providers, setProviders] = useState([]);
  const [selectedKey, setSelectedKey] = useState("");
  const [serverDraft, setServerDraft] = useState(emptyServer);
  const [tools, setTools] = useState([]);
  const [toolDraft, setToolDraft] = useState(emptyTool);
  const [oauthDraft, setOauthDraft] = useState({ issuer: "", clientId: "", clientSecret: "", registrationMode: "manual" });
  const [audit, setAudit] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingTools, setLoadingTools] = useState(false);
  const [saving, setSaving] = useState(false);

  const serverEndpoint = isRoot ? "/api/root/mcp/servers" : "/api/admin/mcp/servers";
  const selectedServer = useMemo(() => servers.find((server) => server.serverKey === selectedKey) || null, [selectedKey, servers]);
  const providerOptions = useMemo(() => {
    const keys = providers
      .filter((provider) => provider.admission === "supported" || provider.providerAdapter === serverDraft.providerAdapter)
      .map((provider) => provider.providerAdapter);
    return [...new Set([...keys, serverDraft.providerAdapter || "generic_oauth21"])];
  }, [providers, serverDraft.providerAdapter]);

  const loadServers = useCallback(async () => {
    setLoading(true);
    try {
      const [{ data }, providerResponse] = await Promise.all([
        authAxios.get(serverEndpoint),
        authAxios.get(isRoot ? "/api/root/mcp/providers" : "/api/admin/mcp/providers"),
      ]);
      const rows = data?.data || [];
      setProviders(providerResponse.data?.data || []);
      setServers(rows);
      setSelectedKey((current) => current || rows[0]?.serverKey || "");
    } catch (error) {
      toast.error(error.response?.data?.message || t("MCP 服务配置加载失败", "Unable to load MCP configuration"));
    } finally {
      setLoading(false);
    }
  }, [authAxios, isRoot, serverEndpoint, t]);

  const loadTools = useCallback(async () => {
    if (!selectedKey) return setTools([]);
    setLoadingTools(true);
    try {
      const { data } = await authAxios.get(`/api/admin/mcp/servers/${encodeURIComponent(selectedKey)}/tools`);
      setTools(data?.data || []);
    } catch (error) {
      toast.error(error.response?.data?.message || t("工具白名单加载失败", "Unable to load tool allowlist"));
    } finally {
      setLoadingTools(false);
    }
  }, [authAxios, selectedKey, t]);

  const loadAudit = useCallback(async () => {
    if (!isRoot) return;
    try {
      const { data } = await authAxios.get("/api/root/mcp/audit", { params: { server_key: selectedKey || undefined, limit: 50 } });
      setAudit(data?.data || []);
    } catch (error) {
      toast.error(error.response?.data?.message || t("MCP 审计加载失败", "Unable to load MCP audit"));
    }
  }, [authAxios, isRoot, selectedKey, t]);

  useEffect(() => { void loadServers(); }, [loadServers]);
  useEffect(() => { void loadTools(); void loadAudit(); }, [loadAudit, loadTools]);

  const updateServerDraft = (key, value) => setServerDraft((current) => ({ ...current, [key]: value }));
  const updateToolDraft = (key, value) => setToolDraft((current) => ({ ...current, [key]: value }));

  const chooseServer = (server) => {
    setSelectedKey(server.serverKey);
    if (isRoot) setServerDraft({
      serverKey: server.serverKey,
      displayName: server.displayName || "",
      canonicalUrl: server.canonicalUrl || "",
      providerAdapter: server.providerAdapter || "notion",
      transport: server.transport || "streamable_http",
      allowedDomains: (server.allowedDomains || []).join(", "),
      allowedScopes: (server.oauthConfig?.allowedScopes || []).join(", "),
    });
  };

  const saveServer = async (event) => {
    event.preventDefault();
    if (!isRoot) return;
    setSaving(true);
    try {
      await authAxios.post("/api/root/mcp/servers", {
        serverKey: serverDraft.serverKey,
        displayName: serverDraft.displayName,
        canonicalUrl: serverDraft.canonicalUrl,
        providerAdapter: serverDraft.providerAdapter,
        transport: serverDraft.transport,
        allowedDomains: splitList(serverDraft.allowedDomains),
        status: selectedServer?.status || "draft",
        enabled: Boolean(selectedServer?.enabled),
        oauthConfig: { allowedScopes: splitList(serverDraft.allowedScopes) },
      });
      toast.success(t("MCP 服务已保存为草稿", "MCP server saved as draft"));
      await loadServers();
      setSelectedKey(serverDraft.serverKey.toLowerCase());
    } catch (error) {
      toast.error(error.response?.data?.message || t("MCP 服务保存失败", "Unable to save MCP server"));
    } finally {
      setSaving(false);
    }
  };

  const changeStatus = async () => {
    if (!isRoot || !selectedServer) return;
    const enabling = selectedServer.status !== "enabled" || !selectedServer.enabled;
    if (enabling && !window.confirm(t("确认启用这个 MCP 服务？启用后，管理员还需要单独启用工具。", "Enable this MCP server? An administrator must still enable individual tools."))) return;
    try {
      await authAxios.patch(`/api/root/mcp/servers/${encodeURIComponent(selectedServer.serverKey)}/status`, { status: enabling ? "enabled" : "disabled", enabled: enabling });
      toast.success(enabling ? t("服务已启用", "Server enabled") : t("服务已停用", "Server disabled"));
      await loadServers();
    } catch (error) {
      toast.error(error.response?.data?.message || t("状态更新失败", "Unable to update status"));
    }
  };

  const saveOAuthClient = async (event) => {
    event.preventDefault();
    if (!isRoot || !selectedKey) return;
    setSaving(true);
    try {
      await authAxios.post(`/api/root/mcp/servers/${encodeURIComponent(selectedKey)}/oauth-clients`, {
        issuer: oauthDraft.issuer,
        clientId: oauthDraft.clientId,
        clientSecret: oauthDraft.clientSecret || undefined,
        registrationMode: oauthDraft.registrationMode,
      });
      toast.success(t("OAuth client 配置已保存，Secret 不会回显。", "OAuth client saved; the secret is never displayed."));
      setOauthDraft((current) => ({ ...current, clientSecret: "" }));
    } catch (error) {
      toast.error(error.response?.data?.message || t("OAuth client 保存失败", "Unable to save OAuth client"));
    } finally {
      setSaving(false);
    }
  };

  const chooseTool = (tool) => setToolDraft({
    toolName: tool.toolName,
    description: tool.description || "",
    operationClass: tool.operationClass || "external_mcp",
    requiredRoles: (tool.requiredRoles || []).join(","),
    approvalPolicy: tool.approvalPolicy || "policy",
    inputSchema: tool.inputSchema ? JSON.stringify(tool.inputSchema, null, 2) : "",
    enabled: Boolean(tool.enabled),
  });

  const saveTool = async (event) => {
    event.preventDefault();
    if (!selectedKey) return toast.error(t("请先选择 MCP 服务", "Select an MCP server first"));
    let inputSchema = null;
    if (toolDraft.inputSchema.trim()) {
      try { inputSchema = JSON.parse(toolDraft.inputSchema); } catch { return toast.error(t("输入 schema 必须是有效 JSON", "Input schema must be valid JSON")); }
    }
    setSaving(true);
    try {
      await authAxios.put(`/api/admin/mcp/servers/${encodeURIComponent(selectedKey)}/tools/${encodeURIComponent(toolDraft.toolName)}`, {
        description: toolDraft.description,
        operationClass: toolDraft.operationClass,
        requiredRoles: splitList(toolDraft.requiredRoles),
        approvalPolicy: toolDraft.approvalPolicy,
        inputSchema,
        enabled: Boolean(toolDraft.enabled),
      });
      toast.success(t("工具白名单已保存", "Tool allowlist saved"));
      setToolDraft(emptyTool);
      await loadTools();
    } catch (error) {
      toast.error(error.response?.data?.message || t("工具保存失败", "Unable to save tool"));
    } finally {
      setSaving(false);
    }
  };

  const pageStyle = { "--mcp-input-bg": ui.surfaceAlt, "--mcp-input-line": ui.lineStrong, color: ui.text };

  return (
    <main className="mx-auto max-w-[1480px] p-6 md:p-8" style={pageStyle}>
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.24em]" style={{ color: ui.primary }}>{isRoot ? t("ROOT MCP 控制台", "ROOT MCP CONSOLE") : t("MCP 工具控制台", "MCP TOOL CONSOLE")}</p>
          <h1 className="mt-2 text-4xl font-black" style={{ color: ui.text }}>{t("MCP 运行时", "MCP Runtime")}</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6" style={{ color: ui.faint }}>{isRoot ? t("root 配置服务域名和 OAuth client；管理员负责选择可用工具。任何 Secret 都不会回传到浏览器。", "Root configures service endpoints and OAuth clients; administrators select allowed tools. Secrets are never returned to the browser.") : t("管理员只能管理 root 已登记的工具白名单，不能修改 MCP 服务域名或替代用户授权。", "Administrators can manage only the allowlisted tools registered by root. They cannot change endpoints or authorize on behalf of users.")}</p>
        </div>
        <button type="button" onClick={() => { void loadServers(); void loadTools(); void loadAudit(); }} className="rounded-xl px-4 py-2.5 text-sm font-black" style={{ background: ui.surface, color: ui.text, border: `1px solid ${ui.line}` }}>{t("刷新", "Refresh")}</button>
      </div>

      <div className="grid gap-6 xl:grid-cols-[0.8fr,1.2fr]">
        <section className="rounded-3xl p-5" style={{ background: ui.surface, border: `1px solid ${ui.line}`, boxShadow: ui.shadow }}>
          <div className="mb-4 flex items-center justify-between"><div><h2 className="text-lg font-black">{t("已登记服务", "Registered servers")}</h2><p className="mt-1 text-xs" style={{ color: ui.faint }}>{loading ? t("加载中…", "Loading…") : `${servers.length} ${t("项", "items")}`}</p></div><span className="material-symbols-outlined" style={{ color: ui.primary }}>hub</span></div>
          <div className="space-y-2">
            {servers.map((server) => <button key={server.serverKey} type="button" onClick={() => chooseServer(server)} className="flex w-full items-center justify-between gap-3 rounded-2xl p-3 text-left" style={{ background: server.serverKey === selectedKey ? ui.primarySoft : ui.surfaceAlt, border: `1px solid ${server.serverKey === selectedKey ? ui.primary : ui.line}` }}><span className="min-w-0"><span className="block truncate text-sm font-black">{server.displayName || server.serverKey}</span><span className="mt-1 block truncate text-[11px]" style={{ color: ui.faint }}>{server.serverKey} · {server.providerAdapter}</span><span className="mt-1 block truncate text-[10px]" style={{ color: server.capability?.admission === "catalog_pending" ? ui.gold : ui.faint }}>{server.capability?.admission === "catalog_pending" ? t("等待 provider 准入", "Provider admission pending") : t("当前版本支持", "Supported in this release")}</span></span><span className="shrink-0 rounded-full px-2 py-1 text-[9px] font-black" style={{ background: server.enabled ? "rgba(82,216,122,.13)" : ui.surface, color: server.enabled ? ui.success : ui.faint }}>{mcpStatusLabel(server.status, t)}</span></button>)}
            {servers.length === 0 && !loading && <div className="rounded-2xl p-7 text-center text-sm" style={{ background: ui.surfaceAlt, color: ui.faint }}>{t("尚未登记服务。", "No servers registered yet.")}</div>}
          </div>
        </section>

        <div className="space-y-6">
          {isRoot && <section className="rounded-3xl p-5" style={{ background: ui.surface, border: `1px solid ${ui.line}`, boxShadow: ui.shadow }}>
            <div className="mb-4 flex items-center justify-between"><div><h2 className="text-lg font-black">{t("root 服务配置", "Root server configuration")}</h2><p className="mt-1 text-xs" style={{ color: ui.faint }}>{t("保存后默认是草稿，启用需要单独确认。", "New records are drafts and require a separate enable action.")}</p></div>{selectedServer && <button type="button" onClick={changeStatus} className="rounded-lg px-3 py-2 text-xs font-black" style={{ background: selectedServer.enabled ? ui.dangerSoft : ui.primarySoft, color: selectedServer.enabled ? ui.danger : ui.primary }}>{selectedServer.enabled ? t("停用", "Disable") : t("启用", "Enable")}</button>}</div>
            <form onSubmit={saveServer} className="grid gap-3 md:grid-cols-2">
              <Field label="serverKey" value={serverDraft.serverKey} onChange={(value) => updateServerDraft("serverKey", value)} placeholder="notion" />
              <Field label={t("显示名称", "Display name")} value={serverDraft.displayName} onChange={(value) => updateServerDraft("displayName", value)} />
              <div className="md:col-span-2"><Field label="canonicalUrl" value={serverDraft.canonicalUrl} onChange={(value) => updateServerDraft("canonicalUrl", value)} placeholder="https://mcp.example.com/mcp" /></div>
              <Select ui={ui} label="providerAdapter" value={serverDraft.providerAdapter} onChange={(value) => updateServerDraft("providerAdapter", value)} options={providerOptions} />
              <Select ui={ui} label="transport" value={serverDraft.transport} onChange={(value) => updateServerDraft("transport", value)} options={["streamable_http", "sse"]} />
              <Field label={t("允许域名（逗号分隔）", "Allowed domains (comma separated)")} value={serverDraft.allowedDomains} onChange={(value) => updateServerDraft("allowedDomains", value)} placeholder="mcp.example.com" />
              <Field label={t("OAuth scopes（逗号分隔）", "OAuth scopes (comma separated)")} value={serverDraft.allowedScopes} onChange={(value) => updateServerDraft("allowedScopes", value)} placeholder="read" />
              <div className="md:col-span-2 flex justify-end"><button type="submit" disabled={saving} className="rounded-xl px-4 py-2.5 text-sm font-black disabled:opacity-50" style={{ background: ui.buttonGradient, color: ui.primaryText }}>{saving ? t("保存中…", "Saving…") : t("保存服务草稿", "Save server draft")}</button></div>
            </form>
          </section>}

          {isRoot && selectedKey && <section className="rounded-3xl p-5" style={{ background: ui.surface, border: `1px solid ${ui.line}`, boxShadow: ui.shadow }}>
            <div className="mb-4"><h2 className="text-lg font-black">{t("OAuth client 配置", "OAuth client configuration")}</h2><p className="mt-1 text-xs" style={{ color: ui.faint }}>{t("Secret 只会写入服务端密文，保存后输入框会清空。", "The secret is encrypted server-side and the input is cleared after saving.")}</p></div>
            <form onSubmit={saveOAuthClient} className="grid gap-3 md:grid-cols-2">
              <div className="md:col-span-2"><Field label="issuer" value={oauthDraft.issuer} onChange={(value) => setOauthDraft((current) => ({ ...current, issuer: value }))} placeholder="https://login.example.com/" /></div>
              <Field label="clientId" value={oauthDraft.clientId} onChange={(value) => setOauthDraft((current) => ({ ...current, clientId: value }))} />
              <Field label="clientSecret" type="password" value={oauthDraft.clientSecret} onChange={(value) => setOauthDraft((current) => ({ ...current, clientSecret: value }))} />
              <Select ui={ui} label={t("注册方式", "Registration mode")} value={oauthDraft.registrationMode} onChange={(value) => setOauthDraft((current) => ({ ...current, registrationMode: value }))} options={["manual", "pre_registered", "client_id_metadata", "dynamic_registration"]} />
              <div className="flex items-end justify-end"><button type="submit" disabled={saving} className="w-full rounded-xl px-4 py-2.5 text-sm font-black disabled:opacity-50" style={{ background: ui.primarySoft, color: ui.primary }}>{t("保存 OAuth client", "Save OAuth client")}</button></div>
            </form>
          </section>}

          <section className="rounded-3xl p-5" style={{ background: ui.surface, border: `1px solid ${ui.line}`, boxShadow: ui.shadow }}>
            <div className="mb-4 flex items-center justify-between"><div><h2 className="text-lg font-black">{t("工具白名单", "Tool allowlist")}</h2><p className="mt-1 text-xs" style={{ color: ui.faint }}>{selectedServer ? `${selectedServer.serverKey} · ${mcpStatusLabel(selectedServer.status, t)}` : t("选择一个 MCP 服务", "Select an MCP server")}</p>{selectedServer?.capability?.oauth?.scopeDefaults?.length > 0 && <p className="mt-1 text-[10px]" style={{ color: ui.faint }}>{t("Provider 默认 OAuth scope", "Provider default OAuth scope")}: {selectedServer.capability.oauth.scopeDefaults.join(", ")}</p>}</div><span className="rounded-full px-2.5 py-1 text-[10px] font-black" style={{ background: ui.primarySoft, color: ui.primary }}>{tools.length}</span></div>
            <div className="mb-5 max-h-56 space-y-2 overflow-auto">{loadingTools ? <p className="p-4 text-center text-xs" style={{ color: ui.faint }}>{t("加载工具中…", "Loading tools…")}</p> : tools.map((tool) => <button type="button" key={tool.toolName} onClick={() => chooseTool(tool)} className="flex w-full items-center justify-between gap-3 rounded-xl p-3 text-left" style={{ background: ui.surfaceAlt, border: `1px solid ${ui.line}` }}><span className="min-w-0"><span className="block truncate text-xs font-black">{tool.toolName}</span><span className="mt-1 block text-[10px]" style={{ color: ui.faint }}>{operationClassLabel(tool.operationClass, t)} · {approvalPolicyLabel(tool.approvalPolicy, t)}</span></span><span className="text-[10px] font-black" style={{ color: tool.enabled ? ui.success : ui.faint }}>{tool.enabled ? t("启用", "ON") : t("停用", "OFF")}</span></button>)}{!loadingTools && selectedKey && tools.length === 0 && <p className="p-4 text-center text-xs" style={{ color: ui.faint }}>{t("还没有工具记录。", "No tool records yet.")}</p>}</div>
            <form onSubmit={saveTool} className="grid gap-3 md:grid-cols-2">
              <Field label="toolName" value={toolDraft.toolName} onChange={(value) => updateToolDraft("toolName", value)} placeholder="pages.search" />
              <Select ui={ui} label={t("操作类别", "Operation class")} value={toolDraft.operationClass} onChange={(value) => updateToolDraft("operationClass", value)} options={["read", "creative", "reversible", "destructive", "publish", "external_mcp"]} />
              <div className="md:col-span-2"><Field label={t("描述", "Description")} value={toolDraft.description} onChange={(value) => updateToolDraft("description", value)} /></div>
              <Field label={t("允许角色（逗号分隔）", "Allowed roles (comma separated)")} value={toolDraft.requiredRoles} onChange={(value) => updateToolDraft("requiredRoles", value)} />
              <Select ui={ui} label={t("Agent 审批策略", "Agent approval policy")} value={toolDraft.approvalPolicy} onChange={(value) => updateToolDraft("approvalPolicy", value)} options={[{ value: "policy", label: t("按权限确认", "policy") }, { value: "always", label: t("始终确认", "always") }]} />
              <div className="md:col-span-2"><label className="block text-xs font-bold"><span className="mb-1.5 block" style={{ opacity: 0.72 }}>{t("输入 schema（可选 JSON）", "Input schema (optional JSON)")}</span><textarea rows={4} value={toolDraft.inputSchema} onChange={(event) => updateToolDraft("inputSchema", event.target.value)} className="w-full rounded-xl px-3 py-2.5 font-mono text-xs outline-none" style={{ background: ui.surfaceAlt, color: ui.text, border: `1px solid ${ui.lineStrong}` }} /></label></div>
              <label className="flex items-center gap-2 text-xs font-bold"><input type="checkbox" checked={toolDraft.enabled} onChange={(event) => updateToolDraft("enabled", event.target.checked)} />{t("启用此工具", "Enable this tool")}</label>
              <div className="flex justify-end"><button type="submit" disabled={saving || !selectedKey} className="rounded-xl px-4 py-2.5 text-sm font-black disabled:opacity-50" style={{ background: ui.buttonGradient, color: ui.primaryText }}>{saving ? t("保存中…", "Saving…") : t("保存工具", "Save tool")}</button></div>
            </form>
          </section>
        </div>
      </div>

      {isRoot && <section className="mt-6 rounded-3xl p-5" style={{ background: ui.surface, border: `1px solid ${ui.line}`, boxShadow: ui.shadow }}><div className="mb-4 flex items-center justify-between"><div><h2 className="text-lg font-black">{t("MCP 调用审计", "MCP call audit")}</h2><p className="mt-1 text-xs" style={{ color: ui.faint }}>{t("仅显示参数摘要，不显示参数原文或 Token。", "Only parameter digests are shown; raw arguments and tokens are never displayed.")}</p></div><button type="button" onClick={() => void loadAudit()} className="rounded-lg px-3 py-2 text-xs font-bold" style={{ background: ui.primarySoft, color: ui.primary }}>{t("刷新", "Refresh")}</button></div><div className="overflow-x-auto"><table className="w-full min-w-[900px] text-left text-xs"><thead><tr style={{ color: ui.faint }}><th className="p-3">{t("时间", "Time")}</th><th className="p-3">{t("用户", "User")}</th><th className="p-3">{t("服务 / 工具", "Server / tool")}</th><th className="p-3">{t("结果", "Outcome")}</th><th className="p-3">{t("错误", "Error")}</th></tr></thead><tbody>{audit.map((row, index) => <tr key={row.id || index} style={{ borderTop: `1px solid ${ui.line}` }}><td className="p-3 whitespace-nowrap">{new Date(row.created_at).toLocaleString(locale)}</td><td className="p-3 max-w-[180px] truncate">{row.user_id}</td><td className="p-3"><span className="font-bold">{row.server_key}</span><br /><span style={{ color: ui.faint }}>{row.tool_name}</span></td><td className="p-3 font-black" style={{ color: row.outcome === "succeeded" ? ui.success : row.outcome === "failed" ? ui.danger : ui.gold }}>{outcomeLabel(row.outcome, t)}</td><td className="p-3" style={{ color: ui.faint }}>{row.error_code || "—"}</td></tr>)}</tbody></table>{audit.length === 0 && <p className="p-6 text-center text-xs" style={{ color: ui.faint }}>{t("暂无调用审计记录。", "No MCP call audit records.")}</p>}</div></section>}
    </main>
  );
};

export default AdminMcpConsole;
