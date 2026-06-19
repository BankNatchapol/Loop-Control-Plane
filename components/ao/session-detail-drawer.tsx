"use client";

import { X } from "lucide-react";

import { AgentTerminal } from "@/components/ao/agent-terminal";
import type { AoDashboardSession } from "@/lib/ao-bridge/types";

export function SessionDetailDrawer({
  session,
  projectId,
  onClose,
  onKill,
}: {
  session: AoDashboardSession;
  projectId?: string;
  onClose: () => void;
  onKill?: () => void;
}) {
  const title =
    session.displayName ||
    session.issueTitle ||
    (session.issueId ? `Issue #${session.issueId}` : session.id);

  return (
    <aside className="fixed inset-y-0 right-0 z-40 flex w-full max-w-xl flex-col border-l border-slate-200 bg-white shadow-xl">
      <header className="flex items-start justify-between gap-3 border-b border-slate-200 p-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
          <p className="mt-1 font-mono text-xs text-slate-500">{session.id}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="border border-slate-200 p-2 text-slate-600 hover:border-slate-300"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      <div className="space-y-4 overflow-y-auto p-4">
        <section className="grid gap-2 text-sm text-slate-700">
          <div>Status: {session.status}</div>
          {session.attentionLevel ? <div>Attention: {session.attentionLevel}</div> : null}
          {session.activity ? <div>Activity: {session.activity}</div> : null}
          {session.branch ? <div>Branch: {session.branch}</div> : null}
        </section>

        {session.pr ? (
          <section className="rounded border border-slate-200 bg-slate-50 p-3 text-sm">
            <h3 className="text-xs font-semibold uppercase text-slate-500">Pull request</h3>
            <div className="mt-2 space-y-1 text-slate-700">
              {session.pr.number ? <div>#{session.pr.number}</div> : null}
              {session.pr.url ? (
                <a href={session.pr.url} className="break-all text-sky-700 underline">
                  {session.pr.url}
                </a>
              ) : null}
              {session.pr.ciStatus ? <div>CI: {session.pr.ciStatus}</div> : null}
              {session.pr.reviewDecision ? (
                <div>Review: {session.pr.reviewDecision}</div>
              ) : null}
            </div>
          </section>
        ) : null}

        {onKill ? (
          <button
            type="button"
            onClick={onKill}
            className="border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700"
          >
            Kill session
          </button>
        ) : null}

        <AgentTerminal sessionId={session.id} projectId={projectId} />
      </div>
    </aside>
  );
}
