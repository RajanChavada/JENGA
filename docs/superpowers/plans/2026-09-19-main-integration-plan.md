# JENGA — integrate `feat/light-theme-map-zip-rox` with `main`

Date: 2026-09-19. Deadline: Sat 2026-09-20 08:00 EDT. Decision: **Option A** — our FastAPI + Next.js app stays the demo surface; main's Postgres schema becomes the shared persistence. No Python→TypeScript rewrite.

## Verified facts this plan rests on

- main (07b556b): Next.js 16 mono-repo, `lib/db.ts` single `execute(sql, binds)` switching Postgres/Snowflake via `DB_DRIVER`. Tables `projects, branches, tickets, dependencies, reports`. `tickets.status` is **plain TEXT, no CHECK** — new values need a comment edit, not a migration. GPTZero is advisory (`reports.gptzero_score`, `gptzero_flag`).
- ours (7481ba2): `MacroHeatmap.tsx` already MapLibre + `react-map-gl/maplibre`, Positron style, Marker/Popup, drill-down **hardcoded to P-106**. Vision uses OpenAI/Gemini direct (keys missing → canned offline). Backboard used only for memory search and dormant (no `BACKBOARD_ASSISTANT_ID`). Arbiter is deterministic Python. Zip fires post-verdict in `main.py`, mock (no `ZIP_API_KEY`).
- Backboard API: base `https://app.backboard.io/api`, header `X-API-Key`. `POST /threads/messages` is the generation endpoint, auto-creates thread+assistant; handles PDF/Office documents. **Image input unverified** — do not route vision through it.
- Keys set: GPTZero, Backboard. Missing: OpenAI/Google, Zip, Browserbase (`BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`). `browse` CLI and Stagehand not installed.

## Golden demo flow (what the judge sees, in order)

1. **Site** — MapLibre Toronto map, 5 hotzones. Click Eglinton West → drills into that site's DAG. Other hotzones open an empty site with "Onboard from blueprint" CTA.
2. **Plan** — Upload PRD/blueprint PDF → Backboard extracts proposed work packages → accept → tickets + dependencies written to main's tables → CPM computed, DAG renders over blueprint.
3. **Submit** — Subcontractor uploads daily report (PDF/photo/voice) against a ticket.
4. **Verdict** — LangGraph: GPTZero gate → vision → Backboard memory → deterministic arbiter. Strict Mode toggle decides whether GPTZero >85% is a hard `disputed` or an advisory warning.
5. **Impact** — `disputed` → Zip PO delay (mock) + CPM cascade + attribution ledger row.

A top-of-page stepper with these five labels replaces the current unlabeled multi-panel layout. This is the readability fix; palette stays light.

## Tasks

### T1 — Schema: additive changes to main's SQL (both files, hand-synced per their convention)
Files: `sql/schema.postgres.sql`, `sql/schema.sql` (from origin/main, brought into our repo at `backend/sql/`).
- `tickets.status` comment: add `'under_review' | 'disputed'`.
- Add tables (our shapes, their conventions: TEXT ids, app-side UUIDs): `attributions`, `purchase_orders`, `evidence_verdicts` (ticket_id, report_id, verdict JSON, created_at).
- Add nullable `tickets.zone TEXT, blueprint_x DOUBLE PRECISION, blueprint_y DOUBLE PRECISION, duration_days INTEGER, spec_text TEXT` — needed for spatial DAG and CPM.
- Add `backend/sql/tiger.sql` (hypertable `sensor_metrics`, continuous aggregate `sensor_metrics_5min` + refresh policy, stretch `agent_telemetry`) — exact SQL in `docs/superpowers/specs/2026-09-19-tiger-data-sensor-stream-design.md`.
- `docker-compose.yml`: image `pgvector/pgvector:pg16` → `timescale/timescaledb-ha:pg16` (ships `timescaledb` + `vector`), port 5433 unchanged.
- Check: `psql -f` all three files against the local container — clean apply, idempotent (`IF NOT EXISTS`). Re-run against Tiger Cloud (`TIGER_SERVICE_URL`) once the service is Running.

### T2 — Storage driver: FastAPI reads/writes main's tables
File: `backend/db.py`.
- Rename ORM tables to main's: `tasks→tickets` (`name→title`, `x→blueprint_x`, `y→blueprint_y`, `state→status`), `dependencies` (`source→parent_ticket_id`, `target→child_ticket_id`, add `branch_id`), `evidence→reports` (+`evidence_verdicts` for the verdict JSON).
- State map at the boundary, one dict each way:
  `pending→blocked, active→in_progress, verified→done, under_review→under_review, disputed→disputed, blocked→blocked`.
- Seed writes one `projects` row (`eglinton-west-station`) + one `branches` row (`main`), all tickets carry both FKs.
- `JENGA_STORAGE=memory` path unchanged (demo safety net).
- `DATABASE_URL` may be the Tiger Cloud DSN (Postgres + timescaledb) — relational tables and hypertables share one database. No code change needed for that; env only.
- Check: `JENGA_STORAGE=postgres DATABASE_URL=postgresql+asyncpg://…:5433/jenga python test_cpm.py` passes; `curl /api/graph` returns 16 tasks; `select status,count(*) from tickets` matches.

### T3 — Multi-site: hotzone → project
Files: `backend/browserbase_hotzones.py`, `backend/main.py`, `frontend/src/store/useJenga.ts`, `frontend/src/components/MacroHeatmap.tsx`.
- `GET /api/graph?project_id=` (default `eglinton-west-station`); `/api/reset` accepts `project_id`.
- Store: `activeProjectId`, `loadSite(hotzoneId)` → finds `linked_site_id`, calls `load(project_id)`, sets `view:'micro'`. Null `linked_site_id` → `view:'micro'` with `tasks=[]` and empty-state panel showing the **Onboard from blueprint** upload.
- MacroHeatmap popup button: `onClick={() => loadSite(hotzone.id)}` — delete the P-106 hardcode.
- Check: Playwright — click Eglinton West → 16 nodes; click Dufferin → empty state with upload CTA.

### T4 — Backboard as the document extractor (real use of the key we have)
Files: `backend/documents.py`, `backend/integrations/backboard.py` (new, ~40 lines).
- `backboard.py`: `async def ask(content, *, thread_id=None, file=None) -> dict` → `POST /threads/messages` with `X-API-Key`; multipart when a file is attached; returns `{content, thread_id}`.
- `documents.py::extract_tasks`: provider order `OPENAI_API_KEY` → `BACKBOARD_API_KEY` → offline fixture. Prompt asks for strict JSON array of `{id, title, zone, duration_days, depends_on[], spec_text, blueprint_x, blueprint_y}`; parse with one `json.loads` after stripping fences; malformed → offline fixture, never a 500.
- `POST /api/documents/commit` — writes accepted proposals to `tickets`+`dependencies` for `project_id`, recomputes CPM, returns graph. Frontend "Accept plan" button in `DocumentUpload` (spec mode) calls it.
- Check: `JENGA_OFFLINE=0 python -c` extraction on `data/sample_prd.pdf` returns ≥5 tasks with a valid DAG (no cycles, `networkx.is_directed_acyclic_graph`).

### T5 — Strict Mode (the GPTZero compromise)
Files: `backend/agent.py`, `backend/main.py`, `frontend/src/store/useJenga.ts`, header component.
- `POST /api/tasks/{id}/verify?strict=true|false` (default `true`). In `arbiter`: strict → `ai_probability>0.85` forces `UNDER_REVIEW` (current behaviour); lenient → append `"GPTZero advisory: {pct}% AI"` to reasoning, no status change.
- Persist to main's columns every time: `reports.gptzero_score`, `reports.gptzero_flag` (`'flagged'|'clear'`), `reports.owner_decision` (`approved|disputed|pending`).
- UI: `Strict` toggle beside "Submit daily update", tooltip "Hard-gate AI-written reports (Rox) / advisory only (main)".
- Check: `test_agent.py` gains two cases: SUB-02 strict → UNDER_REVIEW; SUB-02 lenient → APPROVED with advisory string in reasoning.

### T6 — Zip on `disputed`, persisted
Files: `backend/main.py`, `backend/integrations/zip_api.py`.
- Already fires post-verdict; add: write `purchase_orders.status='rescheduled'`, `last_action` to Postgres; `GET /api/purchase-orders` reads from DB.
- Check: dispute P-106 → `select status from purchase_orders where id='PO-8821'` = `rescheduled`.

### T7 — Browserbase live path
Files: `backend/browserbase_hotzones.py`, `README.md`, `backend/.env`.
- Setup per browserbase.com/SKILL.md: `npm i -g browse`, `export BROWSERBASE_API_KEY=…`, verify with `browse cloud projects list`. Get key + project ID from Booth #46 (PSE 2nd floor) or free tier.
- Fetch API path already exists — confirm it targets Metrolinx/City of Toronto construction pages and geocodes; cache to `data/hotzones_live.json` with 1h TTL; seed fallback unchanged.
- `scrape_construction.py` (Stagehand) stays optional: only runs if `stagehand` importable and both env vars set.
- Check: with key → `GET /api/hotzones` returns `source:"browserbase"`; without → `source:"seed"`.

### T8 — Readability: five-step stepper shell
Files: `frontend/src/app/page.tsx`, new `frontend/src/components/Stepper.tsx`.
- Stepper `Site · Plan · Submit · Verdict · Impact`, current step derived from store (`view==='macro'`→Site; `tasks.length===0`→Plan; `verdict`→Verdict; `attributions.length`→Impact; else Submit). Clicking a step scrolls/focuses its panel; nothing else changes.
- Collapse `Timeline` and `AttributionLedger` into the Impact step; hide until first verdict.
- Check: Playwright screenshots of each step; 0 console errors.

### T10 — Tiger Data: curing sensor stream + fifth agent node (MLH track, Rox strengthener)
Spec: `docs/superpowers/specs/2026-09-19-tiger-data-sensor-stream-design.md` (authoritative; this is the summary).
Files: `backend/integrations/tiger.py` (new), `backend/sensors.py` (new), `backend/agent.py`, `backend/main.py`, `backend/test_sensors.py` (new), `frontend/src/components/SensorStrip.tsx` (new), `frontend/src/store/useJenga.ts`, `frontend/src/components/VerdictPanel.tsx`, `frontend/src/lib/types.ts`, `frontend/src/lib/api.ts`.
- `tiger.py`: asyncpg pool on `TIGER_SERVICE_URL`; `insert_readings`, `recent_buckets` (10 s buckets over raw hypertable, last 2 min), `history_5min` (continuous aggregate), `curing_status` (2-min avg, threshold 10 °C). Mock deque backend when DSN unset/unreachable; `source: "tiger"|"mock"`.
- `sensors.py`: lifespan asyncio loop, 2 s tick, temp+humidity per `in_progress` ticket; `POST /api/sensors/scenario/{id}` `{"mode":"normal"|"cold"}`; `JENGA_SENSORS=0` disables.
- `agent.py`: node `sensor_check` between `historical_memory` and `arbiter`; arbiter rule: below-threshold + claim matches cure/pour/set → `DISPUTED`, reasoning quotes avg and threshold, `actionable_request` asks for maturity log. Trace card `4 · Site telemetry`; arbiter card renumbered 5. Frontend `synthesizeTrace` mirrors.
- `GET /api/sensors/{ticket_id}` → `{live, history, status}`.
- `SensorStrip.tsx`: under DAG for selected non-pending task; inline SVG sparkline, avg temp, threshold dashed line, `tiger|mock` badge whose tooltip shows the two SQL queries, "cold snap" button. Polls every 2 s.
- Check: `JENGA_SENSORS=0 JENGA_OFFLINE=1 python test_agent.py` still 10/10; `python test_sensors.py` 4/4; Playwright: select P-106 → click cold snap → wait 25 s → submit "pour cured" report → DISPUTED with "10 °C" in reasoning.
- Against Tiger (when Running): `SELECT count(*) FROM sensor_metrics` > 0 after 60 s; `sensor_metrics_5min` returns rows after refresh.

### T11 — Stretch: agent telemetry hypertable (only if T10 done before 02:00 EDT)
- Time each LangGraph node; `executemany` into `agent_telemetry` post-run; `GET /api/telemetry/summary` (`time_bucket('1 minute')` avg latency per node, last hour); small "pipeline p50 latency" sparkline in VerdictPanel header. Cut without regret.

### T9 — Verify, commit, push, deploy
- `npm run build`, `python test_cpm.py`, `JENGA_OFFLINE=1 python test_agent.py`, Playwright golden flow.
- Commit per task on `feat/light-theme-map-zip-rox`, trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Open PR into `main` titled "Integrate JENGA verification agent with main schema"; PR body lists the schema additions and the Strict Mode compromise for teammate review.
- Deploy per `DEPLOY.md`.

## Order and parallelism

T1 → T2 (sequential, schema first). T3, T4, T5, T7, T10 parallel after T2 (T10's backend half can start after T1). T6 after T5. T8 after T3 and T10 (stepper hosts SensorStrip in the Submit step). T11 only if T10 done by 02:00 EDT. T9 last. Estimated 8–10 focused hours with subagents on T3/T4/T7/T10.

Sponsor coverage: Rox (agent, T5 + T10 conflicting sources), Browserbase (T7), Tiger Data (T10), Backboard (T4), Zip (T6). Baseten: no viable slot tonight — would need to host vision/extraction on a Baseten endpoint; revisit only if OpenAI key never arrives (Baseten OpenAI-compatible endpoint could replace it in `vision.py` with a base-URL swap).

## Cut (and why)

- LangGraph.js / Next.js API-route rewrite — Option B, rejected; no time, Python pipeline already passes 10/10.
- Backboard for vision — image input unverified; vision stays OpenAI/Gemini with offline canned fallback.
- Dark theme swap — not the readability problem; stepper is.
- Snowflake writes — `DB_DRIVER=snowflake` in main is untouched; our driver is Postgres only tonight.

## Still on the user

- Browserbase key + project ID (booth). Optional OpenAI key for live vision. Optional Zip key.
- Tiger Cloud `db-87722` is **Configuring** (2026-09-19 evening; hostname NXDOMAIN until Running). When Running, copy `TIMESCALE_SERVICE_URL` from `~/Downloads/tiger-cloud-db-87722-credentials.env` into `backend/.env` as `TIGER_SERVICE_URL` (and as `DATABASE_URL` for unified storage). If the hostname changed, re-download the creds file.
- Prize selection lock 2:00 PM today.
- Rotate GPTZero and Backboard keys after the event.
