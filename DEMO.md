# JENGA — 90-second demo script

Judging pitch must be a **live demo**, not slides. Run this, out loud, in this order.
Every beat maps to a judging criterion; the annotations say which.

## Before you walk up

```bash
export JENGA_OFFLINE=1          # every AI call falls back to canned responses
export JENGA_STORAGE=memory     # no database needed
curl -X POST localhost:8000/api/reset
```

Open the blueprint view, zoomed to fit. Second tab: 3D station view. **Do not** rely on
conference wifi. `JENGA_OFFLINE=1` is the default demo posture — turn it off only if the
network has proven itself.

---

## The script

**[0:00] The hook — say this before touching anything**

> "The Eglinton Crosstown opened six years late and a billion over. It wasn't slow workers.
> Sixty-three percent of submitted designs needed rework, they were submitted out of sequence,
> and it went to court four times — because nobody could prove *whose* delay caused *which*
> slip. This is the ledger that answers that."

**[0:12] Blueprint view** — *originality, design*

Sixteen work packages pinned to their physical locations on a station plan. Not a flowchart —
the graph lives on the drawing. Critical path highlighted.

Toggle to logical view. Nodes fly from physical position into topological rank.

> "Same graph, two projections. Where the work is, and what it depends on."

**[0:28] Submit a contractor's daily report** — pick `SUB-02` (P-106, South Platform Pour)

**[0:33] GPTZero gate fires** — *technical complexity*

> "Ninety-four percent AI-generated. Contractors write daily logs with ChatGPT now — verbose,
> no volumes, no weather, no crew names. It hides the fact that nothing happened. So it does
> not auto-approve. Ever."

Node goes **amber**, not green.

**[0:42] Vision contradicts the claim**

Report implies a completed milestone. Photo shows ~40% poured, rebar still exposed. → **DISPUTED**

**[0:52] ★ THE PEAK — submit `SUB-03` (P-107, North Platform Rebar)** — *WOW factor*

Report is human. Plausible. But the drone photo is shadow-occluded.

**Stop talking. Let them read the VerdictPanel.**

> "It won't rule. Confidence 0.32. It says: rebar tie density cannot be verified to ASTM A615
> from this exposure — request an illuminated inspection at X:340, Y:260.
>
> Most demos you'll see today always return an answer. This one knows when it can't. In a system
> whose output is *legal evidence for a delay claim*, a confident guess is worse than useless."

This is the Rox beat. Rox asks for "honest handling of ambiguity." Do not rush it.

**[1:08] The cascade** — *design, WOW factor*

Dispute P-106 with a 4-day slip.

> "South platform had one day of float. This eats it."

Delay ripples through the graph **rank by rank**, staggered by topological depth. Six downstream
tasks turn amber. The critical path **flips** onto the platform branch.

**[1:20] The ledger writes itself**

> "Four-day slip. Three days subcontractor — overstated progress. One day owner — late release
> of platform edge detail SK-114. All float consumed. Project completion moves.
>
> That's the paragraph that took four lawsuits and five hundred sixty-two million dollars to
> argue about on the actual Crosstown."

**[1:28] Close**

> "Blueprints in. Verified work out. Every delay attributed, with evidence, the day it happens."

---

## If something breaks

| Breaks | Do this |
|---|---|
| Backend down | Frontend runs on fixtures — `NEXT_PUBLIC_USE_FIXTURES=1`. Demo is unaffected. |
| An AI call hangs | `JENGA_OFFLINE=1` should already be set. Canned verdicts, same UI. |
| 3D view misbehaves | Skip it. It is beat-optional; the 2D graph carries the whole script. |
| Cascade doesn't fire | Reload, `POST /api/reset`, dispute a different node. |

**Never apologize for a fallback.** Offline mode is a design decision — a field tool for
construction sites has no wifi either. Say that if asked.

## Sponsor tracks — name these during the demo

| Track | Say it at |
|---|---|
| **Rox** ($10K) | Beat 0:52. Four conflicting sources, honest refusal. The whole pitch. |
| **GPTZero** | Beat 0:33. |
| **OpenAI** | Vision + arbiter. Have one concrete Codex anecdote ready. |
| **Backboard** | The historical-memory evidence column. |
| **Tiger Data** | Postgres graph + progress event stream. |
| **Snowflake** | Async audit sink for completed inspections. |
| **Sentry** | If the agent trace panel ships, it's Sentry-fed. |
