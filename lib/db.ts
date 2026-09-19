/**
 * Data-access facade. Every other module imports `execute` (and the dialect
 * helpers) from here rather than from a specific driver — see docs/plan.md
 * "Local Postgres Dev Shim": Snowflake credentials aren't available yet, so
 * DB_DRIVER defaults to 'postgres' for local dev and flips to 'snowflake'
 * with no other code changes once they exist.
 */
import * as snowflake from "./snowflake";
import * as postgres from "./postgres";

const driver = (process.env.DB_DRIVER ?? "postgres") as "postgres" | "snowflake";

export const execute: <T = Record<string, unknown>>(
  sqlText: string,
  binds?: (string | number | null)[]
) => Promise<T[]> = driver === "snowflake" ? snowflake.execute : postgres.execute;

/** Current-timestamp SQL fragment — Postgres rejects the parenthesized Snowflake form. */
export function now(): string {
  return driver === "snowflake" ? "CURRENT_TIMESTAMP()" : "CURRENT_TIMESTAMP";
}

/** `column` shifted forward by a bound number-of-days parameter (`?`). */
export function dateAddDays(column: string): string {
  return driver === "snowflake"
    ? `DATEADD(day, ?, ${column})`
    : `${column} + make_interval(days => ?::int)`;
}
