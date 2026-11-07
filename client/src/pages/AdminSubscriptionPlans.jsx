import { useCallback, useEffect, useState } from "react";
import toast from "react-hot-toast";
import { Trash2 } from "lucide-react";
import { v4 as uuidv4 } from "uuid";
import useAuthAxios from "../hooks/useAuthAxios";
import { useLanguage } from "../contexts/LanguageContext";
import { useStarDrawTheme } from "../utils/stardrawTheme";
import CanvasRoundedSelect from "../components/canvas/CanvasRoundedSelect";

const emptyPlan = () => ({
  id: null,
  plan_key: "",
  plan_name: "",
  membership_tier: "basic",
  billing_interval: "month",
  price_cents: 0,
  included_points: 0,
  bonus_points: 0,
  monthly_bonus_points: 0,
  is_active: false,
  display_order: 0,
});

const emptyPointPackage = () => ({
  id: null,
  package_key: "",
  package_name: "",
  description: "",
  price_cents: 0,
  points: 0,
  bonus_points: 0,
  is_active: false,
  display_order: 0,
});

const AdminSubscriptionPlans = () => {
  const authAxios = useAuthAxios();
  const { t } = useLanguage();
  const { ui } = useStarDrawTheme();
  const [mode, setMode] = useState("points");
  const [plans, setPlans] = useState([]);
  const [pointPackages, setPointPackages] = useState([]);
  const [planDraft, setPlanDraft] = useState(emptyPlan);
  const [pointDraft, setPointDraft] = useState(emptyPointPackage);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const [planResponse, pointResponse] = await Promise.all([
      authAxios.get("/api/admin/subscriptions/plans"),
      authAxios.get("/api/admin/subscriptions/point-packages"),
    ]);
    setPlans(planResponse.data?.data || []);
    setPointPackages(pointResponse.data?.data || []);
  }, [authAxios]);

  useEffect(() => {
    load().catch((error) => toast.error(error.response?.data?.message || t("商品加载失败", "Failed to load products"))).finally(() => setLoading(false));
  }, [load, t]);

  const draft = mode === "points" ? pointDraft : planDraft;
  const update = (key, value) => {
    if (mode === "points") setPointDraft((current) => ({ ...current, [key]: value }));
    else setPlanDraft((current) => ({ ...current, [key]: value }));
  };

  const resetDraft = () => {
    if (mode === "points") setPointDraft(emptyPointPackage());
    else setPlanDraft(emptyPlan());
  };

  const save = async () => {
    const key = mode === "points" ? pointDraft.package_key : planDraft.plan_key;
    const name = mode === "points" ? pointDraft.package_name : planDraft.plan_name;
    if (!String(key).trim() || !String(name).trim()) {
      toast.error(t("商品键和名称不能为空", "Product key and name are required"));
      return;
    }
    setSaving(true);
    try {
      if (mode === "points") {
        const payload = {
          ...pointDraft,
          price_cents: Number(pointDraft.price_cents),
          points: Number(pointDraft.points),
          bonus_points: Number(pointDraft.bonus_points),
          display_order: Number(pointDraft.display_order),
        };
        const path = pointDraft.id
          ? `/api/admin/subscriptions/point-packages/${pointDraft.id}`
          : "/api/admin/subscriptions/point-packages";
        await authAxios.request({ method: pointDraft.id ? "put" : "post", url: path, data: payload, headers: { "X-Idempotency-Key": uuidv4() } });
        setPointDraft(emptyPointPackage());
      } else {
        const payload = {
          ...planDraft,
          price_cents: Number(planDraft.price_cents),
          included_points: Number(planDraft.included_points),
          bonus_points: Number(planDraft.bonus_points),
          monthly_bonus_points: Number(planDraft.monthly_bonus_points),
          display_order: Number(planDraft.display_order),
        };
        const path = planDraft.id
          ? `/api/admin/subscriptions/plans/${planDraft.id}`
          : "/api/admin/subscriptions/plans";
        await authAxios.request({ method: planDraft.id ? "put" : "post", url: path, data: payload, headers: { "X-Idempotency-Key": uuidv4() } });
        setPlanDraft(emptyPlan());
      }
      await load();
      toast.success(t("商品已保存", "Product saved"));
    } catch (error) {
      toast.error(error.response?.data?.message || t("商品保存失败", "Failed to save product"));
    } finally {
      setSaving(false);
    }
  };

  const deactivate = async (item) => {
    const name = mode === "points" ? item.package_name : item.plan_name;
    if (!window.confirm(t(`删除 ${name}？历史订单不受影响，已支付订单仍按原快照保留。`, `Delete ${name}? Historical orders are unaffected and paid orders keep their original snapshot.`))) return;
    const path = mode === "points"
      ? `/api/admin/subscriptions/point-packages/${item.id}`
      : `/api/admin/subscriptions/plans/${item.id}`;
    try {
      await authAxios.delete(path, { headers: { "X-Idempotency-Key": uuidv4() } });
      await load();
      toast.success(t("商品已删除", "Product deleted"));
    } catch (error) {
      toast.error(error.response?.data?.message || t("停用失败", "Failed to deactivate product"));
    }
  };

  const field = (key, label, type = "text") => (
    <label className="block" key={key}>
      <span className="mb-2 block text-[10px] font-bold uppercase tracking-widest" style={{ color: ui.faint }}>{label}</span>
      <input type={type} value={draft[key] ?? ""} onChange={(event) => update(key, event.target.value)}
        className="w-full rounded-lg px-3 py-2.5 outline-none" style={{ background: ui.surfaceAlt, color: ui.text, border: `1px solid ${ui.lineStrong}` }} />
    </label>
  );

  const items = mode === "points" ? pointPackages : plans;

  return (
    <main className="mx-auto max-w-[1480px] p-8">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.24em]" style={{ color: ui.primary }}>{t("管理员后台", "Admin Console")}</p>
          <h1 className="mt-2 text-4xl font-black" style={{ color: ui.text }}>{t("积分与会员商品", "Points & Membership Products")}</h1>
          <p className="mt-2 text-sm" style={{ color: ui.faint }}>{t("管理员独立配置长期积分包和会员订阅；编辑不会改写历史订单快照。", "Manage long-term point packages and memberships independently; edits never rewrite historical orders.")}</p>
        </div>
        <button type="button" onClick={resetDraft} className="rounded-lg px-4 py-2 text-sm font-bold" style={{ background: ui.surface, color: ui.primary, border: `1px solid ${ui.line}` }}>
          {mode === "points" ? t("新建积分包", "New point package") : t("新建订阅", "New subscription")}
        </button>
      </div>

      <div className="mb-6 flex rounded-lg p-1" style={{ background: ui.surfaceAlt, border: `1px solid ${ui.line}` }}>
        {[["points", t("长期积分包", "Long-term points"), "toll"], ["subscriptions", t("会员订阅", "Membership subscriptions"), "workspace_premium"]].map(([key, label, icon]) => (
          <button type="button" key={key} onClick={() => setMode(key)} className="flex flex-1 items-center justify-center gap-2 rounded-lg px-4 py-3 text-sm font-black"
            style={{ background: mode === key ? ui.primary : "transparent", color: mode === key ? ui.primaryText : ui.faint }}>
            <span className="material-symbols-outlined text-lg">{icon}</span>{label}
          </button>
        ))}
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.3fr,0.7fr]">
        <section className="rounded-lg p-5" style={{ background: ui.surface, border: `1px solid ${ui.line}`, boxShadow: ui.shadow }}>
          {loading ? <p style={{ color: ui.faint }}>{t("加载中…", "Loading…")}</p> : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead><tr style={{ color: ui.faint }}><th className="p-3">{t("商品", "Product")}</th><th className="p-3">{mode === "points" ? t("积分数量", "Point amount") : t("等级", "Tier")}</th><th className="p-3">{mode === "points" ? t("有效期", "Expiry") : t("周期", "Cycle")}</th><th className="p-3">{t("价格", "Price")}</th><th className="p-3">{t("状态", "Status")}</th><th className="p-3" /></tr></thead>
                <tbody>{items.map((item) => {
                  const name = mode === "points" ? item.package_name : item.plan_name;
                  const key = mode === "points" ? item.package_key : item.plan_key;
                  return (
                    <tr key={`${mode}:${item.id}`} style={{ borderTop: `1px solid ${ui.line}`, color: ui.text }}>
                      <td className="p-3"><p className="font-bold">{name}</p><p className="text-xs" style={{ color: ui.faint }}>{key}</p></td>
                      <td className="p-3">{mode === "points" ? Number(item.points || 0) + Number(item.bonus_points || 0) : ({ basic: t("基础版", "basic"), pro: t("专业版", "pro"), max: t("高级版", "max"), enterprise: t("企业版", "enterprise") }[item.membership_tier] || item.membership_tier)}</td>
                      <td className="p-3">{mode === "points" ? t("长期", "Long-term") : ({ month: t("月", "month"), year: t("年", "year") }[item.billing_interval] || item.billing_interval)}</td>
                      <td className="p-3">¥{(Number(item.price_cents) / 100).toFixed(2)}</td>
                      <td className="p-3">{item.is_active ? t("启用", "Active") : t("停用", "Inactive")}</td>
                      <td className="p-3 text-right"><button type="button" onClick={() => mode === "points" ? setPointDraft(item) : setPlanDraft(item)} className="mr-2 rounded-lg px-2 py-1 text-xs font-bold" style={{ color: ui.primary, background: ui.primarySoft }}>{t("编辑", "Edit")}</button>{item.is_active && <button type="button" onClick={() => deactivate(item)} title={mode === "points" ? t("删除积分套餐", "Delete point package") : t("删除会员套餐", "Delete membership plan")} aria-label={mode === "points" ? t("删除积分套餐", "Delete point package") : t("删除会员套餐", "Delete membership plan")} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-bold" style={{ color: ui.danger, background: `${ui.danger}18` }}><Trash2 size={13} />{t("删除", "Delete")}</button>}</td>
                    </tr>
                  );
                })}</tbody>
              </table>
            </div>
          )}
        </section>

        <section className="rounded-lg p-5" style={{ background: ui.surface, border: `1px solid ${ui.line}`, boxShadow: ui.shadow }}>
          <div className="mb-5 flex items-center justify-between"><h2 className="text-xl font-black" style={{ color: ui.text }}>{draft.id ? t("编辑商品", "Edit product") : t("新建商品", "New product")}</h2><span className="text-xs" style={{ color: ui.faint }}>{t("人民币（分）", "CNY cents")}</span></div>
          <div className="space-y-4">
            {mode === "points" ? (
              <>
                {field("package_key", t("套餐键", "Package key"))}{field("package_name", t("套餐名称", "Package name"))}
                <label className="block"><span className="mb-2 block text-[10px] font-bold uppercase tracking-widest" style={{ color: ui.faint }}>{t("描述", "Description")}</span><textarea value={draft.description || ""} onChange={(event) => update("description", event.target.value)} rows={3} className="w-full resize-none rounded-lg px-3 py-2.5 outline-none" style={{ background: ui.surfaceAlt, color: ui.text, border: `1px solid ${ui.lineStrong}` }} /></label>
                <div className="grid grid-cols-2 gap-3">{field("price_cents", t("价格（分）", "Price (cents)"), "number")}{field("display_order", t("显示顺序", "Display order"), "number")}</div>
                <div className="grid grid-cols-2 gap-3">{field("points", t("购买积分", "Purchased pts"), "number")}{field("bonus_points", t("赠送积分", "Bonus pts"), "number")}</div>
                <p className="rounded-lg px-3 py-2 text-xs" style={{ background: ui.surfaceAlt, color: ui.faint, border: `1px solid ${ui.line}` }}>{t("购买后不改变会员等级；当前积分长期有效。", "Does not change membership tier; points are currently long-term.")}</p>
              </>
            ) : (
              <>
                {field("plan_key", t("订阅键", "Plan key"))}{field("plan_name", t("订阅名称", "Plan name"))}
                <div className="grid grid-cols-2 gap-3"><label className="block"><span className="mb-2 block text-[10px] font-bold uppercase tracking-widest" style={{ color: ui.faint }}>{t("会员等级", "Tier")}</span><CanvasRoundedSelect label={t("会员等级", "Tier")} value={draft.membership_tier} onChange={(value) => update("membership_tier", value)} options={["basic", "pro", "max", "enterprise"].map((value) => ({ value, label: t({ basic: "基础版", pro: "专业版", max: "高级版", enterprise: "企业版" }[value], value) }))} ui={ui} className="w-full" triggerClassName="h-10 w-full rounded-lg px-3 text-sm" menuMinWidth={180} /></label><label className="block"><span className="mb-2 block text-[10px] font-bold uppercase tracking-widest" style={{ color: ui.faint }}>{t("计费周期", "Interval")}</span><CanvasRoundedSelect label={t("计费周期", "Interval")} value={draft.billing_interval} onChange={(value) => update("billing_interval", value)} options={[{ value: "month", label: t("月", "month") }, { value: "year", label: t("年", "year") }]} ui={ui} className="w-full" triggerClassName="h-10 w-full rounded-lg px-3 text-sm" menuMinWidth={150} /></label></div>
                <div className="grid grid-cols-2 gap-3">{field("price_cents", t("价格（分）", "Price (cents)"), "number")}{field("display_order", t("显示顺序", "Display order"), "number")}</div>
                <div className="grid grid-cols-3 gap-3">{field("included_points", t("包含积分", "Purchased pts"), "number")}{field("bonus_points", t("赠送积分", "Bonus pts"), "number")}{field("monthly_bonus_points", t("每月积分", "Monthly pts"), "number")}</div>
              </>
            )}
            <label className="flex items-center justify-between rounded-lg px-3 py-3" style={{ background: ui.surfaceAlt, border: `1px solid ${ui.line}` }}><span className="text-sm font-bold" style={{ color: ui.text }}>{t("对用户开放", "Visible to customers")}</span><input type="checkbox" checked={Boolean(draft.is_active)} onChange={(event) => update("is_active", event.target.checked)} /></label>
            <button type="button" disabled={saving} onClick={save} className="w-full rounded-lg py-3 text-sm font-black disabled:opacity-60" style={{ background: ui.buttonGradient, color: ui.primaryText }}>{saving ? t("保存中…", "Saving…") : t("保存商品", "Save product")}</button>
          </div>
        </section>
      </div>
    </main>
  );
};

export default AdminSubscriptionPlans;
