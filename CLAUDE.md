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

The app talks to either Postgres (local dev) or Snowflake (production/demo), selected by `DB_DRIVER` in `.env.local` (copy from `.env.example`). Postgres is the default until Snowflake credentials exist:

```bash
docker compose up -d                                    # starts local Postgres (see docker-compose.yml)
psql "$DATABASE_URL" -f sql/schema.postgres.sql          # apply schema (first time / after schema changes)
npm run seed                                             # seed demo data
```

Switching to Snowflake is `DB_DRIVER=snowflake` plus the `SNOWFLAKE_*` vars in `.env.local` — no code changes. Apply `sql/schema.sql` (not the `.postgres.sql` one) there instead.

## Architecture

### Dual-database driver — read this before writing any query

All data access goes through `lib/db.ts`, which picks `lib/snowflake.ts` or `lib/postgres.ts` based on `DB_DRIVER` and exports one `execute<T>(sql, binds)` used everywhere else (`lib/dag.ts`, `lib/branch.ts`, every `app/api/**/route.ts`, `scripts/seed.ts`). This has real constraints on how SQL is written in this codebase:

- **Placeholders are always `?`** (Snowflake's style), never `$1`. `lib/postgres.ts` rewrites them to `$1, $2, …` before sending the query.
- **Never write `CURRENT_TIMESTAMP()` or `DATEADD(...)` inline.** Use the dialect helpers exported from `lib/db.ts` — `now()` and `dateAddDays(column)` — which resolve to the right syntax per driver (Postgres rejects the parenthesized `CURRENT_TIMESTAMP()` form; it has no `DATEADD`).
- **Result rows are always UPPERCASE-keyed** (`row.STATUS`, `row.BRANCH_ID`, …), matching Snowflake's default. `lib/postgres.ts` upper-cases Postgres's naturally-lowercase keys and pins its DATE/TIMESTAMP type parsers to return raw strings (not JS `Date` objects) so both drivers return identical shapes. `lib/types.ts` is written against this uppercase, string-dates shape.
- **Never rely on a database-generated id.** Every insert generates its own id with `crypto.randomUUID()` app-side, because the two schema files don't share id-generation defaults.
- **Two schema files must be kept in sync by hand**: `sql/schema.sql` (Snowflake) and `sql/schema.postgres.sql` (Postgres). A schema change means editing both.

### Data model & DAG logic

Four tables: `projects`, `branches`, `tickets`, `dependencies` (the DAG edges), `reports`. A ticket can have multiple parents (AND-join: all must be `done` before it unblocks). `lib/dag.ts` holds the graph algorithms — descendant traversal and cycle detection via a recursive CTE (`WITH RECURSIVE`, identical syntax on both drivers), AND-join unblocking, cancellation cascades, and delay-ripple date shifting.

Branching (forking an alternate timeline, editing it, merging back) is deliberately simplified rather than a general graph merge — see `lib/branch.ts` and `docs/plan.md`'s "Branching Semantics" section for the exact model: a fork copies only the downstream subtree of the fork point (tracked via `tickets.forked_from_id`), and a merge is refused (not silently overwritten) if the trunk's copy changed since the fork (compared via `updated_at` vs `branches.forked_at`).

### Verification workflow

`lib/gptzero.ts` calls the GPTZero API on report submission but is advisory-only by design — it never blocks submission or approval, and degrades to an `unavailable` flag on any failure (see `docs/plan.md` for why: GPTZero's false-positive rate on short, non-native-English text makes it unsuitable as a gate for this domain).

### Frontend

`app/page.tsx` is the orchestrator: it fetches the current project/branch/graph and composes `components/DagView.tsx` (React Flow graph, laid out by the layered BFS algorithm in `components/dagLayout.ts`), `components/TicketPanel.tsx` (role-gated ticket actions: start work, submit report, delay, cancel, fork, approve/reject), and `components/BranchBar.tsx` (role switcher + timeline/branch selector + merge button). There is no real authentication — `lib/role-context.tsx` is a client-side-only role switch (`owner` / `contractor`) that gates which actions are shown, not a security boundary.
