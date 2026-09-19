import { config } from "dotenv";
// Next.js loads .env.local itself; this script runs standalone, so load it explicitly.
config({ path: ".env.local" });

import { randomUUID } from "crypto";
import { execute, now } from "../lib/db";

async function createProject(name: string): Promise<string> {
  const id = randomUUID();
  await execute(`INSERT INTO projects (id, name) VALUES (?, ?)`, [id, name]);
  return id;
}

async function createTrunkBranch(projectId: string): Promise<string> {
  const id = randomUUID();
  await execute(
    `INSERT INTO branches (id, project_id, name, status) VALUES (?, ?, 'trunk', 'active')`,
    [id, projectId]
  );
  return id;
}

async function createTicket(
  projectId: string,
  branchId: string,
  title: string,
  description: string,
  status: string,
  plannedStart: string,
  plannedEnd: string
): Promise<string> {
  const id = randomUUID();
  await execute(
    `INSERT INTO tickets (id, project_id, branch_id, title, description, status, planned_start, planned_end)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, projectId, branchId, title, description, status, plannedStart, plannedEnd]
  );
  return id;
}

async function createDependency(branchId: string, parentId: string, childId: string): Promise<void> {
  await execute(
    `INSERT INTO dependencies (id, branch_id, parent_ticket_id, child_ticket_id) VALUES (?, ?, ?, ?)`,
    [randomUUID(), branchId, parentId, childId]
  );
}

/** Seeds an approved, closed-out report on a `done` ticket — history, not a live GPTZero call. */
async function createApprovedReport(
  ticketId: string,
  reportText: string,
  mediaUrl: string,
  gptzeroScore: number
): Promise<void> {
  await execute(
    `INSERT INTO reports
       (id, ticket_id, submitted_by_role, report_text, media_url, gptzero_score, gptzero_flag,
        owner_decision, decided_at)
     VALUES (?, ?, 'contractor', ?, ?, ?, 'human', 'approved', ${now()})`,
    [randomUUID(), ticketId, reportText, mediaUrl, gptzeroScore]
  );
}

/**
 * Original demo scenario (docs/plan.md → Demo Script): a road-resurfacing job
 * with fan-in/fan-out for AND-join and branching demos.
 */
async function seedRoute12() {
  const projectId = await createProject("Route 12 Resurfacing");
  const trunkBranchId = await createTrunkBranch(projectId);

  const ticket = (title: string, description: string, plannedStart: string, plannedEnd: string) =>
    createTicket(projectId, trunkBranchId, title, description, "ready", plannedStart, plannedEnd);

  const clearing = await ticket(
    "Site Survey & Clearing",
    "Clear vegetation and debris along the 2km Route 12 corridor.",
    "2026-10-01",
    "2026-10-04"
  );
  const trucking = await ticket(
    "Truck Logistics Scheduling",
    "Line up asphalt and aggregate delivery trucks for the paving window.",
    "2026-10-01",
    "2026-10-05"
  );
  const grading = await ticket(
    "Height Clearance & Grading",
    "Grade the roadbed and clear overhead obstructions for paving equipment.",
    "2026-10-05",
    "2026-10-09"
  );
  const segmentA = await ticket(
    "Segment A Paving (km 0-1)",
    "Pave the first kilometer segment.",
    "2026-10-10",
    "2026-10-13"
  );
  const segmentB = await ticket(
    "Segment B Paving (km 1-2)",
    "Pave the second kilometer segment.",
    "2026-10-10",
    "2026-10-13"
  );
  const painting = await ticket(
    "Line Painting & Signage",
    "Paint lane markings and install signage once both segments are paved.",
    "2026-10-14",
    "2026-10-15"
  );

  await createDependency(trunkBranchId, clearing, grading);
  await createDependency(trunkBranchId, grading, segmentA);
  await createDependency(trunkBranchId, trucking, segmentA);
  await createDependency(trunkBranchId, grading, segmentB);
  await createDependency(trunkBranchId, trucking, segmentB);
  await createDependency(trunkBranchId, segmentA, painting);
  await createDependency(trunkBranchId, segmentB, painting);

  // Everything with an unmet dependency starts blocked; only the two roots stay ready.
  await execute(`UPDATE tickets SET status = 'blocked' WHERE id IN (?, ?, ?, ?)`, [
    grading,
    segmentA,
    segmentB,
    painting,
  ]);

  console.log(`Seeded project ${projectId} (Route 12 Resurfacing) on trunk branch ${trunkBranchId}`);
}

/**
 * Real-world demo scenario: Toronto's Line 5 Eglinton Crosstown LRT — see
 * docs/plan.md "Real Demo Dataset" for the research this is grounded in.
 * Dates and dependency structure reflect the real, publicly-reported project
 * history. All tickets except the last are seeded `done` with an approved
 * report attached (3 link real Metrolinx/Auditor-General PDFs; the rest link
 * synthetic one-pagers from scripts/generate-eglinton-pdfs.ts, grounded in the
 * same real facts). The last ticket is left `in_progress` with no report, for
 * a live PDF-upload demo through the real pipeline.
 */
async function seedEglintonCrosstown() {
  const projectId = await createProject("Line 5 Eglinton Crosstown LRT");
  const trunkBranchId = await createTrunkBranch(projectId);
  const REF = "/reference-docs/eglinton";

  const done = (title: string, description: string, start: string, end: string) =>
    createTicket(projectId, trunkBranchId, title, description, "done", start, end);

  const utilityRelocation = await done(
    "Utility Relocation & Early Works",
    "Relocate municipal and private utilities along the Eglinton Ave corridor ahead of tunnel boring and surface construction.",
    "2011-06-01",
    "2012-12-31"
  );
  const tunnelBoring = await done(
    "Tunnel Boring — Central Underground Section",
    "Twin 10km bore tunnels for the central underground section, TBMs 'Dennis' and 'Lea' launched from Keelesdale.",
    "2013-06-01",
    "2016-08-31"
  );
  const scheduleSettlement2018 = await done(
    "2018 Schedule-Recovery Settlement",
    "Metrolinx–CTS settlement intended to protect the September 2021 target; reviewed in the Auditor General of Ontario's 2018 Annual Report.",
    "2018-01-01",
    "2018-12-15"
  );
  const undergroundStations = await done(
    "Underground Station Construction",
    "Excavation and structural build-out at each underground station along the bored section.",
    "2016-09-01",
    "2019-12-31"
  );
  const surfaceStations = await done(
    "Surface / At-Grade Station Construction",
    "Surface stop construction along the western and eastern at-grade sections (25 stops/stations total on the 19km line).",
    "2014-01-01",
    "2020-06-30"
  );
  const lrvDelivery = await done(
    "LRV Delivery & Storage Facility Readiness",
    "Light rail vehicle delivery and readiness of the Mount Dennis maintenance/storage facility.",
    "2019-01-01",
    "2021-05-25"
  );
  const trackInstallation = await done(
    "Track Installation",
    "Rail installation across the full alignment, completed with the final rail clip in November 2021.",
    "2019-01-01",
    "2021-11-30"
  );
  const systemsInstallation = await done(
    "Systems Installation (Power, Signaling, Communications)",
    "Overhead/third-rail power, signaling, and communications systems installed and commissioned section by section.",
    "2020-01-01",
    "2022-06-30"
  );
  const vehicleTesting = await done(
    "Vehicle Testing — Static & Dynamic",
    "Static clearance testing followed by dynamic coupled-car, speed, braking, and signal/comms testing.",
    "2021-06-01",
    "2021-09-30"
  );
  const threeCarTesting = await done(
    "Full 3-Car Train Testing",
    "Full-length 3-car train consist testing across the alignment.",
    "2022-01-01",
    "2022-12-31"
  );
  const litigation2023 = await done(
    "CTS v. Metrolinx Litigation & Settlement",
    "CTS sued Metrolinx over disputed scope changes; Metrolinx cited out-of-spec track work and withheld payments. Settled November 2023.",
    "2023-05-01",
    "2023-11-30"
  );
  const integrationTesting = await done(
    "Integration & Revenue-Service Testing",
    "Integration testing and revenue-service readiness work across the alignment following the CTS settlement.",
    "2024-01-01",
    "2024-12-31"
  );
  const substantialCompletion = await done(
    "Substantial Completion & TTC Handover",
    "Substantial completion declared section by section; progressive handover from Metrolinx/CTS to the TTC.",
    "2025-01-01",
    "2025-06-30"
  );
  const launchPrep = await createTicket(
    projectId,
    trunkBranchId,
    "Revenue Service Launch Prep",
    "Final TTC operational readiness and launch preparation ahead of public revenue service (actual opening: February 8, 2026).",
    "in_progress",
    "2025-07-01",
    "2026-02-08"
  );

  await createDependency(trunkBranchId, utilityRelocation, tunnelBoring);
  await createDependency(trunkBranchId, tunnelBoring, scheduleSettlement2018);
  await createDependency(trunkBranchId, tunnelBoring, undergroundStations);
  await createDependency(trunkBranchId, utilityRelocation, surfaceStations);
  await createDependency(trunkBranchId, utilityRelocation, lrvDelivery);
  await createDependency(trunkBranchId, undergroundStations, trackInstallation);
  await createDependency(trunkBranchId, surfaceStations, trackInstallation);
  await createDependency(trunkBranchId, trackInstallation, systemsInstallation);
  await createDependency(trunkBranchId, lrvDelivery, vehicleTesting);
  await createDependency(trunkBranchId, systemsInstallation, vehicleTesting);
  await createDependency(trunkBranchId, vehicleTesting, threeCarTesting);
  await createDependency(trunkBranchId, threeCarTesting, litigation2023);
  await createDependency(trunkBranchId, litigation2023, integrationTesting);
  await createDependency(trunkBranchId, integrationTesting, substantialCompletion);
  await createDependency(trunkBranchId, substantialCompletion, launchPrep);

  // Real, external, verified-working (HTTP 200, application/pdf) source documents —
  // linked directly rather than re-hosted. See docs/plan.md for the URLs' provenance.
  await createApprovedReport(
    scheduleSettlement2018,
    "Following schedule pressure on the Eglinton Crosstown program, Metrolinx and Crosslinx Transit Solutions (CTS) reached a settlement in 2018 intended to protect the September 2021 revenue service target. The Auditor General of Ontario's 2018 Annual Report (Section 3.07, \"Metrolinx — LRT Construction and Infrastructure Planning\") reviewed the arrangement, including a $237 million payment made to CTS, and raised concerns about contract oversight and how the payment was assessed.",
    "https://www.auditor.on.ca/en/content/annualreports/arreports/en18/v1_307en18.pdf",
    0.08
  );
  await createApprovedReport(
    litigation2023,
    "In May 2023, Crosslinx Transit Solutions (CTS) filed suit against Metrolinx over disputed scope changes driven by TTC requirements, describing \"shifting goalposts\" on project requirements. Metrolinx countered that delivered track work was outside contracted specifications and that testing/commissioning was behind schedule, and withheld progress payments during the dispute. A settlement was reached in November 2023; Metrolinx's November 30, 2023 board minutes record five major workstreams nearing completion and most road restrictions lifted along the 19km alignment.",
    "https://assets.metrolinx.com/image/upload/v1714507261/Documents/Metrolinx/November_30_2023_Board_Minutes_-_Final_-_red_Tracey_Duncan.pdf",
    0.11
  );
  await createApprovedReport(
    integrationTesting,
    "With the CTS dispute settled, integration testing and revenue-service readiness work is proceeding across the alignment. Metrolinx's Capital Projects — Rapid Transit quarterly report to the Board (September 2024) covers status across the agency's rapid transit program, including continued Eglinton Crosstown testing/readiness activity and progress on the related Eglinton Crosstown West Extension tunnel boring.",
    "https://assets.metrolinx.com/image/upload/v1725569100/Documents/Item_15.5_-_Capital_Projects_Rapid_Transit_En_Sept_2024.pdf",
    0.06
  );

  // Synthetic one-pagers (scripts/generate-eglinton-pdfs.ts), text matches the PDFs exactly.
  await createApprovedReport(
    utilityRelocation,
    "Early works and utility relocation along the Eglinton Avenue corridor are underway, clearing the way for tunnel boring and surface construction to follow.\n\nMunicipal and private utilities (water, gas, telecom, hydro) are being identified and relocated in advance of the tunnel boring launch shaft and surface guideway excavation.\n\nThis phase follows the November 2011 announcement targeting a 2020 revenue service opening for the Eglinton Crosstown LRT.",
    `${REF}/01-utility-relocation.pdf`,
    0.09
  );
  await createApprovedReport(
    tunnelBoring,
    "Tunnel boring machines 'Dennis' and 'Lea' were launched in June 2013 from the Black Creek Drive / Eglinton Avenue West launch shaft near Keelesdale, boring westward.\n\nThe twin 10km bore tunnels forming the central underground section of the alignment were completed in August 2016.\n\nCompletion of tunnelling unblocks underground station excavation and structural work at each of the underground stops along the bored section.",
    `${REF}/02-tunnel-boring.pdf`,
    0.07
  );
  await createApprovedReport(
    undergroundStations,
    "Following tunnel boring completion, excavation and structural build-out is proceeding at each underground station along the central section.\n\nWork includes station box excavation, concrete structure, platform construction, and rough-in for systems to follow (power, signaling, communications, fare gates).\n\nStation construction is sequenced across multiple sites concurrently to keep the overall program on the critical path.",
    `${REF}/04-underground-stations.pdf`,
    0.1
  );
  await createApprovedReport(
    surfaceStations,
    "Surface stop construction is proceeding along the western and eastern at-grade sections of the 19km alignment, part of 25 total stops and stations on the line.\n\nThis work runs in parallel with the underground tunnel and station program, since at-grade stops do not depend on tunnel completion.\n\nPlatform, shelter, and streetscape work is being coordinated with the City of Toronto along the surface right-of-way.",
    `${REF}/05-surface-stations.pdf`,
    0.12
  );
  await createApprovedReport(
    lrvDelivery,
    "Light rail vehicle (LRV) delivery and the readiness of the Mount Dennis maintenance and storage facility are proceeding in parallel with the civil construction program.\n\nThe first LRVs moved onto the property at Rosemount Dr. starting May 25, 2021, ahead of on-alignment testing.\n\nVehicle delivery has experienced its own schedule pressure separate from the civil works — an early contractual test-car delivery milestone originally due in 2014 slipped by several years.",
    `${REF}/06-lrv-delivery.pdf`,
    0.08
  );
  await createApprovedReport(
    trackInstallation,
    "Rail installation is proceeding across the full alignment following station and guideway structural completion in each section.\n\nTrack installation reached 100% completion in November 2021, with the final rail clip fastened on the last remaining section.\n\nCompletion of track installation unblocks systems installation (power, signaling, communications) across the full line.",
    `${REF}/07-track-installation.pdf`,
    0.05
  );
  await createApprovedReport(
    systemsInstallation,
    "Overhead and third-rail power, signaling, and communications systems installation is proceeding section by section following track completion.\n\nCommissioning of completed segments is continuing into 2022 even as initial vehicle testing has begun on sections signed off earlier — phased commissioning is running alongside early-phase vehicle testing rather than strictly ahead of it.\n\nSystems integration is the long pole for the remaining schedule; testing activities are sequenced against systems sign-off per segment.",
    `${REF}/08-systems-installation.pdf`,
    0.13
  );
  await createApprovedReport(
    vehicleTesting,
    "Static clearance testing (walking-pace, 0-5 km/h) began in June 2021 to verify vehicle-to-infrastructure clearances along the alignment.\n\nDynamic testing followed through the summer — coupled-car operation, higher-speed running, braking performance, and communications/signal integration.\n\nTesting is proceeding on sections where systems commissioning is complete, with additional sections added as their commissioning finishes.",
    `${REF}/09-vehicle-testing.pdf`,
    0.07
  );
  await createApprovedReport(
    threeCarTesting,
    "Full-length 3-car train consist testing is proceeding across the alignment throughout 2022, building on the single/coupled-car testing completed in 2021.\n\nThis phase validates full-consist performance, platform berthing, and system response under representative in-service train lengths.\n\nResults from this phase feed directly into the integration and revenue-service testing program.",
    `${REF}/10-three-car-testing.pdf`,
    0.09
  );
  await createApprovedReport(
    substantialCompletion,
    "Substantial completion is being declared section by section as integration and revenue-service testing wraps up across the alignment.\n\nProgressive handover from Metrolinx / Crosslinx Transit Solutions (CTS) to the TTC for operations and maintenance training is underway.\n\nThis phase directly precedes final launch preparation ahead of public revenue service.",
    `${REF}/13-substantial-completion.pdf`,
    0.06
  );

  console.log(
    `Seeded project ${projectId} (Line 5 Eglinton Crosstown LRT) on trunk branch ${trunkBranchId}`
  );
}

async function main() {
  await seedRoute12();
  await seedEglintonCrosstown();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
