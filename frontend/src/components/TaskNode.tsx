'use client';

import { Handle, Position, type NodeProps } from '@xyflow/react';
import { motion } from 'framer-motion';
import { DENIED_STYLE, STATE_STYLE, isDenied } from '@/lib/theme';
import { useJenga } from '@/store/useJenga';
import { displayId } from '@/lib/format';
import type { Task } from '@/lib/types';

export interface TaskNodeData extends Record<string, unknown> {
  task: Task;
  selected: boolean;
  /** Outside the current focus: drawn faint so the focused task and its neighbours read. */
  dimmed?: boolean;
  /**
   * Which view draws it. Logical is the readable one: exactly id, duration, name
   * and status. Blueprint keeps the denser card (critical/float) it always had.
   */
  variant?: 'logical' | 'blueprint';
  thumbnail: string | null;
}

/** Fixed so dagre can measure without rendering. Keep in sync with layout(). */
export const NODE_W = 176;
export const NODE_H = 64;

function TaskNodeImpl({ data }: NodeProps) {
  const { task, selected, dimmed, thumbnail, variant } = data as unknown as TaskNodeData;
  const logical = variant === 'logical';
  const denied = useJenga((s) => isDenied(task, s.reports));
  const style = denied ? DENIED_STYLE : STATE_STYLE[task.state];

  return (
    <motion.div
      animate={{ scale: selected ? 1.06 : 1 }}
      transition={{ type: 'spring', stiffness: 320, damping: 26 }}
      style={{ width: NODE_W, height: NODE_H, opacity: dimmed ? 0.3 : 1, transition: 'opacity 200ms' }}
      className={[
        'rounded-md border px-2 py-1.5 text-[11px] shadow-sm',
        style.chip,
        selected ? 'ring-2 ring-slate-900/70' : '',
        task.is_critical ? 'shadow-[0_0_0_1px_rgba(220,38,38,0.55)]' : '',
        // The logical card has no CRIT label, so a critical task is marked by a red
        // ring (unless selected, whose ring wins).
        logical && task.is_critical && !selected ? 'ring-1 ring-red-400' : '',
        task.state === 'under_review' || denied ? 'animate-pulse' : '',
      ].join(' ')}
    >
      <Handle type="target" position={Position.Left} className="!h-1.5 !w-1.5 !bg-slate-300" />

      <div className="flex items-start gap-1.5">
        {thumbnail ? (
          // Verified work shows the evidence that verified it.
          <img
            src={thumbnail}
            alt=""
            className="h-9 w-9 shrink-0 rounded object-cover ring-1 ring-slate-200"
          />
        ) : null}
        <div className="min-w-0 flex-1">
          {logical ? (
            // The four things a card is for, sized to read at the default zoom.
            // Critical is carried by the red border, so it needs no label here.
            <>
              <div className="flex items-baseline justify-between gap-1">
                <span className="whitespace-nowrap font-mono text-[11px] opacity-70">{displayId(task.id)}</span>
                <span className="font-mono text-[11px]">{task.duration_days}d</span>
              </div>
              <div className="truncate text-[12px] font-medium leading-tight">{task.name}</div>
              <div className="truncate text-[10px] opacity-70">{style.label}</div>
            </>
          ) : (
            <>
              <div className="flex items-baseline justify-between gap-1">
                <span className="whitespace-nowrap font-mono text-[10px] opacity-70">{displayId(task.id)}</span>
                {task.is_critical ? (
                  <span className="font-mono text-[9px] text-red-600">CRIT</span>
                ) : (
                  <span className="font-mono text-[9px] opacity-50">
                    {task.total_float}d float
                  </span>
                )}
              </div>
              <div className="truncate font-medium leading-tight">{task.name}</div>
              <div className="truncate text-[9px] opacity-60">{style.label}</div>
            </>
          )}
        </div>
      </div>

      <Handle type="source" position={Position.Right} className="!h-1.5 !w-1.5 !bg-slate-300" />
    </motion.div>
  );
}

/**
 * MUST live at module scope. Passing a freshly-built nodeTypes object on each
 * render makes React Flow re-register node types every frame and re-render
 * forever. This is the single most common way to hang a React Flow app.
 */
export const nodeTypes = { task: TaskNodeImpl };
