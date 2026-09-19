'use client';

import { useMemo } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  ViewportPortal,
  Controls,
  type Edge,
  type Node,
} from '@xyflow/react';
import dagre from 'dagre';
import '@xyflow/react/dist/style.css';

import { nodeTypes, NODE_H, NODE_W, type TaskNodeData } from './TaskNode';
import { useJenga, type ViewMode } from '@/store/useJenga';
import { STATE_STYLE } from '@/lib/theme';
import type { GraphEdge, Task } from '@/lib/types';

/** Authoritative blueprint coordinate space. Task x/y are pixels in this space. */
const BLUEPRINT_W = 1200;
const BLUEPRINT_H = 800;

/**
 * Dagre hands back centre-anchored positions; React Flow positions from the
 * top-left corner. Subtracting half the node box is the whole fix, and skipping
 * it is why dagre layouts usually look shifted up and left on first attempt.
 */
function layout(tasks: Task[], edges: GraphEdge[]) {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'LR', nodesep: 28, ranksep: 90 });

  tasks.forEach((t) => g.setNode(t.id, { width: NODE_W, height: NODE_H }));
  edges.forEach((e) => g.setEdge(e.source, e.target));
  dagre.layout(g);

  const pos: Record<string, { x: number; y: number }> = {};
  tasks.forEach((t) => {
    const n = g.node(t.id);
    pos[t.id] = { x: n.x - NODE_W / 2, y: n.y - NODE_H / 2 };
  });
  return pos;
}

function Canvas() {
  const tasks = useJenga((s) => s.tasks);
  const edgesRaw = useJenga((s) => s.edges);
  const mode = useJenga((s) => s.mode);
  const selectedTaskId = useJenga((s) => s.selectedTaskId);
  const selectedZone = useJenga((s) => s.selectedZone);
  const selectTask = useJenga((s) => s.selectTask);

  const logicalPos = useMemo(
    () => (mode === 'logical' ? layout(tasks, edgesRaw) : null),
    [mode, tasks, edgesRaw],
  );

  const nodes: Node<TaskNodeData>[] = useMemo(
    () =>
      tasks.map((t) => ({
        id: t.id,
        type: 'task',
        // Blueprint mode uses the drawing's own pixel coordinates, so a node sits
        // exactly over the work it represents. Logical mode uses dagre ranks.
        position: logicalPos ? logicalPos[t.id] : { x: t.x - NODE_W / 2, y: t.y - NODE_H / 2 },
        data: {
          task: t,
          selected: t.id === selectedTaskId || (!!selectedZone && t.zone === selectedZone),
          thumbnail: null,
        },
      })),
    [tasks, logicalPos, selectedTaskId, selectedZone],
  );

  const edges: Edge[] = useMemo(() => {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    return edgesRaw.map((e) => {
      const src = byId.get(e.source);
      const tgt = byId.get(e.target);
      const critical = !!src?.is_critical && !!tgt?.is_critical;
      return {
        id: `${e.source}->${e.target}`,
        source: e.source,
        target: e.target,
        // `animated` gives the dashed flow for free — no custom edge needed.
        animated: critical,
        style: {
          stroke: critical ? '#dc2626' : '#cbd5e1',
          strokeWidth: critical ? 2 : 1,
        },
      };
    });
  }, [edgesRaw, tasks]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodeClick={(_, n) => selectTask(n.id)}
      onPaneClick={() => selectTask(null)}
      fitView
      minZoom={0.2}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
      className="bg-slate-50"
    >
      {mode === 'blueprint' && (
        // ViewportPortal renders inside the flow's coordinate system, so the
        // drawing pans and zooms locked to the nodes. A CSS background-image
        // would pin to the screen instead and the nodes would drift off the plan.
        <ViewportPortal>
          {/*
            left/top must be pinned explicitly. With `position:absolute` and no
            offsets the image falls back to its static position inside the portal
            container, which is not the flow origin — the drawing then sits beside
            the nodes instead of underneath them.
          */}
          <div
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              transform: 'translate(0px, 0px)',
              width: BLUEPRINT_W,
              height: BLUEPRINT_H,
              pointerEvents: 'none',
              // ViewportPortal paints above the node layer by default, which hides
              // every task behind the drawing. Drop it beneath them.
              zIndex: -1,
            }}
          >
            <img
              src="/blueprint.svg"
              alt="Station plan"
              width={BLUEPRINT_W}
              height={BLUEPRINT_H}
              draggable={false}
              style={{ display: 'block', width: '100%', height: '100%' }}
            />
          </div>
        </ViewportPortal>
      )}
      <Controls className="!bottom-4 !left-4" />
    </ReactFlow>
  );
}

export function WorkGraph() {
  const mode = useJenga((s) => s.mode);
  const setMode = useJenga((s) => s.setMode);
  const projectDuration = useJenga((s) => s.projectDuration);
  const baseline = useJenga((s) => s.baselineDuration);
  const cascading = useJenga((s) => s.cascading);

  const slipped = baseline !== null && projectDuration > baseline;

  return (
    <div className="relative h-full w-full">
      <div className="absolute left-4 top-4 z-10 flex items-center gap-3">
        <div className="flex overflow-hidden rounded-md border border-slate-200 bg-white text-xs shadow-sm">
          {(['blueprint', 'logical'] as ViewMode[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`px-3 py-1.5 capitalize transition-colors ${
                mode === m ? 'bg-slate-900 text-white' : 'bg-white text-slate-500 hover:bg-slate-50'
              }`}
            >
              {m}
            </button>
          ))}
        </div>

        <div className="rounded-md border border-slate-200 bg-white px-3 py-1.5 font-mono text-xs text-slate-600 shadow-sm">
          {projectDuration}d
          {slipped && (
            <span className="ml-1.5 text-red-600">+{projectDuration - baseline!}</span>
          )}
        </div>

        {cascading && (
          <span className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1 font-mono text-[10px] text-amber-700">
            propagating…
          </span>
        )}
      </div>

      <Legend />

      <ReactFlowProvider>
        <Canvas />
      </ReactFlowProvider>
    </div>
  );
}

function Legend() {
  return (
    <div className="absolute right-4 top-4 z-10 flex flex-col gap-1 rounded-md border border-slate-200 bg-white/90 p-2 shadow-sm backdrop-blur">
      {(Object.keys(STATE_STYLE) as (keyof typeof STATE_STYLE)[]).map((k) => (
        <div key={k} className="flex items-center gap-2 text-[10px] text-slate-500">
          <span
            className="h-2 w-2 rounded-sm"
            style={{ background: STATE_STYLE[k].hex }}
          />
          {STATE_STYLE[k].label}
        </div>
      ))}
    </div>
  );
}
