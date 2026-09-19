/** "2026-09-14" -> "14 Sep". The dates here are calendar dates, not instants, so no timezone shift. */
export function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

/** A task's calendar due date from its day offset and the project start. */
export function dueDate(startIso: string, dueDay: number): string {
  const [y, m, d] = startIso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + dueDay)).toISOString().slice(0, 10);
}

/**
 * The id a person reads. Every project but the default prefixes its ids with the
 * project (`ossington-relief-tunnel:P-104`) to keep them unique in storage; that
 * prefix is plumbing and must never reach the screen. Works for task and PO ids.
 */
export function displayId(id: string): string {
  return id.slice(id.lastIndexOf(':') + 1);
}
