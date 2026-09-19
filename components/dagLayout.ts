import type { Ticket } from "@/lib/types";

export const DEFAULT_PX_PER_DAY = 40;
export const MIN_PX_PER_DAY = 0.3;
const TARGET_TOTAL_WIDTH = 3000;

export const ROW_HEIGHT = 56;
export const MIN_BAR_WIDTH = 32;

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const iso = value.length <= 10 ? `${value}T00:00:00Z` : value.replace(" ", "T") + "Z";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

function diffDays(a: Date, b: Date): number {
  return Math.round((a.getTime() - b.getTime()) / 86_400_000);
}

function computePxPerDay(totalDays: number): number {
  if (totalDays <= 0) return DEFAULT_PX_PER_DAY;
  const scaled = TARGET_TOTAL_WIDTH / totalDays;
  return Math.min(DEFAULT_PX_PER_DAY, Math.max(MIN_PX_PER_DAY, scaled));
}

export interface TimelineLayout {
  positions: Map<string, { x: number; y: number }>;
  widths: Map<string, number>;
  minDate: Date;
  maxDate: Date;
  laneCount: number;
  pxPerDay: number;
}

export function layoutTimeline(tickets: Ticket[]): TimelineLayout {
  const today = new Date();
  const withDates = tickets.map((t) => {
    const start = parseDate(t.PLANNED_START) ?? today;
    const end = parseDate(t.PLANNED_END) ?? start;
    return { ticket: t, start, end: end < start ? start : end };
  });

  const minDate =
    withDates.length > 0
      ? new Date(Math.min(...withDates.map((w) => w.start.getTime())))
      : today;
  const maxDate =
    withDates.length > 0
      ? new Date(Math.max(...withDates.map((w) => w.end.getTime())))
      : today;

  const pxPerDay = computePxPerDay(diffDays(maxDate, minDate));

  const sorted = [...withDates].sort((a, b) => a.start.getTime() - b.start.getTime());

  const laneEnds: Date[] = [];
  const positions = new Map<string, { x: number; y: number }>();
  const widths = new Map<string, number>();

  for (const { ticket, start, end } of sorted) {
    let lane = laneEnds.findIndex((laneEnd) => laneEnd <= start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(end);
    } else {
      laneEnds[lane] = end;
    }

    positions.set(ticket.ID, { x: diffDays(start, minDate) * pxPerDay, y: lane * ROW_HEIGHT });
    widths.set(ticket.ID, Math.max(MIN_BAR_WIDTH, diffDays(end, start) * pxPerDay));
  }

  return { positions, widths, minDate, maxDate, laneCount: laneEnds.length, pxPerDay };
}
