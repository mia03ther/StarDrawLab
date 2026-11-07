import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import toast from "react-hot-toast";
import { Copy, QrCode, Upload, Plus, Play, Camera, Trash2 } from "lucide-react";
import { v4 as uuidv4 } from "uuid";
import useAuthAxios from "../hooks/useAuthAxios";
import { useLanguage } from "../contexts/LanguageContext";
import { useStarDrawTheme } from "../utils/stardrawTheme";
import { OssImage, OssVideo } from "../components/OssMedia";

const createEmptyRole = () => ({
  role_name: "",
  role_description: "",
  prompt_text: "",
});

const DigitalHumanRoleStudio = () => {
  const navigate = useNavigate();
  const authAxios = useAuthAxios();
  const { t } = useLanguage();
  const { ui } = useStarDrawTheme();
  const [roles, setRoles] = useState([]);
  const [draft, setDraft] = useState(createEmptyRole());
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [uploadingKind, setUploadingKind] = useState(null);
  const [deletingRoleId, setDeletingRoleId] = useState(null);
  const portraitInputRef = useRef(null);
  const videoInputRef = useRef(null);

  const selectedRole = useMemo(() => roles.find((item) => String(item.id) === String(selectedId)) || roles[0] || null, [roles, selectedId]);
  const selectedCaptureUrl = useMemo(() => {
    if (!selectedRole?.capture_url) return "";
    if (/^https?:\/\//i.test(selectedRole.capture_url)) return selectedRole.capture_url;
    return `${window.location.origin}${selectedRole.capture_url.startsWith("/") ? "" : "/"}${selectedRole.capture_url}`;
  }, [selectedRole]);

  const loadRoles = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await authAxios.get("/api/digital-human/roles");
      const rows = Array.isArray(data?.data) ? data.data : [];
      setRoles(rows);
      setSelectedId((current) => {
        if (current && rows.some((item) => String(item.id) === String(current))) return current;
        return rows[0]?.id || null;
      });
    } catch (err) {
      toast.error(err.response?.data?.message || t("加载角色失败", "Failed to load roles"));
    } finally {
      setLoading(false);
    }
  }, [authAxios, t]);

  useEffect(() => {
    loadRoles();
  }, [loadRoles]);

  useEffect(() => {
    const hasPending = roles.some((role) => role.status === "collecting" || role.status === "training");
    if (!hasPending) return undefined;
    const timer = setInterval(() => {
      void loadRoles();
    }, 4000);
    return () => clearInterval(timer);
  }, [loadRoles, roles]);

  const createRole = async () => {
    if (!draft.role_name.trim()) {
      toast.error(t("请填写角色名称", "Enter a role name"));
      return;
    }
    setCreating(true);
    try {
      const { data } = await authAxios.post("/api/digital-human/roles", draft, {
        headers: { "X-Idempotency-Key": `role-${Date.now()}` },
      });
      const role = data?.data;
      if (role) {
        setRoles((prev) => [role, ...prev.filter((item) => String(item.id) !== String(role.id))]);
        setSelectedId(role.id);
        toast.success(t("角色已创建", "Role created"));
      }
      setDraft(createEmptyRole());
    } catch (err) {
      toast.error(err.response?.data?.message || t("创建失败", "Failed to create role"));
    } finally {
      setCreating(false);
    }
  };

  const handleUpload = async (event, roleId, kind) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !roleId) return;

    setUploadingKind(kind);
    try {
      const formData = new FormData();
      formData.append("asset", file);
      const { data } = await authAxios.post(`/api/digital-human/roles/${roleId}/assets`, formData, {
        headers: { "X-Role-Asset-Kind": kind },
      });
      const role = data?.data;
      if (role) {
        setRoles((prev) => [role, ...prev.filter((item) => String(item.id) !== String(role.id))]);
        setSelectedId(role.id);
        toast.success(kind === "video" ? t("演示视频已上传", "Demo video uploaded") : t("形象图片已上传", "Portrait uploaded"));
      }
    } catch (err) {
      if (err.response?.status === 413) {
        toast.error(t("素材过大，请压缩后上传，当前上限为 200MB", "Asset is too large. Compress it and keep it under 200MB."));
      } else {
        toast.error(err.response?.data?.message || t("上传失败", "Upload failed"));
      }
    } finally {
      setUploadingKind(null);
    }
  };

  const copyCaptureUrl = async () => {
    if (!selectedCaptureUrl) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(selectedCaptureUrl);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = selectedCaptureUrl;
        textarea.setAttribute("readonly", "true");
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      toast.success(t("二维码链接已复制", "Capture link copied"));
    } catch {
      toast.error(t("复制失败，请手动复制采集地址", "Copy failed. Copy the capture URL manually."));
    }
  };

  const deleteRole = async () => {
    if (!selectedRole) return;
    if (!window.confirm(t(
      "确定删除这个数字人角色？Free 用户会立即永久删除；会员角色会进入 14 天回收站。正在生成中使用的角色不能删除。",
      "Delete this digital-human role? Free accounts delete permanently; member roles go to the recycle bin for 14 days. Roles used by an active generation cannot be deleted.",
    ))) return;

    setDeletingRoleId(selectedRole.id);
    try {
      await authAxios.delete(`/api/digital-human/roles/${encodeURIComponent(selectedRole.id)}`, {
        headers: { "X-Idempotency-Key": uuidv4() },
        data: { reason: "Deleted from digital-human role studio" },
      });
      const nextRoles = roles.filter((role) => String(role.id) !== String(selectedRole.id));
      setRoles(nextRoles);
      setSelectedId(nextRoles[0]?.id || null);
      toast.success(t("角色已删除", "Role deleted"));
    } catch (err) {
      toast.error(err.response?.data?.message || t("角色删除失败", "Failed to delete role"));
    } finally {
      setDeletingRoleId(null);
    }
  };

  return (
    <div className="p-8 max-w-[1500px] mx-auto">
      <div className="mb-8 flex items-end justify-between gap-4">
        <div>
          <p className="text-[10px] uppercase tracking-[0.22em] font-black mb-2" style={{ color: ui.gold }}>{t("数字人角色库", "Digital Human Roles")}</p>
          <h2 className="text-4xl font-extrabold" style={{ color: ui.text, fontFamily: "Manrope, sans-serif" }}>{t("角色创建与采集", "Role creation and capture")}</h2>
        </div>
      </div>

      <div className="grid grid-cols-12 gap-6">
        <section className="col-span-12 xl:col-span-4 space-y-4">
          <div className="rounded-2xl p-5" style={{ background: ui.surface, border: `1px solid ${ui.line}` }}>
            <div className="flex items-center gap-2 mb-4"><Plus size={16} /><span className="text-sm font-bold">{t("新建角色", "New Role")}</span></div>
            <input value={draft.role_name} onChange={(e) => setDraft((prev) => ({ ...prev, role_name: e.target.value }))} className="w-full rounded-xl px-3 py-2 mb-3 text-sm" placeholder={t("角色名称", "Role name")} style={{ background: ui.surfaceAlt, color: ui.text, border: `1px solid ${ui.line}` }} />
            <textarea value={draft.role_description} onChange={(e) => setDraft((prev) => ({ ...prev, role_description: e.target.value }))} rows={3} className="w-full rounded-xl px-3 py-2 mb-3 text-sm resize-none" placeholder={t("角色描述", "Role description")} style={{ background: ui.surfaceAlt, color: ui.text, border: `1px solid ${ui.line}` }} />
            <textarea value={draft.prompt_text} onChange={(e) => setDraft((prev) => ({ ...prev, prompt_text: e.target.value }))} rows={4} className="w-full rounded-xl px-3 py-2 mb-3 text-sm resize-none" placeholder={t("提示词/口播说明", "Prompt / script notes")} style={{ background: ui.surfaceAlt, color: ui.text, border: `1px solid ${ui.line}` }} />
            <button type="button" onClick={createRole} disabled={creating} className="w-full rounded-xl py-3 font-bold flex items-center justify-center gap-2" style={{ background: ui.buttonGradient, color: ui.primaryText }}>
              <Camera size={16} />{creating ? t("创建中…", "Creating…") : t("创建角色", "Create Role")}
            </button>
          </div>

          <div className="rounded-2xl p-5" style={{ background: ui.surface, border: `1px solid ${ui.line}` }}>
            <div className="flex items-center gap-2 mb-4"><QrCode size={16} /><span className="text-sm font-bold">{t("角色列表", "Role list")}</span></div>
            <div className="space-y-2 max-h-[520px] overflow-y-auto pr-1">
              {loading ? <div className="text-sm" style={{ color: ui.faint }}>{t("加载中…", "Loading…")}</div> : roles.map((role) => (
                <button key={role.id} type="button" onClick={() => setSelectedId(role.id)} className="w-full text-left rounded-xl p-3" style={{ background: String(selectedRole?.id) === String(role.id) ? ui.surfaceHigh : ui.surfaceAlt, border: `1px solid ${String(selectedRole?.id) === String(role.id) ? ui.gold : ui.line}` }}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-bold truncate" style={{ color: ui.text }}>{role.role_name}</p>
                      <p className="text-[11px] mt-1" style={{ color: ui.faint }}>
                        {role.status === "ready" ? t("可用", "Ready") : role.status === "training" ? t("形象创建中", "Training") : t("等待采集", "Collecting")}
                      </p>
                    </div>
                    <span className="text-[10px] px-2 py-1 rounded-full" style={{ background: ui.goldSoft, color: ui.gold }}>{role.id}</span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="col-span-12 xl:col-span-8 space-y-4">
          <div className="rounded-2xl p-5" style={{ background: ui.surface, border: `1px solid ${ui.line}` }}>
            <div className="flex items-center justify-between mb-4">
              <div>
                <p className="text-[10px] uppercase tracking-widest" style={{ color: ui.faint }}>{t("采集入口", "Capture entry")}</p>
                <h3 className="text-xl font-black" style={{ color: ui.text }}>{selectedRole?.role_name || t("请选择一个角色", "Choose a role")}</h3>
              </div>
              <div className="flex items-center gap-2">
                <button type="button" onClick={copyCaptureUrl} className="rounded-xl px-3 py-2 text-sm font-bold flex items-center gap-2" style={{ background: ui.surfaceAlt, color: ui.text, border: `1px solid ${ui.line}` }}>
                  <Copy size={14} />{t("复制链接", "Copy link")}
                </button>
                <button type="button" onClick={() => navigate("/ai/digital-human")} className="rounded-xl px-3 py-2 text-sm font-bold" style={{ background: ui.primarySoft, color: ui.primary, border: `1px solid ${ui.line}` }}>
                  {t("去生成", "Generate")}
                </button>
                <button
                  type="button"
                  onClick={deleteRole}
                  disabled={!selectedRole || String(deletingRoleId) === String(selectedRole?.id)}
                  className="rounded-xl px-3 py-2 text-sm font-bold flex items-center gap-2 disabled:opacity-50"
                  style={{ background: ui.dangerSoft, color: ui.danger, border: `1px solid ${ui.danger}44` }}
                >
                  <Trash2 size={14} />
                  {String(deletingRoleId) === String(selectedRole?.id) ? t("删除中…", "Deleting…") : t("删除角色", "Delete role")}
                </button>
              </div>
            </div>

            {selectedRole ? (
              <div className="grid grid-cols-12 gap-4">
                <div className="col-span-12 md:col-span-5 rounded-2xl p-4" style={{ background: ui.surfaceAlt, border: `1px solid ${ui.line}` }}>
                  <p className="text-xs font-bold mb-3" style={{ color: ui.faint }}>{t("二维码", "QR code")}</p>
                  <img
                    src={`https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(selectedCaptureUrl)}`}
                    alt="qr"
                    className="w-full rounded-xl"
                    style={{ background: "#fff" }}
                  />
                </div>
                <div className="col-span-12 md:col-span-7 space-y-3">
                  <div className="rounded-2xl p-4" style={{ background: ui.surfaceAlt, border: `1px solid ${ui.line}` }}>
                    <p className="text-xs font-bold mb-2" style={{ color: ui.faint }}>{t("角色说明", "Role description")}</p>
                    <p className="text-sm" style={{ color: ui.text }}>{selectedRole.role_description || t("未填写", "Empty")}</p>
                  </div>
                  <div className="rounded-2xl overflow-hidden" style={{ background: ui.surfaceAlt, border: `1px solid ${ui.line}` }}>
                    {selectedRole.avatar_url ? (
                      <OssImage src={selectedRole.avatar_url} alt="" className="w-full max-h-[260px] object-cover" />
                    ) : (
                      <div className="h-[180px] flex flex-col items-center justify-center" style={{ color: ui.faint }}>
                        <span className="material-symbols-outlined text-5xl">portrait</span>
                        <p className="text-sm mt-2">{t("暂无形象图片", "No portrait yet")}</p>
                      </div>
                    )}
                  </div>
                  {selectedRole.demo_video_url && (
                    <div className="rounded-2xl overflow-hidden" style={{ background: ui.surfaceAlt, border: `1px solid ${ui.line}` }}>
                      <div className="px-4 py-3 flex items-center justify-between" style={{ borderBottom: `1px solid ${ui.line}` }}>
                        <p className="text-xs font-bold" style={{ color: ui.faint }}>{t("演示视频预览", "Demo video preview")}</p>
                        <span className="material-symbols-outlined text-base" style={{ color: ui.primary }}>play_circle</span>
                      </div>
                      <div className="aspect-video" style={{ background: ui.surface }}>
                        <OssVideo
                          key={selectedRole.demo_video_url}
                          src={selectedRole.demo_video_url}
                          poster={selectedRole.avatar_url || undefined}
                          controls
                          playsInline
                          preload="metadata"
                          className="w-full h-full object-contain"
                          onError={() => toast.error(t("视频预览加载失败，请确认视频为浏览器可播放格式", "Video preview failed. Use a browser-playable video format."))}
                        />
                      </div>
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      type="button"
                      onClick={() => portraitInputRef.current?.click()}
                      disabled={Boolean(uploadingKind)}
                      className="rounded-2xl p-4 text-sm cursor-pointer text-left disabled:cursor-not-allowed"
                      style={{ background: ui.surfaceAlt, border: `1px solid ${ui.line}`, opacity: uploadingKind ? 0.55 : 1 }}
                    >
                      <Upload size={15} className="inline mr-2" />{uploadingKind === "image" ? t("上传中…", "Uploading…") : t("上传形象图", "Upload portrait")}
                    </button>
                    <button
                      type="button"
                      onClick={() => videoInputRef.current?.click()}
                      disabled={Boolean(uploadingKind)}
                      className="rounded-2xl p-4 text-sm cursor-pointer text-left disabled:cursor-not-allowed"
                      style={{ background: ui.surfaceAlt, border: `1px solid ${ui.line}`, opacity: uploadingKind ? 0.55 : 1 }}
                    >
                      <Play size={15} className="inline mr-2" />{uploadingKind === "video" ? t("上传中…", "Uploading…") : t("上传演示视频", "Upload demo video")}
                    </button>
                    <input ref={portraitInputRef} className="sr-only" type="file" accept="image/*" onChange={(e) => handleUpload(e, selectedRole.id, "image")} />
                    <input ref={videoInputRef} className="sr-only" type="file" accept="video/*,.mp4,.webm,.mov,.m4v" onChange={(e) => handleUpload(e, selectedRole.id, "video")} />
                  </div>
                  <div className="rounded-2xl p-4" style={{ background: ui.surfaceAlt, border: `1px solid ${ui.line}` }}>
                    <p className="text-xs font-bold mb-2" style={{ color: ui.faint }}>{t("采集地址", "Capture URL")}</p>
                    <p className="text-sm break-all" style={{ color: ui.text }}>{selectedCaptureUrl}</p>
                  </div>
                  <div className="rounded-2xl p-4" style={{ background: ui.surfaceAlt, border: `1px solid ${ui.line}` }}>
                    <p className="text-xs font-bold mb-2" style={{ color: ui.faint }}>{t("当前状态", "Current status")}</p>
                    <p className="text-sm font-bold" style={{ color: ui.text }}>
                      {selectedRole.status === "ready" ? t("可用", "Ready") : selectedRole.status === "training" ? t("形象创建中", "Training") : t("等待手机采集", "Waiting for mobile capture")}
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="rounded-2xl p-8 text-center" style={{ background: ui.surfaceAlt, color: ui.faint }}>
                {t("先新建一个角色。", "Create a role first.")}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
};

export default DigitalHumanRoleStudio;
