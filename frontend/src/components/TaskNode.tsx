'use client';

import { Handle, Position, type NodeProps } from '@xyflow/react';
import { motion } from 'framer-motion';
import { STATE_STYLE } from '@/lib/theme';
import type { Task } from '@/lib/types';

export interface TaskNodeData extends Record<string, unknown> {
  task: Task;
  selected: boolean;
  thumbnail: string | null;
}

/** Fixed so dagre can measure without rendering. Keep in sync with layout(). */
export const NODE_W = 176;
export const NODE_H = 64;

function TaskNodeImpl({ data }: NodeProps) {
  const { task, selected, thumbnail } = data as unknown as TaskNodeData;
  const style = STATE_STYLE[task.state];

  return (
    <motion.div
      layout
      animate={{ scale: selected ? 1.06 : 1 }}
      transition={{ type: 'spring', stiffness: 320, damping: 26 }}
      style={{ width: NODE_W, height: NODE_H }}
      className={[
        'rounded-md border px-2 py-1.5 text-[11px] shadow-sm',
        style.chip,
        selected ? 'ring-2 ring-slate-900/70' : '',
        task.is_critical ? 'shadow-[0_0_0_1px_rgba(220,38,38,0.55)]' : '',
        task.state === 'under_review' ? 'animate-pulse' : '',
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
          <div className="flex items-baseline justify-between gap-1">
            <span className="font-mono text-[10px] opacity-70">{task.id}</span>
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
