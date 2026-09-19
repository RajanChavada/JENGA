"""User-triggered procurement agent: proposed work packages -> a real Zip PO.

The flow the user sees: upload a blueprint, review the proposed work packages,
press "Create procurement via agent". This module is the agent behind that
button. It runs the same tool sequence the official ziphq-mcp server exposes —
`zip_search_vendors` -> `zip_create_purchase_order` ->
`zip_add_purchase_order_line_items` -> read-back — executed through the direct
REST client in `integrations.zip_api` rather than an MCP subprocess, so the
backend has no extra process to babysit and the demo has one fewer moving part.

JENGA's one-fallback rule applies twice, independently:

- the bill of materials is LLM-drafted when an OpenAI key is present
  (`_llm_items`) and read off a keyword catalog otherwise (`_heuristic_items`);
- the write is live on Zip staging when `ZIP_API_KEY` is set, and degrades to a
  purchase order on the local ledger when it is not — or when staging refuses —
  so the button always resolves to something honest.

Every step lands in `steps` using the verification trace's shape (node/title/
detail/signal), so the frontend shows the agent's reasoning, not just its
conclusion.
"""

from __future__ import annotations

import datetime as _dt
import json
import os
import uuid

from integrations import log
from integrations import zip_api

#: keywords -> (description, unit, unit rate, qty per duration day, minimum qty).
#: Rates are order-of-magnitude estimates for the demo ledger, not quotes.
_CATALOG: list[tuple[tuple[str, ...], str, str, float, float, float]] = [
    (("concrete", "pour", "slab", "cast"), "Ready-mix concrete 35 MPa", "m³", 185.0, 12.0, 10.0),
    (("rebar", "reinforc"), "Rebar 15M deformed bar", "tonne", 1450.0, 0.8, 2.0),
    # "formwork"/"form release", not bare "form" — every *platform* task would match.
    (("formwork", "form release", "shutter"), "Formwork panels and release agent", "m²", 38.0, 25.0, 40.0),
    (
        ("excavat", "backfill", "subgrade", "grading", "aggregate", "granular"),
        "Granular A aggregate", "tonne", 32.0, 15.0, 20.0,
    ),
    (("track", "rail", "fasten"), "Direct-fixation rail fasteners", "unit", 96.0, 20.0, 50.0),
    (
        ("escalator", "mezzanine", "fit-out", "fare gate"),
        "Structural steel embeds and anchors", "unit", 210.0, 4.0, 8.0,
    ),
]


def _heuristic_items(packages: list[dict]) -> list[dict]:
    """Deterministic bill of materials from the packages' vocabulary.

    One line item per matched material, quantities summed across packages and
    scaled by duration. A package that matches nothing still procures: the
    generic lot line keeps "agent pressed, nothing happened" impossible.
    """
    items: dict[str, dict] = {}
    for pkg in packages:
        text = f"{pkg.get('name', '')} {pkg.get('spec_text', '')}".lower()
        days = int(pkg.get("duration_days") or 5)
        for keys, desc, unit, rate, per_day, floor in _CATALOG:
            if not any(k in text for k in keys):
                continue
            row = items.setdefault(
                desc,
                {"description": f"{desc} ({unit})", "rate": rate, "quantity": 0.0, "for": []},
            )
            row["quantity"] += max(floor, per_day * days)
            row["for"].append(str(pkg.get("name") or "package"))
    if not items:
        items["lot"] = {
            "description": "General site materials package (lot)",
            "rate": 500.0,
            "quantity": 1.0,
            "for": [str(p.get("name") or "package") for p in packages],
        }
    out = []
    for row in items.values():
        pkgs = row.pop("for")
        row["quantity"] = round(row["quantity"], 1)
        row["description"] = f"{row['description']} — for {', '.join(pkgs[:3])}"[:200]
        out.append(row)
    return out


async def _llm_items(packages: list[dict]) -> list[dict] | None:
    """Model-drafted bill of materials. None on any failure or when offline."""
    if os.getenv("JENGA_OFFLINE") == "1" or not os.getenv("OPENAI_API_KEY"):
        return None
    try:
        from openai import AsyncOpenAI
    except Exception:
        return None

    listing = "\n".join(
        f"- {p.get('name')} ({p.get('duration_days')}d): {p.get('spec_text', '')[:200]}"
        for p in packages
    )
    prompt = f"""You are a construction procurement agent. Draft the bill of materials
to purchase for these work packages on a transit station build.

Return JSON only: {{"items": [{{"description": "material (unit)", "quantity": 1.0, "rate": 100.0}}]}}
Rules: at most 6 items, realistic units and rates, no duplicates.

WORK PACKAGES:
{listing}"""
    try:
        client = AsyncOpenAI(timeout=8)
        resp = await client.chat.completions.create(
            model=os.getenv("JENGA_DOC_MODEL", "gpt-4o-mini"),
            response_format={"type": "json_object"},
            max_tokens=600,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = json.loads(resp.choices[0].message.content or "{}").get("items") or []
        items = [
            {
                "description": str(i.get("description"))[:200],
                "quantity": round(max(0.1, float(i.get("quantity", 1))), 1),
                "rate": round(max(0.01, float(i.get("rate", 1))), 2),
            }
            for i in raw[:6]
            if i.get("description")
        ]
        return items or None
    except Exception as exc:
        log.warning("procurement: llm plan failed (%s); using catalog", exc)
        return None


def _step(node: str, title: str, detail: str, signal: str = "info") -> dict:
    return {"node": node, "title": title, "detail": detail, "signal": signal}


async def _create_live(
    po_number: str, items: list[dict], need_by: str, origin: str, steps: list[dict]
) -> dict | None:
    """The live path: vendor -> create -> line items -> read-back.

    Appends its trace to `steps` as it goes. Returns the response payload, or
    None if staging refused — the caller then runs the one local fallback.
    """
    vendors = await zip_api.fetch_vendors()
    if not vendors:
        steps.append(_step(
            "vendor", "No vendor available on Zip staging",
            "GET /vendors returned nothing usable, so there is no one to raise the PO against.",
            "warn",
        ))
        return None
    vendor = vendors[0]
    currency = str(vendor.get("currency") or "USD")
    steps.append(_step(
        "vendor", f"Vendor selected: {vendor['name']}",
        f"Picked from {len(vendors)} vendor{'s' if len(vendors) != 1 else ''} on the staging tenant · currency {currency}.",
        "ok",
    ))

    created = await zip_api.create_purchase_order(vendor["id"], currency, po_number)
    if not created or not created.get("id"):
        steps.append(_step(
            "create", "Zip refused the purchase order",
            "POST /purchase_orders did not return an id; falling back to the local ledger.",
            "bad",
        ))
        return None
    po_id = str(created["id"])
    steps.append(_step(
        "create", f"Purchase order {po_number} created on Zip staging",
        f"POST /purchase_orders → id {po_id}.", "ok",
    ))

    # rate and quantity must be *strings* — staging 400s on a numeric quantity.
    line_payload = [
        {
            "line_type": 0,
            "rate": f"{i['rate']:.2f}",
            "quantity": f"{i['quantity']:g}",
            "description": i["description"],
        }
        for i in items
    ]
    lined = await zip_api.add_purchase_order_line_items(po_id, line_payload)
    steps.append(
        _step(
            "line_items",
            f"{len(items)} line item{'s' if len(items) != 1 else ''} attached",
            "POST /purchase_orders/{id}/line_items accepted the bill of materials.",
            "ok",
        )
        if lined is not None
        else _step(
            "line_items", "Line items were not accepted",
            "The purchase order exists on Zip without its lines; attach them in the Zip UI.",
            "warn",
        )
    )

    confirmed = await zip_api.fetch_purchase_order(po_id)
    number = str((confirmed or created).get("number") or po_number)
    steps.append(
        _step(
            "confirm", f"Confirmed on Zip: {number}",
            f"GET /purchase_orders/{po_id} read the order back from staging.", "ok",
        )
        if confirmed
        else _step(
            "confirm", "Created, read-back inconclusive",
            f"The create returned id {po_id} but the confirming GET did not answer.", "info",
        )
    )

    material = ", ".join(i["description"].split(" — ")[0] for i in items)[:120]
    return {
        "ok": True,
        "live": True,
        "po_id": po_id,
        "po_number": number,
        "vendor": vendor["name"],
        "detail": (
            f"Purchase order {number} created live on Zip staging "
            f"({len(items)} line item{'s' if len(items) != 1 else ''}, vendor {vendor['name']})."
        ),
        "steps": steps,
        "purchase_order": {
            "id": number,
            "material": material,
            "quantity": f"{len(items)} line item{'s' if len(items) != 1 else ''}",
            "vendor": vendor["name"],
            "delivery_date": need_by,
            "status": "confirmed",
            "linked_task": "",
            "last_action": f"Created by the procurement agent{origin} · Zip id {po_id}",
        },
    }


async def run(packages: list[dict], filename: str | None = None) -> dict:
    """The whole agent loop. Always returns a resolved result; never raises."""
    steps: list[dict] = []
    origin = f" from {filename}" if filename else ""

    items = await _llm_items(packages)
    planner = "model-drafted" if items else "catalog"
    if not items:
        items = _heuristic_items(packages)
    est_total = sum(i["quantity"] * i["rate"] for i in items)
    steps.append(_step(
        "plan",
        f"Planned {len(items)} line item{'s' if len(items) != 1 else ''} "
        f"for {len(packages)} work package{'s' if len(packages) != 1 else ''}",
        ("; ".join(
            f"{i['quantity']:g} × {i['description'].split(' — ')[0]}" for i in items
        ))[:280] + f" · est ${est_total:,.0f} ({planner}).",
    ))

    need_by = (_dt.date.today() + _dt.timedelta(days=7)).isoformat()
    po_number = f"JENGA-{uuid.uuid4().hex[:6].upper()}"

    if zip_api.zip_live():
        result = await _create_live(po_number, items, need_by, origin, steps)
        if result:
            return result
        detail = (
            f"Zip staging refused the write — purchase order {po_number} recorded "
            "on the local ledger instead."
        )
    else:
        detail = (
            f"Zip API key not set — purchase order {po_number} recorded on the "
            "local ledger only."
        )

    # The one fallback: the same PO lands on JENGA's own ledger, honestly labelled.
    steps.append(_step("create", "Local ledger fallback", detail, "warn"))
    material = ", ".join(i["description"].split(" — ")[0] for i in items)[:120]
    return {
        "ok": True,
        "live": False,
        "po_id": None,
        "po_number": po_number,
        "vendor": "Pending vendor assignment",
        "detail": detail,
        "steps": steps,
        "purchase_order": {
            "id": po_number,
            "material": material,
            "quantity": f"{len(items)} line item{'s' if len(items) != 1 else ''}",
            "vendor": "Pending vendor assignment",
            "delivery_date": need_by,
            "status": "draft",
            "linked_task": "",
            "last_action": f"Drafted by the procurement agent{origin} (local only).",
        },
    }
