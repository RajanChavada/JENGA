'use client';

import React, { useCallback, useMemo, useState } from 'react';
import Map, { Marker, Popup, NavigationControl } from 'react-map-gl/maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';
import { FileUp, MapPinned, RadioTower, RefreshCw } from 'lucide-react';
import { useJenga } from '@/store/useJenga';
import type { Hotzone } from '@/lib/types';

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
  const [popupId, setPopupId] = useState<string | null>(null);

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
    <div className="flex h-full min-h-0 bg-white">
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
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[10px] uppercase tracking-wider text-slate-400">
            scraped hotzones
          </h2>
          <span className="flex items-center gap-1 font-mono text-[9px] text-slate-400">
            <RefreshCw size={10} />
            {hotzones
              ? new Date(hotzones.generated_at).toLocaleTimeString()
              : 'loading'}
          </span>
        </div>

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
