import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { applyMigrations } from "@/db/migrate";
import { seedDatabase } from "@/db/seed";
import { TaskContextService } from "@/lib/context/task-context-service";
import { LoopBoardRepository } from "@/lib/db/loopboard-repository";
import {
  createExecutorRegistryForRepository,
  type ExecutorContext,
  type ExecutorResult,
} from "@/lib/engine/executor-registry";
import {
  buildTaskRunJobPayload,
  parseTaskRunJobPayload,
  type EngineJob,
} from "@/lib/engine/loop-engine-types";
import { LoopScheduler } from "@/lib/engine/loop-scheduler";
import {
  executeTaskRunJob,
  finalizeTaskRunFailure,
  finalizeTaskRunSuccess,
  isTrivialDemoTask,
  pickupTaskForEngineRun,
  resolveTaskRunExecutorConfig,
} from "@/lib/engine/task-run-executor";
import { seedProject } from "@/lib/loopboard";

const sampleTaskRunJob = (
  overrides: Partial<EngineJob> = {},
): EngineJob => ({
  id: "engine-job-task-run-1",
  kind: "task-run",
  status: "running",
  backend: "stub",
  projectId: seedProject.id,
  taskId: "task-local-persistence-reset",
  payload: buildTaskRunJobPayload({
    taskId: "task-local-persistence-reset",
    projectId: seedProject.id,
    action: "execute",
    executorConfig: { backend: "stub" },
    trigger: "manual",
  }),
  executionLogs: [],
  attempt: 1,
  maxAttempts: 3,
  queuedAt: "2026-06-16T12:00:00.000Z",
  createdAt: "2026-06-16T12:00:00.000Z",
  updatedAt: "2026-06-16T12:00:00.000Z",
  ...overrides,
});

const withRepository = (
  test: (repository: LoopBoardRepository, contextRoot: string) => void | Promise<void>,
) => {
  const tempDirectory = mkdtempSync(join(tmpdir(), "task-run-executor-"));
  const contextRoot = join(tempDirectory, "task-contexts");
  const database = new DatabaseSync(join(tempDirectory, "loopboard.sqlite"));
  const previousRoot = process.env.LOOPBOARD_TASK_CONTEXT_ROOT;

  process.env.LOOPBOARD_TASK_CONTEXT_ROOT = contextRoot;

  return (async () => {
    try {
      applyMigrations(database);
      seedDatabase(database);
      await test(new LoopBoardRepository(database), contextRoot);
    } finally {
      database.close();
      rmSync(tempDirectory, { recursive: true, force: true });
      if (previousRoot === undefined) {
        delete process.env.LOOPBOARD_TASK_CONTEXT_ROOT;
      } else {
        process.env.LOOPBOARD_TASK_CONTEXT_ROOT = previousRoot;
      }
    }
  })();
};

describe("task-run executor helpers", () => {
  it("defaults executor resolution to stub unless explicitly configured", () => {
    withRepository((repository) => {
      const task = repository.getTask("task-local-persistence-reset");
      const project = repository.getProject(task.projectId);
      const payload = parseTaskRunJobPayload(
        buildTaskRunJobPayload({
          taskId: task.id,
          projectId: project.id,
          action: "execute",
          executorConfig: { backend: "stub" },
          trigger: "scheduler",
        }),
      );
      assert.ok(payload);

      const resolved = resolveTaskRunExecutorConfig({
        payload,
        task,
        project,
      });

      assert.equal(resolved.backend, "stub");
    });
  });

  it("uses task executor-backend label when explicitly configured", () => {
    withRepository((repository) => {
      repository.updateTask("task-local-persistence-reset", {
        labels: ["executor-backend:cursor"],
      });
      const task = repository.getTask("task-local-persistence-reset");
      const project = repository.getProject(task.projectId);
      const payload = parseTaskRunJobPayload(
        buildTaskRunJobPayload({
          taskId: task.id,
          projectId: project.id,
          action: "execute",
          executorConfig: { backend: "stub" },
          trigger: "scheduler",
        }),
      );
      assert.ok(payload);

      const resolved = resolveTaskRunExecutorConfig({
        payload,
        task,
        project,
      });

      assert.equal(resolved.backend, "cursor");
    });
  });

  it("detects trivial demo tasks by label", () => {
    withRepository((repository) => {
      const task = repository.getTask("task-local-persistence-reset");
      assert.equal(isTrivialDemoTask(task), false);

      repository.updateTask(task.id, {
        labels: [...task.labels, "engine-trivial"],
      });

      assert.equal(
        isTrivialDemoTask(repository.getTask(task.id)),
        true,
      );
    });
  });
});

describe("task-run executor orchestration", () => {
  it("generates context, picks up task, and moves to needs-review on success", async () => {
    await withRepository(async (repository, contextRoot) => {
      const job = sampleTaskRunJob();
      const context: ExecutorContext = {
        job,
        config: { backend: "stub" },
      };

      const result = await executeTaskRunJob(context, {
        repository,
        contextService: new TaskContextService(contextRoot),
      });

      assert.equal(result.success, true);

      const task = repository.getTask("task-local-persistence-reset");
      assert.equal(task.status, "needs-review");
      assert.equal(task.owner, "ai");
      assert.ok(
        task.events.some(
          (event) =>
            event.type === "ENGINE_PICKUP" && event.actor === "system",
        ),
      );
      assert.ok(
        task.events.some((event) => event.type === "ENGINE_TASK_COMPLETED"),
      );

      const contextDir = join(contextRoot, "task-local-persistence-reset");
      assert.ok(existsSync(join(contextDir, "task.md")));
      assert.ok(existsSync(join(contextDir, "context.md")));
      assert.ok(existsSync(join(contextDir, "handoff.md")));
      assert.ok(existsSync(join(contextDir, "events.jsonl")));

      const handoff = readFileSync(join(contextDir, "handoff.md"), "utf8");
      assert.match(handoff, /ENGINE_TASK_COMPLETED/);
    });
  });

  it("marks trivial demo tasks done instead of needs-review", async () => {
    await withRepository(async (repository, contextRoot) => {
      const task = repository.getTask("task-local-persistence-reset");
      repository.updateTask(task.id, {
        labels: [...task.labels, "engine-trivial"],
      });

      const result = await executeTaskRunJob(
        {
          job: sampleTaskRunJob(),
          config: { backend: "stub" },
        },
        {
          repository,
          contextService: new TaskContextService(contextRoot),
        },
      );

      assert.equal(result.success, true);
      assert.equal(repository.getTask(task.id).status, "done");
    });
  });

  it("keeps task in ai-running on retryable failure and blocks when exhausted", async () => {
    await withRepository(async (repository, contextRoot) => {
      const failingBackend = async (): Promise<ExecutorResult> => ({
        success: false,
        error: "token=super-secret backend failed",
        logs: [],
      });

      const contextService = new TaskContextService(contextRoot);
      const taskId = "task-local-persistence-reset";

      await executeTaskRunJob(
        {
          job: sampleTaskRunJob({ attempt: 1, maxAttempts: 3 }),
          config: { backend: "stub" },
        },
        {
          repository,
          contextService,
          invokeBackend: failingBackend,
        },
      );

      let task = repository.getTask(taskId);
      assert.equal(task.status, "ai-running");
      const failureEvent = task.events.find(
        (event) => event.type === "ENGINE_TASK_FAILED",
      );
      assert.ok(failureEvent);
      assert.equal(failureEvent?.metadata?.willRetry, true);
      assert.match(failureEvent?.message ?? "", /\[redacted\]/);

      await executeTaskRunJob(
        {
          job: sampleTaskRunJob({ attempt: 3, maxAttempts: 3 }),
          config: { backend: "stub" },
        },
        {
          repository,
          contextService,
          invokeBackend: failingBackend,
        },
      );

      task = repository.getTask(taskId);
      assert.equal(task.status, "blocked");
      assert.ok(task.labels.includes("blocked"));
    });
  });

  it("runs through scheduler tick for enqueued task-run jobs", async () => {
    await withRepository(async (repository, contextRoot) => {
      repository.updateAutomationSettings({
        globalAutoRunEnabled: true,
      });

      repository.enqueueTaskRunJob({
        taskId: "task-local-persistence-reset",
        projectId: seedProject.id,
        backend: "stub",
        payload: buildTaskRunJobPayload({
          taskId: "task-local-persistence-reset",
          projectId: seedProject.id,
          action: "execute",
          executorConfig: { backend: "stub" },
          trigger: "scheduler",
        }),
      });

      const scheduler = new LoopScheduler(
        repository,
        createExecutorRegistryForRepository(repository),
      );

      const tick = await scheduler.tick({ mode: "manual" });

      assert.equal(tick.plan.action, "process");
      assert.equal(tick.job?.status, "completed");
      assert.equal(
        repository.getTask("task-local-persistence-reset").status,
        "needs-review",
      );
    });
  });
});

describe("task-run pickup and finalize units", () => {
  it("pickup transitions ready tasks and records engine pickup event", () => {
    withRepository((repository) => {
      const task = repository.getTask("task-local-persistence-reset");
      const job = sampleTaskRunJob();
      const payload = parseTaskRunJobPayload(
        buildTaskRunJobPayload({
          taskId: task.id,
          projectId: task.projectId,
          action: "execute",
          executorConfig: { backend: "stub" },
          trigger: "manual",
        }),
      );
      assert.ok(payload);

      const pickedUp = pickupTaskForEngineRun(repository, task, job, payload);

      assert.equal(pickedUp.status, "ai-running");
      assert.equal(pickedUp.owner, "ai");
      assert.ok(
        pickedUp.events.some((event) => event.type === "ENGINE_PICKUP"),
      );
    });
  });

  it("finalize helpers refresh context artifacts", () => {
    withRepository((repository, contextRoot) => {
      const contextService = new TaskContextService(contextRoot);
      const taskId = "task-local-persistence-reset";
      const job = sampleTaskRunJob();

      repository.applyTaskAction(taskId, "assign-ai");

      finalizeTaskRunSuccess(repository, contextService, taskId, job, {
        success: true,
        stdoutSummary: "Completed demo work.",
        logs: [],
      });

      const task = repository.getTask(taskId);
      assert.equal(task.status, "needs-review");

      finalizeTaskRunFailure(
        repository,
        contextService,
        taskId,
        { ...job, attempt: 3, maxAttempts: 3 },
        "final failure",
        false,
      );

      assert.equal(repository.getTask(taskId).status, "blocked");
    });
  });
});
