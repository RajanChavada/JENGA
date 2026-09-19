"""Browserbase-backed macro construction hotzones.

In live mode this uses Browserbase Fetch API for simple municipal pages. In
offline demo mode, or without credentials, it returns a stable Toronto heatmap
so the Browserbase track can still be shown on stage.
"""

from __future__ import annotations

import os
import re
from datetime import datetime, timezone

import httpx

FETCH_URL = "https://api.browserbase.com/v1/fetch"

SOURCES = [
    "https://www.toronto.ca/services-payments/streets-parking-transportation/road-restrictions-closures/restrictions-map/",
    "https://www.metrolinx.com/en/projects-and-programs/eglinton-crosstown-west-extension",
]

FALLBACK_HOTZONES = [
    {
        "id": "eglinton-west",
        "name": "Eglinton West Station",
        "lat": 43.6992,
        "lng": -79.4356,
        "severity": "high",
        "project": "Eglinton Crosstown West Extension",
        "source": "offline demo seed",
        "summary": "Station box, road staging and utility relocation clustered around Eglinton Avenue West.",
        "linked_site_id": "eglinton-west-station",
    },
    {
        "id": "dufferin-eglinton",
        "name": "Dufferin and Eglinton",
        "lat": 43.6952,
        "lng": -79.4425,
        "severity": "medium",
        "project": "Road occupation permit cluster",
        "source": "offline demo seed",
        "summary": "Lane restrictions and sidewalk diversions near active utility cuts.",
        "linked_site_id": None,
    },
    {
        "id": "mount-dennis",
        "name": "Mount Dennis portal",
        "lat": 43.6861,
        "lng": -79.4895,
        "severity": "medium",
        "project": "LRT portal and guideway works",
        "source": "offline demo seed",
        "summary": "Guideway tie-in activity with staged haul routes west of the station.",
        "linked_site_id": None,
    },
    {
        "id": "yonge-queen",
        "name": "Queen and Yonge",
        "lat": 43.6524,
        "lng": -79.3793,
        "severity": "low",
        "project": "Downtown utility renewal",
        "source": "offline demo seed",
        "summary": "Short-duration closures and utility coordination in a dense pedestrian corridor.",
        "linked_site_id": None,
    },
    {
        "id": "finch-west",
        "name": "Finch West LRT \u2013 Humber College",
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


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _fallback(notes: str) -> dict:
    return {
        "source": "offline",
        "generated_at": _now(),
        "notes": notes,
        "hotzones": [
            {**h, "updated_at": _now()}
            for h in FALLBACK_HOTZONES
        ],
    }


async def _fetch(url: str, key: str) -> str:
    async with httpx.AsyncClient(timeout=8) as client:
        res = await client.post(
            FETCH_URL,
            headers={"X-BB-API-Key": key, "Content-Type": "application/json"},
            json={"url": url, "allowRedirects": True},
        )
        res.raise_for_status()
        payload = res.json()
        return str(payload.get("content") or "")


def _extract(content: str, source_url: str) -> list[dict]:
    text = re.sub(r"<[^>]+>", " ", content)
    text = re.sub(r"\s+", " ", text)
    found: list[dict] = []
    known = [
        ("Eglinton West Station", 43.6992, -79.4356, "high", "eglinton-west-station"),
        ("Dufferin", 43.6952, -79.4425, "medium", None),
        ("Mount Dennis", 43.6861, -79.4895, "medium", None),
        ("Queen", 43.6524, -79.3793, "low", None),
    ]
    for name, lat, lng, severity, site_id in known:
        match = re.search(rf"(.{{0,140}}{re.escape(name)}.{{0,220}})", text, re.I)
        if not match:
            continue
        summary = match.group(1).strip()
        found.append(
            {
                "id": re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-"),
                "name": name if name != "Dufferin" else "Dufferin and Eglinton",
                "lat": lat,
                "lng": lng,
                "severity": severity,
                "project": "Browserbase scraped construction update",
                "source": source_url,
                "updated_at": _now(),
                "summary": summary[:280],
                "linked_site_id": site_id,
            }
        )
    return found


async def _try_stagehand() -> dict | None:
    """If both BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID are set, try the
    full Stagehand scraper for richer LLM-extracted data."""
    project_id = os.getenv("BROWSERBASE_PROJECT_ID")
    if not project_id:
        return None
    try:
        from scrape_construction import scrape_toronto_construction
        result = await scrape_toronto_construction()
        if result and result.get("source") == "browserbase":
            return result
    except Exception as exc:
        print(f"[browserbase] Stagehand scrape failed ({exc}); falling back to Fetch API")
    return None


#: The last operator-triggered scrape. Passive reads serve this so a successful
#: scrape survives page reloads, without any load ever triggering one itself.
_last_scrape: dict | None = None


async def hotzones(force_live: bool = False) -> dict:
    """The macro heatmap payload.

    Passive reads (`force_live=False`) never scrape: page loads serve the last
    operator-triggered scrape, or the seed. A scrape happens only when the
    operator presses the button on the map, which calls this with
    `force_live=True` — that attempts the real Browserbase run even under
    `JENGA_OFFLINE=1`, and reports honestly (in `notes`) when it can't,
    instead of silently serving the seed.
    """
    global _last_scrape
    if not force_live:
        if _last_scrape is not None:
            return _last_scrape
        return _fallback(
            "Seeded Toronto construction hotzones. Press “Scrape live feeds” to pull "
            "current municipal and Metrolinx updates via Browserbase."
        )

    key = os.getenv("BROWSERBASE_API_KEY")
    if not key:
        return _fallback(
            "Scrape requested, but no BROWSERBASE_API_KEY is set — showing the seeded "
            "Toronto hotzones. Add a key to pull live municipal and Metrolinx updates."
        )

    # Prefer Stagehand (full browser session) when project ID is also available
    stagehand_result = await _try_stagehand()
    if stagehand_result:
        _last_scrape = stagehand_result
        return stagehand_result

    # Fall back to Browserbase Fetch API (lighter, no project ID needed)
    hot: list[dict] = []
    for url in SOURCES:
        try:
            hot.extend(_extract(await _fetch(url, key), url))
        except Exception as exc:
            print(f"[browserbase] fetch failed for {url}: {exc}")

    if not hot:
        return _fallback("Browserbase Fetch returned no parseable construction sites; using seeded hotzones.")

    # Keep stable ordering and dedupe by id.
    deduped = {h["id"]: h for h in hot}
    result = {
        "source": "browserbase",
        "generated_at": _now(),
        "notes": "Fetched with Browserbase Fetch API from Toronto/Metrolinx public construction pages.",
        "hotzones": list(deduped.values()),
    }
    _last_scrape = result
    return result
