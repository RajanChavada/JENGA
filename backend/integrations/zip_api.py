"""Zip purchase-order actions.

`detect_material_shortage` reads a contractor's report or voice transcript and
decides whether a purchase order needs expediting.

`update_purchase_order` is a deliberate mock: it mutates the in-memory copy of
`data/seed_tasks.json` loaded at import and returns the updated PO. Nothing is
written to disk and no Zip endpoint is called — that is by design for the demo.
"""

from __future__ import annotations

import datetime as _dt
import re

from . import SEED, log

PURCHASE_ORDERS: list[dict] = SEED.get("purchase_orders", [])

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
