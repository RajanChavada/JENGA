import { NextRequest, NextResponse } from "next/server";
import { mergeBranch, MergeConflictError } from "@/lib/branch";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    await mergeBranch(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof MergeConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}
