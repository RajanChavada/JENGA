import { execute, dateAddDays, now } from "./db";
import type { Ticket, TicketStatus } from "./types";

/** All ticket ids reachable downstream of `ticketId` within `branchId` (exclusive of itself). */
export async function getDescendantIds(
  branchId: string,
  ticketId: string
): Promise<string[]> {
  const rows = await execute<{ TICKET_ID: string }>(
    `WITH RECURSIVE descendants (ticket_id) AS (
       SELECT child_ticket_id AS ticket_id
       FROM dependencies
       WHERE branch_id = ? AND parent_ticket_id = ?
       UNION
       SELECT d.child_ticket_id AS ticket_id
       FROM dependencies d
       JOIN descendants ON d.parent_ticket_id = descendants.ticket_id
       WHERE d.branch_id = ?
     )
     SELECT ticket_id FROM descendants`,
    [branchId, ticketId, branchId]
  );
  return rows.map((r) => r.TICKET_ID);
}

/** True if adding parent -> child would create a cycle (child already reaches parent). */
export async function wouldCreateCycle(
  branchId: string,
  parentTicketId: string,
  childTicketId: string
): Promise<boolean> {
  if (parentTicketId === childTicketId) return true;
  const descendantsOfChild = await getDescendantIds(branchId, childTicketId);
  return descendantsOfChild.includes(parentTicketId);
}

/** Direct parent ticket ids of `ticketId` within `branchId`. */
async function getParentIds(
  branchId: string,
  ticketId: string
): Promise<string[]> {
  const rows = await execute<{ PARENT_TICKET_ID: string }>(
    `SELECT parent_ticket_id FROM dependencies WHERE branch_id = ? AND child_ticket_id = ?`,
    [branchId, ticketId]
  );
  return rows.map((r) => r.PARENT_TICKET_ID);
}

async function getTicket(ticketId: string): Promise<Ticket> {
  const rows = await execute<Ticket>(`SELECT * FROM tickets WHERE id = ?`, [
    ticketId,
  ]);
  if (!rows[0]) throw new Error(`Ticket ${ticketId} not found`);
  return rows[0];
}

/**
 * AND-join unblock: for each direct child of `ticketId`, promote it from
 * 'blocked' to 'ready' once every one of its parents is 'done'.
 */
async function unblockReadyChildren(
  branchId: string,
  ticketId: string
): Promise<void> {
  const children = await execute<{ CHILD_TICKET_ID: string }>(
    `SELECT child_ticket_id FROM dependencies WHERE branch_id = ? AND parent_ticket_id = ?`,
    [branchId, ticketId]
  );

  for (const { CHILD_TICKET_ID: childId } of children) {
    const parentIds = await getParentIds(branchId, childId);
    const parents = await Promise.all(parentIds.map(getTicket));
    const child = await getTicket(childId);
    const allParentsDone = parents.every((p) => p.STATUS === "done");
    if (allParentsDone && child.STATUS === "blocked") {
      await execute(
        `UPDATE tickets SET status = 'ready', updated_at = ${now()} WHERE id = ?`,
        [childId]
      );
    }
  }
}

/**
 * Cascades a status change out from `ticketId`:
 * - 'done'      -> unblocks direct children whose other parents are also done (AND-join).
 * - 'cancelled' -> every downstream descendant flips to 'blocked' (surfaced in the UI as a
 *                  prompt to fork a branch from this point, per docs/plan.md Edge Cases).
 */
export async function recalcAfterStatusChange(
  branchId: string,
  ticketId: string,
  newStatus: TicketStatus
): Promise<void> {
  if (newStatus === "done") {
    await unblockReadyChildren(branchId, ticketId);
  } else if (newStatus === "cancelled") {
    const descendantIds = await getDescendantIds(branchId, ticketId);
    for (const id of descendantIds) {
      await execute(
        `UPDATE tickets SET status = 'blocked', updated_at = ${now()}
         WHERE id = ? AND status != 'cancelled'`,
        [id]
      );
    }
  }
}

/** Shifts planned_start/planned_end forward (or back) by `deltaDays` for every downstream descendant. */
export async function shiftDownstreamDates(
  branchId: string,
  ticketId: string,
  deltaDays: number
): Promise<void> {
  if (deltaDays === 0) return;
  const descendantIds = await getDescendantIds(branchId, ticketId);
  for (const id of descendantIds) {
    await execute(
      `UPDATE tickets
       SET planned_start = ${dateAddDays("planned_start")},
           planned_end = ${dateAddDays("planned_end")},
           updated_at = ${now()}
       WHERE id = ?`,
      [deltaDays, deltaDays, id]
    );
  }
}
