import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const CanvasIconButton = ({
  label,
  children,
  onClick,
  active = false,
  disabled = false,
  className = "",
  style,
  type = "button",
  tooltipSide = "top",
  ...props
}) => {
  const [showTip, setShowTip] = useState(false);
  const [tooltipPosition, setTooltipPosition] = useState({ left: 0, top: 0, visible: false });
  const anchorRef = useRef(null);
  const tooltipRef = useRef(null);

  const positionTooltip = useCallback(() => {
    const anchor = anchorRef.current?.getBoundingClientRect();
    const tip = tooltipRef.current?.getBoundingClientRect();
    if (!anchor || !tip) return;
    const gap = 7;
    let left = anchor.left + (anchor.width - tip.width) / 2;
    let top = anchor.top - tip.height - gap;
    if (tooltipSide === "bottom") top = anchor.bottom + gap;
    if (tooltipSide === "left") {
      left = anchor.left - tip.width - gap;
      top = anchor.top + (anchor.height - tip.height) / 2;
    }
    left = Math.min(window.innerWidth - tip.width - 8, Math.max(8, left));
    top = Math.min(window.innerHeight - tip.height - 8, Math.max(8, top));
    setTooltipPosition({ left, top, visible: true });
  }, [tooltipSide]);

  useLayoutEffect(() => {
    if (showTip && label) positionTooltip();
  }, [label, positionTooltip, showTip]);

  useEffect(() => {
    if (!showTip) return undefined;
    const update = () => positionTooltip();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [positionTooltip, showTip]);

  return (
    <span ref={anchorRef} className="relative inline-flex" onMouseEnter={() => setShowTip(true)} onMouseLeave={() => setShowTip(false)}>
      <button
        {...props}
        type={type}
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        onFocus={() => setShowTip(true)}
        onBlur={() => setShowTip(false)}
        className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-colors duration-150 ${active ? "ring-1 ring-white/20" : ""} disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
        style={style}
      >
        {children}
      </button>
      {showTip && label && typeof document !== "undefined" && createPortal(
        <span ref={tooltipRef} role="tooltip" className="pointer-events-none fixed z-[320] max-w-[min(240px,calc(100vw-16px))] whitespace-normal rounded-xl border px-2 py-1 text-[10px] font-medium leading-4 shadow-xl" style={{ left: tooltipPosition.left, top: tooltipPosition.top, visibility: tooltipPosition.visible ? "visible" : "hidden", background: "var(--canvas-tooltip-bg, #171a20)", borderColor: "var(--canvas-tooltip-line, rgba(255,255,255,.12))", color: "var(--canvas-tooltip-text, #fff)" }}>
          {label}
        </span>,
        document.body,
      )}
    </span>
  );
};

export default CanvasIconButton;
