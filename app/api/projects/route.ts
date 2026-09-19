import { NextResponse } from "next/server";
import { execute } from "@/lib/db";

export async function GET() {
  const projects = await execute(`SELECT * FROM projects ORDER BY created_at`);
  return NextResponse.json(projects);
}
