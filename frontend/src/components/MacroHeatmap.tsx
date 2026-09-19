'use client';

import React, { useCallback, useMemo, useState } from 'react';
import Map, { Layer, Marker, Popup, NavigationControl, Source } from 'react-map-gl/maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';
import { motion } from 'framer-motion';
import {
  Factory,
  FileUp,
  Globe,
  MapPinned,
  RadioTower,
  RefreshCw,
  TriangleAlert,
  Truck,
} from 'lucide-react';
import { useJenga } from '@/store/useJenga';
import type { Hotzone, RouteClosure, RouteRisk } from '@/lib/types';

/* -------------------------------------------------------------------------- */
/* Severity palette                                                           */
/* -------------------------------------------------------------------------- */

const SEVERITY_STYLES: Record<
  Hotzone['severity'],
  { bg: string; ring: string; text: string; glow: string }
> = {
  high: {
    bg: 'bg-red-500',
    ring: 'shadow-[0_0_10px_2px_rgba(239,68,68,.35)]',
    text: 'text-red-600',
    glow: 'rgba(239,68,68,.45)',
  },
  medium: {
    bg: 'bg-amber-500',
    ring: 'shadow-[0_0_10px_2px_rgba(245,158,11,.30)]',
    text: 'text-amber-600',
    glow: 'rgba(245,158,11,.40)',
  },
  low: {
    bg: 'bg-sky-500',
    ring: 'shadow-[0_0_10px_2px_rgba(14,165,233,.25)]',
    text: 'text-sky-600',
    glow: 'rgba(14,165,233,.35)',
  },
};

/* -------------------------------------------------------------------------- */
/* Pulsing marker                                                             */
/* -------------------------------------------------------------------------- */

function PulsingDot({
  severity,
  active,
  onClick,
}: {
  severity: Hotzone['severity'];
  active: boolean;
  onClick: () => void;
}) {
  const s = SEVERITY_STYLES[severity];
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group relative flex h-8 w-8 items-center justify-center rounded-full transition-transform hover:scale-125 ${
        active ? 'scale-125' : ''
      }`}
    >
      {/* outer pulse ring */}
      <span
        className={`absolute h-full w-full animate-ping rounded-full opacity-40 ${s.bg}`}
        style={{ animationDuration: '2s' }}
      />
      {/* static glow */}
      <span
        className={`absolute h-full w-full rounded-full ${s.ring}`}
        style={{ background: `radial-gradient(circle, ${s.glow} 0%, transparent 70%)` }}
      />
      {/* centre dot */}
      <span
        className={`relative z-10 h-3 w-3 rounded-full border-2 border-white/80 ${s.bg}`}
        style={{
          boxShadow: active ? `0 0 22px 4px ${s.glow}` : undefined,
        }}
      />
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* Scrape progress                                                            */
/* -------------------------------------------------------------------------- */

/** Mirrors `SOURCES` in backend/browserbase_hotzones.py — what a press fetches. */
const SCRAPE_STEPS = [
  { host: 'toronto.ca', what: 'road restrictions & closure permits' },
  { host: 'metrolinx.com', what: 'Eglinton Crosstown West updates' },
  { host: 'extraction', what: 'reading construction zones from the pages' },
];

/**
 * What the scrape is doing while it runs: the actual sources Browserbase
 * fetches, stepping as the request progresses. The steps are real (they mirror
 * the backend's source list); only the timing is approximated, since one POST
 * covers the whole run.
 */
function ScrapeProgress() {
  return (
    <ol className="mb-2 flex flex-col gap-1 rounded-md border border-sky-200 bg-sky-50/60 p-2">
      {SCRAPE_STEPS.map((s, i) => (
        <motion.li
          key={s.host}
          initial={{ opacity: 0.35 }}
          animate={{ opacity: [0.35, 1, 0.35] }}
          transition={{ duration: 1.4, repeat: Infinity, delay: i * 0.45, ease: 'easeInOut' }}
          className="flex items-center gap-1.5 text-[10px] text-sky-900"
        >
          <Globe size={10} className="shrink-0 text-sky-500" />
          <span className="font-mono">{s.host}</span>
          <span className="truncate text-sky-700/70">— {s.what}</span>
        </motion.li>
      ))}
    </ol>
  );
}

/* -------------------------------------------------------------------------- */
/* Supply-line radar                                                          */
/* -------------------------------------------------------------------------- */

/** Mirrors the backend pass in route_risk.check_routes — what a press does. */
const ROUTE_STEPS = [
  { host: '511on.ca', what: 'live closures & incidents via Browserbase' },
  { host: 'router.project-osrm.org', what: 'tracing vendor → site delivery routes' },
  { host: 'analysis', what: 'closures on route → CPM slip preview → Zip action' },
];

function RouteProgress() {
  return (
    <ol className="mb-2 flex flex-col gap-1 rounded-md border border-sky-200 bg-sky-50/60 p-2">
      {ROUTE_STEPS.map((s, i) => (
        <motion.li
          key={s.host}
          initial={{ opacity: 0.35 }}
          animate={{ opacity: [0.35, 1, 0.35] }}
          transition={{ duration: 1.4, repeat: Infinity, delay: i * 0.45, ease: 'easeInOut' }}
          className="flex items-center gap-1.5 text-[10px] text-sky-900"
        >
          <Globe size={10} className="shrink-0 text-sky-500" />
          <span className="font-mono">{s.host}</span>
          <span className="truncate text-sky-700/70">— {s.what}</span>
        </motion.li>
      ))}
    </ol>
  );
}

const RISK_TONE: Record<RouteRisk['risk'], { text: string; chip: string; line: string }> = {
  high: { text: 'text-red-600', chip: 'border-red-200 bg-red-50 text-red-700', line: '#dc2626' },
  medium: {
    text: 'text-amber-600',
    chip: 'border-amber-200 bg-amber-50 text-amber-700',
    line: '#d97706',
  },
  low: { text: 'text-slate-500', chip: 'border-slate-200 bg-slate-50 text-slate-600', line: '#64748b' },
  clear: {
    text: 'text-emerald-600',
    chip: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    line: '#94a3b8',
  },
};

/** One radar result, as a side-panel card. */
function RouteCard({ route }: { route: RouteRisk }) {
  const tone = RISK_TONE[route.risk];
  const worst = route.closures[0];
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-2.5 text-[10px]">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate font-medium text-slate-800">
          {route.vendor} <span className="text-slate-400">→ site</span>
        </span>
        <span className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] uppercase tracking-wider ${tone.chip}`}>
          {route.risk}
        </span>
      </div>
      <p className="mt-0.5 text-slate-400">
        {route.po_id} · {route.material}
        {!route.geometry_live && ' · straight-line corridor (router offline)'}
      </p>
      {route.closures.length > 0 && (
        <p className="mt-1 leading-relaxed text-slate-600">
          {route.closures.length} closure{route.closures.length === 1 ? '' : 's'} on route
          {worst && (
            <span className="text-slate-500">
              {' '}
              · worst: {worst.roadway} — {worst.description.slice(0, 90)}
            </span>
          )}
        </p>
      )}
      {route.predicted_slip_days > 0 && route.cpm_preview && (
        <p className={`mt-1 font-medium ${tone.text}`}>
          Predicted +{route.predicted_slip_days}d delivery slip → {route.cpm_preview.task_id} →
          project +{route.cpm_preview.project_slip_days}d ·{' '}
          {route.cpm_preview.downstream_count} downstream tasks
        </p>
      )}
      {route.action !== 'none' && (
        <p className="mt-1 rounded border border-sky-200 bg-sky-50 p-1.5 leading-relaxed text-sky-800">
          <Truck size={10} className="mr-1 inline" />
          Agent {route.action}: {route.action_detail}
        </p>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Component                                                                  */
/* -------------------------------------------------------------------------- */

export function MacroHeatmap({
  onOpenSite,
}: {
  /**
   * Called with the hotzone itself, linked or not: an unlinked pin opens the
   * onboarding pitch rather than nothing, so the caller needs to know which
   * site was clicked to decide between the two.
   */
  onOpenSite: (hotzone: Hotzone) => void;
}) {
  const hotzones = useJenga((s) => s.hotzones);
  const scraping = useJenga((s) => s.scrapingHotzones);
  const scrapeError = useJenga((s) => s.scrapeError);
  const scrapeHotzones = useJenga((s) => s.scrapeHotzones);
  const routeRisk = useJenga((s) => s.routeRisk);
  const checkingRoutes = useJenga((s) => s.checkingRoutes);
  const checkRoutes = useJenga((s) => s.checkRoutes);
  const [popupId, setPopupId] = useState<string | null>(null);
  /** Set once the user has pressed scrape, so the panel can confirm the outcome. */
  const [scrapedOnce, setScrapedOnce] = useState(false);
  const [closurePopup, setClosurePopup] = useState<RouteClosure | null>(null);

  /** Route lines as one GeoJSON collection; the layer colours by `risk`. */
  const routeGeojson = useMemo(() => {
    if (!routeRisk) return null;
    return {
      type: 'FeatureCollection' as const,
      features: routeRisk.routes.map((r) => ({
        type: 'Feature' as const,
        properties: { risk: r.risk },
        geometry: { type: 'LineString' as const, coordinates: r.geometry },
      })),
    };
  }, [routeRisk]);

  /**
   * Closure markers, flagged routes only, deduped (parallel routes share the
   * same 401 works) and capped so a heavy 511 night cannot flood the DOM.
   */
  const closureMarkers = useMemo(() => {
    if (!routeRisk) return [];
    const seen = new Set<string>();
    const out: RouteClosure[] = [];
    for (const r of routeRisk.routes) {
      if (r.risk === 'clear') continue;
      for (const c of r.closures) {
        const key = `${c.lat.toFixed(3)},${c.lng.toFixed(3)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(c);
        if (out.length >= 24) return out;
      }
    }
    return out;
  }, [routeRisk]);

  const sorted = useMemo(
    () =>
      [...(hotzones?.hotzones ?? [])].sort((a, b) => {
        const rank = { high: 0, medium: 1, low: 2 };
        return rank[a.severity] - rank[b.severity] || a.name.localeCompare(b.name);
      }),
    [hotzones],
  );

  const popupInfo = sorted.find((h) => h.id === popupId) ?? null;

  const handleMarkerClick = useCallback(
    (h: Hotzone) => {
      setPopupId(h.id);
    },
    [],
  );

  const handleDrillDown = useCallback(
    (h: Hotzone) => {
      setPopupId(null);
      onOpenSite(h);
    },
    [onOpenSite],
  );

  return (
    <div className="flex h-full w-full min-h-0 bg-white">
      {/* --- Map panel --- */}
      <section className="relative min-w-0 flex-1 overflow-hidden border-r border-slate-200">
        {/* Status badge */}
        <div className="absolute left-4 top-4 z-20 flex items-center gap-2 rounded-lg border border-slate-200 bg-white/90 px-3 py-2 shadow-sm backdrop-blur-md">
          <RadioTower size={14} className="text-slate-400" />
          <div>
            <p className="text-[10px] uppercase tracking-wider text-slate-400">
              Browserbase macro feed
            </p>
            <p className="text-xs text-slate-700">
              Toronto construction heatmap
              {hotzones?.source === 'browserbase' ? (
                <span className="ml-2 inline-flex items-center gap-1 text-emerald-600">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
                  live
                </span>
              ) : (
                <span className="ml-2 text-slate-400">offline seed</span>
              )}
            </p>
          </div>
        </div>

        {/* MapLibre GL map */}
        <Map
          initialViewState={{
            latitude: 43.695,
            longitude: -79.44,
            zoom: 11.5,
            pitch: 0,
            bearing: 0,
          }}
          mapStyle="https://basemaps.cartocdn.com/gl/positron-gl-style/style.json"
          style={{ width: '100%', height: '100%' }}
          attributionControl={false}
        >
          <NavigationControl position="bottom-right" showCompass={false} />

          {/* Delivery routes, under the pins. Colour = risk. */}
          {routeGeojson && (
            <Source id="delivery-routes" type="geojson" data={routeGeojson}>
              <Layer
                id="delivery-route-lines"
                type="line"
                layout={{ 'line-cap': 'round', 'line-join': 'round' }}
                paint={{
                  'line-color': [
                    'match',
                    ['get', 'risk'],
                    'high',
                    RISK_TONE.high.line,
                    'medium',
                    RISK_TONE.medium.line,
                    'low',
                    RISK_TONE.low.line,
                    RISK_TONE.clear.line,
                  ],
                  'line-width': ['match', ['get', 'risk'], 'high', 3.5, 'medium', 2.5, 1.5],
                  'line-opacity': 0.75,
                }}
              />
            </Source>
          )}

          {/* Vendor plants: where each material starts its trip. */}
          {routeRisk?.routes.map((r) => (
            <Marker key={`v-${r.po_id}`} latitude={r.vendor_lat} longitude={r.vendor_lng} anchor="center">
              <span
                title={`${r.vendor} — ${r.material} (${r.po_id})`}
                className="flex h-6 w-6 items-center justify-center rounded-md border border-slate-300 bg-white text-slate-600 shadow-sm"
              >
                <Factory size={13} />
              </span>
            </Marker>
          ))}

          {/* Closures sitting on a flagged route. */}
          {closureMarkers.map((c, i) => (
            <Marker key={`c-${i}`} latitude={c.lat} longitude={c.lng} anchor="center">
              <button
                type="button"
                onClick={() => setClosurePopup(c)}
                title={`${c.roadway}: ${c.description.slice(0, 120)}`}
                className={`flex h-5 w-5 items-center justify-center rounded-full border shadow-sm transition-transform hover:scale-125 ${
                  c.full_closure
                    ? 'border-red-300 bg-red-100 text-red-700'
                    : 'border-amber-300 bg-amber-100 text-amber-700'
                }`}
              >
                <TriangleAlert size={11} />
              </button>
            </Marker>
          ))}

          {closurePopup && (
            <Popup
              latitude={closurePopup.lat}
              longitude={closurePopup.lng}
              closeOnClick={false}
              onClose={() => setClosurePopup(null)}
              anchor="bottom"
              offset={14}
              closeButton={false}
              className="jenga-popup"
              maxWidth="300px"
            >
              <div className="rounded-lg border border-slate-200 bg-white p-2.5 shadow-xl">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-slate-900">
                    {closurePopup.roadway}
                  </span>
                  <span
                    className={`rounded px-1.5 py-0.5 font-mono text-[9px] ${
                      closurePopup.full_closure
                        ? 'border border-red-200 bg-red-50 text-red-600'
                        : 'border border-amber-200 bg-amber-50 text-amber-600'
                    }`}
                  >
                    {closurePopup.full_closure ? 'full closure' : closurePopup.impact || 'restriction'}
                  </span>
                </div>
                <p className="mt-1.5 text-[10px] leading-relaxed text-slate-600">
                  {closurePopup.description}
                </p>
                {closurePopup.lanes_affected && (
                  <p className="mt-1 font-mono text-[9px] text-slate-400">
                    lanes: {closurePopup.lanes_affected}
                  </p>
                )}
              </div>
            </Popup>
          )}

          {sorted.map((h) => (
            <Marker
              key={h.id}
              latitude={h.lat}
              longitude={h.lng}
              anchor="center"
            >
              <PulsingDot
                severity={h.severity}
                active={popupId === h.id}
                onClick={() => handleMarkerClick(h)}
              />
            </Marker>
          ))}

          {popupInfo && (
            <Popup
              latitude={popupInfo.lat}
              longitude={popupInfo.lng}
              closeOnClick={false}
              onClose={() => setPopupId(null)}
              anchor="bottom"
              offset={20}
              closeButton={false}
              className="jenga-popup"
              maxWidth="320px"
            >
              <div className="rounded-lg border border-slate-200 bg-white p-3 shadow-xl">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-900">
                      {popupInfo.name}
                    </h3>
                    <p className="text-[10px] text-slate-400">{popupInfo.project}</p>
                  </div>
                  <span
                    className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[9px] ${
                      SEVERITY_STYLES[popupInfo.severity].text
                    } border ${
                      popupInfo.severity === 'high'
                        ? 'border-red-200 bg-red-50'
                        : popupInfo.severity === 'medium'
                          ? 'border-amber-200 bg-amber-50'
                          : 'border-sky-200 bg-sky-50'
                    }`}
                  >
                    {popupInfo.severity}
                  </span>
                </div>

                <p className="mt-2 text-[11px] leading-relaxed text-slate-600">
                  {popupInfo.summary}
                </p>

                {popupInfo.linked_site_id ? (
                  <button
                    onClick={() => handleDrillDown(popupInfo)}
                    className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-md bg-slate-900 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-slate-800"
                  >
                    <MapPinned size={13} />
                    Drill into JENGA micro-view →
                  </button>
                ) : (
                  <button
                    onClick={() => handleDrillDown(popupInfo)}
                    className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-md border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700 transition-colors hover:border-slate-400 hover:bg-slate-50"
                  >
                    <FileUp size={13} />
                    Onboard this site from its blueprint →
                  </button>
                )}
              </div>
            </Popup>
          )}
        </Map>
      </section>

      {/* --- Side panel --- */}
      <aside className="flex h-full w-[360px] shrink-0 flex-col overflow-auto border-l border-slate-200 bg-white p-3">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-[10px] uppercase tracking-wider text-slate-400">
            construction hotzones
          </h2>
          <span className="flex items-center gap-1 font-mono text-[9px] text-slate-400">
            <RefreshCw size={10} className={scraping ? 'animate-spin' : ''} />
            {hotzones
              ? new Date(hotzones.generated_at).toLocaleTimeString()
              : 'loading'}
          </span>
        </div>

        {/* Press-to-scrape: Browserbase runs only on this button, never on page
            load, so the operator sees the scrape happen and gets a result. */}
        <button
          type="button"
          onClick={() => {
            setScrapedOnce(true);
            void scrapeHotzones();
          }}
          disabled={scraping}
          className="mb-2 flex w-full items-center justify-center gap-2 rounded-md bg-slate-900 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-slate-800 disabled:opacity-60"
        >
          {scraping ? (
            <>
              <RefreshCw size={13} className="animate-spin" />
              Scraping municipal feeds via Browserbase…
            </>
          ) : (
            <>
              <RadioTower size={13} />
              Scrape live feeds
            </>
          )}
        </button>

        {/* While running: the sources Browserbase is actually fetching. */}
        {scraping && <ScrapeProgress />}

        {/* Supply-line radar: delivery routes vs live 511 closures. */}
        <button
          type="button"
          onClick={() => void checkRoutes()}
          disabled={checkingRoutes}
          className="mb-2 flex w-full items-center justify-center gap-2 rounded-md border border-slate-900 bg-white px-3 py-2 text-xs font-medium text-slate-900 transition-colors hover:bg-slate-50 disabled:opacity-60"
        >
          {checkingRoutes ? (
            <>
              <RefreshCw size={13} className="animate-spin" />
              Tracing routes · scanning 511 closures…
            </>
          ) : (
            <>
              <Truck size={13} />
              Check delivery routes
            </>
          )}
        </button>

        {checkingRoutes && <RouteProgress />}

        {routeRisk && !checkingRoutes && (
          <div className="mb-2">
            <p
              className={`mb-2 rounded-md border p-2 text-[10px] leading-relaxed ${
                routeRisk.source === 'live'
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                  : 'border-amber-200 bg-amber-50 text-amber-800'
              }`}
            >
              {routeRisk.source === 'live'
                ? `${routeRisk.events_scanned} live 511 events scanned at ${new Date(routeRisk.checked_at).toLocaleTimeString()} — ${routeRisk.routes.filter((r) => r.risk !== 'clear').length} of ${routeRisk.routes.length} delivery routes at risk.`
                : 'Live 511 feed unreachable — showing a seeded closure so the analysis is still demonstrable.'}
            </p>
            <div className="flex flex-col gap-1.5">
              {[...routeRisk.routes]
                .sort((a, b) => b.predicted_slip_days - a.predicted_slip_days)
                .map((r) => (
                  <RouteCard key={r.po_id} route={r} />
                ))}
            </div>
          </div>
        )}

        {/* Outcome confirmation: what the press actually did, in one line.
            Three honest outcomes: live data landed; the scrape ran but fell
            back to the seed (note below says why); or it never reached the
            backend at all — which must not be dressed up as either. */}
        {scrapedOnce && !scraping && (scrapeError || hotzones) && (
          <p
            className={`mb-2 rounded-md border p-2 text-[10px] leading-relaxed ${
              scrapeError
                ? 'border-red-200 bg-red-50 text-red-700'
                : hotzones!.source === 'browserbase'
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                  : 'border-amber-200 bg-amber-50 text-amber-800'
            }`}
          >
            {scrapeError
              ? scrapeError
              : hotzones!.source === 'browserbase'
                ? `Live scrape complete — ${hotzones!.hotzones.length} zones from Browserbase at ${new Date(hotzones!.generated_at).toLocaleTimeString()}.`
                : 'Scrape ran but returned seeded data — see the note below for why.'}
          </p>
        )}

        {hotzones?.notes && (
          <p className="mb-3 rounded-lg border border-slate-200 bg-slate-50 p-2 text-[10px] leading-relaxed text-slate-500">
            {hotzones.notes}
          </p>
        )}

        <div className="flex flex-col gap-2">
          {sorted.map((h) => {
            const sev = SEVERITY_STYLES[h.severity];
            const active = popupId === h.id;
            return (
              <button
                key={h.id}
                type="button"
                onClick={() => {
                  setPopupId(h.id);
                  onOpenSite(h);
                }}
                className={`rounded-lg border p-2.5 text-left transition-all ${
                  active
                    ? 'border-slate-300 bg-slate-50 ring-1 ring-slate-200'
                    : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-medium text-slate-800">{h.name}</p>
                    <p className="text-[10px] text-slate-400">{h.project}</p>
                  </div>
                  <span className={`font-mono text-[9px] ${sev.text}`}>
                    {h.severity}
                  </span>
                </div>
                <p className="mt-2 text-[10px] leading-relaxed text-slate-500">
                  {h.summary}
                </p>
                {h.linked_site_id ? (
                  <span className="mt-2 inline-flex items-center gap-1 font-mono text-[10px] text-slate-900">
                    <MapPinned size={11} />
                    click drills into JENGA
                  </span>
                ) : (
                  <span className="mt-2 inline-flex items-center gap-1 font-mono text-[10px] text-slate-500">
                    <FileUp size={11} />
                    not onboarded · click to add a blueprint
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </aside>
    </div>
  );
}
