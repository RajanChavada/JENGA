import { NextRequest, NextResponse } from "next/server";
import { execute, now } from "@/lib/db";
import { recalcAfterStatusChange } from "@/lib/dag";
import type { Report, Ticket } from "@/lib/types";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { decision } = await req.json();
  if (decision !== "approved" && decision !== "rejected") {
    return NextResponse.json(
      { error: "decision must be 'approved' or 'rejected'" },
      { status: 400 }
    );
  }

  const [report] = await execute<Report>(`SELECT * FROM reports WHERE id = ?`, [id]);
  if (!report) return NextResponse.json({ error: "Report not found" }, { status: 404 });

  await execute(
    `UPDATE reports SET owner_decision = ?, decided_at = ${now()} WHERE id = ?`,
    [decision, id]
  );

  const newStatus = decision === "approved" ? "done" : "in_progress";
  await execute(
    `UPDATE tickets SET status = ?, updated_at = ${now()} WHERE id = ?`,
    [newStatus, report.TICKET_ID]
  );

  if (decision === "approved") {
    const [ticket] = await execute<Ticket>(`SELECT * FROM tickets WHERE id = ?`, [
      report.TICKET_ID,
    ]);
    await recalcAfterStatusChange(ticket.BRANCH_ID, ticket.ID, "done");
  }

  return NextResponse.json({ ok: true });
}
