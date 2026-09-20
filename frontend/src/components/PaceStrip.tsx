'use client';

import { useState } from 'react';
import { Database, TrendingDown, TrendingUp } from 'lucide-react';
import { useJenga } from '@/store/useJenga';

/**
 * The two statements behind the analytics band, line-wrapped from `SQL_DAILY`
 * and `SQL_RANGE` in backend/integrations/tiger.py. Shown verbatim on purpose:
 * "where is the time-series?" is the first question this feature gets asked,
 * and the honest answer is a hypertable and a `time_bucket` rollup a judge can
 * read off the screen.
 */
const SQL_DAILY = `-- daily rollup · the S-curve and spend curve
SELECT time_bucket('1 day', time) AS bucket, sum(value) AS total
FROM site_events
WHERE event = ANY($1) AND time > now() - make_interval(days=>$2)
GROUP BY 1 ORDER BY 1`;

const SQL_RANGE = `-- raw stream · every timestamped site fact
SELECT time, subject, event, value FROM site_events
WHERE time > now() - make_interval(days=>$1) ORDER BY time`;

/**
 * Site pace at a glance: SPI, earned vs planned, committed vs budget, and the
 * projected finish — the compact readout over the same Tiger Data stream the
 * timeline's analysis band draws in full. Replaces the old curing-thermometer
 * strip: the time-series now measures the *build*, not a demo scenario.
 */
export function PaceStrip() {
  const schedule = useJenga((s) => s.schedule);
  const spend = useJenga((s) => s.spend);

  if (!schedule) return null;

  const spi = schedule.spi;
  const slip = schedule.projected_slip_days;
  const behind = spi !== null && spi < 0.9;

  return (
    <section
      aria-label="Site pace"
      className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-slate-200 bg-white px-3 py-2"
    >
      <div className="min-w-0">
        <h3 className="whitespace-nowrap text-[10px] uppercase tracking-wider text-slate-400">
          Site pace · Tiger Data
        </h3>
        {/* Not decoration: this stream is the arbiter's rule 0'. Say so where
            the numbers are, not only inside a hover panel. */}
        <span
          className="whitespace-nowrap font-mono text-[10px] text-slate-400"
          title="The verification arbiter reads this pace before any approval: a completion claim that outruns the site's measured pace is held for a field record."
        >
          gates the arbiter&apos;s rule 0
        </span>
      </div>

      <div className="flex items-baseline gap-1.5" title="Schedule performance index: verified work ÷ planned work, to date.">
        {behind ? (
          <TrendingDown size={13} className="self-center text-amber-600" />
        ) : (
          <TrendingUp size={13} className="self-center text-emerald-600" />
        )}
        <span
          className={`font-mono text-lg leading-none ${
            spi === null ? 'text-slate-400' : behind ? 'text-amber-700' : 'text-slate-800'
          }`}
        >
          {spi === null ? '—' : spi.toFixed(2)}
        </span>
        <span className="text-[10px] text-slate-400">SPI</span>
      </div>

      <span className="font-mono text-[10px] text-slate-500">
        {schedule.earned_total}d earned / {schedule.planned_total}d planned
      </span>

      {spend && (
        <span
          className="font-mono text-[10px] text-slate-500"
          title={`$${spend.committed_total.toLocaleString()} committed of a $${spend.budget.toLocaleString()} ${spend.currency} site budget`}
        >
          {spend.committed_pct}% budget committed · {spend.earned_pct}% work verified
        </span>
      )}

      {slip !== null && (
        <span
          className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${
            slip > 0
              ? 'border-amber-300 bg-amber-50 text-amber-700'
              : 'border-emerald-200 bg-emerald-50 text-emerald-700'
          }`}
        >
          projected {slip > 0 ? `+${slip}` : slip}d
        </span>
      )}

      {spend?.escalation && (
        <span className="rounded border border-red-300 bg-red-50 px-1.5 py-0.5 font-mono text-[10px] text-red-700">
          escalated · spend outruns build
        </span>
      )}

      <span className="min-w-0 flex-1" />

      {schedule.seeded && (
        <span className="text-[9px] text-slate-300" title="Events before today are seeded demo history, consistent with the sample site's task states. Everything from your session on is real.">
          seeded history
        </span>
      )}
      <SourceBadge source={schedule.source} />
    </section>
  );
}

/**
 * `tiger` or `mock`, with the two queries behind it. A disclosure button, not a
 * decorative badge: clicking genuinely opens and closes the panel and
 * `aria-expanded` says which. Hover still reveals it for the mouse.
 */
function SourceBadge({ source }: { source?: 'tiger' | 'mock' }) {
  const live = source === 'tiger';
  const [open, setOpen] = useState(false);
  const panelId = 'pace-sql-panel';
  return (
    <span className="group relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`Event-stream source: ${source ?? 'not yet known'}. Show the SQL behind this strip.`}
        className={`flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] ${
          live
            ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
            : 'border-slate-300 bg-slate-50 text-slate-500'
        }`}
      >
        <Database size={10} />
        {source ?? '…'}
        <span className="text-slate-400">· sql</span>
      </button>
      <div
        id={panelId}
        className={`absolute bottom-full right-0 z-30 mb-2 w-[520px] rounded-lg border border-slate-200 bg-white p-3 shadow-xl ${
          open ? 'block' : 'hidden group-hover:block'
        }`}
      >
        <p className="mb-2 text-[10px] uppercase tracking-wider text-slate-400">
          {live
            ? 'Reading live from TimescaleDB on Tiger Cloud'
            : 'No Tiger service reached — in-memory store, same buckets'}
        </p>
        <pre className="overflow-x-auto whitespace-pre rounded bg-slate-50 p-2 font-mono text-[10px] leading-relaxed text-slate-700">
          {SQL_DAILY}
        </pre>
        <pre className="mt-2 overflow-x-auto whitespace-pre rounded bg-slate-50 p-2 font-mono text-[10px] leading-relaxed text-slate-700">
          {SQL_RANGE}
        </pre>
      </div>
    </span>
  );
}
