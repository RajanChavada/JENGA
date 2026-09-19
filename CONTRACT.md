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
| `POST` | `/api/reset` | — | `{ ok: true }` — reseed for demo re-runs |

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
