"""Apply backend/sql/schema.postgres.sql then tiger.sql to Postgres/Tiger.

    python backend/sql/apply.py

Reads DATABASE_URL or TIGER_SERVICE_URL. Idempotent: every statement is
IF NOT EXISTS / if_not_exists, so running twice is a no-op.
"""

import asyncio
import os
import sys
from pathlib import Path

import asyncpg
from dotenv import load_dotenv

HERE = Path(__file__).resolve().parent
load_dotenv(HERE.parent / ".env")
FILES = ["schema.postgres.sql", "tiger.sql"]


def statements(sql: str):
    # ponytail: strip '--' comments, then naive split on ';' — none of our SQL
    # has ';' inside strings/DO blocks. Statements run one at a time because
    # continuous aggregates refuse to be created inside a multi-statement
    # implicit transaction.
    sql = "\n".join(l.split("--", 1)[0] for l in sql.splitlines())
    for chunk in sql.split(";"):
        if chunk.strip():
            yield chunk.strip()


async def main():
    dsn = os.getenv("DATABASE_URL") or os.getenv("TIGER_SERVICE_URL")
    if not dsn:
        sys.exit("set DATABASE_URL or TIGER_SERVICE_URL")
    dsn = dsn.replace("postgresql+asyncpg://", "postgresql://")
    conn = await asyncpg.connect(dsn)
    try:
        for name in FILES:
            for stmt in statements((HERE / name).read_text()):
                await conn.execute(stmt)
            print(f"{name} ok")
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
