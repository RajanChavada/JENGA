"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import type { Role } from "./types";

const RoleContext = createContext<{
  role: Role;
  setRole: (role: Role) => void;
}>({ role: "owner", setRole: () => {} });

export function RoleProvider({ children }: { children: ReactNode }) {
  const [role, setRole] = useState<Role>("owner");
  return (
    <RoleContext.Provider value={{ role, setRole }}>{children}</RoleContext.Provider>
  );
}

export function useRole() {
  return useContext(RoleContext);
}
