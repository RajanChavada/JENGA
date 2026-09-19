# JENGA — Interface Contract

**Every parallel workstream codes against this file. Do not change it without saying so.**

Backend: FastAPI on `:8000`. Frontend: Next.js on `:3000`. Frontend calls backend via
`NEXT_PUBLIC_API_URL` (default `http://localhost:8000`).

## Task states (exact strings, used by UI, 3D, and DB)

```
pending | active | under_review | verified | disputed | blocked
```

3D material mapping (Three.js reads the same store as React Flow):

| state | 3D material |
|---|---|
| `pending` | wireframe, blue, opacity 0.3 |
| `active` | wireframe, cyan |
| `under_review` | pulsing amber |
| `verified` | solid concrete grey |
| `disputed` | red wireframe |
| `blocked` | dark grey, opacity 0.2 |

## Zones (3D meshes + blueprint regions)

`track_bed` · `south_platform` · `north_platform` · `mezzanine` · `escalator_well`

## Core types

```ts
type TaskState = 'pending'|'active'|'under_review'|'verified'|'disputed'|'blocked';
type Zone = 'track_bed'|'south_platform'|'north_platform'|'mezzanine'|'escalator_well';

interface Task {
  id: string;              // "P-104"
  name: string;
  zone: Zone;
  x: number; y: number;    // blueprint pixel coords, space is 1200x800
  duration_days: number;
  state: TaskState;
  spec_text: string;       // contractual requirement, fed to the agent
  depends_on: string[];
  // CPM, computed by backend:
  es: number; ef: number; ls: number; lf: number;
  total_float: number;
  is_critical: boolean;    // total_float === 0
  depth: number;           // topological rank — frontend staggers animation by this
}

interface Verdict {
  task_id: string;
  status: 'APPROVED'|'DISPUTED'|'UNDER_REVIEW';
  confidence: number;                 // 0..1
  reasoning: string;
  actionable_request: string | null;  // set when UNDER_REVIEW
  gptzero: { ai_probability: number; flagged: boolean };
  vision: {
    observation: string;
    matches_claim: boolean | null;  // false = image CONTRADICTS the claim -> DISPUTED
                                    // null  = image CANNOT ESTABLISH anything -> UNDER_REVIEW
                                    // these two are not the same and must not be collapsed
    confidence: number;             // 0..1, vision's own confidence, distinct from top-level
  };
  evidence: {                         // the 4 VerdictPanel columns
    spec: string;
    claim: string;
    visual: string;
    historical: string;
  };
}

interface AttributionEntry {
  id: string;
  task_id: string;
  slip_days: number;
  float_consumed: number;
  downstream_affected: string[];
  project_slipped_days: number;
  attribution: { party: string; days: number; reason: string }[];
  created_at: string;
}
```

## Endpoints

| Method | Path | Body | Returns |
|---|---|---|---|
| `GET` | `/api/graph` | — | `{ tasks: Task[], edges: {source,target}[], critical_path: string[], project_duration: number }` |
| `POST` | `/api/tasks/{id}/verify` | `{ report_text, image_base64?, transcript? }` | `Verdict` |
| `POST` | `/api/tasks/{id}/dispute` | `{ delay_days: int, reason: str }` | `{ tasks: Task[], critical_path: string[], attribution: AttributionEntry, project_slipped_days: int }` |
| `POST` | `/api/tasks/{id}/state` | `{ state: TaskState }` | `Task` |
| `GET` | `/api/attributions` | — | `AttributionEntry[]` |
| `GET` | `/api/purchase-orders` | — | `PurchaseOrder[]` |
| `POST` | `/api/reset?project_id=` | — | `{ ok: true, project_id }` — reseed one project for demo re-runs; other projects are untouched |
| `GET` | `/api/portal?company_id=&owner_id=` | — | `PortalOverview` — projects with parties and progress; `owners`/`companies` list only parties that appear |
| `GET` | `/api/projects/{id}/reports?view=owner\|contractor` | — | `Report[]`; `view=contractor` withholds `verdict` |
| `GET` | `/api/portal/owners/{id}/queue` | — | `QueueItem[]` — reports awaiting that owner, oldest first |
| `POST` | `/api/reports/{id}/decision` | `{ decision: 'approve'\|'deny', note? }` | `{ report: Report, tasks: Task[] }` |

`GET /api/graph` and the task routes take/derive a project: `GET /api/graph?project_id=`, and
task ids of every project but `eglinton-west-station` are prefixed `<project_id>:` (so
`ossington-relief-tunnel:P-107`).

**Contractor portal (changed).** Roles are a demo switcher, not auth: routes scope by the ids
given and enforce nothing about the caller. Each project has one owner and one contractor
company (`data/portal.json`).

- `POST /api/tasks/{id}/verify` no longer sets task state from the AI verdict. It records the
  verdict as a **recommendation**, sets the task `under_review`, and returns `409` if the task is
  not `active` or already has an update awaiting review.
- **`under_review` now means "awaiting the owner's decision".** Approve → `verified`; deny →
  `active` (contractor may resubmit). `disputed` stays reserved for `/dispute` and sensor conflict.
- **`blocked` is derived, never stored:** a `pending` task with any predecessor not `verified`
  is returned as `blocked`. Approving a task promotes each `pending` successor whose predecessors
  are all `verified` to `active`.
- A decision needs a `note` to deny, or to approve a report the AI did not approve (recorded as
  `ai_override`). `409` if already decided.

```ts
**Denied overlay (3D and 2D).** `denied` is not a task state: it is a presentation overlay for a task
that is `active` whose latest report was rejected by the owner. It draws solid, pulsing red
(`#dc2626`, opacity 0.9), distinct from `disputed`'s red wireframe, and clears when the contractor
resubmits (amber `under_review`) or the owner approves. A zone box shows its worst live state
(denied > disputed > under_review > active > blocked > pending) and `verified` only when every task in
it is verified; its label carries the `n/m verified` count.

**Deadlines and denial impact (changed).** `Task.due_day?: number | null` is the contractual
due day, an offset from the project's `start_date` (`data/portal.json`; `PortalProject.start_date`).
The project deadline is the latest task due day. A denial's cost is predicted by
`backend/impact.py` from the AI verdict plus the CPM graph, and is **advisory: it never changes a
task's duration or the schedule.** `Task.blocked_by?: string[]` lists the unverified predecessors of a
derived-`blocked` task.

- `GET .../queue` items carry `impact`: what denying that report would do now.
- Denying stores that prediction on `Report.impact`. The contractor view
  (`?view=contractor`) reduces it to `{ rework_days, predicted_finish_date, project_slipped_days }`.

```ts
interface Impact {
  task_id: string; rework_days: number; rationale: string[];
  float_consumed: number; absorbed_by_float: boolean; project_slipped_days: number;
  baseline_finish_date: string; predicted_finish_date: string; project_deadline_date: string;
  days_past_deadline: number; critical_path_changed: boolean;
  affected: { id: string; name: string; finish_date_before: string; finish_date_after: string;
              due_date: string | null; late_by_days: number; newly_late: boolean }[];
}
```

```ts
interface Report {
  id: string; task_id: string; project_id: string; report_text: string;
  verdict: Verdict | null;              // null in the contractor view
  impact: Impact | null;                // set on denial; reduced in the contractor view
  owner_decision: 'pending'|'approved'|'rejected';
  owner_note: string | null; ai_override: boolean;
  submitted_at: string | null; decided_at: string | null;
}
interface PortalProject {
  id: string; name: string; owner: {id,name}; contractor: {id,name};
  total: number; verified: number; active: number; under_review: number; blocked: number;
  awaiting_review: number; start_date: string;
}
interface PortalOverview { owners: {id,name}[]; companies: {id,name}[]; projects: PortalProject[] }
interface QueueItem { report: Report; impact: Impact | null; project_name: string; task_name: string }
```

```ts
interface PurchaseOrder {
  id: string;            // "PO-8821"
  material: string;
  quantity: string;
  vendor: string;
  delivery_date: string; // ISO date
  status: 'confirmed'|'rescheduled'|'draft'|'escalated';
  linked_task: string;
  last_action: string | null;
}
```

## Non-negotiables

1. **Ambiguity rule.** If image evidence is dark, occluded, or insufficient, the agent returns
   `UNDER_REVIEW` with `confidence < 0.5` and a non-null `actionable_request` naming exact
   coordinates. It must never guess. This is the demo's peak beat.
2. **GPTZero gate runs first.** `ai_probability > 0.85` forces `under_review` regardless of what
   vision says. An AI-written report never auto-approves.
3. **`depth` ships on every task.** Frontend staggers the cascade animation `depth * 120ms`.
4. **Blueprint coordinate space is 1200×800.** Task `x,y` are pixels in that space. The SVG must
   not be rescaled independently.
5. **All external AI calls degrade to canned responses** when the API key is missing, so the demo
   runs on dead conference wifi. Log a warning; never throw.
