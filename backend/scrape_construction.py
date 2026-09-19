"""
Browserbase + Stagehand scraping script for JENGA macro heatmap.

Pulls live construction permits / road restrictions from the City of Toronto
portal and outputs a JSON feed of geospatial hotzones. When BROWSERBASE_API_KEY
and BROWSERBASE_PROJECT_ID are set, it runs a headless browser session through
Browserbase. Otherwise, it exits with seeded demo data.

Usage:
    python3 scrape_construction.py              # writes hotzones.json
    python3 scrape_construction.py --stdout      # prints JSON to stdout
"""

import asyncio
import json
import os
import sys
from datetime import datetime, timezone

# ---------------------------------------------------------------------------
# Seeded fallback — always available, no network required
# ---------------------------------------------------------------------------

SEED_HOTZONES = [
    {
        "id": "eglinton-west",
        "name": "Eglinton West Station",
        "lat": 43.6902,
        "lng": -79.4353,
        "severity": "high",
        "project": "Eglinton Crosstown West Extension",
        "source": "offline demo seed",
        "summary": "Station box and guideway tie-in. Multimodal audit triggered. Critical path slip on south platform pour.",
        "linked_site_id": "eglinton-west",
    },
    {
        "id": "dufferin-eglinton",
        "name": "Dufferin & Eglinton",
        "lat": 43.6981,
        "lng": -79.4462,
        "severity": "medium",
        "project": "Eglinton Crosstown West Extension",
        "source": "offline demo seed",
        "summary": "Lane restrictions and structural slab pour. Utility coordination with Toronto Hydro in progress.",
        "linked_site_id": None,
    },
    {
        "id": "mount-dennis",
        "name": "Mount Dennis Portal",
        "lat": 43.6825,
        "lng": -79.4901,
        "severity": "medium",
        "project": "Eglinton Crosstown West Extension",
        "source": "offline demo seed",
        "summary": "Critical path slip on guideway wiring. Contractor claims 90% complete but visual inspection pending.",
        "linked_site_id": None,
    },
    {
        "id": "queen-yonge",
        "name": "Queen & Yonge",
        "lat": 43.6525,
        "lng": -79.3792,
        "severity": "low",
        "project": "Yonge-University TTC station renewal",
        "source": "offline demo seed",
        "summary": "Short-duration closures and utility coordination in a dense pedestrian corridor.",
        "linked_site_id": None,
    },
    {
        "id": "finch-west",
        "name": "Finch West LRT – Humber College",
        "lat": 43.7285,
        "lng": -79.6073,
        "severity": "medium",
        "project": "Finch West LRT",
        "source": "offline demo seed",
        "summary": "Guideway paving near Humber College terminal. Track alignment verification in progress.",
        "linked_site_id": None,
    },
    {
        "id": "scarborough-srt",
        "name": "Scarborough Subway Extension",
        "lat": 43.7735,
        "lng": -79.2580,
        "severity": "high",
        "project": "Scarborough Subway Extension",
        "source": "offline demo seed",
        "summary": "Tunnel boring machine staging area. Deep excavation permit under review.",
        "linked_site_id": None,
    },
]


def _make_response(hotzones: list, source: str, notes: str) -> dict:
    now = datetime.now(timezone.utc).isoformat()
    for h in hotzones:
        h.setdefault("updated_at", now)
    return {
        "source": source,
        "generated_at": now,
        "notes": notes,
        "hotzones": hotzones,
    }


# ---------------------------------------------------------------------------
# Browserbase + Stagehand live scraping
# ---------------------------------------------------------------------------

async def scrape_toronto_construction() -> dict:
    """Use Stagehand via Browserbase to scrape live construction data."""
    try:
        from stagehand import Stagehand
    except ImportError:
        print("[scrape] stagehand not installed; pip install stagehand", file=sys.stderr)
        return _make_response(SEED_HOTZONES, "offline", "Stagehand not installed.")

    api_key = os.environ.get("BROWSERBASE_API_KEY")
    project_id = os.environ.get("BROWSERBASE_PROJECT_ID")

    if not api_key or not project_id:
        print("[scrape] BROWSERBASE_API_KEY / BROWSERBASE_PROJECT_ID not set", file=sys.stderr)
        return _make_response(SEED_HOTZONES, "offline", "Browserbase keys not set.")

    stagehand = Stagehand(
        api_key=api_key,
        project_id=project_id,
        headless=True,
    )

    try:
        await stagehand.init()
        page = stagehand.page

        # Target Toronto's public road restrictions / active construction portal
        await page.goto(
            "https://www.toronto.ca/services-payments/streets-parking-transportation/"
            "road-restrictions-background/"
        )

        # Use Stagehand's LLM-backed extraction to pull structured construction data
        data = await page.extract({
            "instruction": (
                "Extract all active transit and LRT construction zones visible on this page. "
                "For each zone, provide the project name, approximate latitude and longitude "
                "in the Greater Toronto Area, current status (Active, Delayed, or Disputed), "
                "and a one-sentence summary of the restriction or construction activity."
            ),
            "schema": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string"},
                        "lat": {"type": "number"},
                        "lng": {"type": "number"},
                        "status": {"type": "string"},
                        "project": {"type": "string"},
                        "details": {"type": "string"},
                    },
                },
            },
        })

        print(f"[scrape] extracted {len(data)} hotzones from Toronto portal", file=sys.stderr)

        # Normalise Stagehand output into JENGA hotzone format
        severity_map = {"delayed": "high", "disputed": "high", "active": "medium"}
        hotzones = []
        for i, item in enumerate(data or []):
            status = (item.get("status") or "active").lower()
            hotzones.append({
                "id": f"scraped-{i}",
                "name": item.get("name", f"Construction Zone {i}"),
                "lat": float(item.get("lat", 43.69)),
                "lng": float(item.get("lng", -79.44)),
                "severity": severity_map.get(status, "low"),
                "project": item.get("project", "Toronto Infrastructure"),
                "source": "browserbase",
                "summary": item.get("details", ""),
                "linked_site_id": None,
            })

        # If scraping returned nothing useful, augment with seed data
        if len(hotzones) < 2:
            hotzones = SEED_HOTZONES + hotzones

        # Always ensure Eglinton West is present for the demo drilldown
        if not any(h["id"] == "eglinton-west" for h in hotzones):
            hotzones.insert(0, SEED_HOTZONES[0])

        return _make_response(
            hotzones,
            "browserbase",
            f"Live scrape via Browserbase + Stagehand. {len(data)} zones extracted.",
        )

    except Exception as exc:
        print(f"[scrape] Browserbase scraping failed: {exc}", file=sys.stderr)
        return _make_response(
            SEED_HOTZONES,
            "offline",
            f"Browserbase scrape failed ({exc}); using seeded hotzones.",
        )
    finally:
        try:
            await stagehand.close()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def main():
    api_key = os.environ.get("BROWSERBASE_API_KEY")
    project_id = os.environ.get("BROWSERBASE_PROJECT_ID")

    if api_key and project_id and os.environ.get("JENGA_OFFLINE") != "1":
        result = asyncio.run(scrape_toronto_construction())
    else:
        result = _make_response(
            SEED_HOTZONES,
            "offline",
            "Offline demo mode: using seeded Toronto construction hotzones.",
        )

    output = json.dumps(result, indent=2)

    if "--stdout" in sys.argv:
        print(output)
    else:
        outpath = os.path.join(os.path.dirname(__file__), "hotzones.json")
        with open(outpath, "w") as f:
            f.write(output)
        print(f"[scrape] wrote {len(result['hotzones'])} hotzones to {outpath}", file=sys.stderr)


if __name__ == "__main__":
    main()
