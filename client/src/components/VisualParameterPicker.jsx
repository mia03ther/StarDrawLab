import { useEffect, useMemo, useState } from "react";
import useAuthAxios from "../hooks/useAuthAxios";
import { useLanguage } from "../contexts/LanguageContext";
import { useStarDrawTheme } from "../utils/stardrawTheme";
import CanvasRoundedSelect from "./canvas/CanvasRoundedSelect";

const VisualParameterPicker = ({ outputType, modelKey, value = {}, onChange, accent = "primary" }) => {
  const authAxios = useAuthAxios();
  const { t, isZh } = useLanguage();
  const { ui } = useStarDrawTheme();
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    authAxios.get(`/api/visual-parameters?output_type=${encodeURIComponent(outputType || "")}&model_key=${encodeURIComponent(modelKey || "")}`)
      .then(({ data }) => {
        if (!cancelled) setGroups(data?.data?.groups || []);
      })
      .catch(() => {
        if (!cancelled) setGroups([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [authAxios, modelKey, outputType]);

  const availableGroups = useMemo(() => groups.map((group) => ({
    ...group,
    options: (group.options || []).filter((option) => option.is_active !== false
      && (!Array.isArray(option.supported_output_types) || option.supported_output_types.includes(outputType))
      && (!Array.isArray(option.model_keys) || option.model_keys.length === 0 || option.model_keys.includes(modelKey))),
  })).filter((group) => group.options.length > 0), [groups, modelKey, outputType]);

  useEffect(() => {
    const allowed = new Map(availableGroups.map((group) => [group.parameter_key, new Set(group.options.map((option) => option.option_key))]));
    const next = Object.fromEntries(Object.entries(value || {}).filter(([key, option]) => allowed.get(key)?.has(option)));
    if (JSON.stringify(next) !== JSON.stringify(value || {})) onChange(next);
  }, [availableGroups, onChange, value]);

  const accentColor = accent === "gold" ? ui.gold : ui.primary;
  const accentSoft = accent === "gold" ? ui.goldSoft : ui.primarySoft;

  return (
    <div className="rounded-3xl p-5" style={{ background: ui.surface }}>
      <div className="mb-4 flex items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-[10px] uppercase tracking-widest font-bold" style={{ color: accentColor }}>
          <span className="material-symbols-outlined text-sm">tune</span>
          {t("视觉参数", "Visual Controls")}
        </label>
        <span className="text-[10px]" style={{ color: ui.faint }}>{t("可选，不改变模板收费", "Optional; template use remains free")}</span>
      </div>
      {loading ? (
        <p className="text-xs" style={{ color: ui.faint }}>{t("加载视觉选项…", "Loading visual controls…")}</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {availableGroups.map((group) => {
            const selected = value?.[group.parameter_key] || "";
            return (
              <label key={group.parameter_key} className="block">
                <span className="mb-1.5 block text-[10px] font-bold" style={{ color: ui.faint }}>
                  {isZh ? group.display_name : group.display_name_en}
                </span>
                <CanvasRoundedSelect
                  label={isZh ? group.display_name : group.display_name_en}
                  value={selected}
                  onChange={(nextValue) => {
                    const next = { ...(value || {}) };
                    if (nextValue) next[group.parameter_key] = nextValue;
                    else delete next[group.parameter_key];
                    onChange(next);
                  }}
                  options={[{ value: "", label: t("跟随模板 / 不指定", "Template default / None") }, ...group.options.map((option) => ({ value: option.option_key, label: isZh ? option.display_name : option.display_name_en }))]}
                  ui={ui}
                  className="w-full"
                  triggerClassName="h-11 w-full rounded-2xl px-3 text-sm"
                  style={{ borderColor: selected ? accentColor : ui.line }}
                  menuMinWidth={220}
                />
              </label>
            );
          })}
        </div>
      )}
      {Object.keys(value || {}).length > 0 && (
        <button type="button" onClick={() => onChange({})} className="mt-4 rounded-xl px-3 py-2 text-xs font-bold" style={{ background: accentSoft, color: accentColor }}>
          {t("清除视觉参数", "Clear visual controls")}
        </button>
      )}
    </div>
  );
};

export default VisualParameterPicker;
