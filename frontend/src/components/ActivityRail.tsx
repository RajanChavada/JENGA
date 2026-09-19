'use client';

import { AnimatePresence, motion } from 'framer-motion';
import {
  Cpu,
  Database,
  FileText,
  Loader2,
  RadioTower,
  X,
  Zap,
} from 'lucide-react';
import { useJenga, type AgentSource } from '@/store/useJenga';

/** Per-integration icon + label, so each entry names the system that did it. */
const SOURCE_META: Record<AgentSource, { Icon: typeof Cpu; label: string }> = {
  browserbase: { Icon: RadioTower, label: 'Browserbase' },
  tiger: { Icon: Database, label: 'Tiger Data' },
  agent: { Icon: Cpu, label: 'Agent pipeline' },
  documents: { Icon: FileText, label: 'Documents' },
  zip: { Icon: Zap, label: 'Zip procurement' },
};

const STATUS_DOT: Record<string, string> = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  error: 'bg-red-500',
};

/**
 * The agentic work, confirmed on one surface.
 *
 * Every integration logs here as it acts — the Browserbase scrape, the five-node
 * verification pipeline, Tiger telemetry regime changes, document extraction,
 * Zip procurement calls — each entry created `running` and resolved in place
 * with what actually happened. This is the answer to "is the AI doing anything?"
 * that doesn't require catching a 500 ms overlay.
 */
export function ActivityRail() {
  const open = useJenga((s) => s.activityOpen);
  const setOpen = useJenga((s) => s.setActivityOpen);
  const activity = useJenga((s) => s.activity);

  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          initial={{ x: 40, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 40, opacity: 0 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          className="flex h-full w-[320px] shrink-0 flex-col border-l border-slate-200 bg-white"
        >
          <div className="flex shrink-0 items-center justify-between border-b border-slate-200 px-3 py-2.5">
            <h2 className="text-[10px] uppercase tracking-wider text-slate-500">
              Agent activity
            </h2>
            <button
              onClick={() => setOpen(false)}
              aria-label="Close activity rail"
              className="text-slate-400 transition-colors hover:text-slate-700"
            >
              <X size={14} />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-auto p-2">
            {activity.length === 0 ? (
              <p className="p-2 text-[11px] leading-relaxed text-slate-400">
                Nothing yet. Every agentic operation lands here as it runs — scrape the
                map, submit a daily update, upload a document, or act on a purchase
                order, and watch this feed confirm what each system did.
              </p>
            ) : (
              <ol className="flex flex-col gap-1.5">
                <AnimatePresence initial={false}>
                  {activity.map((ev) => {
                    const meta = SOURCE_META[ev.source];
                    return (
                      <motion.li
                        key={ev.id}
                        layout
                        initial={{ opacity: 0, y: -6 }}
                        animate={{ opacity: 1, y: 0 }}
                        className={`rounded-lg border p-2 ${
                          ev.status === 'running'
                            ? 'border-sky-200 bg-sky-50/60'
                            : 'border-slate-200 bg-white'
                        }`}
                      >
                        <div className="flex items-center gap-1.5">
                          <meta.Icon size={11} className="shrink-0 text-slate-400" />
                          <span className="text-[9px] uppercase tracking-wider text-slate-400">
                            {meta.label}
                          </span>
                          <span className="ml-auto shrink-0 font-mono text-[9px] text-slate-300">
                            {new Date(ev.ts).toLocaleTimeString()}
                          </span>
                        </div>
                        <div className="mt-1 flex items-start gap-1.5">
                          {ev.status === 'running' ? (
                            <Loader2
                              size={11}
                              className="mt-0.5 shrink-0 animate-spin text-sky-500"
                            />
                          ) : (
                            <span
                              className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[ev.status]}`}
                            />
                          )}
                          <div className="min-w-0">
                            <p className="text-[11px] font-medium leading-snug text-slate-700">
                              {ev.title}
                            </p>
                            {ev.detail && (
                              <p className="mt-0.5 text-[10px] leading-relaxed text-slate-500">
                                {ev.detail}
                              </p>
                            )}
                          </div>
                        </div>
                      </motion.li>
                    );
                  })}
                </AnimatePresence>
              </ol>
            )}
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

/**
 * Header toggle for the rail. Pulses while anything is running so the agentic
 * work is discoverable even with the rail closed.
 */
export function ActivityToggle() {
  const open = useJenga((s) => s.activityOpen);
  const setOpen = useJenga((s) => s.setActivityOpen);
  const running = useJenga((s) => s.activity.some((e) => e.status === 'running'));

  return (
    <button
      onClick={() => setOpen(!open)}
      aria-pressed={open}
      title="Live log of what each agent and integration is doing"
      className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs transition-colors ${
        open
          ? 'border-slate-900 bg-slate-900 text-white'
          : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50 hover:text-slate-900'
      }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          running ? 'animate-pulse bg-sky-500' : open ? 'bg-emerald-400' : 'bg-slate-300'
        }`}
      />
      Activity
    </button>
  );
}
