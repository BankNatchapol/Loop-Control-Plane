"use client";

import clsx from "clsx";
import { useMemo } from "react";

import type { AoAttentionLevel, AoDashboardSession } from "@/lib/ao-bridge/types";
import type { PersistedTask } from "@/lib/db/loopboard-repository";

const SIMPLE_ZONES: { id: AoAttentionLevel; label: string }[] = [
  { id: "working", label: "Working" },
  { id: "action", label: "Action" },
  { id: "pending", label: "Pending" },
  { id: "merge", label: "Merge" },
];

const toSimpleZone = (level: AoAttentionLevel): AoAttentionLevel => {
  if (level === "respond" || level === "review") {
    return "action";
  }
  if (level === "done") {
    return "done";
  }
  return level;
};

function SessionCard({
  session,
  linkedTask,
  onSelect,
}: {
  session: AoDashboardSession;
  linkedTask?: PersistedTask;
  onSelect: (session: AoDashboardSession) => void;
}) {
  const title =
    session.displayName ||
    session.issueTitle ||
    (session.issueId ? `Issue #${session.issueId}` : session.id);

  return (
    <button
      type="button"
      onClick={() => onSelect(session)}
      className="w-full border border-slate-200 bg-white p-3 text-left hover:border-sky-300 hover:bg-sky-50"
    >
      <div className="text-sm font-semibold text-slate-900">{title}</div>
      <div className="mt-1 text-xs text-slate-500">{session.status}</div>
      {session.activity ? (
        <div className="mt-1 text-[11px] uppercase text-slate-500">{session.activity}</div>
      ) : null}
      {linkedTask ? (
        <div className="mt-2 text-[11px] font-semibold text-sky-700">
          Linked task: {linkedTask.title}
        </div>
      ) : null}
    </button>
  );
}

export function AgentsBoard({
  sessions,
  tasks,
  onSelectSession,
}: {
  sessions: AoDashboardSession[];
  tasks: PersistedTask[];
  onSelectSession: (session: AoDashboardSession) => void;
}) {
  const tasksByIssue = useMemo(() => {
    const map = new Map<number, PersistedTask>();
    for (const task of tasks) {
      if (task.github.issueNumber) {
        map.set(task.github.issueNumber, task);
      }
    }
    return map;
  }, [tasks]);

  const grouped = useMemo(() => {
    const buckets = new Map<AoAttentionLevel, AoDashboardSession[]>(
      SIMPLE_ZONES.map((zone) => [zone.id, []]),
    );
    const done: AoDashboardSession[] = [];

    for (const session of sessions) {
      if (session.isOrchestrator) {
        continue;
      }
      const zone = toSimpleZone(session.attentionLevel);
      if (zone === "done") {
        done.push(session);
        continue;
      }
      buckets.get(zone)?.push(session);
    }

    return { buckets, done };
  }, [sessions]);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 xl:grid-cols-4">
        {SIMPLE_ZONES.map((zone) => (
          <section key={zone.id} className="min-h-48 border border-slate-200 bg-slate-50">
            <header className="border-b border-slate-200 bg-white px-3 py-2 text-xs font-semibold uppercase text-slate-600">
              {zone.label} ({grouped.buckets.get(zone.id)?.length ?? 0})
            </header>
            <div className="space-y-2 p-2">
              {(grouped.buckets.get(zone.id) ?? []).map((session) => {
                const issueNumber = session.issueId
                  ? Number.parseInt(String(session.issueId).replace(/^#/u, ""), 10)
                  : undefined;
                return (
                  <SessionCard
                    key={session.id}
                    session={session}
                    linkedTask={
                      issueNumber && Number.isInteger(issueNumber)
                        ? tasksByIssue.get(issueNumber)
                        : undefined
                    }
                    onSelect={onSelectSession}
                  />
                );
              })}
            </div>
          </section>
        ))}
      </div>

      {grouped.done.length > 0 ? (
        <details className="border border-slate-200 bg-white">
          <summary className="cursor-pointer px-3 py-2 text-xs font-semibold uppercase text-slate-600">
            Done / terminated ({grouped.done.length})
          </summary>
          <div className="grid gap-2 p-2 md:grid-cols-2 xl:grid-cols-3">
            {grouped.done.map((session) => (
              <SessionCard key={session.id} session={session} onSelect={onSelectSession} />
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

export function OrchestratorStrip({
  orchestrators,
}: {
  orchestrators: { id: string; projectId: string; projectName?: string; status?: string }[];
}) {
  if (orchestrators.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap gap-2 border border-slate-200 bg-white p-3">
      <span className="text-xs font-semibold uppercase text-slate-500">Orchestrators</span>
      {orchestrators.map((orchestrator) => (
        <span
          key={orchestrator.id}
          className={clsx(
            "rounded border px-2 py-1 text-xs font-semibold",
            orchestrator.status === "working"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : "border-slate-200 bg-slate-50 text-slate-700",
          )}
        >
          {orchestrator.projectName ?? orchestrator.projectId}: {orchestrator.status ?? "unknown"}
        </span>
      ))}
    </div>
  );
}
