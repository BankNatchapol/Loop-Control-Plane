import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildAoImplementQueue } from "@/lib/engine/ao-implement-queue";
import type { PersistedTask } from "@/lib/db/loopboard-repository";

const task = (input: {
  id: string;
  issueNumber: number;
  sourceId: string;
  dependencies?: string[];
  title?: string;
}): PersistedTask => ({
  id: input.id,
  projectId: "project-1",
  featureId: "feature-1",
  title: input.title ?? input.sourceId,
  description: "",
  status: "ready",
  owner: "ai",
  mode: "execute",
  risk: "low",
  source: "spec-kit",
  labels: [],
  acceptanceCriteria: [],
  dependencies: input.dependencies ?? [],
  branch: "",
  worktree: "",
  github: {
    issueNumber: input.issueNumber,
    issueUrl: `https://github.com/org/repo/issues/${input.issueNumber}`,
    pullRequestNumber: undefined,
    pullRequestUrl: "",
    issueLabels: [],
  },
  handoff: { available: false, contextPaths: [] },
  events: [
    {
      id: `event-${input.id}`,
      taskId: input.id,
      type: "TASK_IMPORTED",
      message: "imported",
      actor: "system",
      createdAt: "2026-06-18T00:00:00.000Z",
      metadata: { sourceId: input.sourceId },
    },
  ],
  createdAt: "2026-06-18T00:00:00.000Z",
  updatedAt: "2026-06-18T00:00:00.000Z",
});

describe("ao implement queue", () => {
  it("blocks dependents until blockers complete", () => {
    const queue = buildAoImplementQueue([
      task({ id: "t1", issueNumber: 1, sourceId: "T001" }),
      task({ id: "t2", issueNumber: 2, sourceId: "T002", dependencies: ["T001"] }),
    ]);

    const items = new Map<number, { state: "queued" | "completed" | "failed" | "skipped" }>([
      [1, { state: "queued" }],
      [2, { state: "queued" }],
    ]);

    assert.equal(queue.isEligible(1, items), true);
    assert.equal(queue.isEligible(2, items), false);

    items.set(1, { state: "completed" });
    assert.equal(queue.isEligible(2, items), true);
  });

  it("skips dependents when a blocker fails", () => {
    const queue = buildAoImplementQueue([
      task({ id: "t1", issueNumber: 1, sourceId: "T001" }),
      task({ id: "t2", issueNumber: 2, sourceId: "T002", dependencies: ["T001"] }),
    ]);

    const items = new Map<number, { state: "failed" | "queued" }>([
      [1, { state: "failed" }],
      [2, { state: "queued" }],
    ]);

    assert.match(queue.getSkipReason(2, items) ?? "", /Blocked by failed dependency T001/);
  });
});
