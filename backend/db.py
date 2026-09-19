"""Storage. JENGA_STORAGE=memory (default) | postgres.

Memory mode holds everything in a module-level dict and never imports
SQLAlchemy — the demo boots with zero infrastructure. Both modes expose the
same async functions, so route handlers never branch on the backend.

Postgres mode speaks main's schema (projects/branches/tickets/dependencies/
reports/evidence_verdicts). Everything above this module keeps talking about
tasks with name/x/y and state pending|active|verified|…; the rename and the
state translation happen here, at the SQL boundary, and nowhere else.
"""

import os
import ssl
import uuid
from datetime import date, datetime, timezone
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from dotenv import load_dotenv

load_dotenv()

STORAGE = os.getenv("JENGA_STORAGE", "memory").lower()
LOCAL_DATABASE_URL = "postgresql+asyncpg://postgres:postgres@localhost:5432/jenga"

# main's schema is multi-project/multi-branch; JENGA drives one of each.
DEFAULT_PROJECT_ID = "eglinton-west-station"
DEFAULT_PROJECT_NAME = "Eglinton West Station"
DEFAULT_BRANCH_ID = "main"
DEFAULT_BRANCH_NAME = "main"

# Our state vocabulary <-> main's tickets.status. Not injective (pending and
# blocked both land on blocked), so the two directions are written out apart.
TO_MAIN = {"pending": "blocked", "active": "in_progress", "verified": "done",
           "under_review": "under_review", "disputed": "disputed", "blocked": "blocked"}
FROM_MAIN = {"blocked": "pending", "ready": "pending", "in_progress": "active", "done": "verified",
             "cancelled": "blocked", "under_review": "under_review", "disputed": "disputed"}

TASK_KEYS = ("id", "name", "zone", "x", "y", "duration_days", "state", "spec_text")
PO_KEYS = ("id", "material", "quantity", "vendor", "delivery_date", "status",
           "linked_task", "last_action")

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


def _dsn():
    """(url, connect_args) for create_async_engine. Never log either of them."""
    raw = os.getenv("DATABASE_URL") or os.getenv("TIGER_SERVICE_URL") or LOCAL_DATABASE_URL
    parts = urlsplit(raw)
    scheme = "postgresql+asyncpg" if parts.scheme in ("postgres", "postgresql") else parts.scheme
    params = parse_qsl(parts.query, keep_blank_values=True)
    sslmode = next((v for k, v in params if k == "sslmode"), None)
    url = urlunsplit((
        scheme,
        parts.netloc,
        parts.path,
        urlencode([(k, v) for k, v in params if k != "sslmode"]),
        parts.fragment,
    ))
    connect_args = {}
    if sslmode in ("require", "verify-ca", "verify-full"):
        # asyncpg has no sslmode; this context mirrors libpq's sslmode=require,
        # which encrypts the connection without verifying the chain. verify-ca
        # and verify-full are downgraded to that same no-verification context —
        # they ask for a check this environment's CA bundle cannot perform.
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        connect_args["ssl"] = ctx
    return url, connect_args


def _define_models():
    """Import SQLAlchemy lazily so memory mode has no hard dependency on it.

    Only the columns this app touches are mapped; the rest keep their defaults.
    """
    from sqlalchemy import Date, DateTime, Float, Integer, String, Text
    from sqlalchemy.dialects.postgresql import JSONB
    from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

    class Base(DeclarativeBase):
        pass

    class ProjectRow(Base):
        __tablename__ = "projects"
        id: Mapped[str] = mapped_column(String, primary_key=True)
        name: Mapped[str] = mapped_column(String)

    class BranchRow(Base):
        __tablename__ = "branches"
        id: Mapped[str] = mapped_column(String, primary_key=True)
        project_id: Mapped[str] = mapped_column(String)
        name: Mapped[str] = mapped_column(String)

    class TicketRow(Base):
        __tablename__ = "tickets"
        id: Mapped[str] = mapped_column(String, primary_key=True)
        project_id: Mapped[str] = mapped_column(String)
        branch_id: Mapped[str] = mapped_column(String)
        title: Mapped[str] = mapped_column(String)
        status: Mapped[str] = mapped_column(String)
        zone: Mapped[str | None] = mapped_column(String, nullable=True)
        blueprint_x: Mapped[float | None] = mapped_column(Float, nullable=True)
        blueprint_y: Mapped[float | None] = mapped_column(Float, nullable=True)
        duration_days: Mapped[int | None] = mapped_column(Integer, nullable=True)
        spec_text: Mapped[str | None] = mapped_column(Text, nullable=True)

    class DependencyRow(Base):
        __tablename__ = "dependencies"
        id: Mapped[str] = mapped_column(String, primary_key=True)
        branch_id: Mapped[str] = mapped_column(String)
        parent_ticket_id: Mapped[str] = mapped_column(String)
        child_ticket_id: Mapped[str] = mapped_column(String)

    class ReportRow(Base):
        __tablename__ = "reports"
        id: Mapped[str] = mapped_column(String, primary_key=True)
        ticket_id: Mapped[str] = mapped_column(String)
        submitted_by_role: Mapped[str] = mapped_column(String)
        report_text: Mapped[str] = mapped_column(Text)
        media_url: Mapped[str | None] = mapped_column(Text, nullable=True)
        # written by the owner-decision flow, not by add_evidence
        gptzero_score: Mapped[float | None] = mapped_column(Float, nullable=True)
        gptzero_flag: Mapped[str | None] = mapped_column(String, nullable=True)
        owner_decision: Mapped[str | None] = mapped_column(String, nullable=True)
        decided_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
        submitted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    class EvidenceVerdictRow(Base):
        __tablename__ = "evidence_verdicts"
        id: Mapped[str] = mapped_column(String, primary_key=True)
        ticket_id: Mapped[str] = mapped_column(String)
        report_id: Mapped[str | None] = mapped_column(String, nullable=True)
        verdict: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
        created_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    class AttributionRow(Base):
        __tablename__ = "attributions"
        id: Mapped[str] = mapped_column(String, primary_key=True)
        project_id: Mapped[str | None] = mapped_column(String, nullable=True)
        ticket_id: Mapped[str] = mapped_column(String)
        slip_days: Mapped[int] = mapped_column(Integer)
        float_consumed: Mapped[int] = mapped_column(Integer)
        project_slipped_days: Mapped[int] = mapped_column(Integer)
        downstream_affected: Mapped[list] = mapped_column(JSONB)
        attribution: Mapped[list] = mapped_column(JSONB)
        created_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    class PurchaseOrderRow(Base):
        __tablename__ = "purchase_orders"
        id: Mapped[str] = mapped_column(String, primary_key=True)
        project_id: Mapped[str | None] = mapped_column(String, nullable=True)
        ticket_id: Mapped[str | None] = mapped_column(String, nullable=True)
        material: Mapped[str] = mapped_column(String)
        quantity: Mapped[str] = mapped_column(String)
        vendor: Mapped[str] = mapped_column(String)
        delivery_date: Mapped[date | None] = mapped_column(Date, nullable=True)
        status: Mapped[str] = mapped_column(String)
        last_action: Mapped[str | None] = mapped_column(Text, nullable=True)

    return {
        "projects": ProjectRow,
        "branches": BranchRow,
        "tasks": TicketRow,
        "edges": DependencyRow,
        "reports": ReportRow,
        "evidence_verdicts": EvidenceVerdictRow,
        "attributions": AttributionRow,
        "purchase_orders": PurchaseOrderRow,
    }


# --- app shape <-> main's columns -------------------------------------------


def _uid():
    return uuid.uuid4().hex


def _dt(value, naive=False):
    """ISO string -> datetime. naive=True for the plain TIMESTAMP columns."""
    out = datetime.fromisoformat(value) if isinstance(value, str) else value
    if naive and isinstance(out, datetime) and out.tzinfo is not None:
        out = out.astimezone(timezone.utc).replace(tzinfo=None)
    return out


def _date(value):
    """ISO string -> date, for the DATE columns."""
    return date.fromisoformat(value) if isinstance(value, str) else value


def _iso(value):
    return value.isoformat() if isinstance(value, (date, datetime)) else value


def _scoped(row, project_id):
    # seeds written before project_id existed belong to the default project
    return row.get("project_id", DEFAULT_PROJECT_ID) == project_id


def _task_shape(row):
    return {k: row.get(k) for k in TASK_KEYS}


def _branch_id(project_id):
    """Each project owns its own 'main' branch; ours keeps the literal id."""
    return DEFAULT_BRANCH_ID if project_id == DEFAULT_PROJECT_ID else f"{project_id}-main"


def _ticket_in(row, project_id):
    return {
        "id": row["id"],
        "project_id": project_id,
        "branch_id": _branch_id(project_id),
        "title": row.get("name"),
        "zone": row.get("zone"),
        "blueprint_x": row.get("x"),
        "blueprint_y": row.get("y"),
        "duration_days": row.get("duration_days"),
        "status": TO_MAIN.get(row.get("state"), row.get("state")),
        "spec_text": row.get("spec_text"),
    }


def _ticket_out(r):
    return {
        "id": r.id,
        "name": r.title,
        "zone": r.zone,
        "x": r.blueprint_x,
        "y": r.blueprint_y,
        "duration_days": r.duration_days,
        "state": FROM_MAIN.get(r.status, r.status),
        "spec_text": r.spec_text,
    }


# update_task() speaks app keys; these are the ones whose column differs
_TICKET_COLUMN = {"name": "title", "x": "blueprint_x", "y": "blueprint_y", "state": "status"}


def _po_in(row, project_id):
    return {
        "id": row["id"],
        "project_id": project_id,
        "ticket_id": row.get("linked_task"),
        "material": row.get("material"),
        "quantity": row.get("quantity"),
        "vendor": row.get("vendor"),
        "delivery_date": _date(row.get("delivery_date")),
        "status": row.get("status"),
        "last_action": row.get("last_action"),
    }


def _po_out(r):
    return {
        "id": r.id,
        "material": r.material,
        "quantity": r.quantity,
        "vendor": r.vendor,
        "delivery_date": _iso(r.delivery_date),
        "status": r.status,
        "linked_task": r.ticket_id,
        "last_action": r.last_action,
    }


_PO_COLUMN = {"linked_task": "ticket_id"}


def _attribution_in(row, project_id):
    return {
        "id": row["id"],
        "project_id": project_id,
        "ticket_id": row.get("task_id"),
        "slip_days": row.get("slip_days"),
        "float_consumed": row.get("float_consumed"),
        "project_slipped_days": row.get("project_slipped_days"),
        "downstream_affected": row.get("downstream_affected"),
        "attribution": row.get("attribution"),
        "created_at": _dt(row.get("created_at")),
    }


def _attribution_out(r):
    return {
        "id": r.id,
        "task_id": r.ticket_id,
        "slip_days": r.slip_days,
        "float_consumed": r.float_consumed,
        "downstream_affected": r.downstream_affected,
        "project_slipped_days": r.project_slipped_days,
        "attribution": r.attribution,
        "created_at": _iso(r.created_at),
    }


async def init():
    """Build the engine (postgres only). Falls back to memory if it's unreachable.

    The schema lives in backend/sql/*.sql and is applied out of band, so all
    this does is prove the connection works.
    """
    global STORAGE, _engine, _Session, _models
    if STORAGE != "postgres":
        return
    try:
        from sqlalchemy import text
        from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

        _models = _define_models()
        url, connect_args = _dsn()
        _engine = create_async_engine(url, connect_args=connect_args)
        _Session = async_sessionmaker(_engine, expire_on_commit=False)
        async with _engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
    except Exception as exc:  # never let a missing database break the demo
        # exception type only — the DSN carries credentials and must not leak
        print(f"[db] postgres unavailable ({type(exc).__name__}); falling back to memory storage")
        STORAGE = "memory"


# --- the API the routes actually use ----------------------------------------


async def reset(seed, project_id=DEFAULT_PROJECT_ID):
    """Wipe and load a seed payload: {tasks, edges, purchase_orders}."""
    if STORAGE == "memory":
        for k in _mem:
            _mem[k].clear()
    else:
        from sqlalchemy import delete, or_, select

        T, D, P = _models["tasks"], _models["edges"], _models["purchase_orders"]
        async with _Session() as s:
            # Scoped to this project — the database is shared, so a reset must
            # not touch anyone else's rows. Children before parents.
            tix = select(T.id).where(T.project_id == project_id)
            for table in ("evidence_verdicts", "reports", "attributions"):
                M = _models[table]
                await s.execute(delete(M).where(M.ticket_id.in_(tix)))
            # purchase_orders.ticket_id is nullable, so the ticket subquery alone
            # would strand our own unlinked rows; dependencies must go if either
            # end is ours, or the ticket delete below hits their foreign keys.
            await s.execute(
                delete(P).where(or_(P.project_id == project_id, P.ticket_id.in_(tix)))
            )
            await s.execute(
                delete(D).where(
                    or_(D.parent_ticket_id.in_(tix), D.child_ticket_id.in_(tix))
                )
            )
            await s.execute(delete(T).where(T.project_id == project_id))

            # projects/branches are upserted, not wiped
            name = DEFAULT_PROJECT_NAME if project_id == DEFAULT_PROJECT_ID else project_id
            await s.merge(_models["projects"](id=project_id, name=name))
            # No model declares a real ForeignKey, so the unit of work has no
            # table-dependency graph: branches only lands after projects if we
            # say so.
            await s.flush()
            await s.merge(
                _models["branches"](
                    id=_branch_id(project_id), project_id=project_id, name=DEFAULT_BRANCH_NAME
                )
            )
            await s.commit()

    await add_tasks(seed["tasks"], project_id)
    await add_edges(seed["edges"], project_id)
    await _add_purchase_orders(seed.get("purchase_orders", []), project_id)


async def add_tasks(rows, project_id=DEFAULT_PROJECT_ID):
    if STORAGE == "memory":
        _mem["tasks"].extend({**dict(r), "project_id": project_id} for r in rows)
        return
    async with _Session() as s:
        s.add_all([_models["tasks"](**_ticket_in(r, project_id)) for r in rows])
        await s.commit()


async def add_edges(rows, project_id=DEFAULT_PROJECT_ID):
    if STORAGE == "memory":
        _mem["edges"].extend(
            {"source": r["source"], "target": r["target"], "project_id": project_id} for r in rows
        )
        return
    async with _Session() as s:
        s.add_all(
            [
                _models["edges"](
                    id=_uid(),
                    branch_id=_branch_id(project_id),
                    parent_ticket_id=r["source"],
                    child_ticket_id=r["target"],
                )
                for r in rows
            ]
        )
        await s.commit()


async def _add_purchase_orders(rows, project_id=DEFAULT_PROJECT_ID):
    if STORAGE == "memory":
        _mem["purchase_orders"].extend({**dict(r), "project_id": project_id} for r in rows)
        return
    async with _Session() as s:
        s.add_all([_models["purchase_orders"](**_po_in(r, project_id)) for r in rows])
        await s.commit()


async def tasks(project_id=DEFAULT_PROJECT_ID):
    if STORAGE == "memory":
        return [_task_shape(r) for r in _mem["tasks"] if _scoped(r, project_id)]
    from sqlalchemy import select

    T = _models["tasks"]
    async with _Session() as s:
        rows = (
            await s.execute(select(T).where(T.project_id == project_id).order_by(T.id))
        ).scalars().all()
        return [_ticket_out(r) for r in rows]


async def edges(project_id=DEFAULT_PROJECT_ID):
    if STORAGE == "memory":
        return [
            {"source": e["source"], "target": e["target"]}
            for e in _mem["edges"]
            if _scoped(e, project_id)
        ]
    from sqlalchemy import select
    from sqlalchemy.orm import aliased

    D = _models["edges"]
    # Both ends must be in the project: an edge to a ticket tasks() never
    # returned becomes an attribute-less node and blows up the CPM pass.
    parent, child = aliased(_models["tasks"]), aliased(_models["tasks"])
    async with _Session() as s:
        rows = (
            await s.execute(
                select(D)
                .join(parent, parent.id == D.parent_ticket_id)
                .join(child, child.id == D.child_ticket_id)
                .where(parent.project_id == project_id, child.project_id == project_id)
                .order_by(D.parent_ticket_id, D.child_ticket_id)
            )
        ).scalars().all()
        return [{"source": r.parent_ticket_id, "target": r.child_ticket_id} for r in rows]


async def update_task(task_id, **fields):
    if STORAGE == "memory":
        for row in _mem["tasks"]:
            if row["id"] == task_id:
                row.update(fields)
                return _task_shape(row)
        return None
    async with _Session() as s:
        row = await s.get(_models["tasks"], task_id)
        if row is None:
            return None
        for k, v in fields.items():
            if k == "state":
                v = TO_MAIN.get(v, v)
            setattr(row, _TICKET_COLUMN.get(k, k), v)
        await s.commit()
        return _ticket_out(row)


async def add_evidence(row):
    """One submission -> a reports row plus its evidence_verdicts row."""
    if STORAGE == "memory":
        _mem["evidence"].append(dict(row))
        return
    async with _Session() as s:
        report_id = _uid()
        s.add(
            _models["reports"](
                id=report_id,
                ticket_id=row["task_id"],
                submitted_by_role="subcontractor",
                report_text=row.get("report_text") or "",
                # bare .get: a report GPTZero never scored stores NULL, which is
                # not the same fact as a confident 0.0. decided_at stays unset.
                gptzero_score=row.get("gptzero_score"),
                gptzero_flag=row.get("gptzero_flag"),
                owner_decision=row.get("owner_decision"),
                # image_base64/transcript are payloads, not URLs — media_url stays empty
                submitted_at=_dt(row.get("created_at"), naive=True),
            )
        )
        await s.flush()  # the verdict's FK needs the report to exist first
        s.add(
            _models["evidence_verdicts"](
                id=_uid(),
                ticket_id=row["task_id"],
                report_id=report_id,
                verdict=row.get("verdict"),
                created_at=_dt(row.get("created_at")),
            )
        )
        await s.commit()


async def attributions(project_id=DEFAULT_PROJECT_ID):
    if STORAGE == "memory":
        return [dict(r) for r in _mem["attributions"] if _scoped(r, project_id)]
    from sqlalchemy import select

    A = _models["attributions"]
    async with _Session() as s:
        rows = (
            await s.execute(
                select(A).where(A.project_id == project_id).order_by(A.created_at)
            )
        ).scalars().all()
        return [_attribution_out(r) for r in rows]


async def add_attribution(row):
    if STORAGE == "memory":
        _mem["attributions"].append(dict(row))
        return
    async with _Session() as s:
        s.add(_models["attributions"](**_attribution_in(row, DEFAULT_PROJECT_ID)))
        await s.commit()


async def purchase_orders(project_id=DEFAULT_PROJECT_ID):
    if STORAGE == "memory":
        return [
            {k: r.get(k) for k in PO_KEYS}
            for r in _mem["purchase_orders"]
            if _scoped(r, project_id)
        ]
    from sqlalchemy import select

    P = _models["purchase_orders"]
    async with _Session() as s:
        rows = (
            await s.execute(select(P).where(P.project_id == project_id).order_by(P.id))
        ).scalars().all()
        return [_po_out(r) for r in rows]


async def update_po(po_id, **fields):
    if STORAGE == "memory":
        for row in _mem["purchase_orders"]:
            if row["id"] == po_id:
                row.update(fields)
                return {k: row.get(k) for k in PO_KEYS}
        return None
    async with _Session() as s:
        row = await s.get(_models["purchase_orders"], po_id)
        if row is None:
            return None
        for k, v in fields.items():
            if k == "delivery_date":
                v = _date(v)
            setattr(row, _PO_COLUMN.get(k, k), v)
        await s.commit()
        return _po_out(row)
