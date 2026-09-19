"""Load data/seed_tasks.json into whichever storage backend is active."""

import json
from pathlib import Path

import db

DATA_DIR = Path(__file__).parent.parent / "data"
SEED_FILE = DATA_DIR / "seed_tasks.json"
PORTAL_FILE = DATA_DIR / "portal.json"

TASK_FIELDS = ("id", "name", "zone", "x", "y", "duration_days", "due_day", "state", "spec_text")
PO_FIELDS = (
    "id",
    "material",
    "quantity",
    "vendor",
    "delivery_date",
    "status",
    "linked_task",
    "last_action",
)


def load_seed():
    return json.loads(SEED_FILE.read_text())


def load_portal():
    return json.loads(PORTAL_FILE.read_text())


def portal_project(project_id):
    return next((p for p in load_portal()["projects"] if p["id"] == project_id), None)


def scoped_id(project_id, raw_id):
    """Ticket and PO ids are global primary keys, so every project but the default
    carries its own prefix. `base_id` undoes it for the canned-evidence lookups."""
    return raw_id if project_id == db.DEFAULT_PROJECT_ID else f"{project_id}:{raw_id}"


def base_id(task_id):
    return task_id.rsplit(":", 1)[-1]


async def seed(project_id=db.DEFAULT_PROJECT_ID):
    raw = load_seed()
    sid = lambda i: scoped_id(project_id, i) if i else i  # noqa: E731
    project = portal_project(project_id)
    await db.reset(
        {
            "project_name": project["name"] if project else None,
            "tasks": [{**{k: t.get(k) for k in TASK_FIELDS}, "id": sid(t["id"])} for t in raw["tasks"]],
            "edges": [
                {"source": sid(e["source"]), "target": sid(e["target"])} for e in raw["edges"]
            ],
            "purchase_orders": [
                {**{k: p.get(k) for k in PO_FIELDS}, "id": sid(p["id"]), "linked_task": sid(p.get("linked_task"))}
                for p in raw.get("purchase_orders", [])
            ],
        },
        project_id,
    )


async def seed_all():
    """The default project first (keeps the literal ids), then every portal project."""
    for project in load_portal()["projects"]:
        await seed(project["id"])


if __name__ == "__main__":
    import asyncio

    async def main():
        await db.init()
        await seed()
        print(f"seeded {len(await db.tasks())} tasks into {db.STORAGE} storage")

    asyncio.run(main())
