import { Pool, types } from "pg";

// Snowflake returns DATE/TIMESTAMP_NTZ as plain strings by default; keep Postgres
// returning the same shape (raw string) instead of parsed JS Date objects, so
// lib/types.ts's `string | null` fields hold on both drivers. OIDs: 1082 = date,
// 1114 = timestamp without time zone.
types.setTypeParser(1082, (val) => val);
types.setTypeParser(1114, (val) => val);

declare global {
  var __jengaPgPool: Pool | undefined;
}

function getPool(): Pool {
  if (!global.__jengaPgPool) {
    global.__jengaPgPool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return global.__jengaPgPool;
}

/** Snowflake's `?` placeholders, in order, become Postgres's `$1, $2, …`. */
function toPgPlaceholders(sqlText: string): string {
  let i = 0;
  return sqlText.replace(/\?/g, () => `$${++i}`);
}

/** Snowflake returns uppercase column names; fold Postgres's lowercase ones to match. */
function uppercaseKeys<T>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) out[key.toUpperCase()] = value;
  return out as T;
}

export async function execute<T = Record<string, unknown>>(
  sqlText: string,
  binds: (string | number | null)[] = []
): Promise<T[]> {
  const { rows } = await getPool().query(toPgPlaceholders(sqlText), binds);
  return rows.map((row) => uppercaseKeys<T>(row));
}
