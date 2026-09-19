"use client";

import { useCallback, useEffect, useState } from "react";
import { BranchBar } from "@/components/BranchBar";
import { DagView } from "@/components/DagView";
import { TicketPanel } from "@/components/TicketPanel";
import type { Branch, Dependency, Ticket } from "@/lib/types";

export default function Home() {
  const [projectId, setProjectId] = useState<string | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [currentBranchId, setCurrentBranchId] = useState<string | null>(null);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [dependencies, setDependencies] = useState<Dependency[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/projects")
      .then((r) => r.json())
      .then((projects: { ID: string }[]) => {
        if (projects[0]) setProjectId(projects[0].ID);
      });
  }, []);

  const loadBranches = useCallback(async () => {
    if (!projectId) return [];
    const list: Branch[] = await fetch(`/api/branches?projectId=${projectId}`).then((r) =>
      r.json()
    );
    setBranches(list);
    return list;
  }, [projectId]);

  useEffect(() => {
    loadBranches().then((list) => {
      if (!currentBranchId) {
        const trunk = list.find((b) => !b.FORKED_FROM_BRANCH_ID);
        if (trunk) setCurrentBranchId(trunk.ID);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const loadGraph = useCallback(async () => {
    if (!currentBranchId) return;
    const { tickets, dependencies } = await fetch(
      `/api/graph?branchId=${currentBranchId}`
    ).then((r) => r.json());
    setTickets(tickets);
    setDependencies(dependencies);
  }, [currentBranchId]);

  useEffect(() => {
    loadGraph();
  }, [loadGraph]);

  const selectedTicket = tickets.find((t) => t.ID === selectedId) ?? null;

  const handleFork = async (ticket: Ticket) => {
    const name = window.prompt(
      `Name this alternate timeline (forking at "${ticket.TITLE}"):`,
      `${ticket.TITLE} — delayed`
    );
    if (!name || !projectId || !currentBranchId) return;
    const branch = await fetch("/api/branches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId,
        fromBranchId: currentBranchId,
        forkTicketId: ticket.ID,
        name,
      }),
    }).then((r) => r.json());
    await loadBranches();
    setCurrentBranchId(branch.ID);
  };

  const handleMerge = async () => {
    if (!currentBranchId) return;
    setMerging(true);
    setError(null);
    try {
      const res = await fetch(`/api/branches/${currentBranchId}/merge`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json();
        setError(body.error ?? "Merge failed");
        return;
      }
      const list = await loadBranches();
      const trunk = list.find((b) => !b.FORKED_FROM_BRANCH_ID);
      if (trunk) setCurrentBranchId(trunk.ID);
    } finally {
      setMerging(false);
    }
  };

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 p-6">
      <div>
        <h1 className="text-2xl font-semibold">JENGA</h1>
        <p className="text-sm text-zinc-500">
          Construction tickets as a dependency graph — fork alternate timelines, verify
          progress, merge back in.
        </p>
      </div>

      <BranchBar
        branches={branches}
        currentBranchId={currentBranchId}
        onSelectBranch={setCurrentBranchId}
        onMerge={handleMerge}
        merging={merging}
      />

      {error && (
        <p className="rounded border border-red-300 bg-red-50 p-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[2fr_1fr]">
        <DagView
          tickets={tickets}
          dependencies={dependencies}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
        <TicketPanel
          ticket={selectedTicket}
          onChanged={loadGraph}
          onForkRequested={handleFork}
        />
      </div>
    </main>
  );
}
