import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { execute } from "@/lib/db";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { projectId, branchId, title, description, plannedStart, plannedEnd } = body;
  if (!projectId || !branchId || !title) {
    return NextResponse.json(
      { error: "projectId, branchId and title are required" },
      { status: 400 }
    );
  }

  const id = randomUUID();
  await execute(
    `INSERT INTO tickets
       (id, project_id, branch_id, title, description, status, planned_start, planned_end, original_planned_end)
     VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, ?)`,
    [
      id,
      projectId,
      branchId,
      title,
      description ?? null,
      plannedStart ?? null,
      plannedEnd ?? null,
      plannedEnd ?? null,
    ]
  );

  return NextResponse.json({ id }, { status: 201 });
}
