import { NextRequest, NextResponse } from "next/server";
import { execute, now } from "@/lib/db";
import { recalcAfterStatusChange, shiftDownstreamDates } from "@/lib/dag";
import type { Ticket } from "@/lib/types";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json();
  const { status, plannedEnd } = body;

  const [before] = await execute<Ticket>(`SELECT * FROM tickets WHERE id = ?`, [id]);
  if (!before) return NextResponse.json({ error: "Ticket not found" }, { status: 404 });

  if (status && status !== before.STATUS) {
    await execute(
      `UPDATE tickets SET status = ?, updated_at = ${now()} WHERE id = ?`,
      [status, id]
    );
    await recalcAfterStatusChange(before.BRANCH_ID, id, status);
  }

  if (plannedEnd && plannedEnd !== before.PLANNED_END) {
    const deltaDays = Math.round(
      (new Date(plannedEnd).getTime() - new Date(before.PLANNED_END ?? plannedEnd).getTime()) /
        86_400_000
    );
    await execute(
      `UPDATE tickets SET planned_end = ?, updated_at = ${now()} WHERE id = ?`,
      [plannedEnd, id]
    );
    // A delay (or pull-forward) on this ticket ripples the same number of days
    // through every downstream descendant's planned dates.
    await shiftDownstreamDates(before.BRANCH_ID, id, deltaDays);
  }

  const [after] = await execute<Ticket>(`SELECT * FROM tickets WHERE id = ?`, [id]);
  return NextResponse.json(after);
}
