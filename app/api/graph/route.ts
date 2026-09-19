import { NextRequest, NextResponse } from "next/server";
import { execute } from "@/lib/db";
import type { Dependency, Ticket } from "@/lib/types";

export async function GET(req: NextRequest) {
  const branchId = req.nextUrl.searchParams.get("branchId");
  if (!branchId) {
    return NextResponse.json({ error: "branchId is required" }, { status: 400 });
  }

  const tickets = await execute<Ticket>(
    `SELECT * FROM tickets WHERE branch_id = ? ORDER BY created_at`,
    [branchId]
  );
  const dependencies = await execute<Dependency>(
    `SELECT * FROM dependencies WHERE branch_id = ?`,
    [branchId]
  );

  return NextResponse.json({ tickets, dependencies });
}
