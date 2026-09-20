# JENGA — Devpost Description

## Inspiration

Have you seen the construction downtown? In Waterloo? The TTC? The LRT?

Big transit projects keep dying the same slow death. Toronto's Eglinton Crosstown took ~19 years and lost billions — not because nobody had data, but because **nobody could trust it**. Progress reports get written to sound good (increasingly by AI), witness accounts contradict each other, permits stall, and every dispute decays into a "he said, she said" court case years after the concrete set. Physical defects hide inside confident paragraphs until it's too late to fix them cheaply.

That's the actual problem: **data is abundant, but claims are unreviewable — and even when someone catches a problem, the follow-up action (reschedule, reorder, escalate) happens weeks later by email.** So we built JENGA around two promises: every claim gets verified against evidence the moment it's made, and the consequences — schedule math, procurement, escalation — fire automatically, on real systems, with a visible paper trail.

## What it does

JENGA is a JIRA-style construction tracking platform for project owners, in two views.

**Macro:** a live MapLibre heatmap of Toronto. Press "Scrape live feeds" and **Browserbase** pulls municipal road restrictions and Metrolinx updates on the spot — the panel shows exactly which sources were fetched and honestly labels what came back live vs. seeded. Click a hotzone to drill into its site.

**Micro:** the site itself — a dependency graph of work packages locked onto the 2D blueprint, a synchronized 3D digital twin, and a schedule that has become the site's **financial-physical timeline**: task bars with real-timestamp stage ticks, procurement diamonds on the rows they feed, and an analysis band where three curves tell the story — planned work, verified work, and committed spend.

When a contractor submits a daily update (PDF, photo, or voice note), a five-node agent pipeline takes over, and you watch it run: **authorship gate (GPTZero) → media analysis (vision + Gemini) → historical memory → site pace → arbiter**. Clear contradiction → **Disputed**. Ambiguous evidence → **Under Review** — the agent refuses to rubber-stamp, and says exactly what field record it needs. Every source's read is shown in one evidence strip; nothing is a black box.

Then the owner decides. Our teammates built the **owner portal**: approve or deny a request to close a ticket, with the predicted schedule impact shown before you click — rework days, downstream risk, the projected extension sitting right in the schedule. Denying a ticket actually moves the timeline; the graph and 3D twin update with it, and the delay lands in an append-only attribution ledger.

### The three moments we're proudest of

**1 — Procurement that acts (Zip).** A voice note says the aggregate delivery never showed. The agent catches the shortage, plans a bill of materials, picks the vendor, and creates a **real purchase order on Zip's staging environment, line items and all** — you can open it in Zip's own UI. Above single POs sits spend governance: JENGA is the only system that knows both what was bought (Zip) and what was actually built (verification), so when committed spend hits 42% while verified work sits at 28%, it escalates — quoting the tenant's **real approval workflow threshold**, delivered as a **real comment on Zip**. Every individual PO was compliant; *the cumulative pattern was not*. That's the catch a human approver structurally cannot make.

**2 — The site's time axis (Tiger Data).** Every verdict, every PO lifecycle event, every escalation lands as a timestamped row in a TimescaleDB **hypertable on Tiger Cloud**. `time_bucket` rollups turn that stream into real earned-value management — the planned-vs-verified S-curve, an SPI, and a projected finish date — the same math construction PMs run in Primavera, computed live from verified evidence instead of self-reported percentages. And it feeds back into verification: the **pace rule** holds any completion claim that outruns the site's measured pace. (Click the badge on the strip — the actual SQL is right there.)

**3 — The supply-line radar (Browserbase).** Materials travel highways, and highways close. On demand, the agent pulls **Ontario 511's live event feed through Browserbase**, traces each vendor's route to the site via OSRM (real GTA suppliers — Dufferin Concrete, Harris Rebar, CRH Canada, Sika), and flags any closure within 500 m of a route. Then it previews the cascade — *"PO slips 2 days → P-104 pour slips → project +2 days, critical path"* — and acts. During our verification run it caught a **real overnight QEW full closure**, traced it to the rebar delivery, and raised a real expedite PO on Zip staging — before any human knew the truck would be late.

Everything the agents do — scrapes, verifications, PO creation, escalations, route checks — is confirmed in one **activity rail**, created "running" and resolved with what actually happened.

## How we built it

Next.js 15 frontend: React Flow nodes locked to blueprint coordinates, a Three.js twin driven by the same Zustand store as the graph (one state, two projections), Framer Motion, and a deliberately minimal white theme.

Python FastAPI backend. The verification pipeline is **LangGraph** (Python): GPTZero as the authorship gate, OpenAI vision plus **Gemini media analysis** for submitted evidence, **Backboard** for historical memory, a pace check reading Tiger, and a deterministic arbiter with an auditable rule order. Procurement goes through the **Zip REST API** (with the ziphq-mcp server configured so agents can drive Zip directly); Zip staging POs turned out to be immutable, which forced a better design — expedites *create* new POs, so every action leaves an artifact. **Browserbase Fetch API** powers both the municipal scrape and the 511 feed; OSRM draws the routes. **Tiger Cloud TimescaleDB** holds the `site_events` hypertable and a continuous aggregate.

One engineering rule everywhere: **one honest fallback per integration.** No key, or a dead API mid-demo, degrades to a clearly-labeled mock — source badges say `live` or `seeded`, and the app never fakes a success it didn't earn.

## Challenges we ran into

- **Live sponsor systems bite back.** Zip's staging POs are immutable (redesign: create-not-mutate). Ontario 511 counts cancelled and ramp-only works as "closures" — our first radar pass expedited every PO on the board until we calibrated severity and capped actions per pass (it's a shared tenant; be polite).
- **We killed our own feature.** Our original Tiger integration was a simulated curing-temperature "cold snap" — technically cute, but it took a physics lecture to explain. We deleted it the night before judging and rebuilt Tiger as the EVM time axis, which lands in one sentence.
- Building this much surface area against five sponsor systems meant ruthlessly skipping everything else: auth, role segregation, real drone ingestion.

## Accomplishments that we're proud of

The honesty of the system. The agent **refuses to rule** on thin evidence instead of guessing; every verdict ships with its full trace; every integration admits when it's degraded. And the wow moments aren't mockups — the POs, the Zip comments, the QEW closure, the hypertable rows all exist on real external systems you can open and check.

## What we learned

- Immutable APIs are a feature: being unable to mutate Zip POs gave us an audit trail for free.
- Determinism matters as much as generative AI in enterprise tools — LLM extraction wrapped in hardcoded rules and honest fallbacks is what makes the product safe.
- Tiger's hypertables drop into a normal Python/Postgres stack almost embarrassingly easily.
- Kill your darlings: if a demo beat needs explaining twice, replace it with one that explains itself.

## What's next for JENGA

- Live drone-feed ingestion replacing uploaded evidence.
- Authentication and real owner/contractor role separation.
- The radar's next move: a Stagehand browser agent that hunts alternate suppliers when a route goes high-risk, and weather-aware pour scheduling off Environment Canada alerts.
- Deeper Zip governance: invoice three-way matching against verified field work — approve what the site confirms, hold what it doesn't.
