"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  MarkerType,
  Position,
  applyNodeChanges,
  useReactFlow,
  useViewport,
} from "@xyflow/react";
import type { Edge, Node, NodeChange } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { Dependency, Ticket, TicketStatus } from "@/lib/types";
import { layoutTimeline, MIN_BAR_WIDTH, ROW_HEIGHT } from "./dagLayout";

const STATUS_COLOR: Record<TicketStatus, string> = {
  blocked: "#9ca3af",
  ready: "#3b82f6",
  in_progress: "#f59e0b",
  done: "#22c55e",
  cancelled: "#ef4444",
};

const BAR_HEIGHT = 22;
const NODE_HEIGHT = 64;
const RULER_HEIGHT = 28;

type TickGranularity = "week" | "month" | "year";

function pickGranularity(totalDays: number): TickGranularity {
  if (totalDays <= 60) return "week";
  if (totalDays <= 730) return "month";
  return "year";
}

function stepTick(d: Date, granularity: TickGranularity): Date {
  const next = new Date(d);
  if (granularity === "week") next.setUTCDate(next.getUTCDate() + 7);
  else if (granularity === "month") next.setUTCMonth(next.getUTCMonth() + 1);
  else next.setUTCFullYear(next.getUTCFullYear() + 1);
  return next;
}

function formatTick(d: Date, granularity: TickGranularity): string {
  if (granularity === "year") return String(d.getUTCFullYear());
  if (granularity === "month")
    return d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function DateRuler({
  minDate,
  maxDate,
  pxPerDay,
}: {
  minDate: Date;
  maxDate: Date;
  pxPerDay: number;
}) {
  const { x, zoom } = useViewport();

  const ticks = useMemo(() => {
    const totalDays = Math.round((maxDate.getTime() - minDate.getTime()) / 86_400_000);
    const granularity = pickGranularity(totalDays);

    let cursor = new Date(minDate);
    if (granularity === "week") cursor.setUTCDate(cursor.getUTCDate() - 1);
    else if (granularity === "month") cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), 1));
    else cursor = new Date(Date.UTC(cursor.getUTCFullYear(), 0, 1));

    const end = stepTick(maxDate, granularity);
    const days: Date[] = [];
    while (cursor <= end) {
      days.push(new Date(cursor));
      cursor = stepTick(cursor, granularity);
    }
    return { days, granularity };
  }, [minDate, maxDate]);

  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-0 z-10 border-b bg-white/90 dark:bg-zinc-900/90"
      style={{ height: RULER_HEIGHT }}
    >
      {ticks.days.map((d) => {
        const dayOffset = Math.round((d.getTime() - minDate.getTime()) / 86_400_000);
        const left = x + dayOffset * pxPerDay * zoom;
        return (
          <div
            key={d.toISOString()}
            className="absolute top-0 h-full border-l pl-1 text-[11px] leading-7 text-zinc-500"
            style={{ left }}
          >
            {formatTick(d, ticks.granularity)}
          </div>
        );
      })}
    </div>
  );
}

const iconButtonClass =
  "flex h-8 w-8 items-center justify-center rounded border bg-white/90 text-zinc-700 shadow-sm hover:bg-zinc-50 dark:bg-zinc-900/90 dark:text-zinc-200 dark:hover:bg-zinc-800";

function GraphControls() {
  const { zoomIn, zoomOut, fitView } = useReactFlow();

  return (
    <div className="absolute bottom-3 right-3 z-10 flex gap-1.5">
      <button type="button" className={iconButtonClass} title="Zoom in" onClick={() => zoomIn()}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M7 1v12M1 7h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      <button type="button" className={iconButtonClass} title="Zoom out" onClick={() => zoomOut()}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M1 7h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      <button
        type="button"
        className={iconButtonClass}
        title="Reset view"
        onClick={() => fitView()}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path
            d="M1 4V1h3M13 4V1h-3M1 10v3h3M13 10v3h-3"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </div>
  );
}

function buildNode(
  t: Ticket,
  x: number,
  y: number,
  width: number,
  selected: boolean,
  measured: Node["measured"]
): Node {
  return {
    id: t.ID,
    position: { x, y },
    draggable: true,
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    initialWidth: width,
    initialHeight: NODE_HEIGHT,
    measured,
    data: {
      label: (
        <div className="flex flex-col gap-1 overflow-visible">
          <span className="whitespace-nowrap text-[11px] font-medium text-zinc-700 dark:text-zinc-200">
            {t.TITLE}
          </span>
          <div
            className="rounded"
            style={{ width, height: BAR_HEIGHT, background: STATUS_COLOR[t.STATUS] }}
          />
        </div>
      ),
    },
    style: {
      padding: 4,
      border: selected ? "2px solid #111827" : "1px solid transparent",
      borderRadius: 8,
      background: "transparent",
      overflow: "visible",
    },
  };
}

export function DagView({
  tickets,
  dependencies,
  selectedId,
  onSelectAction,
}: {
  tickets: Ticket[];
  dependencies: Dependency[];
  selectedId: string | null;
  onSelectAction: (id: string) => void;
}) {
  const layout = useMemo(() => layoutTimeline(tickets), [tickets]);
  const layoutRef = useRef(layout);
  useEffect(() => {
    layoutRef.current = layout;
  }, [layout]);

  const [nodes, setNodes] = useState<Node[]>([]);

  useEffect(() => {
    setNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]));
      return tickets.map((t) => {
        const existing = prevById.get(t.ID);
        const base = layout.positions.get(t.ID) ?? { x: 0, y: 0 };
        const width = layout.widths.get(t.ID) ?? MIN_BAR_WIDTH;
        return buildNode(
          t,
          base.x,
          existing?.position.y ?? base.y,
          width,
          selectedId === t.ID,
          existing?.measured
        );
      });
    });
  }, [selectedId, tickets, layout]);

  const displayNodes = useMemo(
    () =>
      nodes.map((n) => ({
        ...n,
        style: {
          ...n.style,
          border: selectedId === n.id ? "2px solid #111827" : "1px solid transparent",
        },
      })),
    [nodes, selectedId]
  );

  const edges: Edge[] = useMemo(
    () =>
      dependencies.map((d) => ({
        id: d.ID,
        source: d.PARENT_TICKET_ID,
        target: d.CHILD_TICKET_ID,
        animated: true,
        markerEnd: { type: MarkerType.ArrowClosed },
      })),
    [dependencies]
  );

  const handleNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((nds) =>
      applyNodeChanges(changes, nds).map((n) => {
        const base = layoutRef.current.positions.get(n.id);
        return base ? { ...n, position: { x: base.x, y: n.position.y } } : n;
      })
    );
  }, []);

  return (
    <div
      className="relative w-full rounded-lg border"
      style={{ height: Math.max(320, layout.laneCount * ROW_HEIGHT + RULER_HEIGHT + 40) }}
    >
      <ReactFlow
        nodes={displayNodes}
        edges={edges}
        onNodesChange={handleNodesChange}
        onNodeClick={(_, node) => onSelectAction(node.id)}
        proOptions={{ hideAttribution: true }}
        minZoom={0.05}
        fitView
      >
        <Background />
        <DateRuler minDate={layout.minDate} maxDate={layout.maxDate} pxPerDay={layout.pxPerDay} />
        <GraphControls />
      </ReactFlow>
    </div>
  );
}
