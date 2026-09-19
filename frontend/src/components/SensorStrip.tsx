'use client';

import { useEffect, useState } from 'react';
import { Database, Snowflake } from 'lucide-react';
import * as api from '@/lib/api';
import { sensorCard, thresholdLabel, windowLabel } from '@/lib/fixtures';
import { useJenga } from '@/store/useJenga';

/** Matches the simulator's tick. Faster would poll the same row twice. */
const POLL_MS = 2000;
const SPARK_W = 120;
const SPARK_H = 32;
/** Keeps the stroke and the end marker off the top and bottom edges. */
const SPARK_PAD = 3;

/**
 * The two statements behind this strip, line-wrapped from `SQL_LIVE` and
 * `SQL_AGG` in backend/integrations/tiger.py. They are shown verbatim on
 * purpose: "where is the time-series?" is the first question this feature gets
 * asked, and the honest answer is a hypertable and a continuous aggregate that
 * a judge can read off the screen.
 */
const SQL_LIVE = `-- live · raw hypertable, bucketed on read
SELECT time_bucket(make_interval(secs=>$1), time) AS bucket,
       sensor_type, avg(reading)
FROM sensor_metrics
WHERE ticket_id=$2 AND time > now() - make_interval(secs=>$3)
GROUP BY 1,2 ORDER BY 1`;

const SQL_AGG = `-- rollup · continuous aggregate, refreshed by TimescaleDB
SELECT bucket, sensor_type, avg_reading, min_reading, max_reading
FROM sensor_metrics_5min
WHERE ticket_id=$1 AND bucket > now() - make_interval(hours=>$2)
ORDER BY bucket`;

/**
 * Curing telemetry for the selected ticket: a live sparkline off a TimescaleDB
 * hypertable, the average the arbiter's rule 0 reads, and the cold-snap control
 * that drives the demo beat.
 *
 * Self-contained apart from the store, so the stepper rework can move it into
 * the Submit step without unpicking anything.
 */
export function SensorStrip() {
  const selectedTaskId = useJenga((s) => s.selectedTaskId);
  const tasks = useJenga((s) => s.tasks);
  const sensors = useJenga((s) => s.sensors);
  const loadSensors = useJenga((s) => s.loadSensors);
  const [snapping, setSnapping] = useState(false);

  const task = tasks.find((t) => t.id === selectedTaskId);
  // A pending ticket has no pour to instrument, and nothing is selected on load.
  const ticketId = task && task.state !== 'pending' ? task.id : null;

  /**
   * One interval, keyed on the ticket. Changing selection tears the old one
   * down before the new one starts, so a long demo cannot accumulate a poll per
   * node the presenter happened to click.
   */
  useEffect(() => {
    if (!ticketId) return;
    void loadSensors(ticketId);
    const handle = setInterval(() => void loadSensors(ticketId), POLL_MS);
    return () => clearInterval(handle);
  }, [ticketId, loadSensors]);

  if (!ticketId) return null;

  const payload = sensors[ticketId];
  const status = payload?.status;
  const card = sensorCard(status);
  const temps = (payload?.live ?? [])
    .map((b) => b.avg_temp)
    .filter((t): t is number => t !== null);

  const threshold = status?.threshold_c ?? 10;
  const samples = status?.samples ?? 0;
  const floor = status?.min_samples || 10;
  const sparse = samples > 0 && samples < floor;
  const below = Boolean(status?.below_threshold);

  async function coldSnap() {
    if (!ticketId) return;
    setSnapping(true);
    try {
      await api.setSensorScenario(ticketId, 'cold');
      await loadSensors(ticketId);
    } finally {
      setSnapping(false);
    }
  }

  return (
    <section
      aria-label="Curing telemetry"
      className="flex shrink-0 items-center gap-3 border-t border-slate-200 bg-white px-3 py-2"
    >
      <div className="min-w-0">
        <h3 className="whitespace-nowrap text-[10px] uppercase tracking-wider text-slate-400">
          Curing telemetry · Tiger Data
        </h3>
        <span className="font-mono text-[10px] text-slate-400">{ticketId}</span>
      </div>

      <div className="flex items-baseline gap-1.5">
        <span
          className={`font-mono text-lg leading-none ${
            below ? 'text-red-600' : sparse ? 'text-slate-500' : 'text-slate-800'
          }`}
        >
          {status?.avg_temp_c === null || status?.avg_temp_c === undefined
            ? '—'
            : status.avg_temp_c.toFixed(1)}
        </span>
        <span className="text-[10px] text-slate-400">
          {/* No window is quoted with no readings behind it. */}
          °C avg{status && samples ? ` · ${windowLabel(status.window_s)}` : ''}
        </span>
      </div>

      <SourceBadge source={status?.source} />

      <Sparkline temps={temps} threshold={threshold} below={below} />

      {/*
        Sample count sits next to the average on purpose: the floor, not the
        temperature, is what gates a dispute for the first ~20 s after a snap,
        and a card that only showed the average would look stuck.
      */}
      <p
        className={`min-w-0 flex-1 truncate text-[10px] ${
          below ? 'text-red-600' : sparse ? 'text-amber-600' : 'text-slate-500'
        }`}
        title={card.detail}
      >
        {sparse
          ? `${samples} of ${floor} readings needed to judge`
          : `${samples} reading${samples === 1 ? '' : 's'}`}
        {' · threshold '}
        {thresholdLabel(threshold)} °C
        {status?.min_temp_c !== null && status?.min_temp_c !== undefined
          ? ` · low ${status.min_temp_c.toFixed(1)} °C`
          : ''}
      </p>

      <button
        type="button"
        onClick={() => void coldSnap()}
        disabled={snapping}
        title="Drop this pour into a cold snap and watch the average fall"
        className="flex shrink-0 items-center gap-1.5 rounded-md border border-sky-200 bg-sky-50 px-2.5 py-1.5 text-xs text-sky-800 transition-colors hover:bg-sky-100 disabled:opacity-50"
      >
        <Snowflake size={12} />
        {snapping ? 'Snapping…' : 'Cold snap'}
      </button>
    </section>
  );
}

/**
 * `tiger` or `mock`, with the two queries behind it one hover away. The badge
 * is small but it is the whole answer to "where's the time-series?", so the
 * tooltip is a readable SQL block rather than a title attribute.
 */
function SourceBadge({ source }: { source?: 'tiger' | 'mock' }) {
  const live = source === 'tiger';
  return (
    <span className="group relative shrink-0">
      <button
        type="button"
        className={`flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] ${
          live
            ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
            : 'border-slate-300 bg-slate-50 text-slate-500'
        }`}
      >
        <Database size={10} />
        {/* Before the first poll lands the source is unknown, and `mock` would
            be a claim about the backend we have not earned yet. */}
        {source ?? '…'}
        <span className="text-slate-400">· sql</span>
      </button>
      <div className="pointer-events-none absolute bottom-full left-0 z-30 mb-2 hidden w-[520px] rounded-lg border border-slate-200 bg-white p-3 shadow-xl group-focus-within:block group-hover:block">
        <p className="mb-2 text-[10px] uppercase tracking-wider text-slate-400">
          {live
            ? 'Reading live from TimescaleDB on Tiger Cloud'
            : 'No Tiger service reached — in-memory store'}
        </p>
        <pre className="overflow-x-auto whitespace-pre rounded bg-slate-50 p-2 font-mono text-[10px] leading-relaxed text-slate-700">
          {SQL_LIVE}
        </pre>
        <pre className="mt-2 overflow-x-auto whitespace-pre rounded bg-slate-50 p-2 font-mono text-[10px] leading-relaxed text-slate-700">
          {SQL_AGG}
        </pre>
      </div>
    </span>
  );
}

/**
 * Inline SVG, no chart library. Renders sensibly at one and two points, which
 * it routinely has to: the backend clamps its window to the last regime change,
 * so the seconds after a cold snap are genuinely one or two buckets wide.
 */
function Sparkline({
  temps,
  threshold,
  below,
}: {
  temps: number[];
  threshold: number;
  below: boolean;
}) {
  const lo = Math.min(threshold, ...temps);
  const hi = Math.max(threshold, ...temps);
  // A degree of headroom, and never a zero span — a flat trace should sit in
  // the middle of the box rather than divide by zero.
  const span = Math.max(hi - lo, 2);
  const mid = (hi + lo) / 2;
  const y = (t: number) =>
    SPARK_H - SPARK_PAD - ((t - (mid - span / 2)) / span) * (SPARK_H - 2 * SPARK_PAD);
  const x = (i: number) =>
    temps.length < 2 ? SPARK_W / 2 : (i / (temps.length - 1)) * SPARK_W;

  return (
    <svg
      width={SPARK_W}
      height={SPARK_H}
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      className="shrink-0 rounded border border-slate-200 bg-slate-50"
      role="img"
      aria-label={`Curing temperature, last ${temps.length} buckets`}
    >
      <line
        x1={0}
        x2={SPARK_W}
        y1={y(threshold)}
        y2={y(threshold)}
        strokeDasharray="3 3"
        className="stroke-red-300"
        strokeWidth={1}
      />
      {temps.length > 1 && (
        <polyline
          fill="none"
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
          className={below ? 'stroke-red-500' : 'stroke-sky-500'}
          points={temps.map((t, i) => `${x(i)},${y(t)}`).join(' ')}
        />
      )}
      {temps.length > 0 && (
        <circle
          cx={x(temps.length - 1)}
          cy={y(temps[temps.length - 1])}
          r={2}
          className={below ? 'fill-red-500' : 'fill-sky-500'}
        />
      )}
    </svg>
  );
}
