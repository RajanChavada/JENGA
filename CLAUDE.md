# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Project

JENGA is a "JIRA/Linear for construction": construction tasks are tickets, dependencies between them form a DAG, and delays/cancellations can fork the plan into an alternate timeline that gets edited and merged back in. A ticket closes when the construction company submits a progress report (text + photo/video) that the project owner approves; reports get a non-blocking GPTZero authenticity flag. See `docs/plan.md` for the full product/technical plan, competitive landscape, and the reasoning behind every major design decision (it's the source of truth — read it before making architectural changes).

## Commands

```bash
npm install
npm run dev      # Next.js dev server (Turbopack)
npm run build    # production build (also type-checks)
npm run lint     # eslint
npm run seed     # seeds one demo project — see scripts/seed.ts
```

There is no test suite in this repo.

### Local database

```bash
docker compose up -d                     # starts local Postgres (see docker-compose.yml)
psql "$DATABASE_URL" -f sql/schema.sql   # apply schema (first time / after schema changes)
npm run seed                             # seed demo data
```

`DATABASE_URL` lives in `.env.local` (copy from `.env.example`).

## Architecture

### Data access

All data access goes through `lib/db.ts` — a thin `pg.Pool`-backed module (pool cached on `globalThis` to survive Next.js dev-mode hot reload) that every other module imports `execute<T>(sql, binds)` from (`lib/dag.ts`, `lib/branch.ts`, every `app/api/**/route.ts`, `scripts/seed.ts`). Two conventions to know before writing a query:

- **Placeholders are always `?`**, not `$1` — `lib/db.ts` rewrites them to `$1, $2, …` before sending the query to `pg`.
- **Result rows are always UPPERCASE-keyed** (`row.STATUS`, `row.BRANCH_ID`, …) — `lib/db.ts` upper-cases Postgres's naturally-lowercase keys, and pins its DATE/TIMESTAMP type parsers to return raw strings (not JS `Date` objects), matching the shape `lib/types.ts` is written against.
- Every insert generates its own id with `crypto.randomUUID()` app-side rather than relying on a column default.
- `now()` and `dateAddDays(column)`, also exported from `lib/db.ts`, are just factored-out SQL fragments (`CURRENT_TIMESTAMP` / a `make_interval(...)` add) used at most of the write call sites — not a dialect abstraction, just avoiding repeating the same fragment everywhere.

### Data model & DAG logic

Four tables: `projects`, `branches`, `tickets`, `dependencies` (the DAG edges), `reports`. A ticket can have multiple parents (AND-join: all must be `done` before it unblocks). `lib/dag.ts` holds the graph algorithms — descendant traversal and cycle detection via a recursive CTE (`WITH RECURSIVE`), AND-join unblocking, cancellation cascades, and delay-ripple date shifting.

Branching (forking an alternate timeline, editing it, merging back) is deliberately simplified rather than a general graph merge — see `lib/branch.ts` and `docs/plan.md`'s "Branching Semantics" section for the exact model: a fork copies only the downstream subtree of the fork point (tracked via `tickets.forked_from_id`), and a merge is refused (not silently overwritten) if the trunk's copy changed since the fork (compared via `updated_at` vs `branches.forked_at`).

### Verification workflow

Progress reports are a PDF upload, not free text. `app/api/reports/route.ts` saves the file to `public/uploads/` (gitignored, local-disk only — doesn't persist on serverless deploys), extracts its embedded text with `pdf-parse` (text-layer extraction, not OCR — see `docs/plan.md`'s "PDF Progress Reports" for why true OCR was rejected), then passes that extracted text to `lib/gptzero.ts`, which is unchanged and still advisory-only by design — it never blocks submission or approval, and degrades to an `unavailable` flag on any failure or on a PDF with no extractable text (see `docs/plan.md` for why GPTZero itself is a poor gate for this domain).

`pdf-parse` has a real, documented Next.js/Turbopack gotcha: it throws "Setting up fake worker failed" unless `import "pdf-parse/worker"` happens before `import { PDFParse } from "pdf-parse"`, and `next.config.ts` sets `serverExternalPackages: ["pdf-parse", "@napi-rs/canvas"]`. Also use `getText()`'s `pages[].text` array, not the result's own pre-joined `.text` field — that field interleaves `-- N of M --` page-separator markers meant for human/CLI reading.

### Frontend

`app/page.tsx` is the orchestrator: it fetches the current project/branch/graph and composes `components/DagView.tsx`, `components/TicketPanel.tsx` (role-gated ticket actions: start work, submit report, delay, cancel, fork, approve/reject — rendered full-width below the graph, not beside it), and `components/BranchBar.tsx` (role switcher + timeline/branch selector + merge button). There is no real authentication — `lib/role-context.tsx` is a client-side-only role switch (`owner` / `contractor`) that gates which actions are shown, not a security boundary.

### DAG timeline view

`DagView.tsx` renders a Gantt-style timeline, not a generic node-link graph: `components/dagLayout.ts`'s `layoutTimeline()` derives each node's x-position and width from `planned_start`/`planned_end`, and its lane (y) from greedy interval packing (the "minimum meeting rooms" algorithm) so tickets overlapping in time land in separate rows automatically. Dragging a node is intentionally lane-only — `handleNodesChange` in `DagView.tsx` forces `position.x` back to the layout-computed value on every change, so only y ever moves; x can never drift from what the ticket's actual dates say.

**React Flow's `nodes` must be real component state updated via `applyNodeChanges`, not recomputed fresh from ticket data on every render.** React Flow rebuilds its internal `measured` (DOM-measured) size from whatever `measured` field is present on the node objects passed to it on *every* `nodes` prop update; a freshly-`.map()`'d array (as this used to do) never carries that field, so it gets wiped continuously — including on every tick during an active drag, since dragging itself triggers a state update. The wipe races against the async `ResizeObserver` that would otherwise repopulate it, throwing React Flow error #015 ("dragging a node that is not initialized") throughout the drag rather than just once. The fix in place: `nodes` lives in `useState`, a `useEffect` keyed on `tickets` reconciles it (preserving each existing node's `measured` and dragged y-position), and `onNodesChange` applies incoming changes via `applyNodeChanges` onto that same state. Any future change to `DagView.tsx` that goes back to deriving the full `nodes` array inline from props will reintroduce this bug.

**Pixels-per-day is adaptive, not a fixed constant** (`dagLayout.ts`'s `computePxPerDay`) — a fixed 40px/day (fine for Route 12's ~2-week span) renders a multi-year project (e.g. the seeded Eglinton Crosstown LRT, 2011–2026) as a graph hundreds of thousands of pixels wide. `DateRuler`'s tick granularity (week/month/year, `pickGranularity`) scales with the same span for the same reason — weekly ticks over 15 years is hundreds of cluttered labels.

**Switching projects needs `<DagView key={projectId} .../>` in `app/page.tsx`.** React Flow's `fitView` prop only auto-fits once, when the component first mounts with measured nodes — it does not refire just because the `nodes`/`tickets` prop later changes to a completely different date range (e.g. picking a different project in the switcher). Without the `key`, the view keeps whatever zoom/pan the *previous* project's fit computed. Also note `<ReactFlow minZoom={0.05}>` is deliberately far below the library's default `0.5` — that default alone clamps `fitView` before a long project's full range fits in frame.

**Each bar is two adjacent segments, not one** — status-colored up to `tickets.original_planned_end`, then red to the current `planned_end` (`buildNode` in `DagView.tsx`; the split widths come from `dagLayout.ts`'s `delayWidths` map). `original_planned_end` is set once at ticket creation (`app/api/tickets/route.ts`, `scripts/seed.ts`) and carried through forks (`lib/branch.ts`) but never updated by anything else — delays and ripples only ever move `planned_end`. That's deliberate: it's what makes a downstream ripple automatically grow a red tail on every ticket it pushes, with no special-casing. When computing the red segment, `original_planned_end` is clamped into the ticket's current `[planned_start, planned_end]` window rather than ignored when it falls outside that window — a ticket whose original target is *before* its current (delayed) start date should render as fully red, not as "no delay" (this bit a real seed ticket: Eglinton's "Revenue Service Launch Prep" has `original_planned_end = 2021-09-01`, long before its current `planned_start = 2025-07-01`).
