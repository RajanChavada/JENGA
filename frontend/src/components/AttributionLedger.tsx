'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { useJenga } from '@/store/useJenga';

export function AttributionLedger() {
  const attributions = useJenga((s) => s.attributions);
  const purchaseOrders = useJenga((s) => s.purchaseOrders);

  return (
    <aside className="flex h-full w-80 shrink-0 flex-col gap-4 overflow-auto border-l border-slate-200 bg-white p-3">
      <section>
        <h3 className="mb-2 text-[10px] uppercase tracking-wider text-slate-400">
          Delay attribution ledger
        </h3>
        {attributions.length === 0 ? (
          <p className="text-[11px] leading-relaxed text-slate-400">
            Append-only. Every slip is recorded here with the evidence that established it and
            the party it is attributed to.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            <AnimatePresence initial={false}>
              {attributions.map((a) => (
                <motion.div
                  key={a.id}
                  initial={{ opacity: 0, x: 24 }}
                  animate={{ opacity: 1, x: 0 }}
                  className="rounded-lg border border-slate-200 bg-slate-50 p-2.5"
                >
                  <div className="flex items-baseline justify-between">
                    <span className="font-mono text-xs text-slate-700">{a.task_id}</span>
                    <span className="font-mono text-xs text-red-600">+{a.slip_days}d</span>
                  </div>

                  <div className="mt-1.5 grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10px] text-slate-400">
                    <span>Float consumed</span>
                    <span className="text-right text-slate-700">{a.float_consumed}d</span>
                    <span>Downstream</span>
                    <span className="text-right text-slate-700">
                      {a.downstream_affected.length} tasks
                    </span>
                    <span>Project slip</span>
                    <span className="text-right text-red-600">+{a.project_slipped_days}d</span>
                  </div>

                  <div className="mt-2 border-t border-slate-200 pt-1.5">
                    {a.attribution.map((p, i) => (
                      <div key={i} className="mb-1 text-[10px] leading-snug">
                        <div className="flex justify-between gap-2">
                          <span className="text-slate-700">{p.party}</span>
                          <span className="shrink-0 font-mono text-slate-400">{p.days}d</span>
                        </div>
                        <p className="text-slate-500">{p.reason}</p>
                      </div>
                    ))}
                  </div>

                  {a.downstream_affected.length > 0 && (
                    <p className="mt-1 font-mono text-[9px] text-slate-400">
                      {a.downstream_affected.join(' · ')}
                    </p>
                  )}
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}
      </section>

      <section>
        <h3 className="mb-2 text-[10px] uppercase tracking-wider text-slate-400">
          Procurement (Zip)
        </h3>
        <div className="flex flex-col gap-1.5">
          {purchaseOrders.map((po) => (
            <motion.div
              key={po.id}
              layout
              className={`rounded-lg border p-2 text-[10px] ${
                po.status === 'rescheduled'
                  ? 'border-sky-200 bg-sky-50'
                  : 'border-slate-200 bg-slate-50'
              }`}
            >
              <div className="flex justify-between">
                <span className="font-mono text-slate-700">{po.id}</span>
                <span
                  className={
                    po.status === 'rescheduled' ? 'text-sky-700' : 'text-slate-400'
                  }
                >
                  {po.status}
                </span>
              </div>
              <p className="text-slate-500">
                {po.material} · {po.quantity}
              </p>
              <p className="text-slate-400">
                {po.vendor} → {po.delivery_date}
              </p>
              {po.last_action && (
                <p className="mt-1 text-sky-700">{po.last_action}</p>
              )}
            </motion.div>
          ))}
        </div>
      </section>
    </aside>
  );
}
