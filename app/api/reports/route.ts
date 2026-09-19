import { randomUUID } from "crypto";
import { writeFile } from "fs/promises";
import path from "path";
// Must be imported before "pdf-parse" — sets up its PDF.js worker correctly for
// Next.js/serverless environments. See pdf-parse's troubleshooting docs ("Setting
// up fake worker failed" / "Cannot find module ... pdf.worker.mjs").
import "pdf-parse/worker";
import { PDFParse } from "pdf-parse";
import { NextRequest, NextResponse } from "next/server";
import { execute, now } from "@/lib/db";
import { checkGptZero } from "@/lib/gptzero";

const MAX_PDF_BYTES = 10 * 1024 * 1024; // 10MB — plenty for a text progress report
const NO_TEXT_PLACEHOLDER = "(no extractable text found in PDF)";

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
  const formData = await req.formData();
  const ticketId = formData.get("ticketId");
  const pdf = formData.get("pdf");

  if (typeof ticketId !== "string" || !ticketId) {
    return NextResponse.json({ error: "ticketId is required" }, { status: 400 });
  }
  if (!(pdf instanceof File) || pdf.type !== "application/pdf") {
    return NextResponse.json({ error: "A PDF file is required" }, { status: 400 });
  }
  if (pdf.size > MAX_PDF_BYTES) {
    return NextResponse.json({ error: "PDF exceeds the 10MB limit" }, { status: 400 });
  }

  const buffer = Buffer.from(await pdf.arrayBuffer());
  const filename = `${randomUUID()}.pdf`;
  await writeFile(path.join(process.cwd(), "public", "uploads", filename), buffer);
  const mediaUrl = `/uploads/${filename}`;

  // Text-layer extraction (not OCR) — see docs/plan.md for why: true OCR needs a
  // rasterize-then-recognize pipeline and risks a synchronous-request timeout, and
  // GPTZero's own file-upload endpoint does the same text-layer extraction anyway.
  // A scanned/handwritten PDF with no text layer degrades to the placeholder below
  // rather than crashing the submission.
  const parser = new PDFParse({ data: buffer });
  // Join per-page text ourselves rather than using the result's own `.text` —
  // that field interleaves "-- N of M --" page-separator markers meant for
  // human/CLI reading, not for showing the owner a clean report body.
  const { pages } = await parser.getText();
  await parser.destroy();
  const extractedText = pages
    .map((p) => p.text.trim())
    .filter(Boolean)
    .join("\n\n");
  const reportText = extractedText || NO_TEXT_PLACEHOLDER;

  // Real, visible check — but advisory only. See lib/gptzero.ts and docs/plan.md:
  // it never blocks submission, regardless of score or availability. Skipped
  // entirely (not just "unavailable") when there's no extracted text to check.
  const { score, flag } = extractedText
    ? await checkGptZero(extractedText)
    : { score: null, flag: "unavailable" as const };

  const id = randomUUID();
  await execute(
    `INSERT INTO reports
       (id, ticket_id, submitted_by_role, report_text, media_url, gptzero_score, gptzero_flag)
     VALUES (?, ?, 'contractor', ?, ?, ?, ?)`,
    [id, ticketId, reportText, mediaUrl, score, flag]
  );

  await execute(
    `UPDATE tickets SET status = 'in_progress', updated_at = ${now()}
     WHERE id = ? AND status != 'done'`,
    [ticketId]
  );

  return NextResponse.json({ id, gptzeroScore: score, gptzeroFlag: flag }, { status: 201 });
}
