'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, Check, HelpCircle, X } from 'lucide-react';
import { useJenga } from '@/store/useJenga';
import type { Verdict } from '@/lib/types';

const STATUS_STYLE = {
  APPROVED: {
    ring: 'border-emerald-500/60',
    text: 'text-emerald-300',
    bg: 'bg-emerald-950/30',
    Icon: Check,
    blurb: 'Evidence corroborates the claim.',
  },
  DISPUTED: {
    ring: 'border-red-500/60',
    text: 'text-red-300',
    bg: 'bg-red-950/30',
    Icon: X,
    blurb: 'Evidence contradicts the claim.',
  },
  UNDER_REVIEW: {
    ring: 'border-amber-500/70',
    text: 'text-amber-300',
    bg: 'bg-amber-950/30',
    Icon: HelpCircle,
    blurb: 'Evidence is insufficient to rule. Auto-approval refused.',
  },
} as const;

export function VerdictPanel() {
  const verdict = useJenga((s) => s.verdict);
  const sideEffect = useJenga((s) => s.sideEffect);
  const clear = useJenga((s) => s.clearVerdict);
  const runDispute = useJenga((s) => s.runDispute);
  const busy = useJenga((s) => s.busy);

  return (
    <AnimatePresence>
      {verdict && (
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 16 }}
          className="absolute bottom-4 left-4 right-4 z-20 max-h-[52%] overflow-auto rounded-lg border border-slate-600 bg-slate-950/95 p-4 backdrop-blur"
        >
          <Header verdict={verdict} onClose={clear} />

          <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-4">
            <Column title="Blueprint specification" body={verdict.evidence.spec} />
            <Column
              title="Contractor claim"
              body={verdict.evidence.claim}
              footer={
                verdict.gptzero.flagged
                  ? `⚠ ${Math.round(verdict.gptzero.ai_probability * 100)}% AI-generated — auto-approval blocked`
                  : `${Math.round(verdict.gptzero.ai_probability * 100)}% AI probability — human-authored`
              }
              footerTone={verdict.gptzero.flagged ? 'bad' : 'ok'}
            />
            <Column
              title="Visual analysis"
              body={verdict.evidence.visual}
              footer={visionFooter(verdict)}
              footerTone={
                verdict.vision.matches_claim === null
                  ? 'warn'
                  : verdict.vision.matches_claim
                    ? 'ok'
                    : 'bad'
              }
            />
            <Column title="Historical comparison" body={verdict.evidence.historical} />
          </div>

          <Reasoning verdict={verdict} />

          {sideEffect && (
            <p className="mt-3 rounded border border-sky-700/60 bg-sky-950/40 p-2 text-xs text-sky-200">
              <span className="font-semibold">Procurement · </span>
              {sideEffect}
            </p>
          )}

          {/*
            The agent refuses to auto-approve; a human closes the loop. This is the
            hand-off the product argues for, so it must be reachable from both a
            contradiction (DISPUTED) and a refusal-to-rule (UNDER_REVIEW).
          */}
          {verdict.status !== 'APPROVED' && (
            <div className="mt-3 flex items-center gap-2">
              <button
                disabled={busy}
                onClick={() =>
                  runDispute(
                    verdict.task_id,
                    4,
                    verdict.status === 'DISPUTED'
                      ? 'Visual evidence contradicts claimed progress.'
                      : 'Manual audit confirmed shortfall against claim.',
                  )
                }
                className="rounded bg-red-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
              >
                {busy ? 'Propagating…' : 'PM confirms 4-day slip & propagate →'}
              </button>
              <span className="text-[10px] text-slate-500">
                Recomputes float, cascades downstream, writes the attribution.
              </span>
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function visionFooter(v: Verdict): string {
  const pct = Math.round(v.vision.confidence * 100);
  if (v.vision.matches_claim === null) return `Cannot establish — ${pct}% confidence`;
  return v.vision.matches_claim
    ? `Consistent with claim — ${pct}% confidence`
    : `Contradicts claim — ${pct}% confidence`;
}

function Header({ verdict, onClose }: { verdict: Verdict; onClose: () => void }) {
  const s = STATUS_STYLE[verdict.status];
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex items-center gap-2.5">
        <span className={`rounded-full border p-1.5 ${s.ring} ${s.bg} ${s.text}`}>
          <s.Icon size={16} />
        </span>
        <div>
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-xs text-slate-400">{verdict.task_id}</span>
            <span className={`text-sm font-semibold ${s.text}`}>
              {verdict.status.replace('_', ' ')}
            </span>
            <span className="font-mono text-xs text-slate-400">
              confidence {verdict.confidence.toFixed(2)}
            </span>
          </div>
          <p className="text-[11px] text-slate-400">{s.blurb}</p>
        </div>
      </div>
      <button onClick={onClose} className="text-slate-500 hover:text-slate-300">
        <X size={16} />
      </button>
    </div>
  );
}

function Column({
  title,
  body,
  footer,
  footerTone = 'neutral',
}: {
  title: string;
  body: string;
  footer?: string;
  footerTone?: 'ok' | 'bad' | 'warn' | 'neutral';
}) {
  const tone = {
    ok: 'text-emerald-300',
    bad: 'text-red-300',
    warn: 'text-amber-300',
    neutral: 'text-slate-400',
  }[footerTone];

  return (
    <div className="rounded border border-slate-700 bg-slate-900/60 p-2.5">
      <h4 className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">{title}</h4>
      <p className="text-[11px] leading-relaxed text-slate-300">{body}</p>
      {footer && <p className={`mt-1.5 text-[10px] ${tone}`}>{footer}</p>}
    </div>
  );
}

/**
 * The reasoning block is the point of the whole product: when the system will
 * not rule, it has to say why in language a project manager could take to a
 * dispute. Rendered largest in exactly that case.
 */
function Reasoning({ verdict }: { verdict: Verdict }) {
  const isRefusal = verdict.status === 'UNDER_REVIEW';
  return (
    <div
      className={`mt-3 rounded border p-3 ${
        isRefusal ? 'border-amber-500/60 bg-amber-950/25' : 'border-slate-700 bg-slate-900/60'
      }`}
    >
      {isRefusal && (
        <div className="mb-1.5 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-amber-400">
          <AlertTriangle size={12} />
          Declined to rule
        </div>
      )}
      <p
        className={`leading-relaxed ${
          isRefusal ? 'text-sm text-amber-100' : 'text-xs text-slate-300'
        }`}
      >
        {verdict.reasoning}
      </p>
      {verdict.actionable_request && (
        <p className="mt-2 border-t border-amber-500/25 pt-2 text-xs text-amber-200">
          <span className="font-semibold">Required · </span>
          {verdict.actionable_request}
        </p>
      )}
    </div>
  );
}
