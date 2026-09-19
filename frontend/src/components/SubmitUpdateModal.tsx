'use client';

import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { FileText, Mic, X } from 'lucide-react';
import { SUBMISSIONS } from '@/lib/fixtures';
import { useJenga } from '@/store/useJenga';
import { DocumentUpload } from './DocumentUpload';

type Tab = 'demo' | 'upload';

export function SubmitUpdateModal() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('demo');
  const [taskId, setTaskId] = useState<string>('');

  const submit = useJenga((s) => s.submit);
  const submitText = useJenga((s) => s.submitText);
  const tasks = useJenga((s) => s.tasks);
  const busy = useJenga((s) => s.busy);

  async function pick(id: string) {
    setOpen(false);
    await submit(id);
  }

  async function runUploaded(text: string, filename: string) {
    // Default to whatever is actually in progress rather than making the user hunt.
    const target =
      taskId || tasks.find((t) => t.state === 'active')?.id || tasks[0]?.id;
    if (!target) return;
    setOpen(false);
    await submitText(target, text, filename);
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        disabled={busy}
        className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-slate-800 disabled:opacity-50"
      >
        {busy ? 'Verifying…' : 'Submit daily update'}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm"
            onClick={() => setOpen(false)}
          >
            <motion.div
              initial={{ scale: 0.97, y: 8 }}
              animate={{ scale: 1, y: 0 }}
              onClick={(e) => e.stopPropagation()}
              className="max-h-[84vh] w-full max-w-2xl overflow-auto rounded-xl border border-slate-200 bg-white p-4 shadow-xl"
            >
              <div className="mb-3 flex items-start justify-between">
                <div>
                  <h2 className="text-sm font-semibold text-slate-900">
                    Subcontractor submission
                  </h2>
                  <p className="text-[11px] text-slate-500">
                    Runs through the verification graph: authorship gate → visual
                    analysis → historical comparison → arbiter.
                  </p>
                </div>
                <button onClick={() => setOpen(false)} className="text-slate-400 hover:text-slate-700">
                  <X size={16} />
                </button>
              </div>

              <div className="mb-3 flex gap-2 border-b border-slate-200 pb-2">
                {(
                  [
                    ['demo', 'Demo submissions'],
                    ['upload', 'Upload document'],
                  ] as [Tab, string][]
                ).map(([t, label]) => (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    className={`rounded-md px-2.5 py-1 text-[11px] transition-colors ${
                      tab === t
                        ? 'bg-slate-900 text-white'
                        : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {tab === 'demo' ? (
                <div className="flex flex-col gap-2">
                  {SUBMISSIONS.map((s) => (
                    <button
                      key={s.id}
                      onClick={() => pick(s.id)}
                      className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-left transition-colors hover:border-slate-300 hover:bg-white"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-mono text-xs text-slate-700">
                          {s.task_id} · {s.id}
                        </span>
                        <span className="flex items-center gap-1 text-[10px] text-slate-400">
                          {s.report_text ? <FileText size={11} /> : <Mic size={11} />}
                          {s.report_text ? 'PDF report' : 'voice note'}
                        </span>
                      </div>
                      <p className="mt-1 text-[11px] text-slate-600">{s.label}</p>
                      <p className="mt-1 line-clamp-2 text-[10px] italic text-slate-400">
                        {(s.report_text ?? s.transcript ?? '').slice(0, 160)}…
                      </p>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  <label className="flex items-center gap-2 text-[11px] text-slate-500">
                    Verify against
                    <select
                      value={taskId}
                      onChange={(e) => setTaskId(e.target.value)}
                      className="flex-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-700"
                    >
                      <option value="">auto — first active task</option>
                      {tasks.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.id} · {t.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <DocumentUpload onReportText={runUploaded} />
                </div>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
