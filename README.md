# JENGA

**Autonomous construction timeline verification and delay attribution.**

Blueprints go in. A dependency graph of work packages comes out, pinned to the physical drawing.
Field crews close tickets against it. Multimodal evidence verifies the claims — and refuses to
rule when the evidence is insufficient. Every slip is attributed, with evidence, the day it happens.

Built at Hack the North 2026.

---

## Why

The Eglinton Crosstown LRT opened February 2026 — six years late, ~$1B over. The failure wasn't
slow workers. **63% of submitted designs needed rework**, some submitted out of dependency order
(station designs before the excavation beneath them). Four rounds of litigation followed, all
arguing the same question: *whose* delay caused *which* slip. Metrolinx paid $562M in settlements.

Nobody had a ledger. This is the ledger.

## Quickstart

Zero infrastructure required. Two terminals:

```bash
# Terminal 1 — backend
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
JENGA_OFFLINE=1 uvicorn main:app --reload --port 8000

# Terminal 2 — frontend
cd frontend
npm install
npm run dev
```

→ http://localhost:3000

`JENGA_OFFLINE=1` makes every external AI call return canned responses from
`data/mock_evidence.json`. **This is the demo posture** — it runs with no API keys and no network.
Drop it once keys are in `backend/.env`.

## Architecture

```
[ Blueprint PDF + spec text ]
            │  (offline pre-parse — see note below)
            ▼
[ data/seed_tasks.json ] ── 16 work packages, deps, blueprint x/y coords
            │
            ▼
┌───────────────────────── FastAPI :8000 ─────────────────────────┐
│  cpm_engine.py    NetworkX DAG → ES/EF/LS/LF, float, critical   │
│                   path, topological depth                       │
│  agent.py         LangGraph StateGraph:                         │
│                     gptzero_gate → vision → memory → arbiter    │
│  documents.py     PDF/DOCX/TXT extraction → AI package proposal │
│  browserbase_*    Browserbase Fetch → Toronto hotzone feed      │
│  db.py            Postgres + pgvector  (or in-memory, default)  │
└──────────────────────────────┬──────────────────────────────────┘
                               │ REST (see CONTRACT.md)
                               ▼
┌──────────────────── Next.js 15 :3000 ───────────────────────────┐
│  <MacroHeatmap>   Browserbase macro map. Hotzone → project      │
│  <WorkGraph>       React Flow. blueprint mode (ViewportPortal,  │
│                    nodes at drawing pixel coords) ⟷ logical     │
│                    mode (Dagre topological ranks)               │
│  <Timeline>        per-ticket baseline/current schedule and     │
│                    stage-transition ticks                       │
│  <VerdictPanel>    4 evidence columns + verdict + confidence    │
│  <AttributionLedger>  append-only delay attributions            │
│  <StationView>     R3F — 5 zone meshes, state-driven materials  │
│  Zustand store     single source of truth for 2D + 3D           │
└─────────────────────────────────────────────────────────────────┘
```

Blueprint parsing can be shown two ways:

- **Demo posture:** use `data/seed_tasks.json`, the already-reviewed station DAG.
- **Upload posture:** upload PDF/DOCX/TXT/MD in the daily-update modal. Daily reports
  run through the same LangGraph verifier; specs/blueprints produce proposed work
  packages via OpenAI when `OPENAI_API_KEY` is present, otherwise via deterministic
  extraction. Proposals do **not** mutate the live CPM graph until a planner accepts them.

## The one thing that matters

When evidence is insufficient, the agent **refuses to decide**:

```json
{
  "status": "UNDER_REVIEW",
  "confidence": 0.32,
  "reasoning": "Drone image contains extreme shadow occlusion in the north perimeter. Rebar tie
                density cannot be verified to ASTM A615 at 150mm o.c. from this exposure.",
  "actionable_request": "Request illuminated inspection at north platform, X:340 Y:260."
}
```

A system whose output is legal evidence in a delay claim must not guess. Hard rules:

1. `ai_probability > 0.85` on a contractor report forces `under_review`, whatever vision says.
2. Insufficient visual evidence → `UNDER_REVIEW`, confidence < 0.5, non-null `actionable_request`
   naming exact blueprint coordinates.
3. Every external call degrades to a canned response. Never throws, never hangs.

## Layout

| Path | What | Owner |
|---|---|---|
| `CONTRACT.md` | **Interface contract. Authoritative.** Types, endpoints, states. | shared |
| `DEMO.md` | 90-second live demo script + failure playbook | shared |
| `data/seed_tasks.json` | 16-task DAG, blueprint coords, POs | shared |
| `data/mock_evidence.json` | 5 demo submissions + expected verdicts (also the offline fallback) | shared |
| `backend/cpm_engine.py` | CPM forward/backward pass, float, cascade | backend |
| `backend/agent.py` | LangGraph verification graph | ai |
| `backend/integrations/` | gptzero · vision · backboard memory · zip (mocked) | ai |
| `frontend/` | Next.js app | frontend |
| `frontend/public/blueprint.svg` | Synthetic station plan. **1200×800 is authoritative** — task `x,y` are pixels in this space. Do not rescale. | shared |

## Environment

Everything is optional. Absent keys → offline fallback.

```bash
# backend/.env
JENGA_OFFLINE=1                  # force canned responses (demo default)
JENGA_STORAGE=memory             # or `postgres`
DATABASE_URL=postgresql+asyncpg://jenga:jenga@localhost:5433/jenga

OPENAI_API_KEY=                  # vision + arbiter
GOOGLE_API_KEY=                  # vision fallback
GPTZERO_API_KEY=                 # AI-authorship detection
BACKBOARD_API_KEY=               # historical work-package memory
BROWSERBASE_API_KEY=             # macro construction hotzone scrape
JENGA_DOC_MODEL=gpt-4o-mini      # optional document extraction model
```

See `backend/AGENT_ENV.md` for what each key changes.

Optional Postgres: `docker compose up -d`, then `JENGA_STORAGE=postgres`.

## Browserbase setup

The Browserbase skill says to use the unified `browse` CLI:

```bash
npm install -g browse
browse skills install
export BROWSERBASE_API_KEY="your_api_key"
browse cloud projects list
```

If `browse cloud projects list` returns projects, `/api/hotzones` can use Browserbase
Fetch against Toronto/Metrolinx public pages. Without a key, JENGA returns seeded Toronto
hotzones so the macro-to-micro drilldown still works offline.

## Tests

```bash
cd backend
python test_cpm.py                    # CPM math, float, cascade
JENGA_OFFLINE=1 python test_agent.py  # verdicts match expected
```

Plain `assert`, no pytest. They should pass before you demo.

## Sponsor tracks

Rox (anchor, $10K) · OpenAI · GPTZero · Backboard · Tiger Data · Snowflake · Sentry · Vultr ·
GoDaddy. Rationale and the full 36-prize triage: `../research/02-prize-tracks.md`.

⏰ **Track selection locks Sat 2:00 PM EDT** — before the build is done. Select on what the
architecture guarantees.
