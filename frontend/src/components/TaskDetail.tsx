'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useJenga } from '@/store/useJenga';
import { displayId } from '@/lib/format';
import { DENIED_STYLE, STATE_STYLE, isDenied, zoneLabel } from '@/lib/theme';
import type { Task } from '@/lib/types';

/**
 * Schedule + dependency detail for one task, opened by clicking a node that is
 * already focused in the work graph (a second click; the first click focuses).
 * Same native-`<dialog>` pattern as the report preview in ApprovalQueue.tsx.
 */
export function TaskDetail({ taskId, onClose }: { taskId: string | null; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const tasks = useJenga((s) => s.tasks);
  const edges = useJenga((s) => s.edges);
  const reports = useJenga((s) => s.reports);
  const selectTask = useJenga((s) => s.selectTask);
  const projectId = useJenga((s) => s.activeProjectId);

  useEffect(() => {
    if (taskId) ref.current?.showModal();
    else ref.current?.close();
  }, [taskId]);

  const task = tasks.find((t) => t.id === taskId) ?? null;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const successors = task ? edges.filter((e) => e.source === task.id).map((e) => e.target) : [];
  const blockedBy = new Set(task?.blocked_by ?? []);

  function goTo(id: string) {
    selectTask(id, 'graph');
    onClose();
  }

  const style = task ? (isDenied(task, reports) ? DENIED_STYLE : STATE_STYLE[task.state]) : null;

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      className="fixed top-1/2 left-1/2 m-0 w-[min(90vw,480px)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-slate-200 bg-white p-0 shadow-xl backdrop:bg-slate-900/50"
    >
      {task && style && (
        <>
          <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-4 py-3">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 font-mono text-[11px] text-slate-400">
                <span>{displayId(task.id)}</span>
                <span>·</span>
                <span>{zoneLabel(task.zone, projectId)}</span>
              </div>
              <div className="mt-0.5 truncate text-sm font-semibold text-slate-900">{task.name}</div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className={`rounded border px-1.5 py-0.5 text-[11px] ${style.chip}`}>
                {style.label}
              </span>
              <button
                onClick={() => ref.current?.close()}
                aria-label="Close task detail"
                className="text-slate-400 hover:text-slate-700"
              >
                <X size={16} />
              </button>
            </div>
          </div>

          <div className="max-h-[75vh] overflow-auto px-4 py-3">
            <Section title="Description">
              <p className="whitespace-pre-wrap text-xs leading-relaxed text-slate-600">
                {task.spec_text}
              </p>
            </Section>

            <Section title="Details">
              <dl className="divide-y divide-slate-100 text-xs leading-relaxed text-slate-600">
                <Row label="Duration" value={days(task.duration_days)} />
                <Row
                  label="Leeway"
                  value={task.is_critical ? 'None — critical path' : days(task.total_float)}
                />
                <Row label="Earliest start – finish" value={`Day ${task.es} – Day ${task.ef}`} />
                <Row label="Latest start – finish" value={`Day ${task.ls} – Day ${task.lf}`} />
                {task.due_day != null && <Row label="Due" value={`Day ${task.due_day}`} />}
              </dl>
            </Section>

            {task.depends_on.length > 0 && (
              <Section title="Depends on">
                <DepRows
                  ids={task.depends_on}
                  byId={byId}
                  flagIds={blockedBy}
                  flagLabel="unverified"
                  onSelect={goTo}
                />
              </Section>
            )}
            {successors.length > 0 && (
              <Section title="Unblocks">
                <DepRows ids={successors} byId={byId} onSelect={goTo} />
              </Section>
            )}
          </div>
        </>
      )}
    </dialog>
  );
}

function days(n: number): string {
  return `${n} day${n === 1 ? '' : 's'}`;
}

/** One labelled block. Sections after the first are separated by a rule, not a box. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-4 border-t border-slate-100 pt-3 first:mt-0 first:border-t-0 first:pt-0">
      <div className="mb-1.5 text-[11px] font-medium text-slate-500">{title}</div>
      {children}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 text-xs leading-relaxed text-slate-600">
      <span className="text-slate-500">{label}</span>
      <span className="font-medium text-slate-700">{value}</span>
    </div>
  );
}

function DepRows({
  ids,
  byId,
  flagIds,
  flagLabel,
  onSelect,
}: {
  ids: string[];
  byId: Map<string, Task>;
  flagIds?: Set<string>;
  flagLabel?: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      {ids.map((id) => {
        const t = byId.get(id);
        if (!t) return null;
        const style = STATE_STYLE[t.state];
        const flagged = flagIds?.has(id);
        return (
          <button
            key={id}
            onClick={() => onSelect(id)}
            className="flex items-center gap-2 rounded border border-slate-200 px-2 py-1 text-left text-xs hover:bg-slate-50"
          >
            <span className="h-1.5 w-1.5 shrink-0 rounded-sm" style={{ background: style.hex }} />
            <span className="font-mono text-[10px] text-slate-400">{displayId(id)}</span>
            <span className="flex-1 truncate text-slate-700">{t.name}</span>
            {flagged && flagLabel && (
              <span className="shrink-0 text-[10px] text-amber-600">{flagLabel}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
