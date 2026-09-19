import { NextRequest, NextResponse } from "next/server";
import { execute } from "@/lib/db";
import { forkBranch } from "@/lib/branch";
import type { Branch } from "@/lib/types";

export async function GET(req: NextRequest) {
  const projectId = req.nextUrl.searchParams.get("projectId");
  if (!projectId) {
    return NextResponse.json({ error: "projectId is required" }, { status: 400 });
  }
  const branches = await execute<Branch>(
    `SELECT * FROM branches WHERE project_id = ? ORDER BY forked_at`,
    [projectId]
  );
  return NextResponse.json(branches);
}

export async function POST(req: NextRequest) {
  const { projectId, fromBranchId, forkTicketId, name } = await req.json();
  if (!projectId || !fromBranchId || !forkTicketId || !name) {
    return NextResponse.json(
      { error: "projectId, fromBranchId, forkTicketId and name are required" },
      { status: 400 }
    );
  }
  const branch = await forkBranch(projectId, fromBranchId, forkTicketId, name);
  return NextResponse.json(branch, { status: 201 });
}
