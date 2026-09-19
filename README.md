# JENGA

Using AI for construction project management.

A ticketing and dependency-graph planner for construction projects — think "JIRA for construction." Construction tasks are tickets; dependencies between them form a DAG; delays and cancellations can fork the plan into alternate timelines that get edited and merged back in. Progress reports close tickets after project-owner approval, with a GPTZero authenticity check surfaced alongside each report.

See `docs/plan.md` for the full product/technical plan.

## Development

```bash
npm install
cp .env.example .env.local        # fill in your GPTZero API key
docker compose up -d              # starts local Postgres
psql "$DATABASE_URL" -f sql/schema.sql
npm run seed                      # seeds a demo project — see docs/plan.md → Demo Script
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).
