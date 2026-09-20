'use client';

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, FileText, X } from 'lucide-react';
import { displayId, formatDate } from '@/lib/format';
import { mediaUrl } from '@/lib/api';
import type { Impact, QueueItem, Verdict, VerdictStatus } from '@/lib/types';
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
      disabled={queue.length === 0}
      aria-pressed={open}
      className="flex items-center gap-1.5 rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-slate-900"
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
          className="flex h-full w-[560px] shrink-0 flex-col border-l border-slate-200 bg-white"
        >
          <div className="flex shrink-0 items-center justify-end border-b border-slate-200 px-4 py-3">
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

/**
 * How the authorship score is being *used*, which is a different question
 * from how high it is: strict mode blocks on a flagged report, lenient mode
 * records it and lets the other sources rule. Nothing here may claim the
 * score blocked anything when the verdict came back APPROVED. Harvested from
 * the old (unreachable) VerdictPanel's `authorship()`.
 */
function authorshipRead(v: Verdict): { line: string; tone: 'ok' | 'warn' | 'bad' } {
  const pct = Math.round(v.gptzero.ai_probability * 100);
  if (!v.gptzero.flagged) {
    return { line: `${pct}% AI probability — reads as first-hand`, tone: 'ok' };
  }
  // `bad` means the gate blocked this verdict; `warn` means the score was
  // recorded but the other sources ruled. Offline there is no trace, so fall
  // back to the status — approximate, but it still cannot claim a block
  // underneath an approval.
  const card = v.trace?.find((s) => s.node === 'gptzero_gate');
  const gating = card ? card.signal === 'bad' : v.status !== 'APPROVED';
  if (!gating) {
    return {
      line:
        v.status === 'APPROVED'
          ? `${pct}% AI-generated — advisory only, did not block approval`
          : `${pct}% AI-generated — advisory only, not the deciding factor`,
      tone: 'warn',
    };
  }
  return { line: `${pct}% AI-generated — auto-approval blocked`, tone: 'bad' };
}

/** The evidence's read on the claim, media-aware. Harvested from the old
 * VerdictPanel's `sourceReads()` visual-analysis row. */
function evidenceRead(v: Verdict): { line: string; tone: 'ok' | 'warn' | 'bad' } {
  const vc = Math.round(v.vision.confidence * 100);
  if (v.vision.matches_claim === null) return { line: `Cannot establish · ${vc}%`, tone: 'warn' };
  return v.vision.matches_claim
    ? { line: `Consistent with claim · ${vc}%`, tone: 'ok' }
    : { line: `Contradicts claim · ${vc}%`, tone: 'bad' };
}

const TONE_TEXT: Record<'ok' | 'warn' | 'bad', string> = {
  ok: 'text-emerald-700',
  warn: 'text-amber-700',
  bad: 'text-red-700',
};

function ReviewCard({ item }: { item: QueueItem }) {
  const decide = useJenga((s) => s.decide);
  const setPreview = useJenga((s) => s.setPreviewReport);
  const isTarget = useJenga((s) => s.reviewTargetId === item.report.id);
  const ref = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
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
  const [dialogContent, setDialogContent] = useState<'report' | 'photo' | null>(null);

  useEffect(() => {
    if (dialogContent) dialogRef.current?.showModal();
    else dialogRef.current?.close();
  }, [dialogContent]);

  const aiApproved = verdict?.status === 'APPROVED';
  const isRefusal = verdict?.status === 'UNDER_REVIEW';
  const isVideo = verdict?.vision.media_type === 'video';
  const auth = verdict && authorshipRead(verdict);
  const evidence = verdict && evidenceRead(verdict);

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

      {/* Recommendation + attached documentation, one container. */}
      <div className="mt-2 rounded border border-slate-200 p-2">
        {verdict && auth && evidence && (
          <>
            <div className="flex items-center gap-2">
              <span className="text-[10px] uppercase tracking-wide text-slate-400">AI recommendation</span>
              <span className={`rounded border px-1.5 py-0.5 font-mono text-[9px] ${AI_CHIP[verdict.status]}`}>
                {verdict.status.replace('_', ' ')}
              </span>
              <span className="font-mono text-[10px] text-slate-400">
                {Math.round(verdict.confidence * 100)}%
              </span>
            </div>

            <div className="mt-1.5 flex flex-col gap-0.5">
              <p className={`text-[10px] font-medium ${TONE_TEXT[auth.tone]}`}>
                Authorship: {auth.line}
              </p>
              <p className={`text-[10px] font-medium ${TONE_TEXT[evidence.tone]}`}>
                {isVideo ? 'Video' : 'Photo'}: {evidence.line}
              </p>
            </div>

            <div className="mt-2 rounded p-2">
              {isRefusal && (
                <div className="mb-1 flex items-center gap-1 text-[9px] uppercase tracking-wide text-amber-600">
                  <AlertTriangle size={10} />
                  Declined to rule
                </div>
              )}
              <p className="text-[11px] leading-relaxed text-slate-600">{verdict.reasoning}</p>
            </div>
          </>
        )}

        <div className={verdict ? 'mt-3' : ''}>
          <span className="text-[10px] uppercase tracking-wide text-slate-400">Attached documentation</span>
          <div className="mt-1.5 flex flex-col gap-2">
            {report.media_url &&
              (isVideo ? (
                <video
                  src={mediaUrl(report.media_url)}
                  controls
                  className="h-40 w-full rounded border border-slate-200 bg-black object-contain"
                />
              ) : (
                <img
                  src={mediaUrl(report.media_url)}
                  alt="Submitted evidence"
                  onClick={() => setDialogContent('photo')}
                  className="h-40 w-full cursor-zoom-in rounded border border-slate-200 object-cover"
                />
              ))}

            {/* The attached report — open the original document, or the full text. */}
            <button
              onClick={() => setDialogContent('report')}
              className="flex w-full items-center gap-1.5 rounded border border-slate-200 p-2 text-left text-[11px] text-slate-600 hover:bg-slate-50"
            >
              <FileText size={12} className="shrink-0 text-slate-400" />
              <span className="truncate">{report.report_filename ?? 'Open report'}</span>
            </button>
          </div>
        </div>
      </div>

      {/* 4 · If you deny — the cost of denying, before the owner decides. */}
      {item.impact && <DenialImpact impact={item.impact} />}

      {/* 5 · Your decision */}
      <p className="mt-3 text-[10px] uppercase tracking-wide text-slate-400">Your decision</p>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder={
          aiApproved
            ? 'Note (required to deny)'
            : 'Note (required: to deny, or to approve against the AI)'
        }
        rows={2}
        className="mt-1 w-full resize-none rounded-md border border-slate-200 px-2 py-1.5 text-[11px] text-slate-700 placeholder:text-slate-300"
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

      <dialog
        ref={dialogRef}
        onClose={() => setDialogContent(null)}
        className="fixed top-1/2 left-1/2 m-0 w-[min(90vw,760px)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-slate-200 bg-white p-0 shadow-xl backdrop:bg-slate-900/50"
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
          <span className="truncate text-xs font-medium text-slate-700">
            {dialogContent === 'photo' ? 'Submitted photo' : (report.report_filename ?? 'Report')}
          </span>
          <button
            onClick={() => dialogRef.current?.close()}
            aria-label="Close preview"
            className="shrink-0 text-slate-400 hover:text-slate-700"
          >
            <X size={14} />
          </button>
        </div>
        <div className="max-h-[80vh] overflow-auto p-3">
          {dialogContent === 'photo' && report.media_url && (
            <img src={mediaUrl(report.media_url)} alt="Submitted evidence" className="max-w-full rounded" />
          )}
          {dialogContent === 'report' &&
            (report.report_url ? (
              <iframe
                src={mediaUrl(report.report_url)}
                className="h-[70vh] w-[70vw] max-w-full rounded border border-slate-200"
                title={report.report_filename ?? 'Report'}
              />
            ) : (
              <pre className="whitespace-pre-wrap text-xs leading-relaxed text-slate-700">
                {report.report_text}
              </pre>
            ))}
        </div>
      </dialog>
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
