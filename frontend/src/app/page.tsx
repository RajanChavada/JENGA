'use client';

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { ArrowLeft, ListChecks, Waypoints, Workflow } from 'lucide-react';
import { WorkGraph } from '@/components/WorkGraph';
import { Timeline } from '@/components/Timeline';
import { VerdictPanel, AgentRunning } from '@/components/VerdictPanel';
import { AttributionLedger } from '@/components/AttributionLedger';
import { SubmitUpdateModal } from '@/components/SubmitUpdateModal';
import { MacroHeatmap } from '@/components/MacroHeatmap';
import { SensorStrip } from '@/components/SensorStrip';
import { DocumentUpload } from '@/components/DocumentUpload';
import { useJenga } from '@/store/useJenga';

/** What the extractor gives back, spelled out on the empty site. */
const ONBOARD_YIELD = [
  { icon: ListChecks, title: 'Work packages', detail: 'name, zone, duration' },
  { icon: Workflow, title: 'Dependencies', detail: 'what blocks what' },
  { icon: Waypoints, title: 'Critical path', detail: 'float and slip' },
];

// Three.js touches window during module init, so keep it off the server.
const StationView = dynamic(
  () => import('@/components/StationView').then((m) => m.StationView),
  { ssr: false, loading: () => <div className="h-full w-full bg-slate-50" /> },
);

export default function Home() {
  const load = useJenga((s) => s.load);
  const loadSite = useJenga((s) => s.loadSite);
  const reset = useJenga((s) => s.reset);
  const loading = useJenga((s) => s.loading);
  const offline = useJenga((s) => s.offline);
  const strict = useJenga((s) => s.strict);
  const setStrict = useJenga((s) => s.setStrict);
  const view = useJenga((s) => s.view);
  const setView = useJenga((s) => s.setView);
  const siteName = useJenga((s) => s.activeSiteName);
  const [show3d, setShow3d] = useState(true);

  // Two different questions, and they can disagree: a project that exists but
  // has no tickets yet is onboarded with nothing to draw.
  //
  // `hasGraph` answers "is there anything to show?" and every work-package
  // surface follows it, so the header, the body, the twin and the ledger can
  // never contradict each other. `onboarded` answers "does this pin have a
  // project at all?", which is a different fact and the only one Reset cares
  // about.
  const onboarded = useJenga((s) => s.activeProjectId !== null);
  const hasGraph = useJenga((s) => s.tasks.length > 0);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="flex h-screen flex-col overflow-hidden bg-white text-slate-900">
      <header className="flex shrink-0 items-center justify-between border-b border-slate-200 bg-white px-4 py-2.5">
        <div className="flex items-baseline gap-3">
          <h1 className="text-sm font-semibold tracking-tight text-slate-900">JENGA</h1>
          <span className="text-[11px] text-slate-500">
            {/* Follows the body, with one exception: a graph still in flight
                counts as present. Nothing is contradicted while the panel below
                says "loading", and assuming otherwise flashes "Not onboarded"
                on every page load — including into the server-rendered HTML. */}
            {siteName} · {hasGraph || loading ? 'Structural Package' : 'Not onboarded'}
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
            disabled={view === 'macro' || !onboarded}
            className="rounded-md border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-40"
          >
            {show3d ? 'Hide 3D' : 'Show 3D'}
          </button>
          <button
            onClick={() => void reset()}
            // There is no graph to put back on a site with no project behind
            // it, and the store refuses the reload rather than pulling the
            // default project's tasks onto someone else's pin. Say so here
            // instead of leaving a button that looks live and does nothing.
            disabled={!onboarded}
            title={onboarded ? undefined : 'Nothing to reset — this site has no schedule yet'}
            className="rounded-md border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-40"
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
          {/* No graph, nothing to submit against — and a submission here would
              404 on the backend and retire the session to fixtures. */}
          {hasGraph && <SubmitUpdateModal />}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          {loading ? (
            <div className="flex h-full items-center justify-center text-xs text-slate-400">
              loading graph…
            </div>
          ) : view === 'macro' ? (
            <MacroHeatmap onOpenSite={(hotzone) => void loadSite(hotzone.id)} />
          ) : !hasGraph ? (
            <OnboardSite />
          ) : (
            <div className="flex h-full min-h-0 flex-col">
              <div className="relative min-h-0 flex-[2]">
                <WorkGraph />
                <AgentRunning />
                <VerdictPanel />
              </div>
              {/* Under the DAG, above the schedule. Renders nothing until a
                  non-pending ticket is selected. */}
              <SensorStrip />
              <div className="min-h-[210px] flex-1 border-t border-slate-200">
                <Timeline />
              </div>
            </div>
          )}
        </div>

        {/* Both rails follow the body, not the site. If a project ever comes
            back with no tickets, `onboarded` and `hasGraph` disagree, and
            gating these on the site would leave a digital twin and a delay
            ledger flanking a panel that says the site has no drawings. */}
        {view === 'micro' && hasGraph && show3d && (
          <div className="h-full w-[360px] shrink-0 border-l border-slate-200">
            <StationView />
          </div>
        )}

        {view === 'micro' && hasGraph && <AttributionLedger />}
      </div>
    </main>
  );
}

/**
 * What a hotzone with no project behind it opens into.
 *
 * This is the pitch, not an error page: the map watches every site in the city
 * from the outside, and a blueprint is the one thing that turns one of them
 * into a graph JENGA can verify against. So it names the site, says what is
 * missing and why, and hands over the same extractor the spec tab already uses.
 */
function OnboardSite() {
  const siteName = useJenga((s) => s.activeSiteName);
  const setView = useJenga((s) => s.setView);

  return (
    <div className="h-full overflow-auto bg-slate-50 p-6">
      <div className="mx-auto max-w-xl">
        <button
          onClick={() => setView('macro')}
          className="mb-3 flex items-center gap-1 text-[11px] text-slate-500 transition-colors hover:text-slate-900"
        >
          <ArrowLeft size={12} />
          Back to the Toronto map
        </button>

        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <p className="text-[10px] uppercase tracking-wider text-slate-400">
            Not onboarded
          </p>
          <h2 className="mt-1 text-lg font-semibold tracking-tight text-slate-900">
            {siteName}
          </h2>
          <p className="mt-2 text-[11px] leading-relaxed text-slate-600">
            JENGA is watching this hotzone from the outside — permits, closures and the
            municipal feed. There is no dependency graph behind it yet, because nobody
            has handed it the drawings. Upload the spec or blueprint and it reads the
            work packages and the dependencies between them straight off the document.
          </p>

          <div className="mt-4 grid grid-cols-3 gap-2">
            {ONBOARD_YIELD.map(({ icon: Icon, title, detail }) => (
              <div
                key={title}
                className="rounded-lg border border-slate-200 bg-slate-50 p-2.5"
              >
                <Icon size={13} className="text-slate-400" />
                <p className="mt-1.5 text-[11px] text-slate-700">{title}</p>
                <p className="text-[10px] leading-snug text-slate-400">{detail}</p>
              </div>
            ))}
          </div>

          <h3 className="mt-5 text-[10px] uppercase tracking-wider text-slate-400">
            Onboard from blueprint
          </h3>
          <div className="mt-2">
            <DocumentUpload initialMode="spec" />
          </div>
          {/* The uploader above says "does not modify the live graph", and it
              means it. Saying so out here too, rather than letting the heading
              promise a site that the next click cannot deliver. */}
          <p className="mt-3 border-t border-slate-200 pt-3 text-[10px] leading-relaxed text-slate-400">
            Extraction is live — the packages and dependencies you get back are read
            from your document. Committing them to a new site lands next.
          </p>
        </div>
      </div>
    </div>
  );
}
