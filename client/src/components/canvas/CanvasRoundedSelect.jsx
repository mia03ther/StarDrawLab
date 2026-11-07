import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

const getValue = (option) => String(option?.model_key ?? option?.value ?? option ?? "");
const getLabel = (option) => String(option?.display_name ?? option?.label ?? option ?? "");

const CanvasRoundedSelect = ({
  value,
  options = [],
  onChange,
  disabled = false,
  ui,
  label,
  icon = null,
  placeholder = "-",
  className = "",
  triggerClassName = "",
  compact = false,
  menuMinWidth = 180,
  style = {},
  menuStyle = {},
}) => {
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [menuPositionStyle, setMenuPositionStyle] = useState({});

  const selectedIndex = Math.max(0, options.findIndex((option) => getValue(option) === String(value ?? "")));
  const selected = options[selectedIndex];
  const selectedLabel = selected ? getLabel(selected) : (value || placeholder);

  const positionMenu = useCallback(() => {
    const trigger = triggerRef.current?.getBoundingClientRect();
    if (!trigger || typeof window === "undefined") return;

    const viewportPadding = 12;
    const width = Math.min(
      Math.max(trigger.width, menuMinWidth),
      Math.max(160, window.innerWidth - viewportPadding * 2),
    );
    const left = Math.min(
      Math.max(viewportPadding, trigger.left),
      window.innerWidth - width - viewportPadding,
    );
    const estimatedHeight = Math.min(300, Math.max(48, options.length * 36 + 12));
    const belowSpace = window.innerHeight - trigger.bottom - viewportPadding;
    const placeAbove = belowSpace < estimatedHeight && trigger.top > estimatedHeight;
    const top = placeAbove
      ? Math.max(viewportPadding, trigger.top - estimatedHeight - 6)
      : Math.min(window.innerHeight - estimatedHeight - viewportPadding, trigger.bottom + 6);

    setMenuPositionStyle({ left, top, width });
  }, [menuMinWidth, options.length]);

  useLayoutEffect(() => {
    if (open) positionMenu();
  }, [open, positionMenu]);

  useEffect(() => {
    if (!open) return undefined;
    const closeOnOutsidePointer = (event) => {
      if (triggerRef.current?.contains(event.target) || menuRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    const closeOnEscape = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const updatePosition = () => positionMenu();
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, positionMenu]);

  const choose = (option) => {
    onChange?.(getValue(option));
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onTriggerKeyDown = (event) => {
    if (disabled) return;
    if (["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      const offset = event.key === "ArrowUp" ? -1 : 1;
      const nextIndex = Math.min(options.length - 1, Math.max(0, selectedIndex + offset));
      if (options[nextIndex]) choose(options[nextIndex]);
    }
  };

  return (
    <div className={`relative min-w-0 ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="listbox"
        disabled={disabled || options.length === 0}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={onTriggerKeyDown}
        className={`flex min-w-0 items-center gap-1.5 rounded-full border text-left outline-none transition focus-visible:ring-2 disabled:cursor-wait disabled:opacity-55 ${compact ? "h-7 px-2.5 text-[9px]" : "h-9 px-3 text-xs"} ${triggerClassName}`}
        style={{
          background: ui?.soft || ui?.surfaceAlt || ui?.surface || "rgba(127,127,127,.08)",
          borderColor: ui?.line2 || ui?.line || "rgba(127,127,127,.18)",
          color: ui?.text || "inherit",
          "--tw-ring-color": ui?.gold || ui?.primary || "currentColor",
          ...style,
        }}
      >
        {icon && <span className="shrink-0" style={{ color: ui?.faint || "currentColor" }}>{icon}</span>}
        <span className="min-w-0 flex-1 truncate" title={selectedLabel}>{selectedLabel}</span>
        <ChevronDown size={compact ? 9 : 12} className="shrink-0" style={{ color: ui?.faint || "currentColor" }} />
      </button>

      {open && typeof document !== "undefined" && createPortal(
        <div
          ref={menuRef}
          role="listbox"
          aria-label={label}
          className="fixed z-[420] max-h-[min(300px,calc(100vh-24px))] overflow-y-auto rounded-[16px] border p-1.5 shadow-[0_18px_55px_rgba(0,0,0,.28)] backdrop-blur-xl"
          style={{
            ...menuStyle,
            ...menuPositionStyle,
            background: ui?.panelStrong || ui?.surface || ui?.panel || "#171a20",
            borderColor: ui?.line2 || ui?.line || "rgba(127,127,127,.2)",
            color: ui?.text || "inherit",
          }}
        >
          {options.length === 0 && <div className="rounded-[12px] px-3 py-2.5 text-[10px]" style={{ color: ui?.faint || "inherit" }}>{placeholder}</div>}
          {options.map((option) => {
            const optionValue = getValue(option);
            const active = optionValue === String(value ?? "");
            return (
              <button
                key={optionValue}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => choose(option)}
                className="flex min-h-8 w-full items-center gap-2 rounded-[11px] px-2.5 py-2 text-left text-[10px] transition-colors hover:bg-white/[.08] focus-visible:bg-white/[.08] focus-visible:outline-none"
                style={{ background: active ? (ui?.goldSoft || ui?.primarySoft || "rgba(238,157,71,.12)") : "transparent", color: active ? (ui?.gold || ui?.primary || ui?.text || "inherit") : (ui?.text || "inherit") }}
              >
                <span className="min-w-0 flex-1 truncate">{getLabel(option)}</span>
                {active && <Check size={12} className="shrink-0" />}
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
};

export default CanvasRoundedSelect;
