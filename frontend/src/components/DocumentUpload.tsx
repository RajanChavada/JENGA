'use client';

import { useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { FileUp, Loader2, TriangleAlert } from 'lucide-react';
import * as api from '@/lib/api';
import type { ExtractedTasks, ParsedDoc } from '@/lib/api';
import { ZONE_LABEL } from '@/lib/theme';
import type { Zone } from '@/lib/types';

type Mode = 'report' | 'spec';

const ACCEPT = '.pdf,.doc,.docx,.txt,.md';

export function DocumentUpload({
  onReportText,
  initialMode = 'report',
}: {
  /**
   * Called with extracted text when a daily report is parsed and the user runs
   * it. Omitted on a site with no graph yet: there is nothing to verify a
   * report against, so that half of the component is not offered at all.
   */
  onReportText?: (text: string, filename: string) => void;
  /** Which tab opens first. Onboarding a new site starts on the blueprint. */
  initialMode?: Mode;
}) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doc, setDoc] = useState<ParsedDoc | null>(null);
  const [extracted, setExtracted] = useState<ExtractedTasks | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handle(file: File) {
    setBusy(true);
    setError(null);
    setDoc(null);
    setExtracted(null);
    try {
      if (mode === 'spec') {
        setExtracted(await api.extractTasks(file));
      } else {
        setDoc(await api.parseDocument(file));
      }
    } catch (e) {
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
        <p className="text-[11px] text-slate-600">
          {busy
            ? mode === 'spec'
              ? 'Extracting work packages…'
              : 'Parsing document…'
            : 'Drop a file or click to browse'}
        </p>
        <p className="text-[10px] text-slate-400">
          {mode === 'spec'
            ? 'Proposes work packages and dependencies. Does not modify the live graph.'
            : 'Extracts the claim text, then runs it through the verification graph.'}
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
                onClick={() => onReportText(doc.text, doc.filename)}
                className="mt-2 rounded-md bg-slate-900 px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-slate-800"
              >
                Run verification →
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
            className="rounded-lg border border-slate-200 bg-slate-50 p-2.5"
          >
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
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
