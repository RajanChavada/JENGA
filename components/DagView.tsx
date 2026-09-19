"use client";

import { useMemo } from "react";
import { ReactFlow, Background, Controls, MarkerType } from "@xyflow/react";
import type { Edge, Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { Dependency, Ticket, TicketStatus } from "@/lib/types";
import { layoutDag } from "./dagLayout";

const STATUS_COLOR: Record<TicketStatus, string> = {
  blocked: "#9ca3af",
  ready: "#3b82f6",
  in_progress: "#f59e0b",
  done: "#22c55e",
  cancelled: "#ef4444",
};

export function DagView({
  tickets,
  dependencies,
  selectedId,
  onSelect,
}: {
  tickets: Ticket[];
  dependencies: Dependency[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const positions = useMemo(() => layoutDag(tickets, dependencies), [tickets, dependencies]);

  const nodes: Node[] = useMemo(
    () =>
      tickets.map((t) => ({
        id: t.ID,
        position: positions.get(t.ID) ?? { x: 0, y: 0 },
        data: { label: t.TITLE },
        style: {
          background: STATUS_COLOR[t.STATUS],
          color: "white",
          borderRadius: 8,
          padding: 8,
          border: selectedId === t.ID ? "3px solid #111827" : "1px solid rgba(0,0,0,0.2)",
          width: 200,
          fontSize: 12,
        },
      })),
    [tickets, positions, selectedId]
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

  return (
    <div style={{ height: "70vh" }} className="w-full rounded-lg border">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodeClick={(_, node) => onSelect(node.id)}
        fitView
      >
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
}
