'use client';

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { WorkGraph } from '@/components/WorkGraph';
import { Timeline } from '@/components/Timeline';
import { VerdictPanel } from '@/components/VerdictPanel';
import { AttributionLedger } from '@/components/AttributionLedger';
import { SubmitUpdateModal } from '@/components/SubmitUpdateModal';
import { MacroHeatmap } from '@/components/MacroHeatmap';
import { useJenga } from '@/store/useJenga';

// Three.js touches window during module init, so keep it off the server.
const StationView = dynamic(
  () => import('@/components/StationView').then((m) => m.StationView),
  { ssr: false, loading: () => <div className="h-full w-full bg-slate-50" /> },
);

export default function Home() {
  const load = useJenga((s) => s.load);
  const reset = useJenga((s) => s.reset);
  const selectTask = useJenga((s) => s.selectTask);
  const loading = useJenga((s) => s.loading);
  const offline = useJenga((s) => s.offline);
  const strict = useJenga((s) => s.strict);
  const setStrict = useJenga((s) => s.setStrict);
  const [show3d, setShow3d] = useState(true);
  const [view, setView] = useState<'macro' | 'micro'>('micro');

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="flex h-screen flex-col overflow-hidden bg-white text-slate-900">
      <header className="flex shrink-0 items-center justify-between border-b border-slate-200 bg-white px-4 py-2.5">
        <div className="flex items-baseline gap-3">
          <h1 className="text-sm font-semibold tracking-tight text-slate-900">JENGA</h1>
          <span className="text-[11px] text-slate-500">
            Eglinton West Station · Structural Package
          </span>
          {offline && (
            <span className="rounded border border-slate-300 px-1.5 py-0.5 font-mono text-[9px] text-slate-500">
              OFFLINE
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <div className="flex overflow-hidden rounded-md border border-slate-200 text-xs">
            {(['macro', 'micro'] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`px-2.5 py-1.5 capitalize transition-colors ${
                  view === v
                    ? 'bg-slate-900 text-white'
                    : 'bg-white text-slate-500 hover:bg-slate-50 hover:text-slate-900'
                }`}
              >
                {v}
              </button>
            ))}
          </div>
          <button
            onClick={() => setShow3d((v) => !v)}
            disabled={view === 'macro'}
            className="rounded-md border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-40"
          >
            {show3d ? 'Hide 3D' : 'Show 3D'}
          </button>
          <button
            onClick={() => void reset()}
            className="rounded-md border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600 transition-colors hover:bg-slate-50"
          >
            Reset
          </button>
          <button
            onClick={() => setStrict(!strict)}
            aria-pressed={strict}
            title="Hard-gate AI-written reports (Rox) / advisory only (main)"
            className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs transition-colors ${
              strict
                ? 'border-slate-900 bg-slate-900 text-white'
                : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50 hover:text-slate-900'
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${strict ? 'bg-emerald-400' : 'bg-slate-300'}`}
            />
            Strict
          </button>
          <SubmitUpdateModal />
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          {loading ? (
            <div className="flex h-full items-center justify-center text-xs text-slate-400">
              loading graph…
            </div>
          ) : view === 'macro' ? (
            <MacroHeatmap
              onOpenSite={() => {
                setView('micro');
                selectTask('P-106');
              }}
            />
          ) : (
            <div className="flex h-full min-h-0 flex-col">
              <div className="relative min-h-0 flex-[2]">
                <WorkGraph />
                <VerdictPanel />
              </div>
              <div className="min-h-[210px] flex-1 border-t border-slate-200">
                <Timeline />
              </div>
            </div>
          )}
        </div>

        {view === 'micro' && show3d && (
          <div className="h-full w-[360px] shrink-0 border-l border-slate-200">
            <StationView />
          </div>
        )}

        {view === 'micro' && <AttributionLedger />}
      </div>
    </main>
  );
}
