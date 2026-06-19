"use client";

import clsx from "clsx";
import { Bot, RefreshCw, Skull, TerminalSquare } from "lucide-react";

import type { PersistedTask } from "@/lib/db/loopboard-repository";
import type { Task } from "@/lib/loopboard";

export function aoHandoffState(task: Task): {
  label: string;
  message: string;
  className: string;
} {
  const hasIssue = Boolean(task.github.issueNumber || task.github.issueUrl);

  if (!hasIssue) {
    return {
      label: "ao not linked",
      message: "Create a GitHub issue before preparing Agent Orchestrator handoff.",
      className: "border-slate-200 bg-slate-50 text-slate-600",
    };
  }

  if (task.github.issueLabels?.includes("ao-ready")) {
    return {
      label: "ao ready",
      message: "This linked issue is marked ao-ready for Agent Orchestrator handoff.",
      className: "border-emerald-200 bg-emerald-50 text-emerald-800",
    };
  }

  if (task.owner !== "ai") {
    return {
      label: "ao waiting",
      message: "Assign this task to AI before applying ao-ready.",
      className: "border-slate-200 bg-slate-50 text-slate-600",
    };
  }

  if (task.risk === "low") {
    return {
      label: "ao pending",
      message: "Low-risk AI assignment can receive ao-ready on assignment.",
      className: "border-sky-200 bg-sky-50 text-sky-800",
    };
  }

  if (task.github.aoReadyApprovedAt) {
    return {
      label: "ao approved",
      message: "Local risk approval is recorded; ao-ready can be applied on assignment.",
      className: "border-sky-200 bg-sky-50 text-sky-800",
    };
  }

  return {
    label: "ao approval needed",
    message: "Medium, high, and critical risk tasks require local approval before ao-ready.",
    className: "border-orange-200 bg-orange-50 text-orange-800",
  };
}

export function AoRuntimePanel({
  task,
  onSync,
  onKill,
  onOpenTerminal,
  isSyncing = false,
}: {
  task: PersistedTask;
  onSync?: () => void;
  onKill?: () => void;
  onOpenTerminal?: () => void;
  isSyncing?: boolean;
}) {
  const handoff = aoHandoffState(task);
  const runtime = task.aoRuntime;

  return (
    <section className="space-y-3 border border-slate-200 bg-white p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          AO Handoff
        </h3>
        <span
          className={clsx(
            "rounded border px-2 py-0.5 text-[11px] font-semibold uppercase",
            handoff.className,
          )}
        >
          {handoff.label}
        </span>
      </div>
      <p className="text-sm text-slate-600">{handoff.message}</p>

      {runtime?.sessionId ? (
        <div className="space-y-2 rounded border border-slate-200 bg-slate-50 p-3 text-sm">
          <div className="flex items-center gap-2 text-slate-700">
            <Bot className="h-4 w-4 text-sky-600" />
            <span className="font-mono text-xs">{runtime.sessionId}</span>
          </div>
          <div className="grid gap-1 text-xs text-slate-600">
            {runtime.sessionStatus ? <div>Status: {runtime.sessionStatus}</div> : null}
            {runtime.attentionLevel ? <div>Attention: {runtime.attentionLevel}</div> : null}
            {runtime.activity ? <div>Activity: {runtime.activity}</div> : null}
            {runtime.prUrl ? (
              <div className="truncate">
                PR: <span className="font-mono">{runtime.prUrl}</span>
              </div>
            ) : null}
            {runtime.lastSyncedAt ? (
              <div>Synced: {new Date(runtime.lastSyncedAt).toLocaleString()}</div>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            {onOpenTerminal ? (
              <button
                type="button"
                onClick={onOpenTerminal}
                className="inline-flex items-center gap-1 border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700 hover:border-sky-300 hover:text-sky-800"
              >
                <TerminalSquare className="h-3.5 w-3.5" />
                Open terminal
              </button>
            ) : null}
            {onSync ? (
              <button
                type="button"
                onClick={onSync}
                disabled={isSyncing}
                className="inline-flex items-center gap-1 border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700 hover:border-sky-300 hover:text-sky-800 disabled:opacity-50"
              >
                <RefreshCw className={clsx("h-3.5 w-3.5", isSyncing && "animate-spin")} />
                Sync AO
              </button>
            ) : null}
            {onKill ? (
              <button
                type="button"
                onClick={onKill}
                className="inline-flex items-center gap-1 border border-rose-200 bg-rose-50 px-2 py-1 text-xs font-semibold text-rose-700 hover:border-rose-300"
              >
                <Skull className="h-3.5 w-3.5" />
                Kill session
              </button>
            ) : null}
          </div>
          <p className="text-[11px] text-slate-500">
            AO runtime data is external/untrusted until reviewed.
          </p>
        </div>
      ) : (
        <p className="text-xs text-slate-500">No linked AO session yet.</p>
      )}
    </section>
  );
}

export function AoRuntimeBadge({ task }: { task: Task }) {
  const runtime = task.aoRuntime;
  if (!runtime?.attentionLevel && !runtime?.sessionStatus) {
    return null;
  }

  return (
    <span className="rounded border border-sky-200 bg-sky-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-sky-800">
      ao {runtime.attentionLevel ?? runtime.sessionStatus}
    </span>
  );
}
