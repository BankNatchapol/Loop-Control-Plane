import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readAoWorkerPoolSnapshot } from "@/lib/engine/ao-worker-pool-types";

describe("ao worker pool snapshot", () => {
  it("reads aoWorkerPool from engine job result", () => {
    const snapshot = readAoWorkerPoolSnapshot({
      aoWorkerPool: {
        maxWorkers: 2,
        featureId: "feature-1",
        updatedAt: "2026-06-18T00:00:00.000Z",
        items: [
          { issueNumber: 42, taskId: "task-42", state: "running", sessionId: "s-42" },
        ],
      },
    });

    assert.ok(snapshot);
    assert.equal(snapshot?.maxWorkers, 2);
    assert.equal(snapshot?.items[0]?.taskId, "task-42");
    assert.equal(snapshot?.items[0]?.state, "running");
  });
});
