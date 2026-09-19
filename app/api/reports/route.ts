import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { execute, now } from "@/lib/db";
import { checkGptZero } from "@/lib/gptzero";

export async function GET(req: NextRequest) {
  const ticketId = req.nextUrl.searchParams.get("ticketId");
  if (!ticketId) {
    return NextResponse.json({ error: "ticketId is required" }, { status: 400 });
  }
  const reports = await execute(
    `SELECT * FROM reports WHERE ticket_id = ? ORDER BY submitted_at DESC`,
    [ticketId]
  );
  return NextResponse.json(reports);
}

export async function POST(req: NextRequest) {
  const { ticketId, reportText, mediaUrl } = await req.json();
  if (!ticketId || !reportText) {
    return NextResponse.json(
      { error: "ticketId and reportText are required" },
      { status: 400 }
    );
  }

  // Real, visible check — but advisory only. See lib/gptzero.ts and docs/plan.md:
  // it never blocks submission, regardless of score or availability.
  const { score, flag } = await checkGptZero(reportText);

  const id = randomUUID();
  await execute(
    `INSERT INTO reports
       (id, ticket_id, submitted_by_role, report_text, media_url, gptzero_score, gptzero_flag)
     VALUES (?, ?, 'contractor', ?, ?, ?, ?)`,
    [id, ticketId, reportText, mediaUrl ?? null, score, flag]
  );

  await execute(
    `UPDATE tickets SET status = 'in_progress', updated_at = ${now()}
     WHERE id = ? AND status != 'done'`,
    [ticketId]
  );

  return NextResponse.json({ id, gptzeroScore: score, gptzeroFlag: flag }, { status: 201 });
}
