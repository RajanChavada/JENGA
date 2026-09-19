# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

JENGA: construction timeline verification and delay attribution (Hack the North 2026 project). A CPM dependency graph of work packages is pinned to a blueprint; field tickets are verified by a multimodal LangGraph agent that refuses to rule on insufficient evidence; delays are recorded in an append-only attribution ledger.

`CONTRACT.md` is the authoritative interface (task states, zones, types, endpoints) — read it before changing any API shape or state string, and say so if you change it. `DEMO.md` has the live-demo script; `README.md` and `backend/AGENT_ENV.md` cover env vars.

## Commands

Backend (FastAPI, `:8000`):
```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
JENGA_OFFLINE=1 uvicorn main:app --reload --port 8000
```

Frontend (Next.js 15, `:3000`):
```bash
cd frontend
npm install
npm run dev      # also: npm run build, npm run lint
```

Tests are plain-`assert` scripts (no pytest), run from `backend/`:
```bash
python test_cpm.py
JENGA_OFFLINE=1 python test_agent.py
python test_sensors.py
```
To run a single check, run the specific script; there is no test selector.

Reset demo state: `curl -X POST localhost:8000/api/reset`. Optional Postgres: `docker compose up -d` and `JENGA_STORAGE=postgres`.

## Architecture

- **Data flow:** `data/seed_tasks.json` (16-task DAG with blueprint x/y coords) → `backend/cpm_engine.py` (NetworkX; ES/EF/LS/LF, float, critical path, cascade) → REST → frontend Zustand store (`frontend/src/store/useJenga.ts`), which is the single source of truth for both the 2D React Flow views and the 3D R3F `StationView`.
- **Verification agent** (`backend/agent.py`): LangGraph `gptzero_gate → vision → memory → arbiter`. Integrations live in `backend/integrations/` (gptzero, vision, memory/Backboard, tiger, zip_api). The arbiter's status is derived by real logic even on canned inputs.
- **Hard rules of the verifier:** AI-authorship probability > 0.85 forces `under_review`; insufficient visual evidence yields `UNDER_REVIEW` with confidence < 0.5 and a non-null `actionable_request` naming blueprint coordinates; every external call must degrade to a canned fallback and never raise or hang (5s cap).
- **Offline mode:** `JENGA_OFFLINE=1` forces all AI calls to answers from `data/mock_evidence.json` (also the fallback for missing keys). This is the demo posture. `JENGA_STORAGE=memory` (default) vs `postgres` is handled in `db.py`.
- **Documents:** `documents.py` extracts PDF/DOCX/TXT and proposes work packages (OpenAI if key present, else deterministic). Proposals must not mutate the live CPM graph until a planner accepts them.
- **Hotzones:** `browserbase_hotzones.py` feeds the macro map (`MacroHeatmap`, maplibre); seeded Toronto hotzones when no key. Each hotzone opens a project drilldown.
- **Frontend fixtures:** `NEXT_PUBLIC_USE_FIXTURES=1` runs the UI from `data/*.json` with the backend down. API base is `NEXT_PUBLIC_API_URL` (default `http://localhost:8000`).

## Gotchas

- `frontend/public/blueprint.svg` is 1200×800 and authoritative; task `x,y` are pixels in that space. Do not rescale.
- In `TaskNode.tsx`, `nodeTypes` must stay module-scope, or React Flow re-renders infinitely.
- `WorkGraph` has two modes: blueprint (nodes pinned via `ViewportPortal`) and logical (Dagre ranks).
- Task state strings and the 3D material mapping are fixed by `CONTRACT.md`.
- Design specs/plans live in `docs/superpowers/{specs,plans}`.
