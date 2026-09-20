"use client";

import { useEffect, useState } from "react";
import * as api from "@/lib/api";
import type { PortalOverview, Role } from "@/lib/types";
import { useJenga } from "@/store/useJenga";

/**
 * Demo identity picker, not authentication: it chooses whose projects the rest
 * of the app shows. The parties come from the unfiltered directory, since the
 * store's own portal listing is already narrowed to the current identity.
 */
export function RoleSwitcher() {
  const role = useJenga((s) => s.role);
  const ownerId = useJenga((s) => s.ownerId);
  const companyId = useJenga((s) => s.companyId);
  const setRole = useJenga((s) => s.setRole);
  const setOwner = useJenga((s) => s.setOwner);
  const setCompany = useJenga((s) => s.setCompany);
  const [directory, setDirectory] = useState<PortalOverview | null>(null);

  useEffect(() => {
    void api.fetchPortal({}).then(setDirectory);
  }, []);

  const current = role === "owner" ? ownerId : companyId;
  const options =
    role === "owner"
      ? Array.from(
          new Map(
            (directory?.projects ?? []).map((project) => [project.owner.id, {
              id: project.owner.id,
              name: project.name,
            }]),
          ).values(),
        )
      : (directory?.companies ?? []).map((company) => ({
          id: company.id,
          name: company.name,
        }));

  return (
    <div className="flex items-center gap-2">
      <div className="flex overflow-hidden rounded-md border border-slate-200 text-xs">
        {(["owner", "contractor"] as Role[]).map((r) => (
          <button
            key={r}
            onClick={() => void setRole(r)}
            aria-pressed={role === r}
            className={`px-2.5 py-1.5 capitalize transition-colors ${
              role === r
                ? "bg-slate-900 text-white"
                : "bg-white text-slate-500 hover:bg-slate-50 hover:text-slate-900"
            }`}
          >
            {r}
          </button>
        ))}
      </div>
      <select
        aria-label={role === "owner" ? "Project owner" : "Construction company"}
        value={current}
        onChange={(e) =>
          void (role === "owner"
            ? setOwner(e.target.value)
            : setCompany(e.target.value))
        }
        className="max-w-47.5 rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-700"
      >
        {(options ?? []).map((option) => (
          <option key={option.id} value={option.id}>
            {option.name}
          </option>
        ))}
      </select>
    </div>
  );
}
