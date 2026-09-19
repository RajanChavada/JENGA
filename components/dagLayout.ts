import type { Dependency, Ticket } from "@/lib/types";

/** Simple layered layout: x = longest-path distance from a root, y = position within that layer. */
export function layoutDag(
  tickets: Ticket[],
  dependencies: Dependency[]
): Map<string, { x: number; y: number }> {
  const childrenOf = new Map<string, string[]>();
  const parentsOf = new Map<string, string[]>();
  for (const t of tickets) {
    childrenOf.set(t.ID, []);
    parentsOf.set(t.ID, []);
  }
  for (const d of dependencies) {
    childrenOf.get(d.PARENT_TICKET_ID)?.push(d.CHILD_TICKET_ID);
    parentsOf.get(d.CHILD_TICKET_ID)?.push(d.PARENT_TICKET_ID);
  }

  const level = new Map<string, number>();
  const roots = tickets.filter((t) => (parentsOf.get(t.ID) ?? []).length === 0);
  const queue: string[] = roots.map((r) => r.ID);
  for (const id of queue) level.set(id, 0);

  while (queue.length) {
    const id = queue.shift()!;
    const lvl = level.get(id)!;
    for (const childId of childrenOf.get(id) ?? []) {
      const candidate = lvl + 1;
      if ((level.get(childId) ?? -1) < candidate) {
        level.set(childId, candidate);
        queue.push(childId);
      }
    }
  }

  const byLevel = new Map<number, string[]>();
  for (const t of tickets) {
    const lvl = level.get(t.ID) ?? 0;
    if (!byLevel.has(lvl)) byLevel.set(lvl, []);
    byLevel.get(lvl)!.push(t.ID);
  }

  const positions = new Map<string, { x: number; y: number }>();
  for (const [lvl, ids] of byLevel) {
    ids.forEach((id, i) => positions.set(id, { x: lvl * 260, y: i * 140 }));
  }
  return positions;
}
