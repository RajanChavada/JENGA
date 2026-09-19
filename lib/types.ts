export type TicketStatus =
  | "blocked"
  | "ready"
  | "in_progress"
  | "done"
  | "cancelled";

export type Role = "owner" | "contractor";

export interface Ticket {
  ID: string;
  PROJECT_ID: string;
  BRANCH_ID: string;
  FORKED_FROM_ID: string | null;
  TITLE: string;
  DESCRIPTION: string | null;
  STATUS: TicketStatus;
  PLANNED_START: string | null;
  PLANNED_END: string | null;
  ORIGINAL_PLANNED_END: string | null;
  ACTUAL_START: string | null;
  ACTUAL_END: string | null;
  UPDATED_AT: string;
}

export interface Dependency {
  ID: string;
  BRANCH_ID: string;
  PARENT_TICKET_ID: string;
  CHILD_TICKET_ID: string;
}

export interface Branch {
  ID: string;
  PROJECT_ID: string;
  NAME: string;
  FORKED_FROM_BRANCH_ID: string | null;
  FORKED_FROM_TICKET_ID: string | null;
  STATUS: "active" | "merged";
}

export type GptZeroFlag = "human" | "mixed" | "ai" | "unavailable";

export interface Report {
  ID: string;
  TICKET_ID: string;
  SUBMITTED_BY_ROLE: string;
  REPORT_TEXT: string;
  MEDIA_URL: string | null;
  GPTZERO_SCORE: number | null;
  GPTZERO_FLAG: GptZeroFlag | null;
  OWNER_DECISION: "approved" | "rejected" | null;
}
