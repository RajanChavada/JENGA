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

Multimodal image-vs-spec comparison for **photo** evidence only — there is no
OpenAI video path. Used only when `GOOGLE_API_KEY` is absent (see below).
Uses `gpt-4o` with `response_format={"type": "json_object"}`.

- **Where:** https://platform.openai.com/api-keys
- **Absent, and no Gemini key either:** vision falls back to the canned
  `expected.vision` block plus `expected.confidence`.

Also used by `documents.py` to propose work packages from uploaded PDF/DOCX/TXT/MD specs.
If absent, document upload falls back to deterministic extraction and marks the result
`source: "offline"`.

## `JENGA_DOC_MODEL`

Optional model override for document/package extraction. Defaults to `gpt-4o-mini`.

## `GOOGLE_API_KEY`

Gemini, preferred over OpenAI when both are set (`gemini-2.0-flash` for
photos, JSON response mime type) — the only provider for **video** evidence,
via the Files API (`POST /api/tasks/{id}/video-evidence`).

- **Where:** https://aistudio.google.com/apikey
- **Absent:** photo evidence tries OpenAI next; video evidence has no
  fallback provider and goes straight to the canned finding (see
  `JENGA_VIDEO_MODEL` below).

## `JENGA_VISION_MODEL`

Overrides the vision model id for whichever provider is selected.
Defaults to `gpt-4o` (OpenAI) or `gemini-2.0-flash` (Gemini).

> If **no** image is supplied at all, no provider is called: the vision node
> returns `insufficient: true` at confidence `0.0`, and the arbiter holds the
> package for re-inspection. That is the intended behaviour, not a failure.

## `JENGA_VIDEO_MODEL`

Overrides the model id used for video evidence (`POST
/api/tasks/{id}/video-evidence`). Defaults to `gemini-flash-latest`. Video is
Gemini-only — there is no OpenAI fallback path for it — so this only takes
effect when `GOOGLE_API_KEY` is set.

- **Absent `GOOGLE_API_KEY`:** the endpoint still saves the upload and
  returns the same canned fixture finding the photo path falls back to,
  rather than failing the submission; the clip is still there for the owner
  to watch even without a real analysis.

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

## Zip (procurement) — `ZIP_API_KEY`

Live integration with the **Zip Procurement API**, defaulting to the HTN
**staging** environment (`https://staging-api.zip.com`).

When a material shortage is detected in a field report, `verify` calls
`zip_api.expedite_purchase_order()`. POs on the staging tenant are immutable
via the API (`Allow: GET, HEAD, OPTIONS`), so the expedite raises a **new** PO
carrying the local PO number, material and pulled-in date — a real object you
can open in the tenant's Zip UI. Payloads are `{"data": ...}`-wrapped and
collections come back as `{"list": [...]}`:

```
POST https://staging-api.zip.com/purchase_orders
Zip-Api-Key: <ZIP_API_KEY>
{"data": {"currency": "CAD", "vendor_id": "<resolved live>",
          "description": "EXPEDITE <PO> — <material> — need by <date>. <reason>"}}
```

- **Get a key:** ping `#spons-zip-2026` for a domain, then create a standard API
  key at `{your-domain}/manage/api-key`.
- **Set it (backend shell, do not commit):**
  ```
  export ZIP_API_KEY=<your-key>
  # base + header default to staging already; override only if needed:
  # export ZIP_API_URL=https://staging-api.zip.com
  ```
- **Absent, fails, or times out:** falls back to the in-memory PO mirror in
  `data/seed_tasks.json["purchase_orders"]` (status → `rescheduled`), so the
  demo always shows the expedite. `GET /api/zip/status` reports `{live: bool}`
  and the resolved base URL without ever returning the key.

### Optional overrides

| Variable | Default | Purpose |
|---|---|---|
| `ZIP_API_URL` | `https://staging-api.zip.com` | API host (matches ziphq-mcp) |
| `ZIP_API_BASE` | — | legacy alias for `ZIP_API_URL` |
| `ZIP_PO_PATH` | `/purchase_orders` | PO collection (expedite = PATCH `.../{id}`) |
| `ZIP_REQUESTS_PATH` | `/requests` | intake requests (reads) |

> `zip_api.update_purchase_order()` remains a pure in-memory mock, used only by
> the test suite; the file on disk is never written, so repeated demo runs start
> from the same state.

---

## `BROWSERBASE_API_KEY`

Macro-level construction heatmap scraping. `/api/hotzones` uses Browserbase Fetch:

```
POST https://api.browserbase.com/v1/fetch
X-BB-API-Key: <BROWSERBASE_API_KEY>
{"url": "...", "allowRedirects": true}
```

- **Where:** https://browserbase.com/settings
- **Absent or `JENGA_OFFLINE=1`:** returns seeded Toronto construction hotzones so the
  macro map and Eglinton West drilldown still demo without network.

---

## Quick reference

| Variable | Needed for | If absent |
|---|---|---|
| `JENGA_OFFLINE` | forcing canned mode | live calls attempted |
| `GPTZERO_API_KEY` | AI-authorship score | canned `expected.gptzero` |
| `GOOGLE_API_KEY` | vision + video (preferred) | tries OpenAI, photo only |
| `JENGA_DOC_MODEL` | document extraction model | `gpt-4o-mini` |
| `OPENAI_API_KEY` | vision fallback (photo only; no video path) | canned `expected.vision` |
| `JENGA_VISION_MODEL` | photo model override | provider default |
| `JENGA_VIDEO_MODEL` | video model override | `gemini-flash-latest` |
| `BACKBOARD_API_KEY` | historical retrieval | local corpus |
| `BACKBOARD_ASSISTANT_ID` | historical retrieval | local corpus |
| `BACKBOARD_BASE_URL` | non-default host | `https://app.backboard.io/api` |
| `BROWSERBASE_API_KEY` | live macro hotzone scraping | seeded Toronto hotzones |
| — | Zip PO updates | always mocked, no key exists |
