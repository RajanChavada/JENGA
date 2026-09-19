"use client";

import { useCallback, useEffect, useState, type RefObject } from "react";

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/**
 * A pane size held as a fraction of its container, remembered per browser.
 * Read after mount so the server-rendered HTML never disagrees with what a
 * saved size would draw; storage that is missing or blocked just keeps the default.
 */
export function useFraction(key: string, initial: number, min: number, max: number) {
  const [value, setValue] = useState(initial);

  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem(key));
      if (saved) setValue(clamp(saved, min, max));
    } catch {
      /* private window or blocked storage: the default is fine */
    }
  }, [key, min, max]);

  const set = useCallback(
    (next: number) => {
      const v = clamp(next, min, max);
      setValue(v);
      try {
        localStorage.setItem(key, String(v));
      } catch {
        /* the size still applies for this visit */
      }
    },
    [key, min, max],
  );

  return [value, set, () => set(initial)] as const;
}

/**
 * A draggable divider between two panes.
 *
 * `orientation` is the direction the *line* runs: "vertical" is a column divider
 * you drag left and right, "horizontal" a row divider you drag up and down. The
 * drag reports where the pointer sits as a fraction (0..1) of `containerRef`
 * along that axis, so the owner turns it into whichever pane's size it means.
 * Arrow keys nudge it and a double-click restores the default.
 */
export function Splitter({
  orientation,
  containerRef,
  onFraction,
  onReset,
  label,
  className = "",
}: {
  orientation: "vertical" | "horizontal";
  containerRef: RefObject<HTMLElement | null>;
  onFraction: (fraction: number) => void;
  onReset: () => void;
  label: string;
  className?: string;
}) {
  const [dragging, setDragging] = useState(false);
  const vertical = orientation === "vertical";

  function fractionAt(e: React.PointerEvent) {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return vertical
      ? (e.clientX - rect.left) / rect.width
      : (e.clientY - rect.top) / rect.height;
  }

  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      title="Drag to resize · double-click to reset"
      tabIndex={0}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        setDragging(true);
      }}
      onPointerMove={(e) => {
        if (!dragging) return;
        const f = fractionAt(e);
        if (f !== null) onFraction(f);
      }}
      onPointerUp={() => setDragging(false)}
      onPointerCancel={() => setDragging(false)}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        const rect = containerRef.current?.getBoundingClientRect();
        const step = 0.02;
        const back = vertical ? "ArrowLeft" : "ArrowUp";
        const forward = vertical ? "ArrowRight" : "ArrowDown";
        if (!rect || (e.key !== back && e.key !== forward)) return;
        e.preventDefault();
        // Nudge from where the divider is now, so a keypress never jumps.
        const el = e.currentTarget.getBoundingClientRect();
        const now = vertical
          ? (el.left + el.width / 2 - rect.left) / rect.width
          : (el.top + el.height / 2 - rect.top) / rect.height;
        onFraction(now + (e.key === forward ? step : -step));
      }}
      className={[
        "group relative z-10 shrink-0 touch-none select-none outline-none",
        vertical ? "w-1.5 cursor-col-resize" : "h-1.5 cursor-row-resize",
        className,
      ].join(" ")}
    >
      {/* The visible line is thin; the hit area above is wider so it is easy to grab. */}
      <div
        className={[
          "absolute transition-colors",
          vertical ? "inset-y-0 left-1/2 w-px -translate-x-1/2" : "inset-x-0 top-1/2 h-px -translate-y-1/2",
          dragging
            ? "bg-slate-500"
            : "bg-slate-200 group-hover:bg-slate-400 group-focus-visible:bg-slate-400",
        ].join(" ")}
      />
    </div>
  );
}
