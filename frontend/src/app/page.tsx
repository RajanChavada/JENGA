'use client';

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { WorkGraph } from '@/components/WorkGraph';
import { VerdictPanel } from '@/components/VerdictPanel';
import { AttributionLedger } from '@/components/AttributionLedger';
import { SubmitUpdateModal } from '@/components/SubmitUpdateModal';
import { useJenga } from '@/store/useJenga';

// Three.js touches window during module init, so keep it off the server.
const StationView = dynamic(
  () => import('@/components/StationView').then((m) => m.StationView),
  { ssr: false, loading: () => <div className="h-full w-full bg-[#060d18]" /> },
);

export default function Home() {
  const load = useJenga((s) => s.load);
  const reset = useJenga((s) => s.reset);
  const loading = useJenga((s) => s.loading);
  const offline = useJenga((s) => s.offline);
  const [show3d, setShow3d] = useState(true);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="flex h-screen flex-col overflow-hidden">
      <header className="flex shrink-0 items-center justify-between border-b border-slate-800 bg-slate-950 px-4 py-2.5">
        <div className="flex items-baseline gap-3">
          <h1 className="text-sm font-semibold tracking-tight text-slate-100">JENGA</h1>
          <span className="text-[11px] text-slate-500">
            Eglinton West Station · Structural Package
          </span>
          {offline && (
            <span className="rounded border border-slate-600 px-1.5 py-0.5 font-mono text-[9px] text-slate-400">
              OFFLINE
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setShow3d((v) => !v)}
            className="rounded border border-slate-600 px-2.5 py-1.5 text-xs text-slate-300"
          >
            {show3d ? 'Hide 3D' : 'Show 3D'}
          </button>
          <button
            onClick={() => void reset()}
            className="rounded border border-slate-600 px-2.5 py-1.5 text-xs text-slate-300"
          >
            Reset
          </button>
          <SubmitUpdateModal />
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          {loading ? (
            <div className="flex h-full items-center justify-center text-xs text-slate-600">
              loading graph…
            </div>
          ) : (
            <WorkGraph />
          )}
          <VerdictPanel />
        </div>

        {show3d && (
          <div className="h-full w-[360px] shrink-0 border-l border-slate-800">
            <StationView />
          </div>
        )}

        <AttributionLedger />
      </div>
    </main>
  );
}
