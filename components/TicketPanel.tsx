"use client";

import { useEffect, useState } from "react";
import { useRole } from "@/lib/role-context";
import type { Report, Ticket } from "@/lib/types";

const FLAG_LABEL: Record<string, string> = {
  human: "Likely human-written",
  mixed: "Mixed signals",
  ai: "Flagged as possibly AI-generated",
  unavailable: "Authenticity check unavailable",
};

export function TicketPanel({
  ticket,
  onChanged,
  onForkRequested,
}: {
  ticket: Ticket | null;
  onChanged: () => void;
  onForkRequested: (ticket: Ticket) => void;
}) {
  const { role } = useRole();
  const [reports, setReports] = useState<Report[]>([]);
  const [reportText, setReportText] = useState("");
  const [mediaUrl, setMediaUrl] = useState("");
  const [delayDays, setDelayDays] = useState(3);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setReports([]);
    setReportText("");
    setMediaUrl("");
    if (!ticket) return;
    fetch(`/api/reports?ticketId=${ticket.ID}`)
      .then((r) => r.json())
      .then(setReports);
  }, [ticket]);

  if (!ticket) {
    return (
      <div className="rounded-lg border p-4 text-sm text-zinc-500">
        Select a ticket in the graph to see details and actions.
      </div>
    );
  }

  const patchTicket = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      await fetch(`/api/tickets/${ticket.ID}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const submitReport = async () => {
    if (!reportText.trim()) return;
    setBusy(true);
    try {
      await fetch("/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticketId: ticket.ID, reportText, mediaUrl: mediaUrl || null }),
      });
      setReportText("");
      setMediaUrl("");
      onChanged();
      const updated = await fetch(`/api/reports?ticketId=${ticket.ID}`).then((r) => r.json());
      setReports(updated);
    } finally {
      setBusy(false);
    }
  };

  const decide = async (reportId: string, decision: "approved" | "rejected") => {
    setBusy(true);
    try {
      await fetch(`/api/reports/${reportId}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      onChanged();
      const updated = await fetch(`/api/reports?ticketId=${ticket.ID}`).then((r) => r.json());
      setReports(updated);
    } finally {
      setBusy(false);
    }
  };

  const pendingReport = reports.find((r) => !r.OWNER_DECISION);

  return (
    <div className="flex flex-col gap-4 rounded-lg border p-4">
      <div>
        <h2 className="text-lg font-semibold">{ticket.TITLE}</h2>
        <p className="text-sm text-zinc-500">{ticket.DESCRIPTION}</p>
        <p className="mt-2 text-xs uppercase tracking-wide text-zinc-400">
          Status: <span className="font-medium">{ticket.STATUS}</span> · Planned{" "}
          {ticket.PLANNED_START} → {ticket.PLANNED_END}
        </p>
      </div>

      {role === "owner" && (
        <div className="flex flex-col gap-2 border-t pt-3">
          <div className="flex items-center gap-2">
            <input
              type="number"
              className="w-16 rounded border px-2 py-1 text-sm"
              value={delayDays}
              onChange={(e) => setDelayDays(Number(e.target.value))}
            />
            <button
              disabled={busy}
              className="rounded bg-zinc-800 px-3 py-1 text-sm text-white disabled:opacity-50"
              onClick={() => {
                const newEnd = new Date(ticket.PLANNED_END ?? Date.now());
                newEnd.setDate(newEnd.getDate() + delayDays);
                patchTicket({ plannedEnd: newEnd.toISOString().slice(0, 10) });
              }}
            >
              Delay by N days (ripples downstream)
            </button>
          </div>
          <div className="flex gap-2">
            <button
              disabled={busy || ticket.STATUS === "cancelled"}
              className="rounded bg-red-600 px-3 py-1 text-sm text-white disabled:opacity-50"
              onClick={() => patchTicket({ status: "cancelled" })}
            >
              Cancel ticket
            </button>
            <button
              disabled={busy}
              className="rounded border px-3 py-1 text-sm"
              onClick={() => onForkRequested(ticket)}
            >
              Fork alternate timeline here
            </button>
          </div>
        </div>
      )}

      {role === "contractor" && ticket.STATUS === "ready" && (
        <button
          disabled={busy}
          className="rounded bg-blue-600 px-3 py-1 text-sm text-white disabled:opacity-50"
          onClick={() => patchTicket({ status: "in_progress" })}
        >
          Start work
        </button>
      )}

      {role === "contractor" && ticket.STATUS === "in_progress" && (
        <div className="flex flex-col gap-2 border-t pt-3">
          <textarea
            className="rounded border p-2 text-sm"
            rows={3}
            placeholder="Progress report..."
            value={reportText}
            onChange={(e) => setReportText(e.target.value)}
          />
          <input
            className="rounded border p-2 text-sm"
            placeholder="Photo/video URL (optional)"
            value={mediaUrl}
            onChange={(e) => setMediaUrl(e.target.value)}
          />
          <button
            disabled={busy || !reportText.trim()}
            className="self-start rounded bg-blue-600 px-3 py-1 text-sm text-white disabled:opacity-50"
            onClick={submitReport}
          >
            Submit report
          </button>
        </div>
      )}

      {role === "owner" && pendingReport && (
        <div className="flex flex-col gap-2 rounded border border-amber-300 bg-amber-50 p-3 text-sm">
          <p className="font-medium">Pending report</p>
          <p>{pendingReport.REPORT_TEXT}</p>
          {pendingReport.MEDIA_URL && (
            <a className="underline" href={pendingReport.MEDIA_URL} target="_blank" rel="noreferrer">
              View evidence
            </a>
          )}
          <p className="text-xs text-zinc-600">
            GPTZero: {FLAG_LABEL[pendingReport.GPTZERO_FLAG ?? "unavailable"]}
            {pendingReport.GPTZERO_SCORE != null &&
              ` (${Math.round(pendingReport.GPTZERO_SCORE * 100)}% AI-generated probability — advisory only, never auto-rejected)`}
          </p>
          <div className="flex gap-2">
            <button
              disabled={busy}
              className="rounded bg-green-600 px-3 py-1 text-white disabled:opacity-50"
              onClick={() => decide(pendingReport.ID, "approved")}
            >
              Approve & close ticket
            </button>
            <button
              disabled={busy}
              className="rounded bg-red-600 px-3 py-1 text-white disabled:opacity-50"
              onClick={() => decide(pendingReport.ID, "rejected")}
            >
              Reject
            </button>
          </div>
        </div>
      )}

      {reports.filter((r) => r.OWNER_DECISION).length > 0 && (
        <div className="border-t pt-3 text-xs text-zinc-500">
          <p className="font-medium text-zinc-600">History</p>
          {reports
            .filter((r) => r.OWNER_DECISION)
            .map((r) => (
              <p key={r.ID}>
                {r.OWNER_DECISION} — {r.REPORT_TEXT.slice(0, 60)}
              </p>
            ))}
        </div>
      )}
    </div>
  );
}
