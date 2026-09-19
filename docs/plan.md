# JENGA — Construction Ticketing & Dependency-Graph Planner (Hackathon MVP)

## Context

The goal is a HackTheNorth submission: a "JIRA/Linear for construction" where tickets are physical construction tasks (groundwork, road segments, height clearance, truck logistics) whose dependencies form a DAG. Delays or cancellations should be able to fork the plan into an alternate timeline; a ticket is closed when the construction company submits a progress report (photo/video + text) that the project owner approves. Reports are checked for AI-generated text via GPTZero, kept real and visible in the UI for a HackTheNorth sponsor prize track even though (see below) it's demoted to advisory-only. The data layer runs on Postgres — a Snowflake-backed system-of-record was considered for a separate sponsor track but dropped: Snowflake credentials never materialized, and maintaining a second, mostly-unused driver wasn't worth the complexity for a hackathon build.

Research surfaced two things that reshaped the plan from the original request:
- **GPTZero is a poor authenticity signal for this domain** (~60%+ false-positive rate on non-native-English writing, and accuracy collapses under 500 words — exactly the profile of a real contractor's progress note). It's kept anyway for sponsor-track visibility, but demoted to a non-blocking flag rather than a gate.
- **No existing construction tool does git-style branching of a schedule.** Primavera P6's "reflection schedules" are the closest prior art, and even those are a manual copy/merge, not a versioned DAG with automatic delay-ripple propagation. This is the product's most defensible, most demo-able idea — everything else (basic dependency scheduling, photo progress logs, task assignment) is already commoditized by Procore, Fieldwire, Buildertrend, and Primavera P6.

This plan is scoped for a fixed, short hackathon build window: pick the wedge that's both novel and demoable, cut everything else, and sequence the build so a working demo exists even if the riskiest feature (branch merge) runs out of time.

## Product Scope

**In scope (v1 / demo):**
- Tickets representing construction tasks, with a DAG of dependencies (a ticket may have multiple parents — AND-join semantics: all parent tickets must be `done` before a child can start).
- Automatic forward recalculation: changing a ticket's status/dates ripples through its downstream dependents.
- **Branching**: forking an alternate timeline from a ticket (e.g. "what if this is delayed 2 weeks / cancelled"), editing the fork independently, and merging it back into the trunk.
- Progress report submission (text + photo/video upload) by the "Construction Company" role, GPTZero-scored on submission, approved/rejected by the "Project Owner" role. Approval closes the ticket; rejection returns it to in-progress.
- Role switcher (no real auth) to view the app as either actor against shared demo data.
- Postgres as the single system of record — tickets, edges, branches, and reports all live there.

**Explicitly out of scope for v1** (cut during grilling, revisit post-hackathon):
- Video-evidence analysis and worker chat/text "on-ground intelligence" fusion — no model, no pipeline, no UI for this in the demo.
- Real authentication, multi-tenant orgs, multiple contractors/subcontractors per project.
- Cross-ticket text-similarity or photo/video EXIF-tampering detection (the more fraud-relevant signals research surfaced) — noted in the pitch as "what we'd build next," not built now.
- General N-way merge/conflict resolution for branches (see Branching Semantics below for the simplified model actually being built).
- Snowflake — originally planned as the system of record for a second sponsor track (see Context); dropped when credentials didn't come through in time. The data layer (`lib/db.ts`) is Postgres-only.

## Competitive Landscape (for the pitch)

| Capability | Already exists | Gap JENGA fills |
|---|---|---|
| Dependency/Gantt scheduling | Primavera P6, Buildertrend, Autodesk Build | — (table stakes, not the pitch) |
| Photo/video progress tracking | Procore Photo Intelligence, OpenSpace, DroneDeploy | — (table stakes) |
| What-if scheduling | P6 "reflection schedules" (manual copy/merge, no auto-propagation) | **Versioned DAG branches with automatic delay-ripple + explicit merge** |
| Report authenticity/fraud detection | None found | GPTZero flag now; cross-report similarity + media-metadata checks as the credible next step |
| Ticket-style UX for construction | None found (existing tools are Gantt- or document-centric, not ticket-centric) | Ticket/board metaphor construction PMs may already know from software tools |

## Data Model (Postgres)

Single schema (`sql/schema.sql`), four core tables:

- `tickets(id, project_id, branch_id, title, description, status, planned_start, planned_end, original_planned_end, actual_start, actual_end, created_at)` — `original_planned_end` is set once at creation and never touched again by delays/ripples/merges; see "DAG View: Timeline Layout" for what it's for.
- `dependencies(id, branch_id, parent_ticket_id, child_ticket_id)` — the DAG edges, scoped per branch.
- `branches(id, project_id, name, forked_from_branch_id, forked_from_ticket_id, forked_at, status)` — `status` is `active` or `merged`; the trunk is the branch with `forked_from_branch_id IS NULL`.
- `reports(id, ticket_id, submitted_by_role, text, media_url, gptzero_score, gptzero_flag, owner_decision, decided_at)`

DAG traversal (downstream dependents of a ticket, cycle checks on edge insert) uses a recursive CTE (`WITH RECURSIVE`) over `dependencies`. Reject any edge insert whose reachability check would create a cycle.

## Branching Semantics (simplified for feasibility)

True N-way graph merge is out of scope for the time budget. Instead:

1. **Fork**: forking at ticket X copies X and everything reachable *downstream* of X (its dependent subtree) into a new `branch_id`; everything upstream of X is shared/unchanged between trunk and branch (no duplication).
2. **Edit**: changes inside a branch (status, dates, new tickets/edges) only ever touch rows tagged with that `branch_id`.
3. **Merge**: allowed only if the trunk's copy of that same subtree hasn't been edited since the fork. If it hasn't moved, merge = swap the trunk's subtree rows for the branch's rows (delete trunk's, re-tag branch's rows to trunk's `branch_id`) and mark the branch `merged`. If the trunk *has* moved, merge is blocked with a "trunk has changed, re-fork" message — no field-level conflict UI needs to be built.

This gets the real pitch moment (fork → edit → merge, with a visible before/after DAG diff) without general merge-conflict resolution.

**Fallback if branching runs out of time**: keep the trunk-only DAG + forward recalculation fully working first (this alone is demoable — "delay this ticket, watch the graph update"). Layer fork/edit/merge second. If it's not stable by the time-box below, degrade to an *ephemeral* preview: simulate a fork client-side, render the alternate downstream DAG side-by-side, and only "commit" (write) the version the user picks — no independent editing, no true merge. Still tells the branching story visually.

## Verification Workflow

1. Construction Company role opens a ticket, submits a report as a **PDF upload** (not free text — matches what a crew actually produces in the field). The API route (`app/api/reports/route.ts`) saves the PDF to `public/uploads/`, extracts its embedded text with `pdf-parse` (text-layer extraction, not OCR — see "PDF Progress Reports" below for why true OCR was rejected), and uses that extracted text as the report body. A PDF with no text layer (e.g. a photographed page) degrades to a placeholder string rather than failing the submission.
2. If text was extracted, the API route calls the GPTZero API server-side with it and stores `gptzero_score`/`gptzero_flag` on the report row (`lib/gptzero.ts`, unchanged). This call is real and shown in the UI (sponsor-track requirement) but never blocks submission or auto-rejects; it's skipped entirely (not just "unavailable") when there's no extracted text to check.
3. Project Owner role sees the extracted text, a link to the submitted PDF, and the GPTZero flag, and approves or rejects. Approve → ticket status `done`, triggers downstream recalculation. Reject → ticket returns to `in_progress`, contractor can resubmit.
4. GPTZero API failure/timeout is caught and shown as "authenticity check unavailable" rather than blocking the approval flow.

### PDF Progress Reports

GPTZero has its own file-upload endpoint (`predict/files`, PDF/DOCX/TXT, same API key/tier as `predict/text`) that does text-layer extraction internally — but not true OCR, and its response isn't confirmed to echo back extracted text for display. True OCR (`tesseract.js`) was considered and rejected: it doesn't operate on raw PDF bytes (needs a rasterize-to-image step first via `pdfjs-dist`), and its own performance docs warn that cold-start worker/model-download latency can run several seconds to tens of seconds — a real timeout risk in a synchronous submit request, and properly supporting it would need an async job architecture. Locked approach: extract text ourselves with `pdf-parse` and send that to the existing `predict/text` call, so the owner gets a readable inline preview without opening the PDF. Accepted limitation: a scanned/handwritten PDF with no text layer extracts to a placeholder string, not real OCR.

`pdf-parse` needs `import "pdf-parse/worker"` before importing `pdf-parse` itself (`app/api/reports/route.ts`) and `serverExternalPackages: ["pdf-parse", "@napi-rs/canvas"]` in `next.config.ts` — without both, it throws "Setting up fake worker failed" under Next.js/Turbopack. Also use `getText()`'s `pages[].text` array, not its pre-joined `.text` field — the latter interleaves human-readable `-- N of M --` page-separator markers unsuited for showing the owner a clean report body.

## Tech Stack

- **Frontend**: Next.js (TypeScript) + React Flow for the interactive DAG/branch visualization (draggable nodes, animated edges, side-by-side branch rendering).
- **Backend**: Next.js API routes, calling Postgres via `pg` through `lib/db.ts` (parameterized queries, no ORM needed for this scale) and the GPTZero API. Keeps both API keys server-side.
- **No auth layer**: a role switcher (client-side toggle, e.g. a dropdown or `?role=owner|contractor` state) swaps which actions/views are available against the same Postgres data.

## DAG View: Timeline Layout

The graph is a full-width Gantt-style timeline, not a generic node-link diagram: x-position and bar width come from a ticket's `planned_start`/`planned_end` (`components/dagLayout.ts`), and y-position (lane) comes from greedy interval packing — the standard "minimum meeting rooms" algorithm — so tickets that overlap in time land in separate rows automatically instead of stacking. Dependency edges still render between nodes as before; they read more diagonal/horizontal than a topological layout would produce, which is expected for a Gantt-with-dependencies view (this is how Primavera/MS Project render it too). A date ruler above the graph, synced to pan/zoom via React Flow's `useViewport()`, gives the axis a visible scale.

Dragging a node is visual-only: it repositions a ticket's lane to untangle overlapping bars or crossing arrows, never its dates. X always stays locked to the ticket's real planned dates, so the timeline can never show something the data doesn't back up — drag-to-reschedule (dragging a bar to edit its dates live) was considered and explicitly deferred past the hackathon as too large a scope add.

Selecting a ticket opens `TicketPanel` docked full-width below the graph (not a popup/modal) — avoids overlay/z-index/click-outside handling and keeps the graph visible while reading ticket details.

**Scale is adaptive, not fixed** (`computePxPerDay` in `dagLayout.ts`): a constant 40px/day works for Route 12's ~2-week span but renders a multi-year project (the seeded Eglinton Crosstown LRT spans 2011–2026) hundreds of thousands of pixels wide — found by actually loading it, not by inspection. The date ruler's tick granularity (week/month/year) scales with the same span for the same reason. React Flow's `fitView` also only auto-fits once on mount, so switching projects needs `<DagView key={projectId}>` in `app/page.tsx` to force a remount (otherwise the view keeps the previous project's stale zoom/pan), and `minZoom` is set well below React Flow's default `0.5` so a long project's full range can actually fit in frame.

**Delay visualization**: each bar is two adjacent segments, not one — status-colored from `planned_start` to `original_planned_end`, then red from there to the current `planned_end` (zero-width, i.e. invisible, when a ticket hasn't slipped). Because delay ripples (`lib/dag.ts`'s `shiftDownstreamDates`) only ever move `planned_start`/`planned_end`, never the baseline `original_planned_end`, a delay on one ticket automatically grows a red tail on every downstream ticket it pushes too — no special-casing needed. `TicketPanel` shows the same gap as exact text ("Delayed from X — now Y (N days late)"). Seeded on the real Eglinton data on two tickets with a documented original-vs-actual slip (`scripts/seed.ts`): "Revenue Service Launch Prep" (contracted Sept 2021 vs. actual Feb 2026 — the headline ~4.4-year delay) and "Systems Installation" (a smaller, separately-documented slip) — not on all 14, since most don't have a distinctly-documented sub-milestone target separate from the single real date already seeded.

## Edge Cases Handled in MVP

- Cyclic dependency on edge insert → rejected via reachability check before insert.
- Ticket with multiple parents → AND-join; only unblocks when all parents are `done`.
- Cancelling/deep-delaying a ticket with dependents → dependents flip to `blocked`, surfaced as a prompt to fork a branch from that point.
- Report rejected → ticket reopens to `in_progress`, contractor can resubmit a new report (old one kept for history).
- Branch merge attempted after trunk moved → blocked with an explicit message, no silent overwrite.
- GPTZero API error/timeout → degrades gracefully, doesn't block report submission or approval.

## Demo Script / Seed Data

`scripts/seed.ts` seeds **two** projects, selectable via the project switcher in `BranchBar.tsx` (`app/page.tsx` passes `key={projectId}` to `DagView` so switching forces a clean remount — see "DAG View: Timeline Layout" below for why that matters):

**Route 12 Resurfacing** — the original pitch scenario: groundwork/site clearing → height clearance/grading → road segment paving (parallel segments) → truck logistics as a shared dependency feeding multiple paving tickets. Genuine fan-in/fan-out for AND-join and branching demos. Demo flow: show the trunk DAG → delay a groundwork ticket → show downstream ripple → fork a branch to model "what if we reroute trucks instead" → edit → merge back and show the diff → submit a progress report as the contractor → show the GPTZero flag → approve as the owner.

**Line 5 Eglinton Crosstown LRT** — a real, 14-ticket, 2011–2026 timeline for Toronto's badly-delayed light rail line, grounded in verified research rather than invented dates. Real delay figures (don't repeat an unverified "17 years" claim): **~4.4 years late** vs. the contracted September 2021 target, **~19 years** total from the March 2007 Transit City proposal to the actual February 8, 2026 opening. The real construction-phase → dispute → testing → launch dependency chain is seeded with 13 tickets `done` (each with an approved report — 3 link real, external, verified-working Metrolinx/Auditor-General PDFs; the other 10 link synthetic one-pagers from `scripts/generate-eglinton-pdfs.ts`, committed under `public/reference-docs/eglinton/`) and the final "Revenue Service Launch Prep" ticket left `in_progress` with no report, for a live PDF-upload demo through the real pipeline. Demo flow: switch to this project, show the real multi-year delay pattern and the litigation/settlement tickets' real evidence links, then submit a fresh PDF against the open final ticket to show the live GPTZero pipeline against real-world-shaped content.

## Build Sequence (time-boxed)

1. Postgres schema + seed data script (tables above, seeded road-construction scenario).
2. Trunk-only DAG CRUD + React Flow visualization + forward recalculation on status/date change. **(This is the demo floor — must be solid before anything else.)**
3. Report submission + GPTZero call + owner approve/reject + ticket closure.
4. Role switcher wired to steps 2-3's permissions (owner can approve, contractor can submit).
5. Branching: fork → edit → merge per the simplified model above. Time-boxed; fall back to the ephemeral-preview version (see Branching Semantics) if it's not stable.

## Verification

- Manually walk the demo script end-to-end in the browser after each build phase, not just at the end — the "demo floor" (phase 2) must work standalone before layering phases 3-5.
- Verify cycle rejection by attempting to add a back-edge in the seeded DAG.
- Verify AND-join by giving one ticket two parents and confirming it stays blocked until both complete.
- Verify GPTZero failure handling by temporarily using an invalid API key and confirming submission/approval still work.
- Verify merge-block behavior by editing the trunk after a fork, then attempting to merge — should be refused with the explicit message, not silently overwritten.
