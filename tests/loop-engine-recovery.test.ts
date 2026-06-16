import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { POST as postCancelEngineJob } from "@/app/api/engine/jobs/[jobId]/cancel/route";
import { POST as postRetryEngineJob } from "@/app/api/engine/jobs/[jobId]/retry/route";
import { applyMigrations } from "@/db/migrate";
import { seedDatabase } from "@/db/seed";
import {
  getEngineStatus,
  retryEngineJobForApi,
} from "@/lib/api/engine-actions";
import { LoopBoardRepository } from "@/lib/db/loopboard-repository";
import {
  cancelEngineJob,
  describeEngineJobOperatorActions,
  describeWorkflowRunEngineResume,
  EngineJobRecoveryError,
  retryEngineJob,
} from "@/lib/engine/engine-job-recovery";
import {
  createExecutorRegistryForRepository,
} from "@/lib/engine/executor-registry";
import { seedProject } from "@/lib/loopboard";
import {
  resumeWorkflowRunFromEngine,
  startWorkflowRun,
} from "@/lib/workflows/workflow-runner";

type ApiPayload<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

const readApiJson = async <T>(response: Response): Promise<ApiPayload<T>> =>
  (await response.json()) as ApiPayload<T>;

const withRepository = (
  test: (repository: LoopBoardRepository) => void | Promise<void>,
) => {
  const tempDirectory = mkdtempSync(join(tmpdir(), "loop-engine-recovery-"));
  const databasePath = join(tempDirectory, "loopboard.sqlite");
  const originalDatabasePath = process.env.LOOPBOARD_DATABASE_PATH;
  const database = new DatabaseSync(databasePath);

  return (async () => {
    try {
      process.env.LOOPBOARD_DATABASE_PATH = databasePath;
      applyMigrations(database);
      seedDatabase(database);
      await test(new LoopBoardRepository(database));
    } finally {
      if (originalDatabasePath === undefined) {
        delete process.env.LOOPBOARD_DATABASE_PATH;
      } else {
        process.env.LOOPBOARD_DATABASE_PATH = originalDatabasePath;
      }
      database.close();
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  })();
};

const createFailedDemoJob = (repository: LoopBoardRepository): string => {
  const job = repository.createEngineJob({
    id: "engine-job-failed-demo",
    kind: "demo-ping",
    backend: "stub",
    projectId: seedProject.id,
    status: "failed",
    payload: {},
    attempt: 2,
    maxAttempts: 3,
    error: "Demo ping failed.",
    queuedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  });

  return job.id;
};

describe("loop-engine-recovery", () => {
  it("requeues failed jobs when under maxAttempts and policy allows", () =>
    withRepository((repository) => {
      const jobId = createFailedDemoJob(repository);
      const actions = describeEngineJobOperatorActions(
        repository,
        repository.getEngineJob(jobId),
      );

      assert.equal(actions.retry.allowed, true);

      const retried = retryEngineJob(repository, jobId);
      assert.equal(retried.status, "queued");
      assert.equal(retried.error, undefined);
      assert.equal(retried.attempt, 2);
      assert.match(
        retried.executionLogs.at(-1)?.message ?? "",
        /Operator requeued failed engine job/,
      );
    }));

  it("blocks retry when max attempts are exhausted", () =>
    withRepository((repository) => {
      const job = repository.createEngineJob({
        id: "engine-job-exhausted",
        kind: "demo-ping",
        backend: "stub",
        projectId: seedProject.id,
        status: "failed",
        payload: {},
        attempt: 4,
        maxAttempts: 3,
        error: "Exhausted retries.",
        queuedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      });

      const actions = describeEngineJobOperatorActions(repository, job);
      assert.equal(actions.retry.allowed, false);
      assert.equal(actions.retry.code, "engine_job_max_attempts_exhausted");

      assert.throws(
        () => retryEngineJob(repository, job.id),
        (error: unknown) => {
          assert.ok(error instanceof EngineJobRecoveryError);
          assert.equal(error.code, "engine_job_max_attempts_exhausted");
          return true;
        },
      );
    }));

  it("cancels queued jobs and releases task locks", () =>
    withRepository(async (repository) => {
      const task = repository
        .listBoardData(seedProject.id)
        .tasks.find((candidate) => candidate.status === "ready");

      assert.ok(task);

      repository.moveTask(task.id, "ai-running", "system");
      const job = repository.createEngineJob({
        id: "engine-job-cancel-queued",
        kind: "task-run",
        backend: "stub",
        projectId: seedProject.id,
        taskId: task.id,
        status: "queued",
        payload: { taskId: task.id },
        attempt: 1,
        maxAttempts: 3,
        queuedAt: new Date().toISOString(),
      });

      const cancelled = await cancelEngineJob(repository, job.id);
      assert.equal(cancelled.status, "cancelled");
      assert.equal(repository.getTask(task.id).status, "ready");
    }));

  it("cancels running jobs through the executor registry", () =>
    withRepository(async (repository) => {
      const registry = createExecutorRegistryForRepository(repository);
      const job = repository.createEngineJob({
        id: "engine-job-cancel-running",
        kind: "demo-ping",
        backend: "stub",
        projectId: seedProject.id,
        status: "running",
        payload: {},
        attempt: 1,
        maxAttempts: 3,
        queuedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
      });

      const cancelled = await cancelEngineJob(repository, job.id, registry);
      assert.equal(cancelled.status, "cancelled");
    }));

  it("describes workflow resume as blocked while waiting for approval", () =>
    withRepository((repository) => {
      const workflow = repository
        .listWorkflows(seedProject.id)
        .find((candidate) => candidate.id === "workflow-feature-development-loop");

      assert.ok(workflow);

      const run = startWorkflowRun({
        repository,
        input: {
          workflowId: workflow.id,
          featureId: repository.listFeatures(seedProject.id)[0]?.id,
        },
      });

      repository.updateWorkflowRun(run.id, {
        status: "paused",
        currentNodeId: "node-human-review",
      });
      repository.upsertWorkflowRunStep(run.id, {
        id: "step-human-review",
        workflowNodeId: "node-human-review",
        status: "waiting-approval",
        attempt: 1,
        inputArtifacts: [],
        outputArtifacts: [],
        executionLogs: [],
        requireApproval: true,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const resume = describeWorkflowRunEngineResume(repository, run.id);
      assert.equal(resume.allowed, false);
      assert.equal(resume.code, "workflow_approval_required");
    }));

  it("resumes failed workflow runs after operator action", () =>
    withRepository(async (repository) => {
      const workflow = repository
        .listWorkflows(seedProject.id)
        .find((candidate) => candidate.id === "workflow-feature-development-loop");

      assert.ok(workflow);

      const run = startWorkflowRun({
        repository,
        input: {
          workflowId: workflow.id,
          featureId: repository.listFeatures(seedProject.id)[0]?.id,
        },
      });

      repository.updateWorkflowRun(run.id, {
        status: "failed",
        currentNodeId: "node-run-tests",
      });

      const resume = describeWorkflowRunEngineResume(repository, run.id);
      assert.equal(resume.allowed, true);

      const resumed = await resumeWorkflowRunFromEngine({
        repository,
        runId: run.id,
      });
      assert.notEqual(resumed.status, "failed");
    }));

  it("exposes workflow resume policy on engine status", () =>
    withRepository((repository) => {
      const workflow = repository
        .listWorkflows(seedProject.id)
        .find((candidate) => candidate.id === "workflow-feature-development-loop");

      assert.ok(workflow);

      startWorkflowRun({
        repository,
        input: {
          workflowId: workflow.id,
          featureId: repository.listFeatures(seedProject.id)[0]?.id,
        },
      });

      const status = getEngineStatus(repository, { projectId: seedProject.id });
      assert.ok(status.workflowRunResume);
      assert.equal(typeof status.workflowRunResume.allowed, "boolean");
    }));

  it("serves retry and cancel routes through the API layer", () =>
    withRepository(async (repository) => {
      const jobId = createFailedDemoJob(repository);

      const retryResponse = await postRetryEngineJob(
        new Request("http://localhost/api/engine/jobs/retry", { method: "POST" }),
        { params: Promise.resolve({ jobId }) },
      );
      const retryPayload = await readApiJson<{ job: { status: string } }>(retryResponse);
      assert.equal(retryResponse.status, 200);
      assert.equal(retryPayload.ok, true);
      if (retryPayload.ok) {
        assert.equal(retryPayload.data.job.status, "queued");
      }

      const runningJob = repository.createEngineJob({
        id: "engine-job-api-cancel",
        kind: "demo-ping",
        backend: "stub",
        projectId: seedProject.id,
        status: "running",
        payload: {},
        attempt: 1,
        maxAttempts: 3,
        queuedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
      });

      const cancelResponse = await postCancelEngineJob(
        new Request("http://localhost/api/engine/jobs/cancel", { method: "POST" }),
        { params: Promise.resolve({ jobId: runningJob.id }) },
      );
      const cancelPayload = await readApiJson<{ job: { status: string } }>(cancelResponse);
      assert.equal(cancelResponse.status, 200);
      assert.equal(cancelPayload.ok, true);
      if (cancelPayload.ok) {
        assert.equal(cancelPayload.data.job.status, "cancelled");
      }
    }));

  it("wraps operator actions for API consumers", () =>
    withRepository((repository) => {
      const jobId = createFailedDemoJob(repository);
      const retried = retryEngineJobForApi(repository, jobId);
      assert.equal(retried.job.status, "queued");
    }));
});
