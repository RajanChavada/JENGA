'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, Check, Cpu, HelpCircle, Loader2, X } from 'lucide-react';
import { paceCard } from '@/lib/fixtures';
import { useJenga } from '@/store/useJenga';
import { displayId } from '@/lib/format';
import type { Verdict, VerdictStep } from '@/lib/types';

/* -------------------------------------------------------------------------- */
/* Live agent pipeline — shown while the agent is verifying, before a verdict  */
/* -------------------------------------------------------------------------- */

const PIPELINE = [
  { node: 'gptzero_gate', title: 'Authorship gate', work: 'scoring AI-authorship' },
  { node: 'vision_analysis', title: 'Visual analysis', work: 'reading the site photo' },
  { node: 'historical_memory', title: 'Historical memory', work: 'retrieving similar work' },
  { node: 'pace_check', title: 'Site pace', work: 'reading the earned-schedule stream' },
  { node: 'arbiter', title: 'Arbiter', work: 'resolving the sources' },
];

/**
 * Makes the agentic work legible: when a submission is verifying, the four
 * evidence nodes and the arbiter light up in sequence, so the pipeline is
 * something you watch run rather than a result that just appears. Suppressed
 * during a dispute cascade (`cascading`) and the moment a verdict lands.
 */
export function AgentRunning() {
  const busy = useJenga((s) => s.busy);
  const cascading = useJenga((s) => s.cascading);
  const verdict = useJenga((s) => s.verdict);
  const show = busy && !cascading && !verdict;

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
        >
          <div className="mb-3 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-slate-500">
            <Loader2 size={12} className="animate-spin text-slate-500" />
            Agent verifying · four evidence sources, one arbiter
          </div>
          {/* One column: the pipeline lives in a narrow right rail now, so the
              five nodes read top-to-bottom as a sequence rather than a strip. */}
          <ol className="flex flex-col gap-2">
            {PIPELINE.map((s, i) => (
              <motion.li
                key={s.node}
                initial={{ opacity: 0.4 }}
                animate={{ opacity: [0.4, 1, 0.4] }}
                transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.18, ease: 'easeInOut' }}
                className="rounded-md border border-slate-200 bg-slate-50 p-2"
              >
                <div className="flex items-center gap-1.5">
                  <motion.span
                    className="h-2 w-2 rounded-full bg-sky-500"
                    animate={{ scale: [1, 1.4, 1] }}
                    transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.18, ease: 'easeInOut' }}
                  />
                  <span className="text-[11px] font-semibold text-slate-700">
                    {i + 1} · {s.title}
                  </span>
                </div>
                <p className="mt-1 text-[10px] text-slate-400">{s.work}…</p>
              </motion.li>
            ))}
          </ol>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

const STATUS_STYLE = {
  APPROVED: {
    ring: 'border-emerald-300',
    text: 'text-emerald-700',
    bg: 'bg-emerald-50',
    Icon: Check,
    blurb: 'Evidence corroborates the claim.',
  },
  DISPUTED: {
    ring: 'border-red-300',
    text: 'text-red-700',
    bg: 'bg-red-50',
    Icon: X,
    blurb: 'Evidence contradicts the claim.',
  },
  UNDER_REVIEW: {
    ring: 'border-amber-300',
    text: 'text-amber-700',
    bg: 'bg-amber-50',
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
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
        >
          <Header verdict={verdict} onClose={clear} />

          {/* The conclusion leads — it is the point of the panel. */}
          <Reasoning verdict={verdict} />

          {/* One strip, five sources: the agent's read on each, folded into the
              evidence itself rather than repeated as a separate trace row. */}
          <EvidenceStrip verdict={verdict} />

          {sideEffect && (
            <p className="mt-3 rounded-lg border border-sky-200 bg-sky-50 p-2 text-xs text-sky-800">
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
                className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-500 disabled:opacity-50"
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

/* -------------------------------------------------------------------------- */
/* Agent trace — the Rox beat made visible                                    */
/* -------------------------------------------------------------------------- */

type Signal = VerdictStep['signal'];

const SIGNAL_DOT: Record<Signal, string> = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  bad: 'bg-red-500',
  info: 'bg-slate-300',
};

const SIGNAL_TEXT: Record<Signal, string> = {
  ok: 'text-emerald-700',
  warn: 'text-amber-700',
  bad: 'text-red-700',
  info: 'text-slate-400',
};

interface SourceRead {
  title: string;
  /** The one-line finding — the agent's read on this source. */
  finding: string | null;
  signal: Signal;
  detail: string;
}

/** The five evidence sources, each with the agent's read folded in. */
function sourceReads(v: Verdict): SourceRead[] {
  const auth = authorship(v);
  const vc = Math.round(v.vision.confidence * 100);
  const vSignal: Signal =
    v.vision.matches_claim === null ? 'warn' : v.vision.matches_claim ? 'ok' : 'bad';

  return [
    {
      title: 'Blueprint spec',
      finding: null,
      signal: 'info',
      detail: v.evidence.spec,
    },
    {
      title: 'Contractor claim',
      finding: auth.footer,
      signal: auth.tone,
      detail: v.evidence.claim,
    },
    {
      title: 'Visual analysis',
      finding:
        v.vision.matches_claim === null
          ? `Cannot establish · ${vc}%`
          : v.vision.matches_claim
            ? `Consistent · ${vc}%`
            : `Contradicts · ${vc}%`,
      signal: vSignal,
      detail: v.evidence.visual,
    },
    {
      title: 'Historical',
      finding: null,
      signal: 'info',
      detail: v.evidence.historical || 'No close historical match found.',
    },
    paceRead(v),
  ];
}

/** Site pace as a source read, mirroring the pace payload's own verdict. */
function paceRead(v: Verdict): SourceRead {
  const p = v.pace;
  if (!p || !p.samples || p.spi === null) {
    return {
      title: 'Site pace',
      finding: 'No history',
      signal: 'info',
      detail: 'No site-pace history on record for this project yet.',
    };
  }
  const where = p.source === 'tiger' ? 'Tiger Data' : 'Simulated store';
  const { detail, signal } = paceCard(p);
  if (p.samples < (p.min_samples || 5)) {
    return {
      title: 'Site pace',
      finding: `${p.samples}/${p.min_samples} events — too thin`,
      signal: 'info',
      detail: `${detail} · ${where}.`,
    };
  }
  return {
    title: 'Site pace',
    finding: p.flagged
      ? `Claim outruns SPI ${p.spi.toFixed(2)}`
      : `SPI ${p.spi.toFixed(2)} — consistent`,
    signal,
    detail: `${detail} · ${where}.`,
  };
}

/**
 * The five evidence sources as one comparison strip. Replaces the old separate
 * trace row plus five cards: the agent's read on each source lives in that
 * source's own column, so the reasoning is legible without repeating itself.
 */
function EvidenceStrip({ verdict }: { verdict: Verdict }) {
  const reads = sourceReads(verdict);
  return (
    <section className="mt-3 overflow-hidden rounded-lg border border-slate-200">
      <div className="flex items-center gap-1.5 border-b border-slate-200 bg-slate-50 px-3 py-1.5 text-[10px] uppercase tracking-wider text-slate-400">
        <Cpu size={12} />
        Agent resolution · four evidence sources, one arbiter
      </div>
      {/* Stacked, not a strip: this now lives in a ~360px rail, so five columns
          would be unreadable. Each source is its own row with the agent's read. */}
      <div className="grid grid-cols-1 divide-y divide-slate-200">
        {reads.map((r) => (
          <div key={r.title} className="min-w-0 px-3 py-2.5">
            <div className="flex items-center gap-1.5">
              {r.signal !== 'info' && (
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${SIGNAL_DOT[r.signal]}`} />
              )}
              <h4 className="text-[10px] uppercase tracking-wider text-slate-400">{r.title}</h4>
            </div>
            {r.finding && (
              <p className={`mt-1 text-[10px] font-medium ${SIGNAL_TEXT[r.signal]}`}>
                {r.finding}
              </p>
            )}
            <p className="mt-1 text-[10px] leading-relaxed text-slate-600">{r.detail}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * How the authorship score is being *used*, which is a different question from
 * how high it is. Strict mode blocks on a flagged report; lenient mode records
 * it and lets the other sources rule. So nothing here may claim the score
 * blocked anything when the verdict came back APPROVED — that contradiction,
 * rendered in red under an approval, is the one thing this panel must not do.
 * Footer and trace card share this so they cannot drift apart.
 */
function authorship(v: Verdict): {
  footer: string;
  tone: 'ok' | 'warn' | 'bad';
  traceDetail: string;
} {
  const pct = Math.round(v.gptzero.ai_probability * 100);
  if (!v.gptzero.flagged) {
    return {
      footer: `${pct}% AI probability — human-authored`,
      tone: 'ok',
      traceDetail: `Report scores ${pct}% AI-authorship — reads as first-hand.`,
    };
  }

  // The backend's own authorship card already knows which mode ran: `bad`
  // means the gate blocked this verdict, `warn` means the score was recorded
  // and the other sources ruled. Prefer it, since a lenient hold that came
  // from the photograph is not a block by the gate. Offline there is no
  // trace, so fall back to the status — approximate, but it still cannot
  // claim a block underneath an approval.
  const card = v.trace?.find((s) => s.node === 'gptzero_gate');
  const gating = card ? card.signal === 'bad' : v.status !== 'APPROVED';

  if (!gating) {
    return {
      footer:
        v.status === 'APPROVED'
          ? `⚠ ${pct}% AI-generated — advisory only, did not block approval`
          : `⚠ ${pct}% AI-generated — advisory only, not the deciding factor`,
      tone: 'warn',
      traceDetail: `Report scores ${pct}% AI-authorship — flagged, advisory only — not gating this verdict.`,
    };
  }
  return {
    footer: `⚠ ${pct}% AI-generated — auto-approval blocked`,
    tone: 'bad',
    traceDetail: `Report scores ${pct}% AI-authorship — flagged, cannot auto-approve on prose.`,
  };
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
            <span className="font-mono text-xs text-slate-400">{displayId(verdict.task_id)}</span>
            <span className={`text-sm font-semibold ${s.text}`}>
              {verdict.status.replace('_', ' ')}
            </span>
            <span className="font-mono text-xs text-slate-400">
              confidence {verdict.confidence.toFixed(2)}
            </span>
          </div>
          <p className="text-[11px] text-slate-500">{s.blurb}</p>
        </div>
      </div>
      <button onClick={onClose} className="text-slate-400 hover:text-slate-700">
        <X size={16} />
      </button>
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
      className={`mt-3 rounded-lg border p-3 ${
        isRefusal ? 'border-amber-300 bg-amber-50' : 'border-slate-200 bg-slate-50'
      }`}
    >
      {isRefusal && (
        <div className="mb-1.5 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-amber-600">
          <AlertTriangle size={12} />
          Declined to rule
        </div>
      )}
      <p
        className={`leading-relaxed ${
          isRefusal ? 'text-sm text-amber-900' : 'text-xs text-slate-700'
        }`}
      >
        {verdict.reasoning}
      </p>
      {verdict.actionable_request && (
        <p className="mt-2 border-t border-amber-300/60 pt-2 text-xs text-amber-800">
          <span className="font-semibold">Required · </span>
          {verdict.actionable_request}
        </p>
      )}
    </div>
  );
}
