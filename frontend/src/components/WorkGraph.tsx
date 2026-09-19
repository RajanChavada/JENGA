'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  ViewportPortal,
  Controls,
  useReactFlow,
  type Edge,
  type Node,
} from '@xyflow/react';
import dagre from 'dagre';
import '@xyflow/react/dist/style.css';

import { nodeTypes, NODE_H, NODE_W, type TaskNodeData } from './TaskNode';
import { useJenga, type ViewMode } from '@/store/useJenga';
import { DENIED_STYLE, STATE_STYLE } from '@/lib/theme';
import { edgeInFocus, focusNodeIds } from '@/lib/focus';
import type { GraphEdge, Task } from '@/lib/types';

/**
 * The logical view opens at a zoom where a card's text reads (id, days, name,
 * status), and you pan to the rest. Fitting all ~16 cards into the pane drew them
 * at about a third of this, which is too small to read.
 */
const READABLE_ZOOM = 0.85;
const VIEW_PAD = 24;

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
  const focusOrigin = useJenga((s) => s.focusOrigin);
  const selectTask = useJenga((s) => s.selectTask);
  const clearFocus = useJenga((s) => s.clearFocus);

  const { fitView, setViewport } = useReactFlow();
  // Which nodes are on screen. Task ids only: a state change moves nothing and
  // must not reset the zoom. A different site remounts the flow (`key` below), so
  // its own fit-on-mount frames the new nodes once they are measured.
  const graphKey = useMemo(() => tasks.map((t) => t.id).join(), [tasks]);

  // What the selection frames: the task and its direct neighbours, or a zone's
  // tasks. Null when nothing is selected, which is also "fit the whole graph".
  const focusIds = useMemo(
    () => focusNodeIds(selectedTaskId, selectedZone, tasks, edgesRaw),
    [selectedTaskId, selectedZone, tasks, edgesRaw],
  );
  // Read by `fit` after its own delay, so it is enough to keep the ref current in an effect.
  const focusRef = useRef(focusIds);
  useEffect(() => {
    focusRef.current = focusIds;
  }, [focusIds]);

  const logicalPos = useMemo(
    () => (mode === 'logical' ? layout(tasks, edgesRaw) : null),
    [mode, tasks, edgesRaw],
  );

  // `fit` must keep one identity (a new one would cancel the animation queued by
  // the effects below), so it reads the mode and layout through refs kept current here.
  const wrapRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef({ mode, logicalPos });
  useEffect(() => {
    viewRef.current = { mode, logicalPos };
  }, [mode, logicalPos]);

  // The one place the viewport is framed. Every refit (selection, resize, mode
  // switch, deselect) goes through it, so a resize while something is focused
  // keeps the focus, and "no focus" always means the same default view.
  const fit = useCallback(
    (duration: number) => {
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const opts = { duration: reduced ? 0 : duration };
      const ids = focusRef.current;
      if (ids) {
        void fitView({ nodes: [...ids].map((id) => ({ id })), padding: 0.18, maxZoom: 1.2, ...opts });
        return;
      }
      const { mode: m, logicalPos: pos } = viewRef.current;
      const rect = wrapRef.current?.getBoundingClientRect();
      const boxes = pos ? Object.values(pos) : [];
      if (m === 'logical' && rect && boxes.length > 0) {
        // Readable zoom, anchored on the start of the schedule: the first rank at
        // the left edge, the graph centred vertically (or from the top when it is
        // taller than the pane, so its first row is never cut off).
        const minX = Math.min(...boxes.map((b) => b.x));
        const minY = Math.min(...boxes.map((b) => b.y));
        const maxY = Math.max(...boxes.map((b) => b.y + NODE_H));
        const zoom = READABLE_ZOOM;
        const tall = (maxY - minY) * zoom + 2 * VIEW_PAD > rect.height;
        void setViewport(
          {
            x: VIEW_PAD - minX * zoom,
            y: tall ? VIEW_PAD - minY * zoom : rect.height / 2 - ((minY + maxY) / 2) * zoom,
            zoom,
          },
          opts,
        );
        return;
      }
      void fitView({ padding: 0.1, ...opts });
    },
    [fitView, setViewport],
  );

  // `fitView` on <ReactFlow> fits once, on mount. Switching blueprint <-> logical
  // puts the same nodes somewhere else entirely, so refit after the new positions
  // are applied. (`useNodesInitialized` reads false throughout, so it can't gate this.)
  // The pane is resizable (drag the dividers on the Site tab), and React Flow
  // does not reframe on its own when its box changes size. Refit once a resize
  // settles. The first observation is the mount itself, which `fitView` already handles.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    let seen = false;
    let timer: ReturnType<typeof setTimeout>;
    const observer = new ResizeObserver(() => {
      if (!seen) {
        seen = true;
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(() => fit(150), 120);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [fit]);

  const lastMode = useRef(mode);
  useEffect(() => {
    if (lastMode.current === mode) return;
    lastMode.current = mode;
    const timer = setTimeout(() => fit(200), 60);
    return () => clearTimeout(timer);
  }, [mode, fit]);

  // Selecting frames the focus; clearing puts the whole graph back. A click on a
  // graph node does not zoom: the node under the pointer is already where the
  // user is looking, and moving it would make the click feel like a drag.
  const focusKey = selectedTaskId ?? (selectedZone ? `zone:${selectedZone}` : '');
  const lastFocusKey = useRef(focusKey);
  useEffect(() => {
    if (lastFocusKey.current === focusKey) return;
    lastFocusKey.current = focusKey;
    if (focusKey && focusOrigin === 'graph' && selectedTaskId) return;
    const timer = setTimeout(() => fit(350), 30);
    return () => clearTimeout(timer);
  }, [focusKey, focusOrigin, selectedTaskId, fit]);

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
          dimmed: !!focusIds && !focusIds.has(t.id),
          variant: mode,
          thumbnail: null,
        },
      })),
    [tasks, logicalPos, selectedTaskId, selectedZone, focusIds, mode],
  );

  const edges: Edge[] = useMemo(() => {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    return edgesRaw.map((e) => {
      const src = byId.get(e.source);
      const tgt = byId.get(e.target);
      const critical = !!src?.is_critical && !!tgt?.is_critical;
      const inFocus = edgeInFocus(e, focusIds);
      return {
        id: `${e.source}->${e.target}`,
        source: e.source,
        target: e.target,
        // `animated` gives the dashed flow for free — no custom edge needed.
        animated: critical && inFocus,
        style: {
          stroke: critical ? '#dc2626' : '#cbd5e1',
          strokeWidth: critical ? 2 : 1,
          opacity: inFocus ? 1 : 0.2,
          transition: 'opacity 200ms',
        },
      };
    });
  }, [edgesRaw, tasks, focusIds]);

  return (
    <div ref={wrapRef} className="h-full w-full">
    <ReactFlow
      key={graphKey}
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodeClick={(_, n) => selectTask(n.id, 'graph')}
      onPaneClick={() => clearFocus()}
      // Blueprint fits the whole drawing on mount; logical opens at the readable
      // zoom, set as soon as the flow initialises so there is no first-frame flash.
      fitView={mode === 'blueprint'}
      onInit={() => {
        if (viewRef.current.mode === 'logical') fit(0);
      }}
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
    </div>
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
      <div className="flex items-center gap-2 text-[10px] text-slate-500">
        <span className="h-2 w-2 rounded-sm" style={{ background: DENIED_STYLE.hex }} />
        {DENIED_STYLE.label}
      </div>
    </div>
  );
}
