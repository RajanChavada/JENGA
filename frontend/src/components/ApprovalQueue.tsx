'use client';

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';
import { displayId, formatDate } from '@/lib/format';
import { mediaUrl } from '@/lib/api';
import type { Impact, QueueItem, VerdictStatus } from '@/lib/types';
import { useJenga } from '@/store/useJenga';

const AI_CHIP: Record<VerdictStatus, string> = {
  APPROVED: 'border-emerald-300 bg-emerald-50 text-emerald-700',
  UNDER_REVIEW: 'border-amber-300 bg-amber-50 text-amber-700',
  DISPUTED: 'border-red-300 bg-red-50 text-red-700',
};

/** Header toggle for the Reviews rail; the count is the updates awaiting this owner. */
export function ReviewsButton() {
  const queue = useJenga((s) => s.queue);
  const open = useJenga((s) => s.reviewsOpen);
  const setOpen = useJenga((s) => s.setReviewsOpen);

  return (
    <button
      onClick={() => setOpen(!open)}
      aria-pressed={open}
      className="flex items-center gap-1.5 rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-slate-800"
    >
      Reviews
      <span
        className={`rounded-full px-1.5 font-mono text-[10px] ${
          queue.length ? 'bg-amber-400 text-slate-900' : 'bg-slate-700 text-slate-300'
        }`}
      >
        {queue.length}
      </span>
    </button>
  );
}

/**
 * The updates awaiting this owner's call, docked as a right rail beside the
 * Activity rail. It pushes the page over instead of floating above it, so the
 * schedule (where a card's predicted extension is drawn) is never covered.
 * Hovering a card previews its prediction on the schedule.
 */
export function ReviewsRail() {
  const queue = useJenga((s) => s.queue);
  const open = useJenga((s) => s.reviewsOpen);
  const setOpen = useJenga((s) => s.setReviewsOpen);
  const setPreview = useJenga((s) => s.setPreviewReport);

  // A hover left dangling by the rail closing would keep a prediction on screen.
  useEffect(() => () => setPreview(null), [setPreview]);

  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          initial={{ x: 40, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 40, opacity: 0 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          className="flex h-full w-[420px] shrink-0 flex-col border-l border-slate-200 bg-white"
        >
          <div className="flex shrink-0 items-start justify-between border-b border-slate-200 px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">Updates awaiting review</h2>
              <p className="text-[11px] text-slate-500">
                The AI verdict is a recommendation. Hover a card to preview its impact on the
                schedule; your decision moves the task.
              </p>
            </div>
            <button
              onClick={() => setOpen(false)}
              aria-label="Close reviews"
              className="text-slate-400 hover:text-slate-700"
            >
              <X size={16} />
            </button>
          </div>
          <div className="min-h-0 flex-1 space-y-3 overflow-auto p-4">
            {queue.length === 0 && (
              <p className="pt-8 text-center text-xs text-slate-400">
                Nothing to review. New contractor updates appear here.
              </p>
            )}
            {queue.map((item) => (
              <ReviewCard key={item.report.id} item={item} />
            ))}
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

function ReviewCard({ item }: { item: QueueItem }) {
  const decide = useJenga((s) => s.decide);
  const setPreview = useJenga((s) => s.setPreviewReport);
  const isTarget = useJenga((s) => s.reviewTargetId === item.report.id);
  const ref = useRef<HTMLDivElement>(null);
  const { report } = item;

  // A card that goes away under the pointer (decided, or its rail closed) never
  // sees `mouseleave`, so clear its hover here or the preview would stay stuck on it.
  useEffect(
    () => () => {
      const state = useJenga.getState();
      if (state.previewReportId === item.report.id) state.setPreviewReport(null);
    },
    [item.report.id],
  );

  // Opened from a schedule badge: bring this card into view.
  useEffect(() => {
    if (isTarget) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [isTarget]);
  const verdict = report.verdict;
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const aiApproved = verdict?.status === 'APPROVED';

  async function act(decision: 'approve' | 'deny') {
    // Same rule the API enforces; checked here so the reason shows beside the box.
    if ((decision === 'deny' || !aiApproved) && !note.trim()) {
      setError(
        decision === 'deny'
          ? 'Say why you are denying, so the contractor can fix it.'
          : 'The AI did not approve this. Add a note explaining your override.',
      );
      return;
    }
    setWorking(true);
    setError(await decide(report.id, decision, note));
    setWorking(false);
  }

  return (
    <div
      ref={ref}
      onMouseEnter={() => setPreview(report.id)}
      onMouseLeave={() => setPreview(null)}
      className={`rounded-lg border bg-white p-3 transition-shadow ${
        isTarget ? 'border-slate-400 ring-2 ring-slate-900/15' : 'border-slate-200'
      }`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-slate-900">{item.task_name}</span>
        <span className="font-mono text-[10px] text-slate-400">{displayId(report.task_id)}</span>
      </div>
      <p className="text-[10px] text-slate-400">
        {item.project_name}
        {report.submitted_at && ` · ${new Date(report.submitted_at).toLocaleString()}`}
      </p>

      <p className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-2 text-[11px] leading-relaxed text-slate-600">
        {report.report_text}
      </p>

      {verdict && (
        <div className="mt-2 rounded border border-slate-200 p-2">
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wide text-slate-400">AI recommendation</span>
            <span className={`rounded border px-1.5 py-0.5 font-mono text-[9px] ${AI_CHIP[verdict.status]}`}>
              {verdict.status.replace('_', ' ')}
            </span>
            <span className="font-mono text-[10px] text-slate-400">
              {Math.round(verdict.confidence * 100)}%
            </span>
            {verdict.gptzero.flagged && (
              <span className="rounded border border-red-300 px-1.5 py-0.5 font-mono text-[9px] text-red-600">
                AI-written?
              </span>
            )}
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-slate-600">{verdict.reasoning}</p>
          {verdict.actionable_request && (
            <p className="mt-1 text-[11px] italic text-slate-500">{verdict.actionable_request}</p>
          )}
          {verdict.vision.observation && (
            <p className="mt-1.5 text-[11px] leading-relaxed text-slate-600">
              <span className="font-medium text-slate-700">
                {verdict.vision.media_type === 'video' ? 'Video analysis: ' : 'Visual analysis: '}
              </span>
              {verdict.vision.observation}
            </p>
          )}
        </div>
      )}

      {report.media_url && (
        <video
          src={mediaUrl(report.media_url)}
          controls
          className="mt-2 max-h-48 w-full rounded border border-slate-200 bg-black"
        />
      )}

      {item.impact && <DenialImpact impact={item.impact} />}

      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder={
          aiApproved
            ? 'Note (required to deny)'
            : 'Note (required: to deny, or to approve against the AI)'
        }
        rows={2}
        className="mt-2 w-full resize-none rounded-md border border-slate-200 px-2 py-1.5 text-[11px] text-slate-700 placeholder:text-slate-300"
      />
      {error && <p className="mt-1 text-[11px] text-red-600">{error}</p>}
      <div className="mt-2 flex gap-2">
        <button
          disabled={working}
          onClick={() => void act('approve')}
          className="flex-1 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-700 disabled:opacity-50"
        >
          Approve
        </button>
        <button
          disabled={working}
          onClick={() => void act('deny')}
          className="flex-1 rounded-md border border-red-300 px-3 py-1.5 text-xs font-medium text-red-700 transition-colors hover:bg-red-50 disabled:opacity-50"
        >
          Deny
        </button>
      </div>
    </div>
  );
}

/** "If you deny": what the denial does to the schedule, before the owner decides. */
function DenialImpact({ impact }: { impact: Impact }) {
  const breach = impact.days_past_deadline > 0;
  return (
    <div className="mt-2 rounded border border-slate-200 p-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wide text-slate-400">If you deny</span>
        <span className="font-mono text-[11px] font-medium text-slate-800">
          +{impact.rework_days}d rework
        </span>
      </div>
      <ul className="mt-1 list-disc pl-4 text-[11px] leading-relaxed text-slate-500">
        {impact.rationale.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>

      <div
        className={`mt-2 rounded px-2 py-1.5 text-[11px] ${
          breach
            ? 'bg-red-50 text-red-700'
            : impact.absorbed_by_float
              ? 'bg-emerald-50 text-emerald-700'
              : 'bg-amber-50 text-amber-700'
        }`}
      >
        {breach ? (
          <>
            Project finishes <b>{formatDate(impact.predicted_finish_date)}</b>, {impact.days_past_deadline}{' '}
            {impact.days_past_deadline === 1 ? 'day' : 'days'} past the {formatDate(impact.project_deadline_date)}{' '}
            deadline.
          </>
        ) : impact.absorbed_by_float ? (
          <>
            Absorbed by float ({impact.float_consumed} {impact.float_consumed === 1 ? 'day' : 'days'} used).
            Project still finishes {formatDate(impact.baseline_finish_date)}.
          </>
        ) : (
          <>
            Project slips {impact.project_slipped_days}d to {formatDate(impact.predicted_finish_date)}, within
            the {formatDate(impact.project_deadline_date)} deadline.
          </>
        )}
        {impact.critical_path_changed && ' The critical path changes.'}
      </div>

      {impact.affected.length > 0 && (
        <table className="mt-2 w-full text-[10px] text-slate-500">
          <thead>
            <tr className="text-left text-slate-400">
              <th className="font-normal">Task</th>
              <th className="font-normal">Finish</th>
              <th className="font-normal">Due</th>
            </tr>
          </thead>
          <tbody>
            {impact.affected.map((a) => (
              <tr key={a.id}>
                <td className="max-w-[140px] truncate pr-2">{a.name}</td>
                <td className="whitespace-nowrap pr-2">
                  {formatDate(a.finish_date_before)} → {formatDate(a.finish_date_after)}
                </td>
                <td className={`whitespace-nowrap ${a.late_by_days > 0 ? 'text-red-600' : ''}`}>
                  {a.due_date ? formatDate(a.due_date) : '—'}
                  {a.late_by_days > 0 && ` (+${a.late_by_days}d late)`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
