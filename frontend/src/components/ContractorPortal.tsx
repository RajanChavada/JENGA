"use client";

import { useRef, useState } from "react";
import { displayId, dueDate, formatDate } from "@/lib/format";
import { STATE_STYLE } from "@/lib/theme";
import type { PortalProject, Report, Task } from "@/lib/types";
import { useJenga } from "@/store/useJenga";
import { DocumentUpload } from "./DocumentUpload";

/**
 * The construction company's view: its projects grouped by the owner it works
 * for, and for the project open, the work it can report on. It sees the owner's
 * decision and reason on each update, never the AI's verdict.
 */
export function ContractorPortal() {
  const portal = useJenga((s) => s.portal);
  const activeId = useJenga((s) => s.activeProjectId);
  const focusProject = useJenga((s) => s.focusProject);
  const tasks = useJenga((s) => s.tasks);
  const reports = useJenga((s) => s.reports);
  const siteName = useJenga((s) => s.activeSiteName);
  const loading = useJenga((s) => s.loading);

  const byOwner = new Map<
    string,
    { name: string; projects: PortalProject[] }
  >();
  for (const p of portal?.projects ?? []) {
    const group = byOwner.get(p.owner.id) ?? {
      name: p.owner.name,
      projects: [],
    };
    group.projects.push(p);
    byOwner.set(p.owner.id, group);
  }
  const active = portal?.projects.find((p) => p.id === activeId);

  return (
    <div className="flex h-full min-h-0">
      <nav className="w-72 shrink-0 overflow-auto border-r border-slate-200 bg-slate-50/50 p-3">
        <p className="mb-2 px-1 text-[10px] font-medium uppercase tracking-wide text-slate-400">
          Project owners you work for
        </p>
        {[...byOwner.entries()].map(([ownerId, group]) => (
          <div key={ownerId} className="mb-4">
            <h3 className="px-1 text-xs font-semibold text-slate-800">
              {group.name}
            </h3>
            <div className="mt-1.5 space-y-1.5">
              {group.projects.map((p) => (
                <button
                  key={p.id}
                  onClick={() => void focusProject(p)}
                  className={`w-full rounded-lg border p-2.5 text-left transition-colors ${
                    p.id === activeId
                      ? "border-slate-900 bg-white"
                      : "border-slate-200 bg-white hover:border-slate-300"
                  }`}
                >
                  <span className="block text-xs font-medium text-slate-900">
                    {p.name}
                  </span>
                  <span className="mt-1 flex items-center gap-2 text-[10px] text-slate-500">
                    <span>
                      {p.verified}/{p.total} verified
                    </span>
                    <span>· {p.active} open</span>
                    {p.awaiting_review > 0 && (
                      <span className="rounded bg-amber-100 px-1 text-amber-700">
                        {p.awaiting_review} in review
                      </span>
                    )}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </nav>

      <div className="min-w-0 flex-1 overflow-auto p-5">
        {loading || !active ? (
          <p className="pt-16 text-center text-xs text-slate-400">
            {loading
              ? "loading project…"
              : "Pick a project to report progress."}
          </p>
        ) : (
          <div className="mx-auto max-w-3xl">
            <h2 className="text-lg font-semibold tracking-tight text-slate-900">
              {siteName}
            </h2>
            <p className="text-xs text-slate-500">Owner: {active.owner.name}</p>

            <h3 className="mb-2 mt-6 text-xs font-medium text-slate-700">
              Work packages
            </h3>
            <div className="divide-y divide-slate-100 rounded-lg border border-slate-200">
              {tasks.map((t) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  tasks={tasks}
                  startDate={active.start_date}
                  reports={reports.filter((r) => r.task_id === t.id)}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function TaskRow({
  task,
  tasks,
  startDate,
  reports,
}: {
  task: Task;
  tasks: Task[];
  startDate: string;
  reports: Report[];
}) {
  const [open, setOpen] = useState(false);
  const style = STATE_STYLE[task.state];
  const latest = reports[reports.length - 1];

  return (
    <div className="p-3">
      <div className="flex items-center gap-3">
        <span className="w-12 shrink-0 font-mono text-[10px] text-slate-400">
          {displayId(task.id)}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-slate-800">
          {task.name}
        </span>
        {task.due_day != null && (
          <span className="shrink-0 text-[10px] text-slate-400">
            Due {formatDate(dueDate(startDate, task.due_day))}
          </span>
        )}
        {task.is_critical && (
          <span className="shrink-0 rounded border border-amber-200 bg-amber-50 px-1 text-[9px] text-amber-700">
            Critical
          </span>
        )}
        <span
          className={`rounded border px-1.5 py-0.5 text-[10px] ${style.chip}`}
        >
          {task.state === "under_review" ? "Awaiting owner" : style.label}
        </span>
        {task.state === "active" ? (
          <button
            onClick={() => setOpen((v) => !v)}
            className="rounded-md bg-slate-900 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-slate-800"
          >
            {open ? "Close" : "Submit update"}
          </button>
        ) : (
          <span className="w-21.5" />
        )}
      </div>

      {task.state === "blocked" && (
        <p className="mt-1 pl-15 text-[10px] text-slate-400">
          Waiting on the owner to verify:{' '}
          {(task.blocked_by ?? [])
            .map((id) => tasks.find((t) => t.id === id)?.name ?? id)
            .join(', ')}
        </p>
      )}
      {latest?.owner_decision === "rejected" && task.state === "active" && (
        <p className="mt-1 rounded bg-red-50 px-2 py-1 text-[11px] text-red-700">
          Denied{latest.owner_note ? `: ${latest.owner_note}` : "."} Resubmit
          with the fix.
          {latest.impact && (
            <>
              {" "}
              Predicted impact: +{latest.impact.rework_days} days of rework; the
              project finish moves to{" "}
              {formatDate(latest.impact.predicted_finish_date)}.
            </>
          )}
        </p>
      )}
      {open && <UpdateForm task={task} onDone={() => setOpen(false)} />}

      {reports.length > 0 && (
        <ul className="mt-2 space-y-1 pl-15">
          {reports.map((r) => (
            <li key={r.id} className="text-[10px] text-slate-500">
              {r.submitted_at
                ? new Date(r.submitted_at).toLocaleDateString()
                : ""}{" "}
              · {r.owner_decision === "pending" && "Awaiting owner review"}
              {r.owner_decision === "approved" && (
                <span className="text-emerald-700">
                  Approved{r.owner_note ? `: ${r.owner_note}` : ""}
                </span>
              )}
              {r.owner_decision === "rejected" && (
                <span className="text-red-700">
                  Denied{r.owner_note ? `: ${r.owner_note}` : ""}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function UpdateForm({ task, onDone }: { task: Task; onDone: () => void }) {
  const submitUpdate = useJenga((s) => s.submitUpdate);
  const busy = useJenga((s) => s.busy);
  const [text, setText] = useState("");
  const [image, setImage] = useState<{ name: string; base64: string } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function pickPhoto(file: File | undefined) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      // readAsDataURL yields "data:image/jpeg;base64,<payload>"; the API wants the payload.
      const url = String(reader.result);
      setImage({ name: file.name, base64: url.slice(url.indexOf(",") + 1) });
    };
    reader.readAsDataURL(file);
  }

  async function send() {
    if (!text.trim()) {
      setError("Describe the work completed.");
      return;
    }
    const err = await submitUpdate(task.id, text, image?.base64 ?? null);
    if (err) setError(err);
    else onDone();
  }

  return (
    <div className="mt-3 space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        placeholder={`What was completed on “${task.name}”?`}
        className="w-full resize-none rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-700 placeholder:text-slate-300"
      />
      <DocumentUpload
        onReportText={(t) => setText((prev) => (prev ? `${prev}\n\n${t}` : t))}
        reportActionLabel="Use this text"
      />
      <div className="flex items-center gap-2 text-[11px] text-slate-500">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => pickPhoto(e.target.files?.[0])}
        />
        <button
          onClick={() => fileRef.current?.click()}
          className="rounded-md border border-slate-200 bg-white px-2 py-1 hover:bg-slate-50"
        >
          {image ? "Change photo" : "Add site photo"}
        </button>
        {image && <span className="truncate">{image.name}</span>}
      </div>
      {error && <p className="text-[11px] text-red-600">{error}</p>}
      <button
        onClick={() => void send()}
        disabled={busy}
        className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
      >
        {busy ? "Submitting…" : "Send to owner"}
      </button>
    </div>
  );
}
