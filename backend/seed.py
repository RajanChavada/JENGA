"""Load data/seed_tasks.json into whichever storage backend is active."""

import json
from pathlib import Path

import db

DATA_DIR = Path(__file__).parent.parent / "data"
SEED_FILE = DATA_DIR / "seed_tasks.json"

TASK_FIELDS = ("id", "name", "zone", "x", "y", "duration_days", "state", "spec_text")
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


async def seed(project_id=db.DEFAULT_PROJECT_ID):
    raw = load_seed()
    await db.reset(
        {
            "tasks": [{k: t.get(k) for k in TASK_FIELDS} for t in raw["tasks"]],
            "edges": [
                {"source": e["source"], "target": e["target"]} for e in raw["edges"]
            ],
            "purchase_orders": [
                {k: p.get(k) for k in PO_FIELDS} for p in raw.get("purchase_orders", [])
            ],
        },
        project_id,
    )


if __name__ == "__main__":
    import asyncio

    async def main():
        await db.init()
        await seed()
        print(f"seeded {len(await db.tasks())} tasks into {db.STORAGE} storage")

    asyncio.run(main())
