# JENGA frontend

Next.js 15 (App Router) + React Flow + React Three Fiber + Zustand.

```bash
npm install
npm run dev          # http://localhost:3000
```

Expects the API on `http://localhost:8000` (`NEXT_PUBLIC_API_URL`).
Set `NEXT_PUBLIC_USE_FIXTURES=1` to run entirely on `data/*.json` with the backend down.

## Components

| File | Role |
|---|---|
| `components/WorkGraph.tsx` | React Flow canvas. Blueprint mode pins nodes to drawing pixel coords via `ViewportPortal`; logical mode re-ranks with Dagre. |
| `components/TaskNode.tsx` | Custom node, 6 states. `nodeTypes` is module-scope — moving it inside a component causes an infinite re-render. |
| `components/VerdictPanel.tsx` | The 4 evidence columns and the verdict. Renders the refusal-to-rule case largest. |
| `components/AttributionLedger.tsx` | Right rail: delay attributions + Zip purchase orders. |
| `components/StationView.tsx` | R3F digital twin, 5 zone meshes sharing task state with the 2D graph. |
| `components/SubmitUpdateModal.tsx` | Picks one of the 5 demo submissions. |
| `store/useJenga.ts` | Single Zustand store. Drives both 2D and 3D, and staggers the cascade by `depth * 120ms`. |
| `lib/` | Types, API client with fixture fallback, theme/state mapping, local CPM. |

## Three things that will bite you

1. **`ViewportPortal` needs `left:0; top:0` and `zIndex:-1`.** Without the offsets the drawing renders beside the nodes instead of under them; without the z-index it paints over all of them.
2. **Dagre returns centre-anchored positions.** Subtract half the node box or the layout sits up and left.
3. **`<Text>` from drei suspends.** It must be inside `<Suspense>` or the entire canvas renders empty.

React is pinned to `~19.2` because `@react-three/fiber` caps at `<19.3`.
