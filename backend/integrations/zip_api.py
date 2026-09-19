"""Zip (ziphq.com) procurement actions.

`detect_material_shortage` reads a contractor's report or voice transcript and
decides whether a purchase order needs expediting.

`expedite_purchase_order` is the live integration: when `ZIP_API_KEY` is set it
calls the real Zip Procurement API (staging base `https://staging-api.zip.com`,
`Zip-Api-Key` header). Purchase orders on the staging tenant are read-only once
created (`Allow: GET, HEAD, OPTIONS` — changes flow through intake workflows),
so an expedite POSTs a *new* PO whose description carries the local PO number,
the material and the pulled-in date. That PO is visible in the tenant's Zip UI,
which is the point: a real artifact, not a log line. Payloads are wrapped in
`{"data": ...}` and collections come back as `{"list": [...]}`. Without a key —
or if the call fails or times out — it degrades to the in-memory mock, matching
JENGA's one-fallback-per-integration rule so the demo never breaks.

`update_purchase_order` remains a pure in-memory mock used by the test suite.
"""

from __future__ import annotations

import asyncio
import datetime as _dt
import os
import re

import httpx

from . import SEED, log, safe_call

PURCHASE_ORDERS: list[dict] = SEED.get("purchase_orders", [])

# --- live Zip Procurement API config ---------------------------------------
# Defaults target the HTN workshop staging environment. `ZIP_API_URL` matches
# the env var name the official ziphq-mcp package uses; `ZIP_API_BASE` is kept
# as an alias for older configs.
ZIP_BASE = (
    os.getenv("ZIP_API_URL")
    or os.getenv("ZIP_API_BASE")
    or "https://staging-api.zip.com"
).rstrip("/")
ZIP_KEY = os.getenv("ZIP_API_KEY")
#: API version header the official ziphq-mcp client pins on every call.
ZIP_API_VERSION = os.getenv("ZIP_API_VERSION", "2024-06-06")
#: Collection path for purchase orders. Expedite = PATCH `{ZIP_PO_PATH}/{id}`.
ZIP_PO_PATH = os.getenv("ZIP_PO_PATH", "/purchase_orders")
#: Path for intake requests (used only for reads today).
ZIP_REQUESTS_PATH = os.getenv("ZIP_REQUESTS_PATH", "/requests")


def zip_live() -> bool:
    """True when a Zip API key is configured (live integration is possible)."""
    return bool(ZIP_KEY)


def _headers() -> dict[str, str]:
    return {
        "Zip-Api-Key": ZIP_KEY or "",
        "Zip-Api-Version": ZIP_API_VERSION,
        "Content-Type": "application/json",
    }


def _map_po(raw: dict) -> dict:
    """Best-effort map a Zip PO payload onto JENGA's PurchaseOrder shape."""
    return {
        "id": str(raw.get("po_number") or raw.get("number") or raw.get("id") or "PO-?"),
        "material": str(raw.get("description") or raw.get("title") or raw.get("name") or "material"),
        "quantity": str(raw.get("quantity") or raw.get("line_item_count") or ""),
        "vendor": str((raw.get("vendor") or {}).get("name") if isinstance(raw.get("vendor"), dict) else raw.get("vendor") or "vendor"),
        "delivery_date": str(raw.get("delivery_date") or raw.get("need_by_date") or ""),
        "status": "confirmed",
        "linked_task": "",
        "last_action": None,
    }


async def fetch_purchase_orders() -> list[dict] | None:
    """Live-read purchase orders from Zip. Returns None when no key is set."""
    if not ZIP_KEY:
        return None

    async def _go():
        async with httpx.AsyncClient(timeout=5) as client:
            res = await client.get(
                f"{ZIP_BASE}{ZIP_PO_PATH}",
                params={"page_size": 100},
                headers=_headers(),
            )
            res.raise_for_status()
            payload = res.json()
            # Zip staging wraps collections as {"list": [...], "size", "total"};
            # the aliases cover older/other tenant shapes.
            items = (
                payload.get("list")
                or payload.get("data")
                or payload.get("purchase_orders")
                or payload.get("results")
                or []
            )
            return [_map_po(p) for p in items]

    return await safe_call("zip.fetch_purchase_orders", _go, None)


def _unwrap(payload: dict) -> dict:
    """Zip write responses sometimes envelope the entity as `{"data": {...}}`."""
    inner = payload.get("data")
    return inner if isinstance(inner, dict) else payload


async def _live_call(label: str, make_coro, fallback):
    """`safe_call` without the JENGA_OFFLINE gate, for the procurement agent.

    JENGA_OFFLINE keeps the demo's *read* paths on canned data so dead wifi
    never blanks a panel. The agent's procurement write is different: it is an
    explicit user action against a key the operator deliberately configured,
    and short-circuiting it to the mock under the offline flag would report a
    "created" PO that exists nowhere. Same discipline otherwise — one timeout,
    one try/except, one fallback, never raises.
    """
    try:
        return await asyncio.wait_for(make_coro(), timeout=10)
    except Exception as exc:
        log.warning(
            "%s: call failed (%s: %s), using fallback", label, type(exc).__name__, exc
        )
        return fallback


async def fetch_vendors() -> list[dict] | None:
    """Live-read vendors (`GET /vendors` — ziphq-mcp's `zip_search_vendors`).

    Returns `[{id, name, currency}]`, or None when no key is set / the call fails.
    """
    if not ZIP_KEY:
        return None

    async def _go():
        async with httpx.AsyncClient(timeout=8) as client:
            res = await client.get(
                f"{ZIP_BASE}/vendors", params={"page_size": 100}, headers=_headers()
            )
            res.raise_for_status()
            payload = res.json()
            items = payload.get("list") or payload.get("data") or payload.get("vendors") or []
            return [
                {
                    "id": str(v.get("id")),
                    "name": str(v.get("name") or "vendor"),
                    "currency": v.get("currency"),
                }
                for v in items
                if v.get("id")
            ]

    return await _live_call("zip.fetch_vendors", _go, None)


async def create_purchase_order(
    vendor_id: str, currency: str, po_number: str | None = None
) -> dict | None:
    """Create a PO live on Zip — the operation ziphq-mcp's `zip_create_purchase_order` wraps.

    `POST {ZIP_PO_PATH}` with the `{"data": {...}}` envelope the official client
    sends. Returns the created PO body (must carry an `id`) or None. Never raises.
    """
    if not ZIP_KEY:
        return None

    async def _go():
        data: dict = {"vendor_id": vendor_id, "currency": currency}
        if po_number:
            data["po_number"] = po_number
        async with httpx.AsyncClient(timeout=8) as client:
            res = await client.post(
                f"{ZIP_BASE}{ZIP_PO_PATH}", json={"data": data}, headers=_headers()
            )
            res.raise_for_status()
            body = _unwrap(res.json() if res.content else {})
            log.warning("zip: LIVE created PO %s", body.get("id") or po_number)
            return body

    return await _live_call("zip.create_purchase_order", _go, None)


async def add_purchase_order_line_items(po_id: str, items: list[dict]) -> dict | None:
    """Attach line items to a PO (ziphq-mcp's `zip_add_purchase_order_line_items`).

    Each item requires `line_type` (0=item) and `rate` (string number); quantity
    and description are optional per the tool schema. Returns the response body
    or None on failure — the PO already exists either way.
    """
    if not ZIP_KEY:
        return None

    async def _go():
        async with httpx.AsyncClient(timeout=8) as client:
            res = await client.post(
                f"{ZIP_BASE}{ZIP_PO_PATH}/{po_id}/line_items",
                json={"data": items},
                headers=_headers(),
            )
            res.raise_for_status()
            return res.json() if res.content else {}

    return await _live_call("zip.add_po_line_items", _go, None)


async def fetch_purchase_order(po_id: str) -> dict | None:
    """Read one PO back (`GET {ZIP_PO_PATH}/{id}`) to confirm a write landed."""
    if not ZIP_KEY:
        return None

    async def _go():
        async with httpx.AsyncClient(timeout=8) as client:
            res = await client.get(f"{ZIP_BASE}{ZIP_PO_PATH}/{po_id}", headers=_headers())
            res.raise_for_status()
            return _unwrap(res.json())

    return await _live_call("zip.fetch_purchase_order", _go, None)


async def _first_vendor_id(client: httpx.AsyncClient) -> str | None:
    """The staging tenant ships with one demo vendor; resolve its id live."""
    res = await client.get(
        f"{ZIP_BASE}/vendors", params={"page_size": 1}, headers=_headers()
    )
    res.raise_for_status()
    vendors = res.json().get("list") or []
    return str(vendors[0]["id"]) if vendors else None


async def expedite_purchase_order(po_id: str, new_delivery_date: str, reason: str) -> dict:
    """Expedite `po_id` live on Zip, or mock it.

    POs on the staging tenant are immutable via the API, so "expedite" raises a
    *new* Zip PO carrying the local PO number, material and pulled-in date in
    its description — a real object a judge can open in the Zip UI. Returns
    `{ok, live, detail}`; `live` is True only when Zip accepted the create.
    Never raises.
    """
    if not ZIP_KEY:
        return {
            "ok": True,
            "live": False,
            "detail": "Zip API key not set — expedite applied to local mirror only.",
        }

    local = next((p for p in PURCHASE_ORDERS if p.get("id") == po_id), None)
    material = (local or {}).get("material", "material")

    async def _go():
        async with httpx.AsyncClient(timeout=4) as client:
            vendor_id = await _first_vendor_id(client)
            if vendor_id is None:
                raise RuntimeError("no vendor in Zip tenant")
            payload = {
                "data": {
                    "currency": "CAD",
                    "vendor_id": vendor_id,
                    "description": (
                        f"EXPEDITE {po_id} — {material} — need by {new_delivery_date}. {reason}"
                    )[:500],
                }
            }
            res = await client.post(
                f"{ZIP_BASE}{ZIP_PO_PATH}", json=payload, headers=_headers()
            )
            res.raise_for_status()
            body = res.json() if res.content else {}
            ref = str(body.get("id") or "created")
            log.warning("zip: LIVE expedite PO %s raised for %s -> %s", ref, po_id, new_delivery_date)
            return {
                "ok": True,
                "live": True,
                "detail": f"Zip PO {ref[:8]}… raised on staging to expedite {po_id} → {new_delivery_date}.",
            }

    return await safe_call(
        "zip.expedite_purchase_order",
        _go,
        {"ok": True, "live": False, "detail": "Zip expedite call failed — local mirror updated instead."},
    )

#: Contractor vocabulary -> a token that appears in the PO's `material` field.
_MATERIALS: list[tuple[tuple[str, ...], str]] = [
    (("gravel", "aggregate", "granular", "crushed stone"), "aggregate"),
    (("rebar", "reinforcing steel", "reinforcement bar"), "rebar"),
    (("form release", "release agent", "form oil"), "release"),
    (("concrete", "cement", "ready-mix", "ready mix"), "concrete"),
]

_SHORTAGE = (
    "short on", "low on", "running low", "run out", "ran out", "out of",
    "shortage", "depleted", "didn't show", "did not show", "never showed",
    "no delivery", "missed delivery", "delivery slipped", "dead in the water",
    "more ordered", "need more", "need about", "need another", "need 2", "need 5",
)

_QUANTITY_NEED = re.compile(r"\bneed(?:s|ed)?\b[^.]{0,40}?\b\d", re.I)


def _find_po(material_token: str) -> dict | None:
    for po in PURCHASE_ORDERS:
        if material_token in str(po.get("material", "")).lower():
            return po
    return None


async def detect_material_shortage(text: str) -> dict | None:
    """Parse a report/transcript for a material shortage.

    Returns `{po_id, action, new_delivery_date, reason}`, or None if the text
    does not describe a shortage. Matching is scoped to a single sentence so a
    material mentioned in one place and the word "need" in another do not
    combine into a false positive.
    """
    if not text or not text.strip():
        return None

    for sentence in re.split(r"(?<=[.!?])\s+|\n+", text):
        low = sentence.lower()
        if not (any(p in low for p in _SHORTAGE) or _QUANTITY_NEED.search(low)):
            continue
        for aliases, token in _MATERIALS:
            if not any(a in low for a in aliases):
                continue
            po = _find_po(token)
            if not po:
                log.warning("zip: no purchase order found for material token %r", token)
                continue
            return {
                "po_id": po["id"],
                "action": "expedite",
                "new_delivery_date": (_dt.date.today() + _dt.timedelta(days=1)).isoformat(),
                "reason": sentence.strip(),
            }
    return None


def update_purchase_order(po_id: str, new_delivery_date: str, reason: str) -> dict | None:
    """Mock Zip write. Mutates the in-memory PO and returns it."""
    po = next((p for p in PURCHASE_ORDERS if p.get("id") == po_id), None)
    if po is None:
        log.warning("zip: unknown purchase order %r", po_id)
        return None
    po["delivery_date"] = new_delivery_date
    po["status"] = "rescheduled"
    po["last_action"] = reason
    log.warning("zip: MOCK expedite %s -> %s (%s)", po_id, new_delivery_date, reason)
    return po
