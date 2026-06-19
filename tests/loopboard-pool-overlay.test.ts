import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  countActivePoolSlots,
  tasksByStatusWithPoolOverlay,
} from "@/lib/loopboard-pool-overlay";
import type { AoWorkerPoolSnapshot } from "@/lib/engine/ao-worker-pool-types";
import { seedTasks, type Task } from "@/lib/loopboard";

const boardTasks: Task[] = seedTasks.slice(0, 3).map((task, index) => ({
  ...task,
  id: `task-${index + 1}`,
}));

describe("loopboard pool overlay", () => {
  const snapshot: AoWorkerPoolSnapshot = {
    maxWorkers: 2,
    featureId: "feature-1",
    updatedAt: "2026-06-18T00:00:00.000Z",
    items: [
      { issueNumber: 1, taskId: "task-1", state: "running" },
      { issueNumber: 2, taskId: "task-2", state: "queued" },
      { issueNumber: 3, taskId: "task-3", state: "blocked" },
    ],
  };

  it("maps pool states onto existing kanban columns", () => {
    const grouped = tasksByStatusWithPoolOverlay(boardTasks, snapshot);

    assert.ok(grouped["ai-running"].some((task) => task.id === "task-1"));
    assert.ok(grouped.ready.some((task) => task.id === "task-2"));
    assert.ok(grouped.blocked.some((task) => task.id === "task-3"));
  });

  it("counts active pool slots", () => {
    assert.equal(countActivePoolSlots(snapshot), 1);
  });
});
