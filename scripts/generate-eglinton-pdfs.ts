import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

/**
 * One-time generator for the synthetic Eglinton Crosstown demo report PDFs
 * (see docs/plan.md "Real Demo Dataset"). Output is committed to
 * public/reference-docs/eglinton/ — this script doesn't need to run again
 * unless a report's content changes. Content is grounded in real, researched
 * project dates/facts; it's still a synthesized document, not a real CTS
 * filing, and is labelled as such on the page.
 */

interface ReportSpec {
  slug: string;
  title: string;
  dateRange: string;
  body: string[];
}

const REPORTS: ReportSpec[] = [
  {
    slug: "01-utility-relocation",
    title: "Utility Relocation & Early Works",
    dateRange: "June 2011 - December 2012",
    body: [
      "Early works and utility relocation along the Eglinton Avenue corridor are underway, clearing the way for tunnel boring and surface construction to follow.",
      "Municipal and private utilities (water, gas, telecom, hydro) are being identified and relocated in advance of the tunnel boring launch shaft and surface guideway excavation.",
      "This phase follows the November 2011 announcement targeting a 2020 revenue service opening for the Eglinton Crosstown LRT.",
    ],
  },
  {
    slug: "02-tunnel-boring",
    title: "Tunnel Boring - Central Underground Section",
    dateRange: "June 2013 - August 2016",
    body: [
      "Tunnel boring machines 'Dennis' and 'Lea' were launched in June 2013 from the Black Creek Drive / Eglinton Avenue West launch shaft near Keelesdale, boring westward.",
      "The twin 10km bore tunnels forming the central underground section of the alignment were completed in August 2016.",
      "Completion of tunnelling unblocks underground station excavation and structural work at each of the underground stops along the bored section.",
    ],
  },
  {
    slug: "04-underground-stations",
    title: "Underground Station Construction",
    dateRange: "September 2016 - December 2019",
    body: [
      "Following tunnel boring completion, excavation and structural build-out is proceeding at each underground station along the central section.",
      "Work includes station box excavation, concrete structure, platform construction, and rough-in for systems to follow (power, signaling, communications, fare gates).",
      "Station construction is sequenced across multiple sites concurrently to keep the overall program on the critical path.",
    ],
  },
  {
    slug: "05-surface-stations",
    title: "Surface / At-Grade Station Construction",
    dateRange: "January 2014 - June 2020",
    body: [
      "Surface stop construction is proceeding along the western and eastern at-grade sections of the 19km alignment, part of 25 total stops and stations on the line.",
      "This work runs in parallel with the underground tunnel and station program, since at-grade stops do not depend on tunnel completion.",
      "Platform, shelter, and streetscape work is being coordinated with the City of Toronto along the surface right-of-way.",
    ],
  },
  {
    slug: "06-lrv-delivery",
    title: "LRV Delivery & Storage Facility Readiness",
    dateRange: "January 2019 - May 2021",
    body: [
      "Light rail vehicle (LRV) delivery and the readiness of the Mount Dennis maintenance and storage facility are proceeding in parallel with the civil construction program.",
      "The first LRVs moved onto the property at Rosemount Dr. starting May 25, 2021, ahead of on-alignment testing.",
      "Vehicle delivery has experienced its own schedule pressure separate from the civil works - an early contractual test-car delivery milestone originally due in 2014 slipped by several years.",
    ],
  },
  {
    slug: "07-track-installation",
    title: "Track Installation",
    dateRange: "January 2019 - November 2021",
    body: [
      "Rail installation is proceeding across the full alignment following station and guideway structural completion in each section.",
      "Track installation reached 100% completion in November 2021, with the final rail clip fastened on the last remaining section.",
      "Completion of track installation unblocks systems installation (power, signaling, communications) across the full line.",
    ],
  },
  {
    slug: "08-systems-installation",
    title: "Systems Installation (Power, Signaling, Communications)",
    dateRange: "January 2020 - June 2022",
    body: [
      "Overhead and third-rail power, signaling, and communications systems installation is proceeding section by section following track completion.",
      "Commissioning of completed segments is continuing into 2022 even as initial vehicle testing has begun on sections signed off earlier - phased commissioning is running alongside early-phase vehicle testing rather than strictly ahead of it.",
      "Systems integration is the long pole for the remaining schedule; testing activities are sequenced against systems sign-off per segment.",
    ],
  },
  {
    slug: "09-vehicle-testing",
    title: "Vehicle Testing - Static & Dynamic",
    dateRange: "June 2021 - September 2021",
    body: [
      "Static clearance testing (walking-pace, 0-5 km/h) began in June 2021 to verify vehicle-to-infrastructure clearances along the alignment.",
      "Dynamic testing followed through the summer - coupled-car operation, higher-speed running, braking performance, and communications/signal integration.",
      "Testing is proceeding on sections where systems commissioning is complete, with additional sections added as their commissioning finishes.",
    ],
  },
  {
    slug: "10-three-car-testing",
    title: "Full 3-Car Train Testing",
    dateRange: "January 2022 - December 2022",
    body: [
      "Full-length 3-car train consist testing is proceeding across the alignment throughout 2022, building on the single/coupled-car testing completed in 2021.",
      "This phase validates full-consist performance, platform berthing, and system response under representative in-service train lengths.",
      "Results from this phase feed directly into the integration and revenue-service testing program.",
    ],
  },
  {
    slug: "13-substantial-completion",
    title: "Substantial Completion & TTC Handover",
    dateRange: "January 2025 - June 2025",
    body: [
      "Substantial completion is being declared section by section as integration and revenue-service testing wraps up across the alignment.",
      "Progressive handover from Metrolinx / Crosslinx Transit Solutions (CTS) to the TTC for operations and maintenance training is underway.",
      "This phase directly precedes final launch preparation ahead of public revenue service.",
    ],
  },
];

const PAGE_WIDTH = 612; // US Letter
const PAGE_HEIGHT = 792;
const MARGIN = 56;
const BODY_SIZE = 11;
const LINE_HEIGHT = 16;

function wrapText(text: string, font: import("pdf-lib").PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

async function generateOne(spec: ReportSpec): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const maxWidth = PAGE_WIDTH - MARGIN * 2;

  let y = PAGE_HEIGHT - MARGIN;

  page.drawText("Crosslinx Transit Solutions", { x: MARGIN, y, size: 10, font: bold, color: rgb(0.35, 0.35, 0.35) });
  y -= 14;
  page.drawText("Eglinton Crosstown LRT - Construction Progress Report", {
    x: MARGIN,
    y,
    size: 10,
    font: regular,
    color: rgb(0.45, 0.45, 0.45),
  });
  y -= 28;

  page.drawText(spec.title, { x: MARGIN, y, size: 18, font: bold });
  y -= 22;
  page.drawText(spec.dateRange, { x: MARGIN, y, size: 11, font: regular, color: rgb(0.4, 0.4, 0.4) });
  y -= 30;

  for (const paragraph of spec.body) {
    for (const line of wrapText(paragraph, regular, BODY_SIZE, maxWidth)) {
      page.drawText(line, { x: MARGIN, y, size: BODY_SIZE, font: regular });
      y -= LINE_HEIGHT;
    }
    y -= LINE_HEIGHT * 0.6;
  }

  y = MARGIN;
  page.drawText(
    "Synthesized for demo purposes from publicly reported project facts/dates - not an official CTS/Metrolinx filing.",
    { x: MARGIN, y, size: 8, font: regular, color: rgb(0.55, 0.55, 0.55) }
  );

  return doc.save();
}

async function main() {
  const outDir = path.join(process.cwd(), "public", "reference-docs", "eglinton");
  await mkdir(outDir, { recursive: true });
  for (const spec of REPORTS) {
    const bytes = await generateOne(spec);
    await writeFile(path.join(outDir, `${spec.slug}.pdf`), bytes);
    console.log(`wrote ${spec.slug}.pdf`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
