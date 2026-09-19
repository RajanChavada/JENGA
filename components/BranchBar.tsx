"use client";

import { useRole } from "@/lib/role-context";
import type { Branch } from "@/lib/types";

interface ProjectOption {
  ID: string;
  NAME: string;
}

export function BranchBar({
  projects,
  currentProjectId,
  onSelectProjectAction,
  branches,
  currentBranchId,
  onSelectBranchAction,
  onMergeAction,
  merging,
}: {
  projects: ProjectOption[];
  currentProjectId: string | null;
  onSelectProjectAction: (id: string) => void;
  branches: Branch[];
  currentBranchId: string | null;
  onSelectBranchAction: (id: string) => void;
  onMergeAction: () => void;
  merging: boolean;
}) {
  const { role, setRole } = useRole();
  const currentBranch = branches.find((b) => b.ID === currentBranchId);
  const canMerge = role === "owner" && currentBranch?.FORKED_FROM_BRANCH_ID && currentBranch.STATUS === "active";

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border p-3">
      <label className="flex items-center gap-2 text-sm">
        Project
        <select
          className="rounded border px-2 py-1"
          value={currentProjectId ?? ""}
          onChange={(e) => onSelectProjectAction(e.target.value)}
        >
          {projects.map((p) => (
            <option key={p.ID} value={p.ID}>
              {p.NAME}
            </option>
          ))}
        </select>
      </label>

      <label className="flex items-center gap-2 text-sm">
        Viewing as
        <select
          className="rounded border px-2 py-1"
          value={role}
          onChange={(e) => setRole(e.target.value as "owner" | "contractor")}
        >
          <option value="owner">Project Owner</option>
          <option value="contractor">Construction Company</option>
        </select>
      </label>

      <label className="flex items-center gap-2 text-sm">
        Timeline
        <select
          className="rounded border px-2 py-1"
          value={currentBranchId ?? ""}
          onChange={(e) => onSelectBranchAction(e.target.value)}
        >
          {branches.map((b) => (
            <option key={b.ID} value={b.ID}>
              {b.NAME} {b.STATUS === "merged" ? "(merged)" : ""}
            </option>
          ))}
        </select>
      </label>

      {canMerge && (
        <button
          disabled={merging}
          className="rounded bg-purple-600 px-3 py-1 text-sm text-white disabled:opacity-50"
          onClick={onMergeAction}
        >
          Merge into trunk
        </button>
      )}
    </div>
  );
}
