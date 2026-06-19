"use client";

import clsx from "clsx";
import { useMemo } from "react";

import type { AoReviewRun } from "@/lib/ao-bridge/types";

const REVIEW_COLUMNS = [
  { id: "queued", label: "Queued" },
  { id: "reviewing", label: "Reviewing" },
  { id: "triage", label: "Triage" },
  { id: "waiting", label: "Waiting" },
  { id: "clean", label: "Clean" },
  { id: "failed", label: "Failed" },
  { id: "outdated", label: "Outdated" },
] as const;

const columnForStatus = (status: string): (typeof REVIEW_COLUMNS)[number]["id"] => {
  const normalized = status.toLowerCase();
  if (normalized === "queued" || normalized === "preparing") return "queued";
  if (normalized === "running") return "reviewing";
  if (normalized === "needs_triage") return "triage";
  if (normalized === "sent_to_agent" || normalized === "waiting_update") return "waiting";
  if (normalized === "clean") return "clean";
  if (normalized === "failed" || normalized === "cancelled") return "failed";
  return "outdated";
};

export function ReviewsBoard({
  reviews,
  onSelectReview,
}: {
  reviews: AoReviewRun[];
  onSelectReview: (review: AoReviewRun) => void;
}) {
  const grouped = useMemo(() => {
    const buckets = new Map<string, AoReviewRun[]>(
      REVIEW_COLUMNS.map((column) => [column.id, []]),
    );
    for (const review of reviews) {
      const column = columnForStatus(review.status);
      buckets.get(column)?.push(review);
    }
    return buckets;
  }, [reviews]);

  return (
    <div className="grid gap-3 xl:grid-cols-4 2xl:grid-cols-7">
      {REVIEW_COLUMNS.map((column) => (
        <section key={column.id} className="min-h-48 border border-slate-200 bg-slate-50">
          <header className="border-b border-slate-200 bg-white px-3 py-2 text-xs font-semibold uppercase text-slate-600">
            {column.label} ({grouped.get(column.id)?.length ?? 0})
          </header>
          <div className="space-y-2 p-2">
            {(grouped.get(column.id) ?? []).map((review) => (
              <button
                key={review.id}
                type="button"
                onClick={() => onSelectReview(review)}
                className="w-full border border-slate-200 bg-white p-3 text-left hover:border-sky-300 hover:bg-sky-50"
              >
                <div className="text-sm font-semibold text-slate-900">{review.id}</div>
                <div className="mt-1 text-xs text-slate-500">{review.status}</div>
                {review.prNumber ? (
                  <div className="mt-1 text-[11px] text-slate-600">PR #{review.prNumber}</div>
                ) : null}
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export function ReviewFindingsDrawer({
  review,
  findings,
  loading,
  onClose,
}: {
  review: AoReviewRun;
  findings: { id: string; file: string; startLine: number; endLine: number; body: string }[];
  loading: boolean;
  onClose: () => void;
}) {
  return (
    <aside className="fixed inset-y-0 right-0 z-40 flex w-full max-w-xl flex-col border-l border-slate-200 bg-white shadow-xl">
      <header className="flex items-center justify-between border-b border-slate-200 p-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Review {review.id}</h2>
          <p className="text-xs text-slate-500">{review.status}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-700"
        >
          Close
        </button>
      </header>
      <div className="space-y-3 overflow-y-auto p-4">
        {loading ? <p className="text-sm text-slate-500">Loading findings…</p> : null}
        {!loading && findings.length === 0 ? (
          <p className="text-sm text-slate-500">No findings reported.</p>
        ) : null}
        {findings.map((finding) => (
          <article
            key={finding.id}
            className={clsx("rounded border border-slate-200 bg-slate-50 p-3 text-sm")}
          >
            <div className="font-mono text-xs text-slate-600">
              {finding.file}:{finding.startLine}-{finding.endLine}
            </div>
            <p className="mt-2 whitespace-pre-wrap text-slate-800">{finding.body}</p>
          </article>
        ))}
      </div>
    </aside>
  );
}
