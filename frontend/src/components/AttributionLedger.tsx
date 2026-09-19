'use client';

import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown, Link2, PackageCheck, Zap } from 'lucide-react';
import { useJenga } from '@/store/useJenga';
import { displayId } from '@/lib/format';
import type { PurchaseOrder } from '@/lib/types';

/**
 * The Procurement + attribution surface, as its own tab.
 *
 * Two halves: the append-only delay-attribution ledger on the left, and the Zip
 * purchase orders on the right — with real actions, not a read-only display. A
 * planner can expedite a PO (live via Zip when keyed), mark it received, or link
 * it to a ticket so a later slip can be attributed to the material.
 */
export function AttributionLedger() {
  const attributions = useJenga((s) => s.attributions);
  const purchaseOrders = useJenga((s) => s.purchaseOrders);

  return (
    <div className="h-full overflow-auto bg-white">
      <div className="mx-auto grid max-w-5xl grid-cols-1 gap-8 px-6 py-8 lg:grid-cols-2">
        {/* Procurement leads — it's the half with actions. */}
        <section>
          <div className="mb-1 flex items-baseline justify-between">
            <h2 className="text-sm font-semibold tracking-tight text-slate-900">
              Procurement
            </h2>
            <span className="text-[10px] uppercase tracking-wider text-slate-400">
              Zip · {purchaseOrders.length} orders
            </span>
          </div>
          <p className="mb-4 text-[11px] leading-relaxed text-slate-500">
            Purchase orders mirrored from Zip. Expedite pulls delivery forward (live
            against the Zip API when a key is set); receive and link update the ledger.
          </p>
          <div className="flex flex-col gap-2.5">
            {purchaseOrders.length === 0 ? (
              <p className="text-[11px] text-slate-400">No purchase orders on this site.</p>
            ) : (
              purchaseOrders.map((po) => <POCard key={po.id} po={po} />)
            )}
          </div>
        </section>

        <section>
          <h2 className="mb-1 text-sm font-semibold tracking-tight text-slate-900">
            Delay attribution ledger
          </h2>
          <p className="mb-4 text-[11px] leading-relaxed text-slate-500">
            Append-only. Every slip is recorded with the evidence that established it
            and the party it is attributed to.
          </p>
          {attributions.length === 0 ? (
            <p className="text-[11px] text-slate-400">
              Nothing recorded yet. A confirmed slip on the Site tab writes its first
              entry here, with the downstream cascade and the split.
            </p>
          ) : (
            <div className="flex flex-col gap-2.5">
              <AnimatePresence initial={false}>
                {attributions.map((a) => (
                  <motion.div
                    key={a.id}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="rounded-lg border border-slate-200 bg-slate-50 p-3"
                  >
                    <div className="flex items-baseline justify-between">
                      <span className="font-mono text-xs text-slate-700">{a.task_id}</span>
                      <span className="font-mono text-xs text-red-600">+{a.slip_days}d</span>
                    </div>
                    <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px] text-slate-500">
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
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

const STATUS_TONE: Record<PurchaseOrder['status'], string> = {
  confirmed: 'border-slate-200 bg-slate-50 text-slate-500',
  rescheduled: 'border-sky-200 bg-sky-50 text-sky-700',
  escalated: 'border-amber-200 bg-amber-50 text-amber-700',
  received: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  draft: 'border-slate-200 bg-slate-50 text-slate-400',
};

function POCard({ po }: { po: PurchaseOrder }) {
  const tasks = useJenga((s) => s.tasks);
  const expeditePO = useJenga((s) => s.expeditePO);
  const markPoReceived = useJenga((s) => s.markPoReceived);
  const linkPoToTask = useJenga((s) => s.linkPoToTask);
  const routeRisk = useJenga((s) => s.routeRisk);
  const [pending, setPending] = useState<'expedite' | 'receive' | null>(null);
  const [linking, setLinking] = useState(false);

  const received = po.status === 'received';
  // The supply-line radar's read on this PO's delivery route, when one ran.
  const route = routeRisk?.routes.find(
    (r) => r.po_id === po.id && r.risk !== 'clear' && r.closures.length > 0,
  );

  async function run(kind: 'expedite' | 'receive') {
    setPending(kind);
    if (kind === 'expedite') await expeditePO(po.id);
    else await markPoReceived(po.id);
    setPending(null);
  }

  return (
    <motion.div
      layout
      className="rounded-lg border border-slate-200 bg-white p-3 text-[11px] shadow-sm"
    >
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-slate-700">{displayId(po.id)}</span>
        <span
          className={`rounded-full border px-1.5 py-0.5 text-[9px] uppercase tracking-wider ${STATUS_TONE[po.status]}`}
        >
          {po.status}
        </span>
      </div>
      <p className="mt-1 text-slate-700">
        {po.material} · <span className="text-slate-500">{po.quantity}</span>
      </p>
      <p className="text-[10px] text-slate-400">
        {po.vendor} → {po.delivery_date}
        {po.linked_task && (
          <span className="ml-1 text-slate-500">· linked {displayId(po.linked_task)}</span>
        )}
      </p>
      {po.last_action && <p className="mt-1 text-[10px] text-sky-700">{po.last_action}</p>}

      {route && (
        <p
          className={`mt-1 flex items-start gap-1 text-[10px] ${
            route.risk === 'high' ? 'text-red-600' : 'text-amber-600'
          }`}
        >
          <span
            className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${
              route.risk === 'high' ? 'bg-red-500' : 'bg-amber-500'
            }`}
          />
          route risk: {route.closures[0].roadway} — {route.closures.length} closure
          {route.closures.length === 1 ? '' : 's'} on the delivery route
          {route.predicted_slip_days > 0 && ` · predicted +${route.predicted_slip_days}d`}
        </p>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <button
          onClick={() => void run('expedite')}
          disabled={pending !== null || received}
          className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-[10px] font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-40"
        >
          <Zap size={11} />
          {pending === 'expedite' ? 'Expediting…' : 'Expedite'}
        </button>
        <button
          onClick={() => void run('receive')}
          disabled={pending !== null || received}
          className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-[10px] font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-40"
        >
          <PackageCheck size={11} />
          {pending === 'receive' ? 'Receiving…' : received ? 'Received' : 'Mark received'}
        </button>
        <div className="relative">
          <button
            onClick={() => setLinking((v) => !v)}
            className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-[10px] font-medium text-slate-600 transition-colors hover:bg-slate-50"
          >
            <Link2 size={11} />
            {po.linked_task ? 'Relink' : 'Link'}
            <ChevronDown size={10} />
          </button>
          {linking && (
            <div className="absolute left-0 top-full z-10 mt-1 max-h-48 w-52 overflow-auto rounded-md border border-slate-200 bg-white py-1 shadow-lg">
              {tasks.length === 0 ? (
                <p className="px-2 py-1 text-[10px] text-slate-400">No tickets to link.</p>
              ) : (
                tasks.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => {
                      setLinking(false);
                      void linkPoToTask(po.id, t.id);
                    }}
                    className="block w-full truncate px-2 py-1 text-left text-[10px] text-slate-600 hover:bg-slate-50"
                  >
                    <span className="font-mono text-slate-400">{displayId(t.id)}</span> · {t.name}
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}
