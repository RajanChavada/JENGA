# JENGA — Construction Ticketing & Dependency-Graph Planner (Hackathon MVP)

## Context

The goal is a HackTheNorth submission: a "JIRA/Linear for construction" where tickets are physical construction tasks (groundwork, road segments, height clearance, truck logistics) whose dependencies form a DAG. Delays or cancellations should be able to fork the plan into an alternate timeline; a ticket is closed when the construction company submits a progress report (photo/video + text) that the project owner approves. Reports are checked for AI-generated text via GPTZero and, per HackTheNorth sponsor prize tracks, Snowflake must be a real, visible part of the stack — not an implementation detail buried behind another database.

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
- Snowflake as the single system of record — tickets, edges, branches, and reports all live there.

**Explicitly out of scope for v1** (cut during grilling, revisit post-hackathon):
- Video-evidence analysis and worker chat/text "on-ground intelligence" fusion — no model, no pipeline, no UI for this in the demo.
- Real authentication, multi-tenant orgs, multiple contractors/subcontractors per project.
- Cross-ticket text-similarity or photo/video EXIF-tampering detection (the more fraud-relevant signals research surfaced) — noted in the pitch as "what we'd build next," not built now.
- General N-way merge/conflict resolution for branches (see Branching Semantics below for the simplified model actually being built).
- Postgres or any second database — everything routes through Snowflake, including operational writes, accepting the OLTP/OLAP mismatch as a deliberate hackathon trade-off in exchange for sponsor-track visibility.

## Competitive Landscape (for the pitch)

| Capability | Already exists | Gap JENGA fills |
|---|---|---|
| Dependency/Gantt scheduling | Primavera P6, Buildertrend, Autodesk Build | — (table stakes, not the pitch) |
| Photo/video progress tracking | Procore Photo Intelligence, OpenSpace, DroneDeploy | — (table stakes) |
| What-if scheduling | P6 "reflection schedules" (manual copy/merge, no auto-propagation) | **Versioned DAG branches with automatic delay-ripple + explicit merge** |
| Report authenticity/fraud detection | None found | GPTZero flag now; cross-report similarity + media-metadata checks as the credible next step |
| Ticket-style UX for construction | None found (existing tools are Gantt- or document-centric, not ticket-centric) | Ticket/board metaphor construction PMs may already know from software tools |

## Data Model (Snowflake)

Single schema, four core tables:

- `tickets(id, project_id, branch_id, title, description, status, planned_start, planned_end, actual_start, actual_end, created_at)`
- `dependencies(id, branch_id, parent_ticket_id, child_ticket_id)` — the DAG edges, scoped per branch.
- `branches(id, project_id, name, forked_from_branch_id, forked_from_ticket_id, forked_at, status)` — `status` is `active` or `merged`; the trunk is the branch with `forked_from_branch_id IS NULL`.
- `reports(id, ticket_id, submitted_by_role, text, media_url, gptzero_score, gptzero_flag, owner_decision, decided_at)`

DAG traversal (downstream dependents of a ticket, cycle checks on edge insert) uses Snowflake recursive CTEs (`WITH RECURSIVE`) over `dependencies`. Reject any edge insert whose reachability check would create a cycle.

## Branching Semantics (simplified for feasibility)

True N-way graph merge is out of scope for the time budget. Instead:

1. **Fork**: forking at ticket X copies X and everything reachable *downstream* of X (its dependent subtree) into a new `branch_id`; everything upstream of X is shared/unchanged between trunk and branch (no duplication).
2. **Edit**: changes inside a branch (status, dates, new tickets/edges) only ever touch rows tagged with that `branch_id`.
3. **Merge**: allowed only if the trunk's copy of that same subtree hasn't been edited since the fork. If it hasn't moved, merge = swap the trunk's subtree rows for the branch's rows (delete trunk's, re-tag branch's rows to trunk's `branch_id`) and mark the branch `merged`. If the trunk *has* moved, merge is blocked with a "trunk has changed, re-fork" message — no field-level conflict UI needs to be built.

This gets the real pitch moment (fork → edit → merge, with a visible before/after DAG diff) without general merge-conflict resolution.

**Fallback if branching runs out of time**: keep the trunk-only DAG + forward recalculation fully working first (this alone is demoable — "delay this ticket, watch the graph update"). Layer fork/edit/merge second. If it's not stable by the time-box below, degrade to an *ephemeral* preview: simulate a fork client-side, render the alternate downstream DAG side-by-side, and only "commit" (write) the version the user picks — no independent editing, no true merge. Still tells the branching story visually.

## Verification Workflow

1. Construction Company role opens a ticket, submits a report: free text + a photo/video upload.
2. On submit, the API route calls the GPTZero API server-side with the report text and stores `gptzero_score`/`gptzero_flag` on the report row. This call is real and shown in the UI (sponsor-track requirement) but never blocks submission or auto-rejects.
3. Project Owner role sees the report with the GPTZero flag displayed alongside it, and approves or rejects. Approve → ticket status `done`, triggers downstream recalculation. Reject → ticket returns to `in_progress`, contractor can resubmit.
4. GPTZero API failure/timeout is caught and shown as "authenticity check unavailable" rather than blocking the approval flow.

## Tech Stack

- **Frontend**: Next.js (TypeScript) + React Flow for the interactive DAG/branch visualization (node drag, animated edges, side-by-side branch rendering).
- **Backend**: Next.js API routes, calling the Snowflake Node SDK (parameterized queries, no ORM needed for this scale) and the GPTZero API. Keeps both API keys server-side.
- **No auth layer**: a role switcher (client-side toggle, e.g. a dropdown or `?role=owner|contractor` state) swaps which actions/views are available against the same Snowflake data.

## Edge Cases Handled in MVP

- Cyclic dependency on edge insert → rejected via reachability check before insert.
- Ticket with multiple parents → AND-join; only unblocks when all parents are `done`.
- Cancelling/deep-delaying a ticket with dependents → dependents flip to `blocked`, surfaced as a prompt to fork a branch from that point.
- Report rejected → ticket reopens to `in_progress`, contractor can resubmit a new report (old one kept for history).
- Branch merge attempted after trunk moved → blocked with an explicit message, no silent overwrite.
- GPTZero API error/timeout → degrades gracefully, doesn't block report submission or approval.

## Demo Script / Seed Data

Seed one project matching the original pitch examples directly: a road-construction project with tickets for groundwork/site clearing → height clearance/grading → road segment paving (multiple segments as parallel branches of the DAG) → truck logistics/delivery scheduling as a shared dependency feeding multiple paving tickets. This gives a DAG with genuine fan-in/fan-out (good for showing AND-join and branching) using the exact scenario the pitch already describes.

Demo flow: show the trunk DAG → delay a groundwork ticket → show downstream ripple → fork a branch at that ticket to model "what if we reroute trucks instead" → edit the branch → merge it back and show the diff → submit a progress report as the contractor → show the GPTZero flag → approve as the owner → ticket closes, DAG updates.

## Build Sequence (time-boxed)

1. Snowflake schema + seed data script (tables above, seeded road-construction scenario).
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
