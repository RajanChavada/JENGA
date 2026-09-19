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
/** Keeps the stroke and the end marker clear of all four edges. */
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
  const logActivity = useJenga((s) => s.logActivity);
  const [snapping, setSnapping] = useState(false);
  const [snapFailed, setSnapFailed] = useState(false);

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
    // A failed snap belongs to the ticket it was aimed at, not to the strip.
    setSnapFailed(false);
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
    setSnapFailed(false);
    try {
      // null means the regime did not change. Say so on the button rather than
      // leaving the presenter watching a sparkline that is never going to fall.
      const applied = await api.setSensorScenario(ticketId, 'cold');
      setSnapFailed(applied === null);
      logActivity(
        applied
          ? {
              source: 'tiger',
              status: 'warn',
              title: `Cold snap on ${ticketId} — curing regime changed`,
              detail:
                'Telemetry window reset to the new regime. Once ten readings land below 10 °C, the arbiter\u2019s rule 0 will dispute any "curing fine" claim.',
            }
          : {
              source: 'tiger',
              status: 'error',
              title: `Cold snap on ${ticketId} did not apply`,
            },
      );
      if (applied) await loadSensors(ticketId);
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
        {/* Not decoration: this stream is the arbiter's rule 0. Say so where
            the sparkline is, not only inside a hover panel. */}
        <span className="whitespace-nowrap font-mono text-[10px] text-slate-400">
          {ticketId} <span className="text-slate-300">·</span>{' '}
          <span title="The verification arbiter reads this average before any approval: a curing claim over a sub-threshold pour is disputed on telemetry alone.">
            gates the arbiter&apos;s rule 0
          </span>
        </span>
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

        Sparse reads neutral here, the same as it does in both verdict panels.
        It was amber, which made one fact three colours across three surfaces.
        The state is carried by the wording and by the dimmed average instead —
        "too few readings to judge" is a statement about the evidence, not a
        warning about the pour, and amber says the opposite.
      */}
      <p
        className={`min-w-0 flex-1 truncate text-[10px] ${
          below ? 'text-red-600' : 'text-slate-500'
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
        title={
          snapFailed
            ? 'The sensor service did not accept the scenario change. The pour is still curing normally.'
            : 'Drop this pour into a cold snap and watch the average fall'
        }
        className={`flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs transition-colors disabled:opacity-50 ${
          snapFailed
            ? 'border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100'
            : 'border-sky-200 bg-sky-50 text-sky-800 hover:bg-sky-100'
        }`}
      >
        <Snowflake size={12} />
        {snapping ? 'Snapping…' : snapFailed ? 'Snap failed — retry' : 'Cold snap'}
      </button>
    </section>
  );
}

/**
 * `tiger` or `mock`, with the two queries behind it. The badge is small but it
 * is the whole answer to "where's the time-series?", so the SQL is a readable
 * block rather than a title attribute.
 *
 * It is a **disclosure button**, not a decorative badge with a tooltip. The
 * earlier version was a `<button>` that did nothing on click and existed only
 * to be focusable, which announces to assistive tech as an action that isn't
 * there. Clicking now genuinely opens and closes the panel and `aria-expanded`
 * says which, so the keyboard and screen-reader paths tell the truth. Hover
 * still reveals it for the mouse, and the panel is inside the `group` and
 * accepts pointer events, so the cursor can travel from the badge into the SQL
 * to select and copy it — which is what the person who leans in to read it
 * closely is trying to do.
 */
function SourceBadge({ source }: { source?: 'tiger' | 'mock' }) {
  const live = source === 'tiger';
  const [open, setOpen] = useState(false);
  const panelId = 'sensor-sql-panel';
  return (
    <span className="group relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`Telemetry source: ${source ?? 'not yet known'}. Show the SQL behind this strip.`}
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
      <div
        id={panelId}
        className={`absolute bottom-full left-0 z-30 mb-2 w-[520px] rounded-lg border border-slate-200 bg-white p-3 shadow-xl ${
          open ? 'block' : 'hidden group-hover:block'
        }`}
      >
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
  // Inset horizontally as well as vertically. Without this the newest reading
  // lands at x = SPARK_W and the right half of its marker falls outside the
  // viewBox — which is exactly where the eye goes during the cold snap.
  const x = (i: number) =>
    temps.length < 2
      ? SPARK_W / 2
      : (i / (temps.length - 1)) * (SPARK_W - 2 * SPARK_PAD) + SPARK_PAD;

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
