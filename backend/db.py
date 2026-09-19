"""Storage. JENGA_STORAGE=memory (default) | postgres.

Memory mode holds everything in a module-level dict and never imports
SQLAlchemy — the demo boots with zero infrastructure. Both modes expose the
same async functions, so route handlers never branch on the backend.
"""

import os

from dotenv import load_dotenv

load_dotenv()

STORAGE = os.getenv("JENGA_STORAGE", "memory").lower()
DATABASE_URL = os.getenv(
    "DATABASE_URL", "postgresql+asyncpg://postgres:postgres@localhost:5432/jenga"
)

# rows, keyed the same way in both modes
_mem: dict[str, list[dict]] = {
    "tasks": [],
    "edges": [],
    "evidence": [],
    "attributions": [],
    "purchase_orders": [],
}

_engine = None
_Session = None
_models: dict = {}


def _define_models():
    """Import SQLAlchemy lazily so memory mode has no hard dependency on it."""
    from pgvector.sqlalchemy import Vector
    from sqlalchemy import JSON, Float, ForeignKey, Integer, String, Text
    from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

    class Base(DeclarativeBase):
        pass

    class TaskRow(Base):
        __tablename__ = "tasks"
        id: Mapped[str] = mapped_column(String, primary_key=True)
        name: Mapped[str] = mapped_column(String)
        zone: Mapped[str] = mapped_column(String)
        x: Mapped[float] = mapped_column(Float)
        y: Mapped[float] = mapped_column(Float)
        duration_days: Mapped[int] = mapped_column(Integer)
        state: Mapped[str] = mapped_column(String)
        spec_text: Mapped[str] = mapped_column(Text)

    class DependencyRow(Base):
        __tablename__ = "dependencies"
        id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
        source: Mapped[str] = mapped_column(String)
        target: Mapped[str] = mapped_column(String)

    class EvidenceRow(Base):
        __tablename__ = "evidence"
        id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
        task_id: Mapped[str] = mapped_column(String)
        report_text: Mapped[str | None] = mapped_column(Text, nullable=True)
        image_base64: Mapped[str | None] = mapped_column(Text, nullable=True)
        transcript: Mapped[str | None] = mapped_column(Text, nullable=True)
        verdict: Mapped[dict | None] = mapped_column(JSON, nullable=True)
        created_at: Mapped[str] = mapped_column(String)

    class AttributionRow(Base):
        __tablename__ = "attributions"
        id: Mapped[str] = mapped_column(String, primary_key=True)
        task_id: Mapped[str] = mapped_column(String)
        slip_days: Mapped[int] = mapped_column(Integer)
        float_consumed: Mapped[int] = mapped_column(Integer)
        downstream_affected: Mapped[list] = mapped_column(JSON)
        project_slipped_days: Mapped[int] = mapped_column(Integer)
        attribution: Mapped[list] = mapped_column(JSON)
        created_at: Mapped[str] = mapped_column(String)

    class PurchaseOrderRow(Base):
        __tablename__ = "purchase_orders"
        id: Mapped[str] = mapped_column(String, primary_key=True)
        material: Mapped[str] = mapped_column(String)
        quantity: Mapped[str] = mapped_column(String)
        vendor: Mapped[str] = mapped_column(String)
        delivery_date: Mapped[str] = mapped_column(String)
        status: Mapped[str] = mapped_column(String)
        linked_task: Mapped[str] = mapped_column(String)
        last_action: Mapped[str | None] = mapped_column(Text, nullable=True)

    class SpecChunkRow(Base):
        # ponytail: created but unpopulated. RAG over spec text goes here.
        __tablename__ = "spec_chunks"
        id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
        task_id: Mapped[str] = mapped_column(ForeignKey("tasks.id"))
        chunk_text: Mapped[str] = mapped_column(Text)
        embedding: Mapped[list[float] | None] = mapped_column(Vector(1536), nullable=True)

    return {
        "Base": Base,
        "tasks": TaskRow,
        "edges": DependencyRow,
        "evidence": EvidenceRow,
        "attributions": AttributionRow,
        "purchase_orders": PurchaseOrderRow,
        "spec_chunks": SpecChunkRow,
    }


def _row_to_dict(row):
    return {c.name: getattr(row, c.name) for c in row.__table__.columns}


async def init():
    """Create tables (postgres only). Falls back to memory if Postgres is unreachable."""
    global STORAGE, _engine, _Session, _models
    if STORAGE != "postgres":
        return
    try:
        from sqlalchemy import text
        from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

        _models = _define_models()
        _engine = create_async_engine(DATABASE_URL)
        _Session = async_sessionmaker(_engine, expire_on_commit=False)
        async with _engine.begin() as conn:
            await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
            await conn.run_sync(_models["Base"].metadata.create_all)
    except Exception as exc:  # never let a missing database break the demo
        print(f"[db] postgres unavailable ({exc}); falling back to memory storage")
        STORAGE = "memory"


async def _all(table):
    if STORAGE == "memory":
        return [dict(r) for r in _mem[table]]
    from sqlalchemy import select

    async with _Session() as s:
        rows = (await s.execute(select(_models[table]))).scalars().all()
        return [_row_to_dict(r) for r in rows]


async def _insert(table, rows):
    if STORAGE == "memory":
        _mem[table].extend(dict(r) for r in rows)
        return
    async with _Session() as s:
        s.add_all([_models[table](**r) for r in rows])
        await s.commit()


async def _update(table, pk, fields):
    if STORAGE == "memory":
        for row in _mem[table]:
            if row["id"] == pk:
                row.update(fields)
                return row
        return None
    from sqlalchemy import select

    async with _Session() as s:
        row = await s.get(_models[table], pk)
        if row is None:
            return None
        for k, v in fields.items():
            setattr(row, k, v)
        await s.commit()
        return _row_to_dict(row)


# --- the API the routes actually use ----------------------------------------


async def reset(seed):
    """Wipe and load a seed payload: {tasks, edges, purchase_orders}."""
    if STORAGE == "memory":
        for k in _mem:
            _mem[k].clear()
    else:
        from sqlalchemy import delete

        async with _Session() as s:
            for table in ("evidence", "attributions", "purchase_orders", "edges", "tasks"):
                await s.execute(delete(_models[table]))
            await s.commit()

    await _insert("tasks", seed["tasks"])
    await _insert("edges", seed["edges"])
    await _insert("purchase_orders", seed.get("purchase_orders", []))


async def tasks():
    return await _all("tasks")


async def edges():
    return [{"source": e["source"], "target": e["target"]} for e in await _all("edges")]


async def update_task(task_id, **fields):
    return await _update("tasks", task_id, fields)


async def add_evidence(row):
    await _insert("evidence", [row])


async def attributions():
    return await _all("attributions")


async def add_attribution(row):
    await _insert("attributions", [row])


async def purchase_orders():
    return await _all("purchase_orders")


async def update_po(po_id, **fields):
    return await _update("purchase_orders", po_id, fields)
