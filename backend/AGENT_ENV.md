# JENGA agent — environment variables

Everything here is optional. With an empty environment the pipeline runs end to
end on canned evidence from `data/mock_evidence.json` and returns well-formed
Verdicts. Nothing in `backend/agent.py` or `backend/integrations/` ever raises
out to the caller, and no external call can exceed 5 seconds.

Read from a `.env` at the repo root (via `python-dotenv`) or the real environment.

---

## `JENGA_OFFLINE`

**The demo switch.** Set to `1` (or `true`/`yes`/`on`) to force every external
call onto its canned fallback. No network traffic is attempted at all.

- **Set:** GPTZero, vision and Backboard are skipped; each node answers from the
  matching `expected` block in `data/mock_evidence.json`. The arbiter still runs
  its real decision logic over those values — the status is genuinely derived,
  not replayed.
- **Absent:** live calls are attempted, each one falling back individually on
  failure or timeout.

Run the demo with this on unless the wifi has been tested in the room.

```bash
JENGA_OFFLINE=1 python test_agent.py
```

---

## `GPTZERO_API_KEY`

AI-authorship scoring for the written report.
`POST https://api.gptzero.me/v2/predict/text`, sent as an `x-api-key` header.

- **Where:** https://gptzero.me → Dashboard → API. Free tier is enough for a demo.
- **Absent / invalid / times out:** falls back to the canned `expected.gptzero`
  block for the task, logging a warning. The 0.85 gate still applies to the
  fallback value, so SUB-02's AI-written report is still caught offline.

---

## `OPENAI_API_KEY`

Multimodal image-vs-spec comparison. Preferred over Gemini when both are set.
Uses `gpt-4o` with `response_format={"type": "json_object"}`.

- **Where:** https://platform.openai.com/api-keys
- **Absent:** the vision node tries Gemini next.

## `GOOGLE_API_KEY`

Gemini fallback for the same comparison (`gemini-2.0-flash`, JSON response mime type).

- **Where:** https://aistudio.google.com/apikey
- **Absent (and no OpenAI key):** vision falls back to the canned
  `expected.vision` block plus `expected.confidence`.

## `JENGA_VISION_MODEL`

Overrides the vision model id for whichever provider is selected.
Defaults to `gpt-4o` (OpenAI) or `gemini-2.0-flash` (Gemini).

> If **no** image is supplied at all, no provider is called: the vision node
> returns `insufficient: true` at confidence `0.0`, and the arbiter holds the
> package for re-inspection. That is the intended behaviour, not a failure.

---

## `BACKBOARD_API_KEY` and `BACKBOARD_ASSISTANT_ID`

Historical work-package retrieval — the fourth evidence column — against
Backboard.io (the sponsor track: one API for RAG, embeddings and memory).

```
POST https://app.backboard.io/api/assistants/{assistant_id}/memories/search
X-API-Key: <BACKBOARD_API_KEY>
{"query": "...", "limit": 3}
```

- **Where:** https://app.backboard.io → API keys. The assistant id is the
  assistant whose memories hold the historical package corpus.
- **Both absent, either absent, or the call fails:** falls back to `LOCAL_CORPUS`
  in `backend/integrations/memory.py`, a hand-written set of slip statistics
  bucketed by work type (pour, rebar, formwork, excavation, subgrade). The
  evidence column is populated either way.

> **Before the live path is useful,** the corpus in `memory.py` has to be ingested
> into that assistant's memories — searching an empty assistant returns nothing
> and we would silently show a blank column. Until then the module answers from
> the local corpus even when a key is present. See the `TODO(backboard)` in
> `memory.py`.

## `BACKBOARD_BASE_URL`

Overrides the Backboard base URL. Defaults to `https://app.backboard.io/api`.

---

## Zip (purchase orders) — no key, mocked by design

`backend/integrations/zip_api.py` makes **no network call**.
`update_purchase_order()` mutates the in-memory copy of
`data/seed_tasks.json["purchase_orders"]` loaded at import and returns the
updated PO with `status: "rescheduled"`. The file on disk is never written, so
repeated demo runs always start from the same state.

---

## Quick reference

| Variable | Needed for | If absent |
|---|---|---|
| `JENGA_OFFLINE` | forcing canned mode | live calls attempted |
| `GPTZERO_API_KEY` | AI-authorship score | canned `expected.gptzero` |
| `OPENAI_API_KEY` | vision (preferred) | tries Gemini |
| `GOOGLE_API_KEY` | vision (fallback) | canned `expected.vision` |
| `JENGA_VISION_MODEL` | model override | provider default |
| `BACKBOARD_API_KEY` | historical retrieval | local corpus |
| `BACKBOARD_ASSISTANT_ID` | historical retrieval | local corpus |
| `BACKBOARD_BASE_URL` | non-default host | `https://app.backboard.io/api` |
| — | Zip PO updates | always mocked, no key exists |
