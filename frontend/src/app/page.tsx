"use client";

import { useEffect, useRef } from "react";
import dynamic from "next/dynamic";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { WorkGraph } from "@/components/WorkGraph";
import { Timeline } from "@/components/Timeline";
import { VerdictPanel, AgentRunning } from "@/components/VerdictPanel";
import { AttributionLedger } from "@/components/AttributionLedger";
import { ApprovalQueue } from "@/components/ApprovalQueue";
import { ContractorPortal } from "@/components/ContractorPortal";
import { RoleSwitcher } from "@/components/RoleSwitcher";
import { Splitter, useFraction } from "@/components/Splitter";
import { ActivityRail, ActivityToggle } from "@/components/ActivityRail";
import { MacroHeatmap } from "@/components/MacroHeatmap";
import { PaceStrip } from "@/components/PaceStrip";
import { DocumentUpload } from "@/components/DocumentUpload";
import { useJenga } from "@/store/useJenga";

const StationView = dynamic(
  () => import("@/components/StationView").then((m) => m.StationView),
  { ssr: false, loading: () => <div className="h-full w-full bg-slate-50" /> },
);

export default function Home() {
  const load = useJenga((s) => s.load);
  const loadSite = useJenga((s) => s.loadSite);
  const reset = useJenga((s) => s.reset);
  const loading = useJenga((s) => s.loading);
  const offline = useJenga((s) => s.offline);
  const view = useJenga((s) => s.view);
  const setView = useJenga((s) => s.setView);
  const microTab = useJenga((s) => s.microTab);
  const setMicroTab = useJenga((s) => s.setMicroTab);
  const siteName = useJenga((s) => s.activeSiteName);
  const role = useJenga((s) => s.role);
  const restoreIdentity = useJenga((s) => s.restoreIdentity);
  const refreshPortal = useJenga((s) => s.refreshPortal);
  const isOwner = role === "owner";

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
    restoreIdentity();
    // The graph first (the map and graph views paint from it), then whoever is looking.
    void load().then(() => refreshPortal());
  }, [load, restoreIdentity, refreshPortal]);

  return (
    <main className="flex h-screen flex-col overflow-hidden bg-white text-slate-900">
      <header className="flex shrink-0 items-center justify-between border-b border-slate-200 bg-white px-4 py-2.5">
        <div className="flex items-baseline gap-3">
          <h1 className="text-sm font-semibold tracking-tight text-slate-900">
            JENGA
          </h1>
          <span className="text-[11px] text-slate-500">
            {/* Follows the body, with one exception: a graph still in flight
                counts as present. Nothing is contradicted while the panel below
                says "loading", and assuming otherwise flashes "Not onboarded"
                on every page load — including into the server-rendered HTML. */}
            {siteName} ·{" "}
            {hasGraph || loading ? "Structural Package" : "Not onboarded"}
          </span>
          {offline && (
            <span className="rounded border border-slate-300 px-1.5 py-0.5 font-mono text-[9px] text-slate-500">
              OFFLINE
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <RoleSwitcher />
          {isOwner && (
            <>
              <div className="flex overflow-hidden rounded-md border border-slate-200 text-xs">
                {(["macro", "micro"] as const).map((v) => (
                  <button
                    key={v}
                    onClick={() => setView(v)}
                    className={`px-2.5 py-1.5 capitalize transition-colors ${
                      view === v
                        ? "bg-slate-900 text-white"
                        : "bg-white text-slate-500 hover:bg-slate-50 hover:text-slate-900"
                    }`}
                  >
                    {v}
                  </button>
                ))}
              </div>

              {/* Within a site: the work surface, or procurement + the ledger. */}
              {view === "micro" && hasGraph && (
                <div className="flex overflow-hidden rounded-md border border-slate-200 text-xs">
                  {(["site", "procurement"] as const).map((t) => (
                    <button
                      key={t}
                      onClick={() => setMicroTab(t)}
                      className={`px-2.5 py-1.5 capitalize transition-colors ${
                        microTab === t
                          ? "bg-slate-900 text-white"
                          : "bg-white text-slate-500 hover:bg-slate-50 hover:text-slate-900"
                      }`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              )}

              <button
                onClick={() => void reset()}
                // There is no graph to put back on a site with no project behind
                // it, and the store refuses the reload rather than pulling the
                // default project's tasks onto someone else's pin. Say so here
                // instead of leaving a button that looks live and does nothing.
                disabled={!onboarded}
                title={
                  onboarded
                    ? undefined
                    : "Nothing to reset — this site has no schedule yet"
                }
                className="rounded-md border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-40"
              >
                Reset
              </button>
              {/* Contractors submit from their own portal; the owner reviews here. */}
              <ApprovalQueue />
            </>
          )}
          <ActivityToggle />
        </div>
      </header>

      {/* The wrapper is load-bearing: every body panel sizes itself with
          h-full/w-full, so it needs a flex-1 parent to fill. Without it the
          map canvas collapses to zero width and only the side panel renders. */}
      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          {!isOwner ? (
            <ContractorPortal />
          ) : loading ? (
            <div className="flex h-full w-full items-center justify-center text-xs text-slate-400">
              loading graph…
            </div>
          ) : view === "macro" ? (
            <MacroHeatmap onOpenSite={(hotzone) => void loadSite(hotzone.id)} />
          ) : !hasGraph ? (
            <OnboardSite />
          ) : microTab === "procurement" ? (
            <AttributionLedger />
          ) : (
            <SiteTab />
          )}
        </div>

        {/* The agentic-work confirmation surface, on every view. */}
        <ActivityRail />
      </div>
    </main>
  );
}

function SiteTab() {
  const columnRef = useRef<HTMLDivElement>(null);
  const bandRef = useRef<HTMLDivElement>(null);
  const clearFocus = useJenga((s) => s.clearFocus);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const el = e.target as HTMLElement | null;
      if (
        el &&
        (el.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName))
      )
        return;
      clearFocus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [clearFocus]);

  const [topFrac, setTopFrac, resetTop] = useFraction(
    "jenga.split.top",
    0.66,
    0.15,
    0.85,
  );
  const [graphFrac, setGraphFrac, resetGraph] = useFraction(
    "jenga.split.graph",
    0.5,
    0.2,
    0.8,
  );

  return (
    <div ref={columnRef} className="flex h-full min-h-0 w-full flex-col">
      {/* Top band: blueprint + twin side by side, verdict/pipeline rail on the right. */}
      <div
        className="flex min-h-0 shrink-0"
        style={{ height: `${topFrac * 100}%` }}
      >
        <div ref={bandRef} className="flex min-w-0 flex-1">
          <div
            className="min-w-0 flex-1 lg:flex-none lg:w-(--graph-w)"
            style={{ ["--graph-w" as string]: `${graphFrac * 100}%` }}
          >
            <WorkGraph />
          </div>
          <Splitter
            orientation="vertical"
            label="Resize graph and digital twin"
            containerRef={bandRef}
            onFraction={setGraphFrac}
            onReset={resetGraph}
            className="hidden lg:block"
          />
          <div className="hidden min-w-0 flex-1 lg:block">
            <StationView />
          </div>
        </div>
        <VerifyRail />
      </div>

      <Splitter
        orientation="horizontal"
        label="Resize graph and schedule"
        containerRef={columnRef}
        onFraction={setTopFrac}
        onReset={resetTop}
      />

      {/* Site pace at a glance — SPI, spend vs earned, projected finish. */}
      <PaceStrip />

      {/* Schedule spans the full width along the bottom. */}
      <div className="min-h-0 flex-1">
        <Timeline />
      </div>
    </div>
  );
}

/**
 * The verify rail: the agent pipeline while a submission runs, then the verdict.
 * Collapses to zero width when idle so the blueprint and twin get the room.
 */
function VerifyRail() {
  const busy = useJenga((s) => s.busy);
  const cascading = useJenga((s) => s.cascading);
  const verdict = useJenga((s) => s.verdict);
  const active = (busy && !cascading) || !!verdict;

  if (!active) return null;

  return (
    <aside className="w-[360px] shrink-0 overflow-auto bg-slate-50 p-3">
      <AgentRunning />
      <VerdictPanel />
    </aside>
  );
}

/**
 * What a hotzone with no project behind it opens into.
 *
 * Not an error page: the map watches every site from the municipal feed, and a
 * blueprint is the one thing that turns one into a graph JENGA can verify. So it
 * offers the fastest path to value first — the sample site, already onboarded —
 * and the real path second: hand this site its own drawings.
 */
function OnboardSite() {
  const siteName = useJenga((s) => s.activeSiteName);
  const setView = useJenga((s) => s.setView);
  const loadSample = useJenga((s) => s.loadSample);

  return (
    <div className="h-full overflow-auto bg-white">
      <div className="mx-auto flex min-h-full max-w-lg flex-col justify-center px-6 py-12">
        <button
          onClick={() => setView("macro")}
          className="mb-8 inline-flex items-center gap-1.5 self-start text-[11px] text-slate-400 transition-colors hover:text-slate-700"
        >
          <ArrowLeft size={12} />
          Toronto map
        </button>

        <h2 className="text-2xl font-semibold tracking-tight text-slate-900">
          {siteName}
        </h2>
        <p className="mt-3 max-w-md text-sm leading-relaxed text-slate-500">
          JENGA is watching this site from the municipal feed — permits and
          closures — but has no schedule to verify against yet. Hand it a
          blueprint and it reads the work packages and their dependencies
          straight off the document.
        </p>

        {/* Primary path: instant value on the one site that ships onboarded. */}
        <button
          onClick={() => void loadSample()}
          className="group mt-8 flex w-full items-center justify-between gap-4 rounded-lg bg-slate-900 px-4 py-3.5 text-left text-white transition-colors hover:bg-slate-800"
        >
          <span>
            <span className="block text-sm font-medium">
              See it on the sample site
            </span>
            <span className="mt-0.5 block text-[11px] text-slate-300">
              Eglinton West Station — a fully onboarded schedule
            </span>
          </span>
          <ArrowRight
            size={16}
            className="shrink-0 text-slate-400 transition-transform group-hover:translate-x-0.5 group-hover:text-white"
          />
        </button>

        {/* Secondary path: onboard this specific site from its drawings. */}
        <div className="mt-8">
          <h3 className="mb-2.5 text-xs font-medium text-slate-700">
            Or onboard {siteName} from a blueprint
          </h3>
          <DocumentUpload initialMode="spec" />
          <p className="mt-3 text-[10px] leading-relaxed text-slate-400">
            Extraction is live — packages and dependencies are read from your
            document. Committing them to a new site lands next.
          </p>
        </div>
      </div>
    </div>
  );
}
