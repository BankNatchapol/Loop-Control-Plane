import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { applyMigrations } from "@/db/migrate";
import { seedDatabase } from "@/db/seed";
import { TaskContextService } from "@/lib/context/task-context-service";
import { LoopBoardRepository } from "@/lib/db/loopboard-repository";
import type { BackendAdapter, BackendPollResult } from "@/lib/engine/backends/backend-adapter";
import type { BackendAdapterRegistry } from "@/lib/engine/backends/backend-adapter-registry";
import {
  ENGINE_JOB_AWAITING_EXTERNAL_SYNC_KEY,
  hasEngineJobPollTimedOut,
  isEngineJobAwaitingExternalSync,
  syncInFlightEngineJobs,
} from "@/lib/engine/engine-sync-service";
import {
  buildTaskRunJobPayload,
  type EngineJob,
  type ExecutorBackend,
} from "@/lib/engine/loop-engine-types";
import { seedProject } from "@/lib/loopboard";
import { externalUntrustedPrefix } from "@/lib/security/safe-context";

const withRepository = (
  test: (repository: LoopBoardRepository) => void | Promise<void>,
) => {
  const tempDirectory = mkdtempSync(join(tmpdir(), "engine-sync-"));
  const database = new DatabaseSync(join(tempDirectory, "loopboard.sqlite"));

  return (async () => {
    try {
      applyMigrations(database);
      seedDatabase(database);
      await test(new LoopBoardRepository(database));
    } finally {
      database.close();
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  })();
};

const createAwaitingJob = (
  repository: LoopBoardRepository,
  overrides: Partial<EngineJob> = {},
): EngineJob => {
  const task = repository.getTask("task-local-persistence-reset");
  const startedAt = "2026-06-16T12:00:00.000Z";

  return repository.createEngineJob({
    kind: "task-run",
    backend: "agent-orchestrator",
    status: "running",
    projectId: task.projectId,
    taskId: task.id,
    startedAt,
    payload: buildTaskRunJobPayload({
      taskId: task.id,
      projectId: task.projectId,
      action: "execute",
      executorConfig: {
        backend: "agent-orchestrator",
        issueNumber: 42,
        timeoutMs: 600_000,
      },
      trigger: "manual",
    }),
    result: {
      [ENGINE_JOB_AWAITING_EXTERNAL_SYNC_KEY]: true,
      externalSessionId: "ao-session-42",
      branchLabel: "running",
      untrusted: true,
    },
    ...overrides,
  });
};

const mockAdapterRegistry = (input: {
  pollResults: BackendPollResult[];
  cancelCalls?: string[];
}): BackendAdapterRegistry => {
  let pollIndex = 0;

  const adapter: BackendAdapter = {
    backend: "agent-orchestrator",
    async checkAvailability() {
      return {
        backend: "agent-orchestrator",
        available: true,
        message: "mocked",
      };
    },
    async execute() {
      return { success: true, logs: [] };
    },
    async cancel(jobId: string) {
      input.cancelCalls?.push(jobId);
    },
    async poll() {
      const result = input.pollResults[pollIndex] ?? input.pollResults.at(-1)!;
      pollIndex += 1;
      return result;
    },
  };

  return new Map<ExecutorBackend, BackendAdapter>([
    ["agent-orchestrator", adapter],
  ]);
};

describe("engine sync service", () => {
  it("identifies jobs awaiting external sync", () => {
    const job = {
      id: "job-1",
      kind: "task-run",
      status: "running",
      backend: "agent-orchestrator",
      payload: {},
      executionLogs: [],
      attempt: 1,
      maxAttempts: 3,
      queuedAt: "2026-06-16T12:00:00.000Z",
      createdAt: "2026-06-16T12:00:00.000Z",
      updatedAt: "2026-06-16T12:00:00.000Z",
      result: { [ENGINE_JOB_AWAITING_EXTERNAL_SYNC_KEY]: true },
    } satisfies EngineJob;

    assert.equal(isEngineJobAwaitingExternalSync(job), true);
    assert.equal(
      isEngineJobAwaitingExternalSync({
        ...job,
        result: { [ENGINE_JOB_AWAITING_EXTERNAL_SYNC_KEY]: false },
      } as EngineJob),
      false,
    );
  });

  it("detects poll timeout from startedAt and executor timeoutMs", () => {
    const job = {
      startedAt: "2026-06-16T12:00:00.000Z",
    } as EngineJob;
    const now = () => new Date("2026-06-16T12:05:00.000Z");

    assert.equal(hasEngineJobPollTimedOut(job, 600_000, now), false);
    assert.equal(hasEngineJobPollTimedOut(job, 120_000, now), true);
  });

  it("reconciles completed external poll into Needs Review with untrusted summary", async () => {
    await withRepository(async (repository) => {
      const task = repository.getTask("task-local-persistence-reset");
      repository.applyTaskAction(task.id, "assign-ai");
      const job = createAwaitingJob(repository);

      const syncResult = await syncInFlightEngineJobs({
        repository,
        contextService: new TaskContextService(),
        adapterRegistry: mockAdapterRegistry({
          pollResults: [
            {
              status: "completed",
              summary: "Issue #42 reached done.",
              artifacts: {
                branchLabel: "completed",
                externalSessionId: "ao-session-42",
                untrusted: true,
              },
            },
          ],
        }),
        syncPullRequest: async () => ({
          status: "token-missing",
          repository: seedProject.githubRepository,
          message: "token missing",
          syncedAt: "2026-06-16T12:01:00.000Z",
          linkedIssueNumbers: [],
        }),
        resolveGitHubToken: () => "",
        now: () => new Date("2026-06-16T12:01:00.000Z"),
      });

      assert.equal(syncResult.examined, 1);
      assert.equal(syncResult.completed, 1);

      const updatedJob = repository.getEngineJob(job.id);
      assert.equal(updatedJob.status, "completed");

      const updatedTask = repository.getTask(task.id);
      assert.equal(updatedTask.status, "needs-review");
      const completedEvent = updatedTask.events.find(
        (event) => event.type === "ENGINE_TASK_COMPLETED",
      );
      assert.ok(completedEvent);
      assert.match(completedEvent!.message, new RegExp(externalUntrustedPrefix, "u"));
    });
  });

  it("syncs external PR URLs through github-prs helpers", async () => {
    await withRepository(async (repository) => {
      const task = repository.getTask("task-local-persistence-reset");
      repository.applyTaskAction(task.id, "assign-ai");
      createAwaitingJob(repository);

      const syncResult = await syncInFlightEngineJobs({
        repository,
        adapterRegistry: mockAdapterRegistry({
          pollResults: [
            {
              status: "completed",
              summary: "Issue #42 reached done with PR.",
              artifacts: {
                branchLabel: "completed",
                prUrl: "https://github.com/bank-p/loop-control-plane/pull/99",
                untrusted: true,
              },
            },
          ],
        }),
        syncPullRequest: async () => ({
          status: "synced",
          repository: seedProject.githubRepository,
          message: "synced pr",
          syncedAt: "2026-06-16T12:01:00.000Z",
          linkedIssueNumbers: [42],
          github: {
            issueNumber: 42,
            pullRequestNumber: 99,
            pullRequestUrl: "https://github.com/bank-p/loop-control-plane/pull/99",
            pullRequestState: "open",
            deliveryStatus: "pr-opened",
          },
        }),
        resolveGitHubToken: () => "ghp_test_token",
        now: () => new Date("2026-06-16T12:01:00.000Z"),
      });

      assert.equal(syncResult.prSynced, 1);

      const updatedTask = repository.getTask(task.id);
      assert.equal(
        updatedTask.github.pullRequestUrl,
        "https://github.com/bank-p/loop-control-plane/pull/99",
      );
    });
  });

  it("marks timed-out polls as failed and moves tasks to Blocked while leaving AO running", async () => {
    await withRepository(async (repository) => {
      const task = repository.getTask("task-local-persistence-reset");
      repository.applyTaskAction(task.id, "assign-ai");
      const job = createAwaitingJob(repository, {
        startedAt: "2026-06-16T12:00:00.000Z",
        payload: buildTaskRunJobPayload({
          taskId: task.id,
          projectId: task.projectId,
          action: "execute",
          executorConfig: {
            backend: "agent-orchestrator",
            issueNumber: 42,
            timeoutMs: 1_000,
          },
          trigger: "manual",
        }),
      });

      const cancelCalls: string[] = [];
      const syncResult = await syncInFlightEngineJobs({
        repository,
        adapterRegistry: mockAdapterRegistry({
          pollResults: [{ status: "running", summary: "still working" }],
          cancelCalls,
        }),
        now: () => new Date("2026-06-16T12:05:00.000Z"),
      });

      assert.equal(syncResult.timedOut, 1);
      assert.equal(cancelCalls.length, 0);

      const updatedJob = repository.getEngineJob(job.id);
      assert.equal(updatedJob.status, "failed");
      assert.equal(updatedJob.result?.pollTimedOut, true);

      const updatedTask = repository.getTask(task.id);
      assert.equal(updatedTask.status, "blocked");
      assert.match(updatedJob.error ?? "", /exceeded timeout/iu);
    });
  });

  it("keeps jobs running while external backend poll is still in progress", async () => {
    await withRepository(async (repository) => {
      const task = repository.getTask("task-local-persistence-reset");
      repository.applyTaskAction(task.id, "assign-ai");
      const job = createAwaitingJob(repository);

      const syncResult = await syncInFlightEngineJobs({
        repository,
        adapterRegistry: mockAdapterRegistry({
          pollResults: [{ status: "running", summary: "Agent Orchestrator session is working." }],
        }),
        now: () => new Date("2026-06-16T12:00:30.000Z"),
      });

      assert.equal(syncResult.stillRunning, 1);
      assert.equal(syncResult.completed, 0);

      const updatedJob = repository.getEngineJob(job.id);
      assert.equal(updatedJob.status, "running");
      assert.match(String(updatedJob.result?.lastExternalSummary), new RegExp(externalUntrustedPrefix, "u"));

      const updatedTask = repository.getTask(task.id);
      assert.equal(updatedTask.status, "ai-running");
      assert.ok(
        updatedTask.events.some((event) => event.type === "ENGINE_EXTERNAL_SYNC"),
      );
    });
  });
});
