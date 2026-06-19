import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
import { executeCreateGitHubIssues } from "@/lib/engine/executors/create-github-issues-executor";
import { executeImportTasks } from "@/lib/engine/executors/import-tasks-executor";
import {
  createExecutorRegistryForRepository,
} from "@/lib/engine/executor-registry";
import { TaskContextService } from "@/lib/context/task-context-service";
import { discoverFeatureArtifacts } from "@/lib/features/feature-artifacts";
import { SpecKitTaskImporter } from "@/lib/importers/spec-kit-task-importer";
import { defaultAutomationSettings } from "@/lib/policies/automation-policy";
import { seedProject } from "@/lib/loopboard";
import type { WorkflowArtifact } from "@/lib/loopboard";
import {
  resumeWorkflowRunFromEngine,
  runNextWorkflowStep,
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
  it("marks orphaned running work interrupted and resumes with a new attempt", () =>
    withRepository(async (repository) => {
      const workflow = repository.createWorkflow({
        id: "workflow-interruption-recovery",
        projectId: seedProject.id,
        name: "Interruption recovery",
        nodes: [
          {
            id: "node-import",
            type: "import-tasks",
            name: "Import",
            mode: "auto",
            position: { x: 0, y: 0 },
            inputArtifacts: [],
            outputArtifacts: [
              {
                name: "loopboard-tasks",
                path: "loopboard://feature/{feature}/tasks",
                required: true,
              },
            ],
            requireApproval: false,
            maxRetries: 2,
            riskPolicy: "low",
            config: {},
            currentState: "idle",
          },
        ],
        edges: [],
      });
      repository.updateAutomationSettings({ globalAutoRunEnabled: true });
      const run = startWorkflowRun({
        repository,
        input: { workflowId: workflow.id },
      });
      const running = runNextWorkflowStep({ repository, runId: run.id });
      assert.equal(running.steps[0]?.status, "running");

      const interrupted = repository.interruptOrphanedExecutions("test restart");
      assert.equal(interrupted.runs, 1);
      assert.equal(interrupted.jobs, 1);
      assert.equal(repository.getWorkflowRun(run.id).status, "interrupted");
      assert.equal(
        repository
          .listEngineJobs({ workflowRunId: run.id })
          .at(-1)?.status,
        "interrupted",
      );
      assert.equal(
        repository.getWorkflowRun(run.id).steps[0]?.status,
        "interrupted",
      );

      const resumed = await resumeWorkflowRunFromEngine({
        repository,
        runId: run.id,
      });
      assert.equal(resumed.status, "running");
      assert.equal(resumed.steps.length, 2);
      assert.equal(resumed.steps[0]?.status, "interrupted");
      assert.equal(resumed.steps[1]?.attempt, 2);
    }));

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

  it("keeps import-tasks idempotent after operator retry requeue", () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "loop-engine-recovery-import-"));
    const repoPath = join(tempDirectory, "repo");
    const contextRoot = join(tempDirectory, "contexts");
    const featureFolder = join(repoPath, "specs", "checkout");
    const databasePath = join(tempDirectory, "loopboard.sqlite");
    const database = new DatabaseSync(databasePath);

    try {
      mkdirSync(featureFolder, { recursive: true });
      writeFileSync(
        join(featureFolder, "tasks.md"),
        [
          "# Tasks",
          "",
          "- [ ] T001 Add checkout API in `app/api/checkout/route.ts`",
          "- [ ] T002 Build checkout form in `app/checkout/page.tsx`",
        ].join("\n"),
        "utf8",
      );

      applyMigrations(database);
      const repository = new LoopBoardRepository(database);
      const project = repository.createProject({
        id: "project-recovery-import",
        name: "Recovery Import",
        repoPath,
        specKitRoot: "specs",
        createdAt: "2026-06-16T08:00:00.000Z",
      });
      const discovered = discoverFeatureArtifacts({
        project,
        artifactFolderPath: "specs/checkout",
        status: "tasks-ready",
      });
      const feature = repository.createFeature({
        id: "feature-recovery-import",
        projectId: project.id,
        name: "Checkout Flow",
        source: "spec-kit",
        status: "tasks-ready",
        ...discovered,
        createdAt: "2026-06-16T08:10:00.000Z",
      });

      const workflow = repository.createWorkflow({
        id: "workflow-recovery-import",
        projectId: project.id,
        name: "Recovery Import",
        description: "Import retry workflow.",
        nodes: [
          {
            id: "node-import-tasks",
            type: "import-tasks",
            name: "Import Tasks",
            mode: "auto",
            position: { x: 0, y: 0 },
            inputArtifacts: [],
            outputArtifacts: [],
            requireApproval: false,
            maxRetries: 0,
            riskPolicy: "low",
            config: {},
            currentState: "idle",
          },
        ],
        edges: [],
      });
      repository.createWorkflowRun({
        id: "workflow-run-import-retry",
        workflowId: workflow.id,
        featureId: feature.id,
        status: "running",
        currentNodeId: "node-import-tasks",
      });

      const inputArtifacts: WorkflowArtifact[] = [
        { name: "tasks", path: "specs/checkout/tasks.md", required: true },
      ];
      const outputArtifacts: WorkflowArtifact[] = [
        {
          name: "loopboard-tasks",
          path: "loopboard://feature/{feature}/tasks",
          required: true,
        },
      ];
      const importer = new SpecKitTaskImporter(
        repository,
        new TaskContextService(contextRoot),
      );

      const failedJob = repository.createEngineJob({
        id: "engine-job-import-retry",
        kind: "workflow-step",
        backend: "stub",
        projectId: project.id,
        workflowRunId: "workflow-run-import-retry",
        workflowNodeId: "node-import-tasks",
        status: "failed",
        payload: { nodeType: "import-tasks", featureId: feature.id },
        attempt: 1,
        maxAttempts: 3,
        error: "Transient import failure.",
        queuedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      });

      const first = executeImportTasks({
        repository,
        featureId: feature.id,
        inputArtifacts,
        outputArtifacts,
        importer,
      });
      assert.equal(first.success, true);
      assert.equal(first.result?.importedCount, 2);

      const retried = retryEngineJob(repository, failedJob.id);
      assert.equal(retried.status, "queued");

      const second = executeImportTasks({
        repository,
        featureId: feature.id,
        inputArtifacts,
        outputArtifacts,
        importer,
      });
      assert.equal(second.success, true);
      assert.equal(second.result?.importedCount, 0);
      assert.equal(second.result?.skippedCount, 2);

      const tasks = repository
        .listBoardData(project.id)
        .tasks.filter((task) => task.featureId === feature.id);
      assert.equal(tasks.length, 2);
      assert.ok(existsSync(join(contextRoot, tasks[0]?.id ?? "", "task.md")));
      assert.ok(readFileSync(join(contextRoot, tasks[0]?.id ?? "", "task.md"), "utf8").length > 0);
    } finally {
      database.close();
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  it("keeps create-github-issues idempotent after operator retry requeue", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "loop-engine-recovery-github-"));
    const repoPath = join(tempDirectory, "repo");
    const databasePath = join(tempDirectory, "loopboard.sqlite");
    const database = new DatabaseSync(databasePath);

    try {
      mkdirSync(repoPath, { recursive: true });
      applyMigrations(database);
      const repository = new LoopBoardRepository(database);
      const project = repository.createProject({
        id: "project-recovery-github",
        name: "Recovery GitHub",
        repoPath,
        specKitRoot: "specs",
        githubRepository: "bank-p/loop-control-plane",
        automationPolicy: {
          allowLowRiskAutoIssueCreation: true,
          allowLowRiskAutoAoReadyLabeling: false,
          mediumRiskRequiresReview: true,
          highRiskManualOnly: true,
        },
        createdAt: "2026-06-16T08:00:00.000Z",
      });
      const feature = repository.createFeature({
        id: "feature-recovery-github",
        projectId: project.id,
        name: "Checkout Flow",
        source: "manual",
        status: "tasks-ready",
        createdAt: "2026-06-16T08:10:00.000Z",
      });
      repository.createTask({
        id: "task-recovery-github",
        projectId: project.id,
        featureId: feature.id,
        title: "Polish sidebar spacing",
        description: "Adjust padding on the settings sidebar panel.",
        status: "ready",
        owner: "ai",
        mode: "execute",
        risk: "low",
        source: "manual",
        createdAt: "2026-06-16T08:20:00.000Z",
      });

      const workflow = repository.createWorkflow({
        id: "workflow-recovery-github",
        projectId: project.id,
        name: "Recovery GitHub",
        description: "GitHub issue retry workflow.",
        nodes: [
          {
            id: "node-create-github-issues",
            type: "create-github-issues",
            name: "Create GitHub Issues",
            mode: "auto",
            position: { x: 0, y: 0 },
            inputArtifacts: [],
            outputArtifacts: [],
            requireApproval: false,
            maxRetries: 0,
            riskPolicy: "low",
            config: {},
            currentState: "idle",
          },
        ],
        edges: [],
      });
      repository.createWorkflowRun({
        id: "workflow-run-github-retry",
        workflowId: workflow.id,
        featureId: feature.id,
        status: "running",
        currentNodeId: "node-create-github-issues",
      });

      const outputArtifacts: WorkflowArtifact[] = [
        {
          name: "github-issues",
          path: "https://github.com/{repository}/issues",
          required: true,
        },
      ];
      let createCalls = 0;
      const createIssue = async ({ title }: { title: string }) => {
        createCalls += 1;
        return {
          status: "created" as const,
          repository: "bank-p/loop-control-plane",
          message: `Created GitHub issue for ${title}.`,
          issueNumber: 42,
          issueUrl: "https://github.com/bank-p/loop-control-plane/issues/42",
          labels: ["loopboard", "risk-low"],
          createdAt: "2026-06-16T00:00:00.000Z",
        };
      };

      const failedJob = repository.createEngineJob({
        id: "engine-job-github-retry",
        kind: "workflow-step",
        backend: "stub",
        projectId: project.id,
        workflowRunId: "workflow-run-github-retry",
        workflowNodeId: "node-create-github-issues",
        status: "failed",
        payload: { nodeType: "create-github-issues", featureId: feature.id },
        attempt: 1,
        maxAttempts: 3,
        error: "Transient GitHub API failure.",
        queuedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      });

      const first = await executeCreateGitHubIssues({
        repository,
        featureId: feature.id,
        workflowRunId: "workflow-run-github-retry",
        outputArtifacts,
        token: "token",
        automationSettings: {
          ...defaultAutomationSettings,
          globalAutoRunEnabled: true,
        },
        createIssue,
      });
      assert.equal(first.success, true);
      assert.equal(first.result?.createdCount, 1);
      assert.equal(createCalls, 1);

      const retried = retryEngineJob(repository, failedJob.id);
      assert.equal(retried.status, "queued");

      const second = await executeCreateGitHubIssues({
        repository,
        featureId: feature.id,
        workflowRunId: "workflow-run-github-retry",
        outputArtifacts,
        token: "token",
        automationSettings: {
          ...defaultAutomationSettings,
          globalAutoRunEnabled: true,
        },
        createIssue,
      });
      assert.equal(second.success, true);
      assert.equal(second.result?.createdCount, 0);
      assert.equal(second.result?.skippedExistingCount, 1);
      assert.equal(createCalls, 1);
    } finally {
      database.close();
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  });
});
