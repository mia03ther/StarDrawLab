import { useCallback, useEffect, useMemo, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import toast from "react-hot-toast";
import useAuthAxios from "../hooks/useAuthAxios";
import { useAuthing } from "../contexts/AuthingContext";
import { useLanguage } from "../contexts/LanguageContext";
import { useStarDrawTheme } from "../utils/stardrawTheme";

const TIER_LABELS = {
  basic: ["Basic", "基础版"],
  pro: ["Pro", "专业版"],
  max: ["Max", "Max 版"],
  enterprise: ["Enterprise", "企业版"],
};

const formatMoney = (cents) => `¥${(Number(cents || 0) / 100).toFixed(2)}`;
const formatPoints = (value) => Number(value || 0).toLocaleString();
const formatDate = (value, isZh) => value
  ? new Intl.DateTimeFormat(isZh ? "zh-CN" : "en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value))
  : "—";

const PlanCard = ({ plan, recommended, onBuy, buying, t, isZh, ui }) => {
  const tier = TIER_LABELS[plan.membership_tier] || [plan.membership_tier, plan.membership_tier];
  const totalPoints = Number(plan.included_points || 0) + Number(plan.bonus_points || 0);

  return (
    <article className="relative flex flex-col rounded-3xl p-6 transition-transform hover:-translate-y-1"
      style={{
        background: recommended ? ui.surfaceHigh : ui.surface,
        border: `1px solid ${recommended ? ui.primary : ui.line}`,
        boxShadow: recommended ? "0 18px 50px rgba(197,107,35,0.18)" : ui.shadow,
      }}>
      {recommended && (
        <span className="absolute -top-3 left-6 rounded-full px-3 py-1 text-[10px] font-black uppercase tracking-widest"
          style={{ background: ui.primary, color: ui.primaryText }}>
          {t("推荐", "Recommended")}
        </span>
      )}
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.22em]" style={{ color: ui.primary }}>
            {isZh ? tier[1] : tier[0]}
          </p>
          <h3 className="mt-2 text-xl font-black" style={{ color: ui.text, fontFamily: "Manrope, sans-serif" }}>
            {plan.plan_name}
          </h3>
        </div>
        <span className="material-symbols-outlined text-3xl" style={{ color: recommended ? ui.gold : ui.faint }}>
          {plan.membership_tier === "enterprise" ? "corporate_fare" : "workspace_premium"}
        </span>
      </div>

      <div className="mt-6 flex items-baseline gap-2">
        <span className="text-4xl font-black" style={{ color: ui.primary, fontFamily: "Manrope, sans-serif" }}>
          {formatMoney(plan.price_cents)}
        </span>
        <span className="text-xs" style={{ color: ui.faint }}>
          / {plan.billing_interval === "year" ? t("年", "year") : t("月", "month")}
        </span>
      </div>

      <div className="mt-5 rounded-2xl p-4" style={{ background: ui.surfaceAlt, border: `1px solid ${ui.line}` }}>
        <p className="text-2xl font-black" style={{ color: ui.text, fontFamily: "Manrope, sans-serif" }}>
          {formatPoints(totalPoints)} <span className="text-xs font-bold" style={{ color: ui.faint }}>{t("积分", "pts")}</span>
        </p>
        <p className="mt-1 text-xs" style={{ color: ui.faint }}>
          {t(`每月赠送 ${formatPoints(plan.monthly_bonus_points)} 积分`, `${formatPoints(plan.monthly_bonus_points)} monthly bonus pts`)}
        </p>
      </div>

      <ul className="mt-6 flex-1 space-y-3 text-sm" style={{ color: ui.text }}>
        <li className="flex gap-2"><span className="material-symbols-outlined text-base" style={{ color: ui.primary }}>check_circle</span>{t("模板使用不消耗积分", "Templates do not consume points")}</li>
        <li className="flex gap-2"><span className="material-symbols-outlined text-base" style={{ color: ui.primary }}>check_circle</span>{t("生成服务按次原子扣费", "Generation is charged atomically per task")}</li>
        <li className="flex gap-2"><span className="material-symbols-outlined text-base" style={{ color: ui.primary }}>check_circle</span>{t("到期前两天邮件提醒主动续费", "Manual renewal reminder two days before expiry")}</li>
      </ul>

      <button type="button" disabled={buying} onClick={() => onBuy(plan)}
        className="mt-7 w-full rounded-2xl py-3.5 text-sm font-black transition-transform active:scale-95 disabled:opacity-50"
        style={{ background: recommended ? ui.buttonGradient : ui.surfaceHigh, color: recommended ? ui.primaryText : ui.text, border: `1px solid ${ui.lineStrong}` }}>
        {buying ? t("正在创建订单…", "Creating order…") : t("订阅此套餐", "Subscribe")}
      </button>
    </article>
  );
};

const PointPackageCard = ({ pointPackage, onBuy, buying, t, ui }) => {
  const totalPoints = Number(pointPackage.total_points)
    || Number(pointPackage.points || 0) + Number(pointPackage.bonus_points || 0);
  return (
    <article className="flex flex-col rounded-3xl p-6 transition-transform hover:-translate-y-1"
      style={{ background: ui.surface, border: `1px solid ${ui.line}`, boxShadow: ui.shadow }}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.22em]" style={{ color: ui.primary }}>{t("长期有效", "Long-term validity")}</p>
          <h3 className="mt-2 text-xl font-black" style={{ color: ui.text, fontFamily: "Manrope, sans-serif" }}>{pointPackage.package_name}</h3>
        </div>
        <span className="material-symbols-outlined text-3xl" style={{ color: ui.gold }}>toll</span>
      </div>
      <div className="mt-6 flex items-baseline gap-2">
        <span className="text-4xl font-black" style={{ color: ui.primary, fontFamily: "Manrope, sans-serif" }}>{formatMoney(pointPackage.price_cents)}</span>
        <span className="text-xs" style={{ color: ui.faint }}>{t("一次性购买", "one-time")}</span>
      </div>
      <div className="mt-5 rounded-2xl p-4" style={{ background: ui.surfaceAlt, border: `1px solid ${ui.line}` }}>
        <p className="text-2xl font-black" style={{ color: ui.text }}>{formatPoints(totalPoints)} <span className="text-xs font-bold" style={{ color: ui.faint }}>{t("积分", "pts")}</span></p>
        {Number(pointPackage.bonus_points || 0) > 0 && <p className="mt-1 text-xs" style={{ color: ui.gold }}>{t(`含赠送 ${formatPoints(pointPackage.bonus_points)} 积分`, `Includes ${formatPoints(pointPackage.bonus_points)} bonus pts`)}</p>}
      </div>
      <p className="mt-5 flex-1 text-sm leading-6" style={{ color: ui.faint }}>{pointPackage.description || t("购买后不改变会员等级，未使用积分长期保留。", "Does not change membership tier; unused points are retained long-term.")}</p>
      <button type="button" disabled={buying} onClick={() => onBuy(pointPackage)}
        className="mt-7 w-full rounded-2xl py-3.5 text-sm font-black transition-transform active:scale-95 disabled:opacity-50"
        style={{ background: ui.buttonGradient, color: ui.primaryText }}>
        {buying ? t("正在创建订单…", "Creating order…") : t("购买积分包", "Buy point package")}
      </button>
    </article>
  );
};

const LedgerRow = ({ entry, isZh, ui, t }) => {
  const positive = Number(entry.change_points || 0) > 0;
  const label = {
    reserve: t("预占", "Reserve"),
    charge: t("生成扣费", "Generation charge"),
    release: t("失败返还", "Released"),
    recharge: t("订阅积分", "Subscription points"),
    membership_grant: t("月赠积分", "Monthly bonus"),
    expire: t("积分到期", "Expired"),
  }[entry.entry_type] || entry.entry_type;
  const sourceType = {
    generation: t("生成任务", "generation"),
    subscription: t("会员订阅", "subscription"),
    point_package: t("积分包", "point_package"),
    agent: t("Agent", "agent"),
  }[entry.source_type] || entry.source_type;

  return (
    <div className="flex items-center justify-between gap-4 border-b py-4" style={{ borderColor: ui.line }}>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="rounded-md px-2 py-1 text-[10px] font-black" style={{ background: positive ? "rgba(82,216,122,0.12)" : ui.surfaceHigh, color: positive ? "#32b960" : ui.muted }}>{label}</span>
          <span className="truncate text-[10px]" style={{ color: ui.faint }}>{sourceType}</span>
        </div>
        <p className="mt-1 truncate text-xs" style={{ color: ui.faint }}>{entry.note || t("无备注", "No note")}</p>
      </div>
      <div className="shrink-0 text-right">
        <p className="font-black" style={{ color: positive ? "#32b960" : ui.danger }}>{positive ? "+" : ""}{entry.change_points}</p>
        <p className="text-[10px]" style={{ color: ui.faint }}>{formatDate(entry.created_at, isZh)}</p>
      </div>
    </div>
  );
};

const Billing = () => {
  const authAxios = useAuthAxios();
  const { user } = useAuthing();
  const { t, isZh } = useLanguage();
  const { ui } = useStarDrawTheme();
  const [productMode, setProductMode] = useState("points");
  const [interval, setInterval] = useState("month");
  const [plans, setPlans] = useState([]);
  const [pointPackages, setPointPackages] = useState([]);
  const [overview, setOverview] = useState({ account: null, subscription: null, capabilities: {} });
  const [ledger, setLedger] = useState([]);
  const [loading, setLoading] = useState(true);
  const [buying, setBuying] = useState(null);
  const [cancelling, setCancelling] = useState(false);
  const [signing, setSigning] = useState(false);

  const refresh = useCallback(async () => {
    const [planResponse, pointPackageResponse, overviewResponse, ledgerResponse] = await Promise.all([
      authAxios.get("/api/subscriptions/plans"),
      authAxios.get("/api/points/packages"),
      authAxios.get("/api/subscriptions/overview"),
      authAxios.get("/api/points/ledger?page=1&page_size=20"),
    ]);
    setPlans(planResponse.data?.data || []);
    setPointPackages(pointPackageResponse.data?.data || []);
    setOverview(overviewResponse.data?.data || { account: null, subscription: null, capabilities: {} });
    setLedger(ledgerResponse.data?.data?.items || []);
  }, [authAxios]);

  useEffect(() => {
    refresh().catch((error) => {
      toast.error(error.response?.data?.message || t("账单加载失败", "Failed to load billing"));
    }).finally(() => setLoading(false));
  }, [refresh, t]);

  const visiblePlans = useMemo(() => plans.filter((plan) => plan.billing_interval === interval), [plans, interval]);
  const recommendedKey = visiblePlans[Math.min(1, Math.max(0, visiblePlans.length - 1))]?.plan_key;
  const account = overview.account;
  const subscription = overview.subscription;
  const periodicEnabled = overview.capabilities?.periodic_enabled === true;

  const handleSubscribe = async (plan) => {
    setBuying(plan.plan_key);
    try {
      const response = await authAxios.post("/api/subscriptions/orders", {
        plan_key: plan.plan_key,
        contact_email: user?.email || undefined,
      }, { headers: { "X-Idempotency-Key": uuidv4() } });
      const data = response.data?.data;
      if (data?.scheduled) {
        await refresh();
        toast.success(t("降级已安排在当前周期结束后生效。", "Downgrade scheduled for the end of the current period."));
        return;
      }
      if (data?.payment_url) {
        window.location.assign(data.payment_url);
        return;
      }
      toast.error(t("支付宝尚未配置，订单已创建但暂不能支付。", "Alipay is not configured; the order was created but cannot be paid yet."));
    } catch (error) {
      toast.error(error.response?.data?.message || t("订阅订单创建失败", "Failed to create subscription order"));
    } finally {
      setBuying(null);
    }
  };

  const handlePointPackage = async (pointPackage) => {
    setBuying(`points:${pointPackage.package_key}`);
    try {
      const response = await authAxios.post("/api/points/orders", {
        package_key: pointPackage.package_key,
      }, { headers: { "X-Idempotency-Key": uuidv4() } });
      const paymentUrl = response.data?.data?.payment_url;
      if (paymentUrl) {
        window.location.assign(paymentUrl);
        return;
      }
      toast.error(t("支付宝尚未配置，订单已创建但暂不能支付。", "Alipay is not configured; the order was created but cannot be paid yet."));
    } catch (error) {
      toast.error(error.response?.data?.message || t("积分订单创建失败", "Failed to create point order"));
    } finally {
      setBuying(null);
    }
  };

  const handlePeriodicAgreement = async () => {
    setSigning(true);
    try {
      const response = await authAxios.post("/api/subscriptions/periodic-agreement");
      const paymentUrl = response.data?.data?.payment_url;
      if (paymentUrl) {
        window.location.assign(paymentUrl);
        return;
      }
      await refresh();
      toast.success(t("自动续订已开启", "Auto-renewal is enabled"));
    } catch (error) {
      toast.error(error.response?.data?.message || t("开通自动续订失败", "Failed to enable auto-renewal"));
    } finally {
      setSigning(false);
    }
  };

  const handleCancelRenewal = async () => {
    if (!window.confirm(t("取消后本期仍可使用，但到期不会自动续订。确认取消吗？", "Your current period remains active, but it will not renew. Continue?"))) return;
    setCancelling(true);
    try {
      await authAxios.post("/api/subscriptions/cancel-renewal");
      await refresh();
      toast.success(t("已取消自动续订", "Auto-renewal cancelled"));
    } catch (error) {
      toast.error(error.response?.data?.message || t("取消续订失败", "Failed to cancel renewal"));
    } finally {
      setCancelling(false);
    }
  };

  return (
    <main className="mx-auto max-w-[1480px] p-6 lg:p-10">
      <section className="mb-8 grid items-end gap-6 lg:grid-cols-[1fr,420px]">
        <div>
          <span className="mb-4 inline-flex items-center gap-2 rounded-full px-3 py-1 text-[10px] font-black uppercase tracking-[0.2em]" style={{ background: ui.primarySoft, color: ui.primary }}>
            <span className="material-symbols-outlined text-sm">payments</span>{t("积分与会员", "Points & Membership")}
          </span>
          <h1 className="text-4xl font-black lg:text-5xl" style={{ color: ui.text, fontFamily: "Manrope, sans-serif" }}>{t("选择适合你的创作额度", "Choose your creative capacity")}</h1>
          <p className="mt-4 max-w-2xl text-sm leading-7" style={{ color: ui.faint }}>{t("模板本身不扣积分，图片、视频和 Agent 工具在执行时逐次原子扣费。", "Templates are free to use; image, video, and Agent tools are charged atomically per execution.")}</p>
        </div>

        <div className="rounded-3xl p-5" style={{ background: ui.surface, border: `1px solid ${ui.line}`, boxShadow: ui.shadow }}>
          <div className="grid grid-cols-3 gap-3">
            <div><p className="text-[10px] uppercase tracking-widest" style={{ color: ui.faint }}>{t("会员等级", "Tier")}</p><p className="mt-2 text-xl font-black" style={{ color: ui.primary }}>{{ free: t("免费版", "free"), basic: t("基础版", "basic"), pro: t("专业版", "pro"), max: t("高级版", "max"), enterprise: t("企业版", "enterprise") }[account?.membership_tier || "free"] || account?.membership_tier || "free"}</p></div>
            <div><p className="text-[10px] uppercase tracking-widest" style={{ color: ui.faint }}>{t("可用积分", "Available")}</p><p className="mt-2 text-xl font-black" style={{ color: ui.text }}>{formatPoints(account?.available_points)}</p></div>
            <div><p className="text-[10px] uppercase tracking-widest" style={{ color: ui.faint }}>{t("冻结积分", "Held")}</p><p className="mt-2 text-xl font-black" style={{ color: ui.gold }}>{formatPoints(account?.held_points)}</p></div>
          </div>
        </div>
      </section>

      {subscription?.status === "active" && (
        <section className="mb-8 rounded-3xl p-6" style={{ background: ui.surface, border: `1px solid ${ui.primary}55` }}>
          <div className="flex flex-wrap items-start justify-between gap-5">
            <div>
              <p className="text-[10px] font-black uppercase tracking-widest" style={{ color: ui.primary }}>{t("当前订阅", "Current subscription")}</p>
              <h2 className="mt-2 text-2xl font-black" style={{ color: ui.text }}>{subscription.plan_name}</h2>
              <p className="mt-2 text-sm" style={{ color: ui.faint }}>
                {formatDate(subscription.current_period_start, isZh)} → {formatDate(subscription.current_period_end, isZh)}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <span className="rounded-full px-3 py-1 text-xs font-bold" style={{ background: subscription.auto_renew && subscription.provider_agreement_id ? ui.primarySoft : ui.surfaceHigh, color: subscription.auto_renew && subscription.provider_agreement_id ? ui.primary : ui.faint }}>
                {subscription.auto_renew && subscription.provider_agreement_id
                  ? t("自动续订已开启", "Auto-renew on")
                  : periodicEnabled
                    ? t("可开通自动续订", "Auto-renew available")
                    : t("到期前邮件提醒续费", "Renewal reminder before expiry")}
              </span>
              {periodicEnabled && !subscription.provider_agreement_id && <button type="button" disabled={signing} onClick={handlePeriodicAgreement} className="rounded-xl px-4 py-2 text-xs font-bold" style={{ color: ui.primary, border: `1px solid ${ui.primary}66` }}>{signing ? t("处理中…", "Working…") : t("开通自动续订", "Enable auto-renew")}</button>}
              {subscription.auto_renew && subscription.provider_agreement_id && <button type="button" disabled={cancelling} onClick={handleCancelRenewal} className="rounded-xl px-4 py-2 text-xs font-bold" style={{ color: ui.danger, border: `1px solid ${ui.danger}66` }}>{cancelling ? t("处理中…", "Working…") : t("取消续订", "Cancel renewal")}</button>}
            </div>
          </div>
          {subscription.scheduled_plan_key && <p className="mt-4 text-xs" style={{ color: ui.gold }}>{t(`当前周期结束后将切换至 ${subscription.scheduled_plan_name}。`, `Scheduled to switch to ${subscription.scheduled_plan_name} at the end of this period.`)}</p>}
        </section>
      )}

      <section className="mb-10">
        <div className="mb-6 flex rounded-2xl p-1" style={{ background: ui.surfaceAlt, border: `1px solid ${ui.line}` }}>
          {[["points", t("长期积分", "Long-term points"), "toll"], ["subscription", t("会员订阅", "Membership"), "workspace_premium"]].map(([key, label, icon]) => (
            <button type="button" key={key} onClick={() => setProductMode(key)} className="flex flex-1 items-center justify-center gap-2 rounded-xl px-5 py-3 text-sm font-black"
              style={{ background: productMode === key ? ui.primary : "transparent", color: productMode === key ? ui.primaryText : ui.faint }}>
              <span className="material-symbols-outlined text-lg">{icon}</span>{label}
            </button>
          ))}
        </div>

        {productMode === "points" ? (
          <>
            <div className="mb-5"><h2 className="text-2xl font-black" style={{ color: ui.text }}>{t("一次购买，长期有效", "Buy once, keep long-term")}</h2><p className="mt-1 text-xs" style={{ color: ui.faint }}>{t("长期积分不会改变会员等级，当前长期有效。", "Long-term points do not change membership tier and are currently retained long-term.")}</p></div>
            {loading ? <div className="rounded-3xl p-10 text-center" style={{ background: ui.surface, color: ui.faint }}>{t("正在加载积分包…", "Loading point packages…")}</div> : pointPackages.length === 0 ? <div className="rounded-3xl p-10 text-center" style={{ background: ui.surface, border: `1px dashed ${ui.lineStrong}`, color: ui.faint }}>{t("管理员尚未配置可购买的积分包。", "No point packages are available yet.")}</div> : <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">{pointPackages.map((pointPackage) => <PointPackageCard key={pointPackage.package_key} pointPackage={pointPackage} onBuy={handlePointPackage} buying={buying === `points:${pointPackage.package_key}`} t={t} ui={ui} />)}</div>}
          </>
        ) : (
          <>
            <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
              <div><h2 className="text-2xl font-black" style={{ color: ui.text }}>{t("选择订阅周期", "Choose billing cycle")}</h2><p className="mt-1 text-xs" style={{ color: ui.faint }}>{t("按购买时间滚动到期，月末自动对齐到下个月最后一天。", "Calendar-aligned periods; month-end dates roll to the next month's last day.")}</p></div>
              <div className="flex rounded-2xl p-1" style={{ background: ui.surfaceAlt, border: `1px solid ${ui.line}` }}>
                {["month", "year"].map((key) => <button type="button" key={key} onClick={() => setInterval(key)} className="rounded-xl px-5 py-2 text-sm font-bold" style={{ background: interval === key ? ui.primary : "transparent", color: interval === key ? ui.primaryText : ui.faint }}>{key === "month" ? t("按月", "Monthly") : t("按年", "Yearly")}</button>)}
              </div>
            </div>
            {loading ? <div className="rounded-3xl p-10 text-center" style={{ background: ui.surface, color: ui.faint }}>{t("正在加载套餐…", "Loading plans…")}</div> : visiblePlans.length === 0 ? <div className="rounded-3xl p-10 text-center" style={{ background: ui.surface, border: `1px dashed ${ui.lineStrong}`, color: ui.faint }}>{t("管理员尚未配置可购买的订阅套餐。", "No purchasable subscription plans have been configured yet.")}</div> : <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">{visiblePlans.map((plan) => <PlanCard key={plan.plan_key} plan={plan} recommended={plan.plan_key === recommendedKey} onBuy={handleSubscribe} buying={buying === plan.plan_key} t={t} isZh={isZh} ui={ui} />)}</div>}
          </>
        )}
      </section>

      <section className="rounded-3xl p-6" style={{ background: ui.surface, border: `1px solid ${ui.line}` }}>
        <div className="flex items-center justify-between gap-4"><div><h2 className="text-xl font-black" style={{ color: ui.text }}>{t("积分流水", "Point ledger")}</h2><p className="mt-1 text-xs" style={{ color: ui.faint }}>{t("每次生成都会单独记录预占、扣费或返还。", "Every generation records its own reservation, charge, or release.")}</p></div><span className="material-symbols-outlined" style={{ color: ui.primary }}>receipt_long</span></div>
        <div className="mt-4">{ledger.length === 0 ? <p className="py-8 text-center text-sm" style={{ color: ui.faint }}>{t("暂无积分流水", "No point activity yet")}</p> : ledger.map((entry) => <LedgerRow key={entry.id} entry={entry} isZh={isZh} ui={ui} t={t} />)}</div>
      </section>
    </main>
  );
};

export default Billing;
