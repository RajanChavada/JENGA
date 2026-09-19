'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, Check, Cpu, HelpCircle, X } from 'lucide-react';
import { useJenga } from '@/store/useJenga';
import type { Verdict, VerdictStep } from '@/lib/types';

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
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 16 }}
          className="absolute bottom-4 left-4 right-4 z-20 max-h-[52%] overflow-auto rounded-xl border border-slate-200 bg-white/95 p-4 shadow-lg backdrop-blur"
        >
          <Header verdict={verdict} onClose={clear} />

          <AgentTrace verdict={verdict} />

          <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-4">
            <Column title="Blueprint specification" body={verdict.evidence.spec} />
            <ClaimColumn verdict={verdict} />
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

const SIGNAL_DOT: Record<VerdictStep['signal'], string> = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  bad: 'bg-red-500',
  info: 'bg-slate-400',
};

/**
 * Derive the four-node trace from the verdict when the backend didn't send one
 * (pure-fixtures / offline mode), so the agent's reasoning is always visible.
 */
function synthesizeTrace(v: Verdict): VerdictStep[] {
  const vc = Math.round(v.vision.confidence * 100);
  const m = v.vision.matches_claim;

  const vision: VerdictStep =
    m === true
      ? { node: 'vision_analysis', title: '2 · Visual analysis', detail: `Photo is consistent with the claim (${vc}% confidence).`, signal: 'ok' }
      : m === false
        ? { node: 'vision_analysis', title: '2 · Visual analysis', detail: `Photo contradicts the claim (${vc}% confidence).`, signal: 'bad' }
        : { node: 'vision_analysis', title: '2 · Visual analysis', detail: `Image cannot establish the claim (${vc}% confidence).`, signal: 'warn' };

  const arbiter: VerdictStep = {
    node: 'arbiter',
    title: '4 · Arbiter',
    detail:
      v.status === 'APPROVED'
        ? 'Sources agree — approved.'
        : v.status === 'DISPUTED'
          ? 'Sources conflict, evidence legible — disputed.'
          : 'Evidence insufficient — declined to rule, routed to a human.',
    signal: v.status === 'APPROVED' ? 'ok' : v.status === 'DISPUTED' ? 'bad' : 'warn',
  };

  const auth = authorship(v);

  return [
    {
      node: 'gptzero_gate',
      title: '1 · Authorship gate',
      detail: auth.traceDetail,
      signal: auth.tone,
    },
    vision,
    {
      node: 'historical_memory',
      title: '3 · Historical memory',
      detail: v.evidence.historical
        ? 'Compared against similar past work packages.'
        : 'No close historical match found.',
      signal: 'info',
    },
    arbiter,
  ];
}

function AgentTrace({ verdict }: { verdict: Verdict }) {
  const steps = verdict.trace && verdict.trace.length ? verdict.trace : synthesizeTrace(verdict);
  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="mb-2 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-slate-400">
        <Cpu size={12} />
        Agent resolution · four conflicting sources
      </div>
      <ol className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {steps.map((s, i) => (
          <motion.li
            key={s.node + i}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.06 }}
            className="relative rounded-md border border-slate-200 bg-white p-2"
          >
            <div className="flex items-center gap-1.5">
              <span className={`h-2 w-2 shrink-0 rounded-full ${SIGNAL_DOT[s.signal]}`} />
              <span className="text-[10px] font-semibold text-slate-700">{s.title}</span>
            </div>
            <p className="mt-1 text-[10px] leading-relaxed text-slate-500">{s.detail}</p>
          </motion.li>
        ))}
      </ol>
    </div>
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

function ClaimColumn({ verdict }: { verdict: Verdict }) {
  const a = authorship(verdict);
  return (
    <Column
      title="Contractor claim"
      body={verdict.evidence.claim}
      footer={a.footer}
      footerTone={a.tone}
    />
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
          <p className="text-[11px] text-slate-500">{s.blurb}</p>
        </div>
      </div>
      <button onClick={onClose} className="text-slate-400 hover:text-slate-700">
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
    ok: 'text-emerald-700',
    bad: 'text-red-700',
    warn: 'text-amber-700',
    neutral: 'text-slate-500',
  }[footerTone];

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-2.5">
      <h4 className="mb-1 text-[10px] uppercase tracking-wider text-slate-400">{title}</h4>
      <p className="text-[11px] leading-relaxed text-slate-700">{body}</p>
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
