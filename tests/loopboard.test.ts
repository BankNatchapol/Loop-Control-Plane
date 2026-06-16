import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  KANBAN_COLUMNS,
  applyTaskAction,
  canTransitionOwner,
  createPersistedBoardState,
  createTaskEvent,
  formatTimestamp,
  initialBoardState,
  moveTaskToStatus,
  normalizeGitHubDeliveryStatus,
  parsePersistedBoardState,
  riskStyle,
  seedTasks,
  statusLabel,
  tasksByStatus,
} from "@/lib/loopboard";

describe("loopboard domain model", () => {
  it("keeps the default columns aligned with PRD status labels", () => {
    assert.deepEqual(
      KANBAN_COLUMNS.map((column) => column.label),
      [
        "Backlog",
        "Spec Review",
        "Plan Review",
        "Ready",
        "AI Running",
        "Human Working",
        "Needs Review",
        "Blocked",
        "Done",
      ],
    );
  });

  it("seeds tasks with representative prototype metadata", () => {
    assert.ok(seedTasks.some((task) => task.source === "spec-kit"));
    assert.ok(seedTasks.some((task) => task.owner === "ai"));
    assert.ok(seedTasks.some((task) => task.owner === "human"));
    assert.ok(seedTasks.some((task) => task.github.pullRequestNumber));
    assert.ok(seedTasks.some((task) => task.handoff.available));
    assert.ok(seedTasks.every((task) => task.branch.length > 0));
    assert.ok(seedTasks.every((task) => task.worktree.length > 0));
    assert.ok(seedTasks.every((task) => task.acceptanceCriteria.length > 0));
  });

  it("normalizes GitHub PR, CI, review, merged, and closed delivery states", () => {
    assert.equal(normalizeGitHubDeliveryStatus({}), "no-pr");
    assert.equal(
      normalizeGitHubDeliveryStatus({
        pullRequestNumber: 12,
        pullRequestState: "open",
      }),
      "pr-opened",
    );
    assert.equal(
      normalizeGitHubDeliveryStatus({
        pullRequestNumber: 12,
        pullRequestState: "open",
        ciStatus: "pending",
      }),
      "ci-running",
    );
    assert.equal(
      normalizeGitHubDeliveryStatus({
        pullRequestNumber: 12,
        pullRequestState: "open",
        ciStatus: "failing",
      }),
      "ci-failed",
    );
    assert.equal(
      normalizeGitHubDeliveryStatus({
        pullRequestNumber: 12,
        pullRequestState: "open",
        ciStatus: "passing",
      }),
      "ci-passed",
    );
    assert.equal(
      normalizeGitHubDeliveryStatus({
        pullRequestNumber: 12,
        pullRequestState: "open",
        ciStatus: "passing",
        reviewStatus: "requested",
      }),
      "review-requested",
    );
    assert.equal(
      normalizeGitHubDeliveryStatus({
        pullRequestNumber: 12,
        pullRequestState: "open",
        reviewStatus: "changes-requested",
      }),
      "changes-requested",
    );
    assert.equal(
      normalizeGitHubDeliveryStatus({
        pullRequestNumber: 12,
        pullRequestState: "open",
        reviewStatus: "approved",
      }),
      "approved",
    );
    assert.equal(
      normalizeGitHubDeliveryStatus({
        pullRequestNumber: 12,
        pullRequestState: "merged",
        reviewStatus: "changes-requested",
      }),
      "merged",
    );
    assert.equal(
      normalizeGitHubDeliveryStatus({
        pullRequestNumber: 12,
        pullRequestState: "closed",
        reviewStatus: "approved",
      }),
      "closed",
    );
  });

  it("groups tasks by every supported board status", () => {
    const grouped = tasksByStatus(seedTasks);

    for (const column of KANBAN_COLUMNS) {
      assert.ok(Array.isArray(grouped[column.id]));
      assert.ok(
        grouped[column.id].every((task) => task.status === column.id),
        `${column.id} contains only matching tasks`,
      );
    }
  });

  it("moves a task between statuses and records a TASK_MOVED event", () => {
    const task = seedTasks.find((seedTask) => seedTask.status === "ready");
    assert.ok(task);

    const moved = moveTaskToStatus({
      task,
      toStatus: "ai-running",
      createdAt: "2026-06-14T04:00:00.000Z",
    });

    assert.equal(moved.status, "ai-running");
    assert.equal(moved.updatedAt, "2026-06-14T04:00:00.000Z");
    assert.equal(moved.events.at(-1)?.type, "TASK_MOVED");
    assert.equal(moved.events.at(-1)?.fromStatus, "ready");
    assert.equal(moved.events.at(-1)?.toStatus, "ai-running");
    assert.equal(
      moved.events.at(-1)?.message,
      "Moved from Ready to AI Running.",
    );
  });

  it("applies core task actions with consistent local state and events", () => {
    const readyTask = seedTasks.find((seedTask) => seedTask.status === "ready");
    assert.ok(readyTask);

    const assigned = applyTaskAction({
      task: readyTask,
      action: "assign-ai",
      createdAt: "2026-06-14T04:10:00.000Z",
    });

    assert.equal(assigned.owner, "ai");
    assert.equal(assigned.status, "ai-running");
    assert.equal(assigned.mode, "execute");
    assert.ok(assigned.labels.includes("ai-assigned"));
    assert.equal(assigned.events.at(-1)?.type, "ASSIGNED_TO_AI");
    assert.equal(assigned.events.at(-1)?.fromOwner, "unassigned");
    assert.equal(assigned.events.at(-1)?.toOwner, "ai");

    const claimed = applyTaskAction({
      task: assigned,
      action: "claim-human",
      createdAt: "2026-06-14T04:12:00.000Z",
    });

    assert.equal(claimed.owner, "human");
    assert.equal(claimed.status, "human-working");
    assert.equal(claimed.mode, "handoff");
    assert.ok(claimed.labels.includes("human-takeover"));
    assert.ok(claimed.labels.includes("ai-paused"));
    assert.equal(claimed.labels.includes("ai-assigned"), false);
    assert.deepEqual(claimed.github.issueLabels, ["human-working"]);
    assert.equal(claimed.github.issueLastSyncedAt, "2026-06-14T04:12:00.000Z");
    assert.equal(claimed.events.at(-2)?.type, "HUMAN_TAKEOVER");
    assert.equal(claimed.events.at(-2)?.metadata?.branch, assigned.branch);
    assert.equal(claimed.events.at(-2)?.metadata?.worktree, assigned.worktree);
    assert.equal(claimed.events.at(-1)?.type, "ASSIGNED_TO_HUMAN");
    assert.equal(claimed.events.at(-1)?.fromOwner, "ai");
    assert.equal(claimed.events.at(-1)?.toOwner, "human");

    const returned = applyTaskAction({
      task: claimed,
      action: "return-ai",
      createdAt: "2026-06-14T04:14:00.000Z",
    });

    assert.equal(returned.owner, "ai");
    assert.equal(returned.status, "ready");
    assert.ok(returned.labels.includes("handoff-ready"));
    assert.equal(returned.labels.includes("ai-paused"), false);
    assert.equal(returned.github.issueLabels?.includes("ao-ready"), true);
    assert.equal(returned.github.issueLabels?.includes("human-working"), false);
    assert.equal(returned.events.at(-2)?.type, "RETURNED_TO_AI");
    assert.equal(returned.events.at(-1)?.type, "ASSIGNED_TO_AI");

    const repeated = applyTaskAction({
      task: returned,
      action: "return-ai",
      createdAt: "2026-06-14T04:16:00.000Z",
    });

    assert.equal(repeated, returned);
  });

  it("records explicit local approval before gated AO ready handoff", () => {
    const task = seedTasks.find((seedTask) => seedTask.risk === "medium");
    assert.ok(task);

    const approved = applyTaskAction({
      task,
      action: "approve-ao-ready",
      createdAt: "2026-06-14T04:18:00.000Z",
    });

    assert.equal(approved.github.aoReadyApprovedAt, "2026-06-14T04:18:00.000Z");
    assert.equal(approved.events.at(-1)?.type, "AO_READY_APPROVED");

    const repeated = applyTaskAction({
      task: approved,
      action: "approve-ao-ready",
      createdAt: "2026-06-14T04:19:00.000Z",
    });

    assert.equal(repeated, approved);
  });

  it("pauses, blocks, and completes tasks through PRD event types", () => {
    const aiTask = seedTasks.find((seedTask) => seedTask.owner === "ai");
    assert.ok(aiTask);

    const paused = applyTaskAction({
      task: aiTask,
      action: "pause-ai",
      createdAt: "2026-06-14T04:20:00.000Z",
    });

    assert.equal(paused.owner, "human");
    assert.equal(paused.status, "human-working");
    assert.ok(paused.labels.includes("ai-paused"));
    assert.ok(paused.labels.includes("handoff-ready"));
    assert.equal(paused.events.at(-1)?.type, "AI_PAUSED");

    const blocked = applyTaskAction({
      task: paused,
      action: "mark-blocked",
      createdAt: "2026-06-14T04:22:00.000Z",
    });

    assert.equal(blocked.status, "blocked");
    assert.ok(blocked.labels.includes("blocked"));
    assert.ok(blocked.labels.includes("needs-decision"));
    assert.equal(blocked.events.at(-1)?.type, "BLOCKED");

    const done = applyTaskAction({
      task: blocked,
      action: "mark-done",
      createdAt: "2026-06-14T04:25:00.000Z",
    });

    assert.equal(done.status, "done");
    assert.equal(done.owner, "human");
    assert.equal(done.mode, "review");
    assert.ok(done.labels.includes("verified"));
    assert.equal(done.labels.includes("blocked"), false);
    assert.equal(done.events.at(-1)?.type, "MARKED_DONE");
  });

  it("exposes labels, risk styles, owner transitions, events, and timestamps", () => {
    assert.equal(statusLabel("ai-running"), "AI Running");
    assert.match(riskStyle("critical"), /red/);
    assert.equal(canTransitionOwner("ai", "human"), true);
    assert.equal(canTransitionOwner("unassigned", "pairing"), false);

    const moved = createTaskEvent({
      taskId: "task-ai-board-dragging",
      type: "TASK_MOVED",
      actor: "human",
      message: "Moved task for review.",
      createdAt: "2026-06-14T03:00:00.000Z",
      fromStatus: "ai-running",
      toStatus: "needs-review",
    });

    assert.equal(
      moved.id,
      "task-ai-board-dragging-task-moved-2026-06-14T03:00:00.000Z",
    );
    assert.match(
      formatTimestamp("2026-06-14T03:00:00.000Z", "en-US"),
      /^Jun 14, \d{2}:00 AM$/,
    );
  });

  it("serializes and hydrates valid local board state", () => {
    const selectedTask = seedTasks[2];
    const movedTask = moveTaskToStatus({
      task: selectedTask,
      toStatus: "needs-review",
      createdAt: "2026-06-14T04:40:00.000Z",
    });
    const tasks = seedTasks.map((task) =>
      task.id === movedTask.id ? movedTask : task,
    );

    const persisted = createPersistedBoardState({
      tasks,
      selectedTaskId: movedTask.id,
      savedAt: "2026-06-14T04:41:00.000Z",
    });
    const hydrated = parsePersistedBoardState(JSON.stringify(persisted));

    assert.equal(persisted.version, 1);
    assert.equal(persisted.savedAt, "2026-06-14T04:41:00.000Z");
    assert.equal(hydrated.selectedTaskId, movedTask.id);
    assert.equal(
      hydrated.tasks.find((task) => task.id === movedTask.id)?.status,
      "needs-review",
    );
    assert.equal(
      hydrated.tasks.find((task) => task.id === movedTask.id)?.events.at(-1)
        ?.type,
      "TASK_MOVED",
    );
  });

  it("falls back to seed data when local storage is empty or malformed", () => {
    assert.deepEqual(parsePersistedBoardState(null), initialBoardState());
    assert.deepEqual(parsePersistedBoardState("{bad json"), initialBoardState());
    assert.deepEqual(
      parsePersistedBoardState(JSON.stringify({ version: 1, tasks: [] })),
      initialBoardState(),
    );
    assert.deepEqual(
      parsePersistedBoardState(
        JSON.stringify({ version: 99, tasks: seedTasks, selectedTaskId: "x" }),
      ),
      initialBoardState(),
    );
  });

  it("keeps only complete stored tasks and repairs stale selection", () => {
    const partialTask = {
      id: "old-task",
      title: "Missing prototype fields",
      status: "ready",
    };
    const validTask = {
      ...seedTasks[0],
      status: "blocked",
      events: [
        ...seedTasks[0].events,
        {
          type: "BLOCKED",
          actor: "human",
          message: "Stored event without id is repaired.",
          createdAt: "2026-06-14T04:45:00.000Z",
          metadata: { issueNumber: 18, ignored: { nested: true } },
        },
      ],
      github: {
        ciStatus: "stale-shape",
        reviewStatus: "approved",
        pullRequestBranch: "feature/pr-ci-model",
        pullRequestState: "open",
        mergeStatus: "mergeable",
        deliveryStatus: "ci-failed",
        prCiLastSyncedAt: "2026-06-15T00:00:00.000Z",
        ciFailureSummary: "unit-test failed",
        reviewUrl:
          "https://github.com/bank-p/loop-control-plane/pull/12#pullrequestreview-1",
      },
      handoff: {},
    };

    const hydrated = parsePersistedBoardState(
      JSON.stringify({
        version: 1,
        tasks: [partialTask, validTask],
        selectedTaskId: "missing-selection",
      }),
    );

    assert.equal(hydrated.tasks.length, 1);
    assert.equal(hydrated.tasks[0].id, seedTasks[0].id);
    assert.equal(hydrated.tasks[0].status, "blocked");
    assert.equal(hydrated.tasks[0].github.ciStatus, undefined);
    assert.equal(hydrated.tasks[0].github.reviewStatus, "approved");
    assert.equal(
      hydrated.tasks[0].github.pullRequestBranch,
      "feature/pr-ci-model",
    );
    assert.equal(hydrated.tasks[0].github.pullRequestState, "open");
    assert.equal(hydrated.tasks[0].github.mergeStatus, "mergeable");
    assert.equal(hydrated.tasks[0].github.deliveryStatus, "ci-failed");
    assert.equal(
      hydrated.tasks[0].github.prCiLastSyncedAt,
      "2026-06-15T00:00:00.000Z",
    );
    assert.equal(hydrated.tasks[0].github.ciFailureSummary, "unit-test failed");
    assert.equal(
      hydrated.tasks[0].github.reviewUrl,
      "https://github.com/bank-p/loop-control-plane/pull/12#pullrequestreview-1",
    );
    assert.deepEqual(hydrated.tasks[0].handoff.contextPaths, []);
    assert.equal(hydrated.tasks[0].events.at(-1)?.type, "BLOCKED");
    assert.equal(
      hydrated.tasks[0].events.at(-1)?.id,
      `${seedTasks[0].id}-blocked-2026-06-14T04:45:00.000Z`,
    );
    assert.deepEqual(hydrated.tasks[0].events.at(-1)?.metadata, {
      issueNumber: 18,
    });
    assert.equal(hydrated.selectedTaskId, seedTasks[0].id);
  });
});
