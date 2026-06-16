import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { applyMigrations } from "@/db/migrate";
import { seedDatabase } from "@/db/seed";
import { LoopBoardRepository } from "@/lib/db/loopboard-repository";
import {
  ExecutorRegistry,
  StubExecutor,
  type ExecutorContext,
} from "@/lib/engine/executor-registry";
import { dispatchWorkflowStepJob } from "@/lib/engine/executors/workflow-step-dispatcher";
import { parseWorkflowStepJobPayload } from "@/lib/engine/executors/workflow-step-types";
import { LoopScheduler } from "@/lib/engine/loop-scheduler";
import type { ProcessRunResult, ProcessRunner } from "@/lib/engine/process-runner";
import { discoverFeatureArtifacts } from "@/lib/features/feature-artifacts";
import { seedProject, seedWorkflows } from "@/lib/loopboard";
import {
  approveWorkflowRunStep,
  runNextWorkflowStep,
  startWorkflowRun,
} from "@/lib/workflows/workflow-runner";

const FEATURE_BRIEF = [
  "# Feature Brief",
  "",
  "Verify workflow executors for the Feature Development Loop.",
].join("\n");

const FIXTURE_TASKS = [
  "# Tasks",
  "",
  "- [ ] T001 Verify spec-kit-actions executor with mocked CLI",
  "- [ ] T002 Verify import-tasks executor creates board tasks",
].join("\n");

const createMockSpecKitProcessRunner = (repoPath: string): ProcessRunner => ({
  run: async (request: { args?: string[] }): Promise<ProcessRunResult> => {
    const args = request.args ?? [];
    const outputPath = args.at(-1);
    if (typeof outputPath === "string") {
      writeFileSync(join(repoPath, outputPath), `# ${args[0] ?? "output"}\n`, "utf8");
    }

    return {
      success: true,
      exitCode: 0,
      stdout: "generated",
      stderr: "",
      stdoutSummary: "generated",
      stderrSummary: "",
      timedOut: false,
      durationMs: 1,
      commandSummary: args.join(" "),
      profile: "spec-kit",
      command: "spec-kit",
      args,
    };
  },
} as unknown as ProcessRunner);

const createVerificationExecutorRegistry = (
  repository: LoopBoardRepository,
  repoPath: string,
): ExecutorRegistry =>
  new ExecutorRegistry([
    new StubExecutor({
      workflowStepHandler: async (context: ExecutorContext) =>
        dispatchWorkflowStepJob(context, {
          repository,
          processRunner: createMockSpecKitProcessRunner(repoPath),
        }),
    }),
  ]);

describe("workflow executor verification", () => {
  it("walks Feature Development Loop through import-tasks with fixture brief and mocked Spec Kit CLI", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "loopboard-fdl-verify-"));
    const repoPath = join(tempDirectory, "repo");
    const featureId = "feature-fdl-verify";
    const featureFolder = join(repoPath, "specs", featureId);
    const database = new DatabaseSync(join(tempDirectory, "loopboard.sqlite"));

    try {
      mkdirSync(featureFolder, { recursive: true });
      writeFileSync(join(featureFolder, "PRD.md"), FEATURE_BRIEF, "utf8");

      applyMigrations(database);
      seedDatabase(database);

      const repository = new LoopBoardRepository(database);
      repository.updateProject(seedProject.id, { repoPath });
      repository.updateAutomationSettings({ globalAutoRunEnabled: true });

      const discovered = discoverFeatureArtifacts({
        project: repository.getProject(seedProject.id),
        artifactFolderPath: `specs/${featureId}`,
        status: "prd-draft",
      });
      repository.createFeature({
        id: featureId,
        projectId: seedProject.id,
        name: "Feature Development Loop Verification",
        source: "spec-kit",
        status: "prd-draft",
        ...discovered,
        createdAt: "2026-06-16T12:00:00.000Z",
      });

      const workflowId = seedWorkflows[0].id;
      const scheduler = new LoopScheduler(
        repository,
        createVerificationExecutorRegistry(repository, repoPath),
      );

      const run = startWorkflowRun({
        repository,
        input: { workflowId, featureId },
      });
      assert.equal(run.currentNodeId, "node-human-input");

      const humanPaused = runNextWorkflowStep({ repository, runId: run.id });
      assert.equal(humanPaused.status, "paused");
      assert.equal(humanPaused.steps[0]?.status, "waiting-approval");

      const afterHumanInput = approveWorkflowRunStep({ repository, runId: run.id });
      assert.equal(afterHumanInput.currentNodeId, "node-spec-kit-actions");
      assert.equal(afterHumanInput.steps[0]?.status, "completed");
      assert.equal(
        afterHumanInput.steps[0]?.outputArtifacts[0]?.path,
        `specs/${featureId}/PRD.md`,
      );

      const specKitPaused = runNextWorkflowStep({ repository, runId: run.id });
      assert.equal(specKitPaused.status, "paused");
      assert.equal(specKitPaused.currentNodeId, "node-spec-kit-actions");

      const specKitDelegated = approveWorkflowRunStep({ repository, runId: run.id });
      assert.equal(specKitDelegated.steps.at(-1)?.status, "running");
      const specKitJobPayload = repository
        .listEngineJobs({ status: "queued" })
        .find((job) => job.workflowRunId === run.id)?.payload;
      assert.ok(specKitJobPayload);
      assert.equal(
        parseWorkflowStepJobPayload(specKitJobPayload)?.nodeType,
        "spec-kit-actions",
      );

      const specKitTick = await scheduler.tick({ mode: "manual" });
      assert.equal(specKitTick.job?.status, "completed");
      assert.equal(specKitTick.job?.payload.nodeType, "spec-kit-actions");

      const afterSpecKit = repository.getWorkflowRun(run.id);
      assert.equal(afterSpecKit.currentNodeId, "node-human-review");
      assert.equal(afterSpecKit.steps.at(-1)?.status, "completed");

      writeFileSync(join(featureFolder, "tasks.md"), FIXTURE_TASKS, "utf8");

      const reviewPaused = runNextWorkflowStep({ repository, runId: run.id });
      assert.equal(reviewPaused.status, "paused");
      assert.equal(reviewPaused.currentNodeId, "node-human-review");

      const afterReview = approveWorkflowRunStep({ repository, runId: run.id });
      assert.equal(afterReview.currentNodeId, "node-import-tasks");

      const importPaused = runNextWorkflowStep({ repository, runId: run.id });
      assert.equal(importPaused.status, "paused");
      assert.equal(importPaused.currentNodeId, "node-import-tasks");

      const importDelegated = approveWorkflowRunStep({ repository, runId: run.id });
      assert.equal(importDelegated.steps.at(-1)?.status, "running");

      const importTick = await scheduler.tick({ mode: "manual" });
      assert.equal(importTick.job?.status, "completed");
      assert.equal(importTick.job?.payload.nodeType, "import-tasks");

      const afterImport = repository.getWorkflowRun(run.id);
      assert.equal(afterImport.currentNodeId, "node-create-github-issues");
      assert.equal(afterImport.steps.at(-1)?.status, "completed");

      const boardTasks = repository
        .listBoardData(seedProject.id)
        .tasks.filter((task) => task.featureId === featureId);
      assert.equal(boardTasks.length, 2);
      assert.ok(
        boardTasks.some((task) =>
          task.title.includes("Verify spec-kit-actions executor"),
        ),
      );
      assert.ok(
        boardTasks.some((task) =>
          task.title.includes("Verify import-tasks executor"),
        ),
      );

      const featureEvents = repository.getFeature(featureId).events;
      assert.ok(featureEvents.some((event) => event.type === "WORKFLOW_RUN_STARTED"));
      assert.ok(
        featureEvents.filter((event) => event.type === "WORKFLOW_STEP_COMPLETED").length >=
          3,
      );
    } finally {
      database.close();
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  });
});
