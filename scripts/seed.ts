import { config } from "dotenv";
// Next.js loads .env.local itself; this script runs standalone, so load it explicitly.
config({ path: ".env.local" });

import { randomUUID } from "crypto";
import { execute } from "../lib/db";

/**
 * Seeds the single demo project used in the pitch (docs/plan.md → Demo Script):
 * a road-resurfacing job with real fan-in/fan-out —
 *   Site Clearing -> Grading -> {Segment A, Segment B} -> Line Painting
 * and Truck Logistics feeding both paving segments — so the demo can show
 * AND-join blocking, delay ripple, and a believable place to fork a branch
 * (e.g. "what if we reroute the trucks").
 */
async function main() {
  const projectId = randomUUID();
  await execute(`INSERT INTO projects (id, name) VALUES (?, ?)`, [
    projectId,
    "Route 12 Resurfacing",
  ]);

  const trunkBranchId = randomUUID();
  await execute(
    `INSERT INTO branches (id, project_id, name, status) VALUES (?, ?, 'trunk', 'active')`,
    [trunkBranchId, projectId]
  );

  const ticket = async (
    title: string,
    description: string,
    plannedStart: string,
    plannedEnd: string
  ) => {
    const id = randomUUID();
    await execute(
      `INSERT INTO tickets
         (id, project_id, branch_id, title, description, status, planned_start, planned_end)
       VALUES (?, ?, ?, ?, ?, 'ready', ?, ?)`,
      [id, projectId, trunkBranchId, title, description, plannedStart, plannedEnd]
    );
    return id;
  };

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

  const dependsOn = async (parent: string, child: string) => {
    await execute(
      `INSERT INTO dependencies (id, branch_id, parent_ticket_id, child_ticket_id) VALUES (?, ?, ?, ?)`,
      [randomUUID(), trunkBranchId, parent, child]
    );
  };

  await dependsOn(clearing, grading);
  await dependsOn(grading, segmentA);
  await dependsOn(trucking, segmentA);
  await dependsOn(grading, segmentB);
  await dependsOn(trucking, segmentB);
  await dependsOn(segmentA, painting);
  await dependsOn(segmentB, painting);

  // Everything with an unmet dependency starts blocked; only the two roots stay ready.
  await execute(
    `UPDATE tickets SET status = 'blocked'
     WHERE id IN (?, ?, ?, ?)`,
    [grading, segmentA, segmentB, painting]
  );

  console.log(`Seeded project ${projectId} on trunk branch ${trunkBranchId}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
