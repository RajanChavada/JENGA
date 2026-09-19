import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { execute, now } from "@/lib/db";
import { wouldCreateCycle } from "@/lib/dag";
import type { Ticket } from "@/lib/types";

export async function POST(req: NextRequest) {
  const { branchId, parentTicketId, childTicketId } = await req.json();
  if (!branchId || !parentTicketId || !childTicketId) {
    return NextResponse.json(
      { error: "branchId, parentTicketId and childTicketId are required" },
      { status: 400 }
    );
  }

  if (await wouldCreateCycle(branchId, parentTicketId, childTicketId)) {
    return NextResponse.json(
      { error: "That dependency would create a cycle in the DAG" },
      { status: 409 }
    );
  }

  await execute(
    `INSERT INTO dependencies (id, branch_id, parent_ticket_id, child_ticket_id) VALUES (?, ?, ?, ?)`,
    [randomUUID(), branchId, parentTicketId, childTicketId]
  );

  // AND-join: a newly-dependent child can't stay 'ready' if its new parent isn't done yet.
  const [parent] = await execute<Ticket>(`SELECT * FROM tickets WHERE id = ?`, [
    parentTicketId,
  ]);
  const [child] = await execute<Ticket>(`SELECT * FROM tickets WHERE id = ?`, [
    childTicketId,
  ]);
  if (parent.STATUS !== "done" && child.STATUS === "ready") {
    await execute(
      `UPDATE tickets SET status = 'blocked', updated_at = ${now()} WHERE id = ?`,
      [childTicketId]
    );
  }

  return NextResponse.json({ ok: true }, { status: 201 });
}
