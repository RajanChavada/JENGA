'use client';

import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { FileText, Mic, X } from 'lucide-react';
import { SUBMISSIONS } from '@/lib/fixtures';
import { useJenga } from '@/store/useJenga';

export function SubmitUpdateModal() {
  const [open, setOpen] = useState(false);
  const submit = useJenga((s) => s.submit);
  const busy = useJenga((s) => s.busy);

  async function pick(id: string) {
    setOpen(false);
    await submit(id);
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        disabled={busy}
        className="rounded bg-slate-200 px-3 py-1.5 text-xs font-medium text-slate-900 disabled:opacity-50"
      >
        {busy ? 'Verifying…' : 'Submit daily update'}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
            onClick={() => setOpen(false)}
          >
            <motion.div
              initial={{ scale: 0.97, y: 8 }}
              animate={{ scale: 1, y: 0 }}
              onClick={(e) => e.stopPropagation()}
              className="max-h-[80vh] w-full max-w-2xl overflow-auto rounded-lg border border-slate-700 bg-slate-950 p-4"
            >
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <h2 className="text-sm font-semibold text-slate-200">
                    Incoming subcontractor submissions
                  </h2>
                  <p className="text-[11px] text-slate-500">
                    Pick one to run through the verification graph.
                  </p>
                </div>
                <button onClick={() => setOpen(false)} className="text-slate-500">
                  <X size={16} />
                </button>
              </div>

              <div className="flex flex-col gap-2">
                {SUBMISSIONS.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => pick(s.id)}
                    className="rounded border border-slate-700 bg-slate-900/60 p-3 text-left hover:border-slate-500"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-xs text-slate-300">
                        {s.task_id} · {s.id}
                      </span>
                      <span className="flex items-center gap-1 text-[10px] text-slate-500">
                        {s.report_text ? <FileText size={11} /> : <Mic size={11} />}
                        {s.report_text ? 'PDF report' : 'voice note'}
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] text-slate-400">{s.label}</p>
                    <p className="mt-1 line-clamp-2 text-[10px] italic text-slate-600">
                      {(s.report_text ?? s.transcript ?? '').slice(0, 160)}…
                    </p>
                  </button>
                ))}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
