import { Pool, types } from "pg";

// Postgres returns DATE/TIMESTAMP as JS Date objects by default; keep them as
// plain strings instead so lib/types.ts's `string | null` fields hold and date
// math elsewhere in the app (e.g. `new Date(ticket.PLANNED_END)`) stays simple.
// OIDs: 1082 = date, 1114 = timestamp without time zone.
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

/** Every query in this app is written with `?` placeholders, in order; translate to `$1, $2, …`. */
function toPgPlaceholders(sqlText: string): string {
  let i = 0;
  return sqlText.replace(/\?/g, () => `$${++i}`);
}

// Postgres folds unquoted identifiers to lowercase; the rest of the app (lib/types.ts
// and every `.STATUS`/`.BRANCH_ID`-style field access) expects uppercase keys.
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

/** Current-timestamp SQL fragment, factored out since it's used in most write queries. */
export function now(): string {
  return "CURRENT_TIMESTAMP";
}

/** `column` shifted forward by a bound number-of-days parameter (`?`). */
export function dateAddDays(column: string): string {
  return `${column} + make_interval(days => ?::int)`;
}
