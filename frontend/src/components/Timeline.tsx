'use client';

import { useEffect, useMemo, useRef } from 'react';
import { motion } from 'framer-motion';
import { AlertTriangle } from 'lucide-react';
import { STATE_STYLE, isDenied } from '@/lib/theme';
import { displayId, formatDate } from '@/lib/format';
import { axisSpan, extensionsByTask, whatIfFor, type Extension } from '@/lib/whatif';
import { useJenga, type StageEvent } from '@/store/useJenga';
import type { Task } from '@/lib/types';

/** Label gutter, px. Everything right of this is the day axis. */
const LABEL_W = 176;
/** Right gutter, px, so the last day's label isn't cut off at the panel edge. */
const PAD_R = 24;
const ROW_H = 26;
/** Current bar occupies 4..16; the baseline hairline sits at 18..21 beneath it. */
const BAR_TOP = 4;
const BAR_H = 12;
const GHOST_TOP = 18;
const GHOST_H = 3;

const SPRING = { type: 'spring', stiffness: 220, damping: 28 } as const;

export function Timeline() {
  const tasks = useJenga((s) => s.tasks);
  const baseline = useJenga((s) => s.baseline);
  const stageHistory = useJenga((s) => s.stageHistory);
  const projectDuration = useJenga((s) => s.projectDuration);
  const baselineDuration = useJenga((s) => s.baselineDuration);
  const selectedTaskId = useJenga((s) => s.selectedTaskId);
  const selectTask = useJenga((s) => s.selectTask);
  const focusOrigin = useJenga((s) => s.focusOrigin);
  const queue = useJenga((s) => s.queue);
  const reports = useJenga((s) => s.reports);
  const previewReportId = useJenga((s) => s.previewReportId);
  const activeProjectId = useJenga((s) => s.activeProjectId);
  const openReview = useJenga((s) => s.openReview);
  const listRef = useRef<HTMLDivElement>(null);

  // A task chosen in the graph or the twin can be off-screen here once the
  // schedule is made short. Bring its row into view; a click on the row itself
  // is already under the pointer, so that origin does not scroll.
  useEffect(() => {
    if (!selectedTaskId || focusOrigin === 'schedule') return;
    const row = listRef.current?.querySelector(`[data-task-row="${CSS.escape(selectedTaskId)}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }, [selectedTaskId, focusOrigin]);
  const cascading = useJenga((s) => s.cascading);

  /**
   * Derive the axis from the data rather than trusting projectDuration alone:
   * the store only republishes it after the last cascade rank lands, so mid-
   * cascade a moved task's ef would otherwise run off the right edge.
   */
  const baseSpan = useMemo(() => {
    let max = Math.max(projectDuration, baselineDuration ?? 0, 1);
    for (const t of tasks) max = Math.max(max, t.ef, t.lf);
    return max;
  }, [tasks, projectDuration, baselineDuration]);

  // What the owner is looking at, and what is still outstanding from earlier
  // denials. The axis stretches only while a prediction is on screen; the bars'
  // spring animation slides everything to the new scale and back.
  const { primary, faint } = useMemo(
    () => whatIfFor({ selectedTaskId, previewReportId, queue, reports, tasks, activeProjectId }),
    [selectedTaskId, previewReportId, queue, reports, tasks, activeProjectId],
  );
  const extensions = useMemo(() => extensionsByTask(primary, faint), [primary, faint]);
  const span = axisSpan(baseSpan, primary);
  // Updates awaiting this owner on the site on screen, by task.
  const pendingByTask = useMemo(
    () =>
      new Map(
        queue.filter((q) => q.report.project_id === activeProjectId).map((q) => [q.report.task_id, q.report.id]),
      ),
    [queue, activeProjectId],
  );

  const rows = useMemo(
    () =>
      [...tasks].sort(
        (a, b) => a.es - b.es || a.depth - b.depth || a.id.localeCompare(b.id),
      ),
    [tasks],
  );

  const gridDays = useMemo(() => {
    const step = Math.max(1, Math.ceil(span / 10));
    const out: number[] = [];
    for (let d = 0; d <= span; d += step) out.push(d);
    return out;
  }, [span]);

  const pct = (day: number) => (day / span) * 100;
  const slip = baselineDuration === null ? 0 : projectDuration - baselineDuration;
  const slipped = slip > 0;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-white text-slate-700">
      <header className="flex shrink-0 items-center gap-3 border-b border-slate-200 px-3 py-2">
        <h3 className="text-[10px] uppercase tracking-wider text-slate-400">
          Schedule · baseline vs current
        </h3>

        <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-[10px] text-slate-600">
          {projectDuration}d
        </span>

        {slipped && (
          <span className="flex items-center gap-1 rounded border border-red-300 bg-red-50 px-1.5 py-0.5 font-mono text-[10px] text-red-700">
            <AlertTriangle size={10} />+{slip}d vs baseline {baselineDuration}d
          </span>
        )}

        {cascading && (
          <span className="rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 font-mono text-[10px] text-amber-700">
            propagating…
          </span>
        )}

        {pendingByTask.size > 0 && (
          <button
            type="button"
            onClick={() => {
              const [taskId, reportId] = [...pendingByTask][0];
              openReview(reportId, taskId);
            }}
            className="rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 font-mono text-[10px] text-amber-800 hover:bg-amber-100"
          >
            {pendingByTask.size} awaiting review
          </button>
        )}

        {primary && (
          <span
            className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${
              primary.impact.days_past_deadline > 0
                ? 'border-red-300 bg-red-50 text-red-700'
                : 'border-slate-300 bg-slate-50 text-slate-600'
            }`}
          >
            {primary.impact.project_slipped_days > 0
              ? `+${primary.impact.project_slipped_days}d ${primary.kind === 'pending' ? 'if denied' : 'from denial'} → ${formatDate(primary.impact.predicted_finish_date)}`
              : `absorbed by float (${primary.kind === 'pending' ? 'if denied' : 'denied'})`}
            {primary.impact.days_past_deadline > 0 && ` · ${primary.impact.days_past_deadline}d past deadline`}
          </span>
        )}
      </header>

      {rows.length === 0 ? (
        <p className="p-3 text-[11px] leading-relaxed text-slate-400">
          No work packages loaded. Once the graph arrives every package is drawn against the
          project schedule, with its float tail and its baseline position.
        </p>
      ) : (
        <>
          {/* Day axis. Kept out of the scroll body so it stays put vertically; the
              track is percentage-based so it never drifts out of column. */}
          <div className="relative shrink-0 border-b border-slate-200 pb-1 pt-1.5">
            <div className={`relative ${primary ? 'h-6' : 'h-3.5'}`} style={{ marginLeft: LABEL_W, marginRight: PAD_R }}>
              {gridDays.map((d) => (
                <span
                  key={d}
                  className="absolute top-0 -translate-x-1/2 font-mono text-[9px] text-slate-400"
                  style={{ left: `${pct(d)}%` }}
                >
                  {d}d
                </span>
              ))}
              {primary && (
                <span
                  className={`absolute top-2.5 -translate-x-full whitespace-nowrap pr-1 font-mono text-[9px] ${
                    primary.impact.days_past_deadline > 0 ? 'text-red-600' : 'text-slate-500'
                  }`}
                  style={{ left: `${pct(Math.max(primary.impact.predicted_finish_day ?? 0, primary.impact.deadline_day ?? 0))}%` }}
                >
                  predicted {primary.impact.predicted_finish_day}d · deadline {primary.impact.deadline_day}d
                </span>
              )}
            </div>
          </div>

          <div ref={listRef} className="relative min-h-0 flex-1 overflow-y-auto">
            <div className="relative">
              {/* Gridlines, the completion marker and the slip band all live in one
                  overlay so they span every row and scroll with them. */}
              <div
                className="pointer-events-none absolute inset-y-0 z-10"
                style={{ left: LABEL_W, right: PAD_R }}
              >
                {gridDays.map((d) => (
                  <div
                    key={d}
                    className="absolute inset-y-0 w-px bg-slate-100"
                    style={{ left: `${pct(d)}%` }}
                  />
                ))}

                {slipped && (
                  <>
                    <div
                      className="absolute inset-y-0 bg-red-500/10"
                      style={{
                        left: `${pct(baselineDuration!)}%`,
                        width: `${pct(slip)}%`,
                      }}
                    />
                    <div
                      className="absolute inset-y-0 w-px border-l border-dashed border-slate-400"
                      style={{ left: `${pct(baselineDuration!)}%` }}
                    />
                  </>
                )}

                {primary && (
                  <>
                    <div
                      className="absolute inset-y-0 bg-red-500/10"
                      style={{
                        left: `${pct(primary.impact.baseline_finish_day ?? projectDuration)}%`,
                        width: `${pct(Math.max(0, (primary.impact.predicted_finish_day ?? 0) - (primary.impact.baseline_finish_day ?? projectDuration)))}%`,
                      }}
                    />
                    <div
                      className="absolute inset-y-0 w-px border-l border-dashed border-red-600"
                      style={{ left: `${pct(primary.impact.predicted_finish_day ?? 0)}%` }}
                    />
                    <div
                      className="absolute inset-y-0 w-px bg-slate-800/70"
                      style={{ left: `${pct(primary.impact.deadline_day ?? 0)}%` }}
                    />
                  </>
                )}

                <motion.div
                  initial={false}
                  animate={{ left: `${pct(projectDuration)}%` }}
                  transition={SPRING}
                  className={`absolute inset-y-0 w-px ${
                    slipped ? 'bg-red-600' : 'bg-slate-400'
                  }`}
                />
              </div>

              {rows.map((t) => (
                <Row
                  key={t.id}
                  task={t}
                  base={baseline[t.id]}
                  log={stageHistory[t.id]}
                  selected={t.id === selectedTaskId}
                  onSelect={() => selectTask(t.id === selectedTaskId ? null : t.id, 'schedule')}
                  pct={pct}
                  ext={extensions.get(t.id)}
                  denied={isDenied(t, reports)}
                  onReview={
                    pendingByTask.has(t.id) ? () => openReview(pendingByTask.get(t.id)!, t.id) : undefined
                  }
                />
              ))}
            </div>
          </div>

          <footer className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-slate-200 px-3 py-1.5 text-[9px] text-slate-400">
            <Swatch className="bg-slate-400">current</Swatch>
            <Swatch className="bg-slate-300 [background-image:repeating-linear-gradient(45deg,#94a3b866_0_3px,transparent_3px_6px)]">
              float tail
            </Swatch>
            <Swatch className="bg-slate-300">baseline (moved only)</Swatch>
            <Swatch className="bg-red-500">critical · zero float</Swatch>
            <Swatch className="bg-red-400/60 [background-image:repeating-linear-gradient(45deg,#dc2626aa_0_3px,transparent_3px_6px)]">
              predicted if denied
            </Swatch>
            <span className="flex items-center gap-1">
              <span className="rounded border border-amber-300 bg-amber-100 px-1 text-[8px] text-amber-800">Review</span>
              update awaiting you
            </span>
            <span>ticks = stage transitions</span>
          </footer>
        </>
      )}
    </div>
  );
}

function Swatch({ className, children }: { className: string; children: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className={`h-2 w-4 rounded-sm ${className}`} />
      {children}
    </span>
  );
}

function Row({
  task: t,
  base,
  log,
  selected,
  onSelect,
  pct,
  ext,
  denied,
  onReview,
}: {
  task: Task;
  base: { es: number; ef: number } | undefined;
  log: StageEvent[] | undefined;
  selected: boolean;
  onSelect: () => void;
  pct: (day: number) => number;
  /** A predicted schedule extension for this task, if one is on screen. */
  ext?: Extension;
  /** Denied and waiting on a resubmission. */
  denied?: boolean;
  /** Present when an update on this task is awaiting the owner; opens its review. */
  onReview?: () => void;
}) {
  const style = STATE_STYLE[t.state];
  const moved = !!base && (base.es !== t.es || base.ef !== t.ef);
  // Milestones have zero duration; give them a sliver so they stay clickable.
  const barW = Math.max(pct(t.ef - t.es), 0.5);

  return (
    <button
      type="button"
      onClick={onSelect}
      data-task-row={t.id}
      aria-pressed={selected}
      className={`relative flex w-full items-center text-left transition-colors ${
        selected ? 'bg-slate-100 ring-1 ring-inset ring-slate-300' : 'hover:bg-slate-50'
      }`}
      style={{ height: ROW_H }}
    >
      <div
        className="flex shrink-0 items-center gap-1.5 overflow-hidden px-2"
        style={{ width: LABEL_W }}
      >
        <span className="shrink-0 font-mono text-[10px] text-slate-400">{displayId(t.id)}</span>
        <span className="truncate text-[10px] text-slate-700">{t.name}</span>
        {onReview && (
          // A span, not a button: this whole row is already a button.
          <span
            role="button"
            tabIndex={0}
            title="Open this update in Reviews"
            onClick={(e) => {
              e.stopPropagation();
              onReview();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                onReview();
              }
            }}
            className="shrink-0 rounded border border-amber-300 bg-amber-100 px-1 text-[8px] font-medium text-amber-800 hover:bg-amber-200"
          >
            Review
          </span>
        )}
        {denied && !onReview && (
          <span className="shrink-0 rounded border border-red-300 bg-red-100 px-1 text-[8px] font-medium text-red-700">
            Denied
          </span>
        )}
        <span
          className={`ml-auto shrink-0 font-mono text-[9px] ${
            ext?.live && ext.lateBy > 0
              ? 'font-medium text-red-600'
              : t.is_critical
                ? 'text-red-600'
                : 'text-slate-400'
          }`}
        >
          {ext?.live && ext.lateBy > 0 ? `+${ext.lateBy}d late` : t.is_critical ? 'CRIT' : `${t.total_float}d`}
        </span>
      </div>

      <div className="relative h-full flex-1" style={{ marginRight: PAD_R }}>
        {/* Slack the task can absorb before it starts pushing the finish date. */}
        {t.total_float > 0 && (
          <motion.div
            initial={false}
            animate={{ left: `${pct(t.ef)}%`, width: `${pct(t.lf - t.ef)}%` }}
            transition={SPRING}
            className="absolute rounded-r-sm border border-l-0 border-dashed"
            style={{
              top: BAR_TOP,
              height: BAR_H,
              borderColor: `${style.hex}55`,
              backgroundImage: `repeating-linear-gradient(45deg, ${style.hex}33 0 3px, transparent 3px 6px)`,
            }}
          />
        )}

        {/* Where this package sat at load. Drawn only once it has moved — a ghost
            under every untouched bar is noise, and displacement is the signal. */}
        {moved && (
          <div
            className="absolute rounded-sm bg-slate-300"
            style={{
              left: `${pct(base!.es)}%`,
              width: `${Math.max(pct(base!.ef - base!.es), 0.5)}%`,
              top: GHOST_TOP,
              height: GHOST_H,
            }}
          />
        )}

        {/* The predicted extension: from where this task finishes now to where it would
            finish. Full strength for the prediction being looked at, faint for a past
            denial that is still outstanding. */}
        {ext && (
          <motion.div
            initial={false}
            animate={{ left: `${pct(ext.from)}%`, width: `${pct(ext.to - ext.from)}%` }}
            transition={SPRING}
            data-ext={ext.live ? 'live' : 'faint'}
            className="absolute rounded-r-sm border border-l-0 border-dashed border-red-600"
            style={{
              top: BAR_TOP,
              height: BAR_H,
              opacity: ext.live ? 1 : 0.4,
              backgroundImage: 'repeating-linear-gradient(45deg, #dc2626aa 0 3px, transparent 3px 6px)',
            }}
          />
        )}
        {/* Where it was due, on tasks the prediction pushes (or keeps) past it. */}
        {ext?.live && ext.dueDay != null && (
          <div
            className="absolute w-px bg-slate-800/70"
            style={{ left: `${pct(ext.dueDay)}%`, top: 2, height: ROW_H - 4 }}
          />
        )}

        {/* Animating left/width rather than layout/transform keeps the stage ticks
            inside from being scaled out of shape during the cascade. */}
        <motion.div
          initial={false}
          animate={{ left: `${pct(t.es)}%`, width: `${barW}%` }}
          transition={SPRING}
          className="absolute overflow-hidden rounded-sm"
          style={{
            top: BAR_TOP,
            height: BAR_H,
            background: style.hex,
            opacity: Math.max(style.opacity, 0.45),
            boxShadow: t.is_critical ? '0 0 0 1px #dc2626' : undefined,
          }}
        >
          {/* ponytail: ticks are spaced evenly by index, not by timestamp — the bar
              axis is project days and a transition log is wall clock, so the two do
              not share a scale. They read as "this ticket passed through these
              stages, in this order". Place by real date once tasks carry one. */}
          {log &&
            log.length > 1 &&
            log.map((e, i) => (
              <span
                key={`${e.at}-${i}`}
                className="absolute inset-y-0 w-[2px]"
                style={{
                  left: `${((i + 1) / (log.length + 1)) * 100}%`,
                  background: STATE_STYLE[e.state].hex,
                  boxShadow: '0 0 0 1px rgba(255,255,255,0.7)',
                }}
              />
            ))}
        </motion.div>
      </div>
    </button>
  );
}
