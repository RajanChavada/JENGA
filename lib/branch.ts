import { randomUUID } from "crypto";
import { execute, now } from "./db";
import { getDescendantIds } from "./dag";
import type { Branch, Dependency, Ticket } from "./types";

export async function forkBranch(
  projectId: string,
  fromBranchId: string,
  forkTicketId: string,
  name: string
): Promise<Branch> {
  const subtreeIds = [forkTicketId, ...(await getDescendantIds(fromBranchId, forkTicketId))];

  const originals = await execute<Ticket>(
    `SELECT * FROM tickets WHERE id IN (${subtreeIds.map(() => "?").join(",")})`,
    subtreeIds
  );

  const internalEdges = await execute<Dependency>(
    `SELECT * FROM dependencies
     WHERE branch_id = ?
       AND child_ticket_id IN (${subtreeIds.map(() => "?").join(",")})`,
    [fromBranchId, ...subtreeIds]
  );

  const newBranchId = randomUUID();
  await execute(
    `INSERT INTO branches (id, project_id, name, forked_from_branch_id, forked_from_ticket_id, status)
     VALUES (?, ?, ?, ?, ?, 'active')`,
    [newBranchId, projectId, name, fromBranchId, forkTicketId]
  );

  const idMap = new Map<string, string>();
  for (const original of originals) idMap.set(original.ID, randomUUID());

  for (const original of originals) {
    await execute(
      `INSERT INTO tickets
         (id, project_id, branch_id, forked_from_id, title, description, status,
          planned_start, planned_end, original_planned_end, actual_start, actual_end)
       SELECT ?, project_id, ?, id, title, description, status,
              planned_start, planned_end, original_planned_end, actual_start, actual_end
       FROM tickets WHERE id = ?`,
      [idMap.get(original.ID)!, newBranchId, original.ID]
    );
  }

  for (const edge of internalEdges) {
    const newParentId = idMap.get(edge.PARENT_TICKET_ID) ?? edge.PARENT_TICKET_ID;
    const newChildId = idMap.get(edge.CHILD_TICKET_ID)!;
    await execute(
      `INSERT INTO dependencies (id, branch_id, parent_ticket_id, child_ticket_id) VALUES (?, ?, ?, ?)`,
      [randomUUID(), newBranchId, newParentId, newChildId]
    );
  }

  const [branch] = await execute<Branch>(`SELECT * FROM branches WHERE id = ?`, [
    newBranchId,
  ]);
  return branch;
}

export class MergeConflictError extends Error {}

export async function mergeBranch(branchId: string): Promise<void> {
  const [branch] = await execute<Branch & { FORKED_AT: string }>(
    `SELECT * FROM branches WHERE id = ?`,
    [branchId]
  );
  if (!branch) throw new Error("Branch not found");
  if (branch.STATUS !== "active") throw new Error("Branch is not active");
  const trunkBranchId = branch.FORKED_FROM_BRANCH_ID;
  if (!trunkBranchId) throw new Error("Cannot merge the trunk into itself");

  const branchTickets = await execute<Ticket>(
    `SELECT * FROM tickets WHERE branch_id = ?`,
    [branchId]
  );

  const copiedTickets = branchTickets.filter((t) => t.FORKED_FROM_ID);
  const newTickets = branchTickets.filter((t) => !t.FORKED_FROM_ID);

  for (const copy of copiedTickets) {
    const originalId = copy.FORKED_FROM_ID!;
    const [original] = await execute<{ UPDATED_AT: string }>(
      `SELECT updated_at FROM tickets WHERE id = ?`,
      [originalId]
    );
    if (original && new Date(original.UPDATED_AT) > new Date(branch.FORKED_AT)) {
      throw new MergeConflictError(
        "Trunk has changed since this branch was forked — re-fork instead of merging."
      );
    }
  }

  for (const copy of copiedTickets) {
    const originalId = copy.FORKED_FROM_ID!;
    await execute(
      `UPDATE tickets
       SET status = ?, planned_start = ?, planned_end = ?, actual_start = ?, actual_end = ?,
           updated_at = ${now()}
       WHERE id = ?`,
      [copy.STATUS, copy.PLANNED_START, copy.PLANNED_END, copy.ACTUAL_START, copy.ACTUAL_END, originalId]
    );
  }

  for (const fresh of newTickets) {
    await execute(`UPDATE tickets SET branch_id = ? WHERE id = ?`, [
      trunkBranchId,
      fresh.ID,
    ]);
  }

  const originalIdOf = (ticketId: string): string => {
    const copy = copiedTickets.find((t) => t.ID === ticketId);
    return copy ? copy.FORKED_FROM_ID! : ticketId;
  };

  const branchEdges = await execute<Dependency>(
    `SELECT * FROM dependencies WHERE branch_id = ?`,
    [branchId]
  );
  for (const edge of branchEdges) {
    const parentId = originalIdOf(edge.PARENT_TICKET_ID);
    const childId = originalIdOf(edge.CHILD_TICKET_ID);
    const [existing] = await execute<{ ID: string }>(
      `SELECT id FROM dependencies WHERE branch_id = ? AND parent_ticket_id = ? AND child_ticket_id = ?`,
      [trunkBranchId, parentId, childId]
    );
    if (!existing) {
      await execute(
        `INSERT INTO dependencies (id, branch_id, parent_ticket_id, child_ticket_id) VALUES (?, ?, ?, ?)`,
        [randomUUID(), trunkBranchId, parentId, childId]
      );
    }
  }

  await execute(`DELETE FROM dependencies WHERE branch_id = ?`, [branchId]);
  if (copiedTickets.length > 0) {
    await execute(
      `DELETE FROM tickets WHERE id IN (${copiedTickets.map(() => "?").join(",")})`,
      copiedTickets.map((t) => t.ID)
    );
  }

  await execute(`UPDATE branches SET status = 'merged' WHERE id = ?`, [branchId]);
}
