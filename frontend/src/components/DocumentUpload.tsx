'use client';

import { useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { FileUp, Loader2, TriangleAlert, Zap } from 'lucide-react';
import * as api from '@/lib/api';
import type { AgentProcurementResult, ExtractedTasks, ParsedDoc } from '@/lib/api';
import { ZONE_LABEL } from '@/lib/theme';
import type { Zone } from '@/lib/types';
import { useJenga } from '@/store/useJenga';

/** What the agent does with an upload, shown while it happens. */
const PIPELINE_STEPS: Record<Mode, { label: string; work: string }[]> = {
  spec: [
    { label: 'Parse', work: 'extracting text from the document' },
    { label: 'Extract', work: 'AI reads work packages & dependencies' },
    { label: 'Propose', work: 'packages staged for planner review' },
  ],
  report: [
    { label: 'Parse', work: 'extracting the claim text' },
    { label: 'Stage', work: 'ready to run the 5-node verification' },
  ],
};

type Mode = 'report' | 'spec';

const ACCEPT = '.pdf,.doc,.docx,.txt,.md';

export function DocumentUpload({
  onReportText,
  reportActionLabel = 'Run verification →',
  initialMode = 'report',
}: {
  /**
   * Called with extracted text when a daily report is parsed and the user runs
   * it. Omitted on a site with no graph yet: there is nothing to verify a
   * report against, so that half of the component is not offered at all.
   */
  onReportText?: (text: string, filename: string, mediaUrl: string | null) => void;
  /** Label of the button that hands the extracted text to `onReportText`. */
  reportActionLabel?: string;
  /** Which tab opens first. Onboarding a new site starts on the blueprint. */
  initialMode?: Mode;
}) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const logActivity = useJenga((s) => s.logActivity);
  const updateActivity = useJenga((s) => s.updateActivity);
  const agentProcure = useJenga((s) => s.agentProcure);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doc, setDoc] = useState<ParsedDoc | null>(null);
  const [extracted, setExtracted] = useState<ExtractedTasks | null>(null);
  const [dragging, setDragging] = useState(false);
  /** The procurement agent's run for the current extraction, while/after it happens. */
  const [procuring, setProcuring] = useState(false);
  const [procured, setProcured] = useState<AgentProcurementResult | null>(null);
  const [procureError, setProcureError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function procure() {
    if (!extracted || extracted.tasks.length === 0 || procuring) return;
    setProcuring(true);
    setProcureError(null);
    const result = await agentProcure(extracted.tasks, extracted.filename);
    setProcuring(false);
    if (result) setProcured(result);
    else
      setProcureError(
        'The procurement agent did not reach the backend. Is it running on :8000?',
      );
  }

  async function handle(file: File) {
    setBusy(true);
    setError(null);
    setDoc(null);
    setExtracted(null);
    setProcured(null);
    setProcureError(null);
    const ev = logActivity({
      source: 'documents',
      status: 'running',
      title:
        mode === 'spec'
          ? `Extracting work packages from ${file.name}`
          : `Parsing ${file.name} for a claim`,
      detail:
        mode === 'spec'
          ? 'Parse → AI extraction → proposal. The live schedule is not modified.'
          : 'Parse → stage the claim for the verification pipeline.',
    });
    try {
      if (mode === 'spec') {
        const ext = await api.extractTasks(file);
        setExtracted(ext);
        updateActivity(
          ev,
          ext.source === 'rejected'
            ? {
                status: 'warn',
                title: `${file.name} rejected — not a construction document`,
                detail: ext.notes,
              }
            : ext.tasks.length === 0
              ? {
                  status: 'warn',
                  title: `No work packages found in ${file.name}`,
                  detail: ext.notes,
                }
              : {
                  status: 'ok',
                  title: `${ext.tasks.length} work packages proposed from ${file.name}`,
                  detail:
                    ext.source === 'llm'
                      ? 'Model-extracted. Staged for planner review — schedule unchanged.'
                      : 'Offline heuristic extraction. Staged for planner review.',
                },
        );
      } else {
        const parsed = await api.parseDocument(file);
        setDoc(parsed);
        updateActivity(ev, {
          status: 'ok',
          title: `${file.name} parsed — claim ready to verify`,
          detail: `${parsed.char_count.toLocaleString()} characters extracted. Press "Run verification" to hand it to the agent.`,
        });
      }
    } catch (e) {
      updateActivity(ev, {
        status: 'error',
        title: `Upload of ${file.name} failed`,
      });
      setError(
        e instanceof Error
          ? `${e.message}. Is the backend running on :8000?`
          : 'Upload failed.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        {/* One mode, no tabs: an unonboarded site can only take a blueprint. */}
        {onReportText &&
          (
            [
              ['report', 'Daily report'],
              ['spec', 'Spec / blueprint'],
            ] as [Mode, string][]
          ).map(([m, label]) => (
            <button
              key={m}
              onClick={() => {
                setMode(m);
                setDoc(null);
                setExtracted(null);
                setError(null);
                setProcured(null);
                setProcureError(null);
              }}
              className={`rounded-md px-2.5 py-1 text-[11px] transition-colors ${
                mode === m
                  ? 'bg-slate-900 text-white'
                  : 'border border-slate-200 text-slate-500 hover:bg-slate-50'
              }`}
            >
              {label}
            </button>
          ))}
        <span className="ml-auto text-[10px] text-slate-400">
          PDF · DOCX · TXT · MD
        </span>
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const f = e.dataTransfer.files?.[0];
          if (f) void handle(f);
        }}
        onClick={() => inputRef.current?.click()}
        className={`flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed py-7 transition-colors ${
          dragging
            ? 'border-slate-400 bg-slate-100'
            : 'border-slate-300 bg-slate-50 hover:border-slate-400 hover:bg-white'
        }`}
      >
        {busy ? (
          <Loader2 size={18} className="animate-spin text-slate-500" />
        ) : (
          <FileUp size={18} className="text-slate-400" />
        )}
        {busy ? (
          /* The agent's steps, named while they run — the upload is agentic
             work, and it should look like it. */
          <ol className="flex items-center gap-2">
            {PIPELINE_STEPS[mode].map((s, i) => (
              <motion.li
                key={s.label}
                initial={{ opacity: 0.35 }}
                animate={{ opacity: [0.35, 1, 0.35] }}
                transition={{
                  duration: 1.2,
                  repeat: Infinity,
                  delay: i * 0.3,
                  ease: 'easeInOut',
                }}
                className="flex items-center gap-1 text-[10px] text-slate-600"
                title={s.work}
              >
                <span className="font-semibold">{i + 1}</span> {s.label}
                {i < PIPELINE_STEPS[mode].length - 1 && (
                  <span className="text-slate-300">→</span>
                )}
              </motion.li>
            ))}
          </ol>
        ) : (
          <p className="text-[11px] text-slate-600">Drop a file or click to browse</p>
        )}
        <p className="text-[10px] text-slate-400">
          {busy
            ? PIPELINE_STEPS[mode].map((s) => s.work)[
                mode === 'spec' ? 1 : 0
              ]
            : mode === 'spec'
              ? 'AI proposes work packages and dependencies. Does not modify the live graph.'
              : 'Extracts the claim text, then runs it through the 5-node verification pipeline.'}
        </p>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handle(f);
            e.target.value = '';
          }}
        />
      </div>

      {error && (
        <p className="flex items-start gap-1.5 rounded-lg border border-red-300 bg-red-50 p-2 text-[10px] text-red-700">
          <TriangleAlert size={12} className="mt-0.5 shrink-0" />
          {error}
        </p>
      )}

      <AnimatePresence mode="wait">
        {doc && (
          <motion.div
            key="doc"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="rounded-lg border border-slate-200 bg-slate-50 p-2.5"
          >
            <div className="flex items-baseline justify-between">
              <span className="font-mono text-[11px] text-slate-700">{doc.filename}</span>
              <span className="text-[10px] text-slate-400">
                {doc.kind} · {doc.char_count.toLocaleString()} chars
              </span>
            </div>
            <p className="mt-1.5 max-h-24 overflow-auto whitespace-pre-wrap text-[10px] leading-relaxed text-slate-500">
              {doc.preview}
            </p>
            {onReportText && (
              <button
                onClick={() => onReportText(doc.text, doc.filename, doc.media_url)}
                className="mt-2 rounded-md bg-slate-900 px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-slate-800"
              >
                {reportActionLabel}
              </button>
            )}
          </motion.div>
        )}

        {extracted && (
          <motion.div
            key="ext"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className={`rounded-lg border p-2.5 ${
              extracted.source === 'rejected' || extracted.tasks.length === 0
                ? 'border-amber-300 bg-amber-50'
                : 'border-slate-200 bg-slate-50'
            }`}
          >
            {extracted.source === 'rejected' ? (
              // Not a spec — say so plainly instead of mining a resume for phrases.
              <div className="flex items-start gap-2">
                <TriangleAlert size={13} className="mt-0.5 shrink-0 text-amber-600" />
                <div>
                  <p className="text-[11px] font-medium text-amber-800">
                    {extracted.filename} doesn’t look like a construction document
                  </p>
                  <p className="mt-1 text-[10px] leading-relaxed text-amber-700">
                    {extracted.notes}
                  </p>
                </div>
              </div>
            ) : extracted.tasks.length === 0 ? (
              // Passed the relevance gate but no line read as a work package.
              // Honest "found 0" beats a schedule full of CLI fragments.
              <div className="flex items-start gap-2">
                <TriangleAlert size={13} className="mt-0.5 shrink-0 text-amber-600" />
                <div>
                  <p className="text-[11px] font-medium text-amber-800">
                    No work packages found in {extracted.filename}
                  </p>
                  <p className="mt-1 text-[10px] leading-relaxed text-amber-700">
                    {extracted.notes}
                  </p>
                </div>
              </div>
            ) : (
              <>
                <div className="flex items-baseline justify-between">
                  <span className="font-mono text-[11px] text-slate-700">
                    {extracted.filename}
                  </span>
                  <span
                    className={`rounded px-1.5 py-0.5 text-[9px] ${
                      extracted.source === 'llm'
                        ? 'bg-emerald-100 text-emerald-700'
                        : 'bg-slate-200 text-slate-500'
                    }`}
                  >
                    {extracted.source === 'llm' ? 'model-extracted' : 'offline extraction'}
                  </span>
                </div>
                {extracted.notes && (
                  <p className="mt-1 text-[10px] text-slate-500">{extracted.notes}</p>
                )}

                <p className="mt-2 text-[10px] uppercase tracking-wider text-slate-400">
                  {extracted.tasks.length} proposed work package
                  {extracted.tasks.length === 1 ? '' : 's'}
                </p>
                <div className="mt-1 flex max-h-52 flex-col gap-1 overflow-auto">
                  {extracted.tasks.map((t, i) => (
                    <div
                      key={i}
                      className="rounded-md border border-slate-200 bg-white p-1.5"
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-[11px] text-slate-700">{t.name}</span>
                        <span className="shrink-0 font-mono text-[9px] text-slate-400">
                          {t.duration_days}d
                        </span>
                      </div>
                      <div className="flex items-center gap-2 text-[9px] text-slate-400">
                        <span>{ZONE_LABEL[t.zone as Zone] ?? t.zone}</span>
                        {t.depends_on.length > 0 && (
                          <span>after {t.depends_on.join(', ')}</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
                <p className="mt-2 text-[10px] text-slate-400">
                  Proposal only — the live schedule is unchanged.
                </p>

                {/* The agentic beat: hand the packages to the procurement agent,
                    which plans materials and raises a real PO on Zip staging. */}
                {!procured && (
                  <button
                    onClick={() => void procure()}
                    disabled={procuring}
                    className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md bg-slate-900 px-2.5 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-slate-800 disabled:opacity-60"
                  >
                    {procuring ? (
                      <>
                        <Loader2 size={11} className="animate-spin" />
                        Agent planning materials → vendor → Zip…
                      </>
                    ) : (
                      <>
                        <Zap size={11} />
                        Create procurement via agent
                      </>
                    )}
                  </button>
                )}
                {procureError && (
                  <p className="mt-2 flex items-start gap-1.5 rounded-md border border-red-300 bg-red-50 p-2 text-[10px] text-red-700">
                    <TriangleAlert size={12} className="mt-0.5 shrink-0" />
                    {procureError}
                  </p>
                )}
                {procured && (
                  <div
                    className={`mt-2 rounded-md border p-2 ${
                      procured.live
                        ? 'border-emerald-300 bg-emerald-50'
                        : 'border-amber-300 bg-amber-50'
                    }`}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span
                        className={`text-[11px] font-medium ${
                          procured.live ? 'text-emerald-800' : 'text-amber-800'
                        }`}
                      >
                        {procured.live
                          ? `Zip PO ${procured.po_number ?? procured.po_id} created`
                          : `PO ${procured.po_number} drafted locally`}
                      </span>
                      <span
                        className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] ${
                          procured.live
                            ? 'bg-emerald-100 text-emerald-700'
                            : 'bg-amber-100 text-amber-700'
                        }`}
                      >
                        {procured.live ? 'live on Zip staging' : 'local ledger only'}
                      </span>
                    </div>
                    <p
                      className={`mt-1 text-[10px] leading-relaxed ${
                        procured.live ? 'text-emerald-700' : 'text-amber-700'
                      }`}
                    >
                      {procured.detail}
                    </p>
                    {/* The agent's steps, so the reasoning is visible, not just
                        the conclusion — same contract as the verdict trace. */}
                    <ol className="mt-1.5 flex flex-col gap-1">
                      {procured.steps.map((s, i) => (
                        <li key={i} className="flex items-start gap-1.5">
                          <span
                            className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${
                              {
                                ok: 'bg-emerald-500',
                                warn: 'bg-amber-500',
                                bad: 'bg-red-500',
                                info: 'bg-slate-400',
                              }[s.signal]
                            }`}
                          />
                          <div className="min-w-0">
                            <p className="text-[10px] font-medium leading-snug text-slate-700">
                              {s.title}
                            </p>
                            <p className="text-[9px] leading-relaxed text-slate-500">
                              {s.detail}
                            </p>
                          </div>
                        </li>
                      ))}
                    </ol>
                    <p className="mt-1.5 text-[9px] text-slate-400">
                      Mirrored into the Procurement tab
                      {procured.live && procured.po_id ? ` · Zip id ${procured.po_id}` : ''}.
                    </p>
                  </div>
                )}
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
