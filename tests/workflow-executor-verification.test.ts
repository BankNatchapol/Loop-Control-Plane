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
  type ExecutorResult,
} from "@/lib/engine/executor-registry";
import { executeCreateGitHubIssues } from "@/lib/engine/executors/create-github-issues-executor";
import { executeOpenPr } from "@/lib/engine/executors/open-pr-executor";
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

const createMockTestProcessRunner = (): ProcessRunner =>
  ({
    run: async (): Promise<ProcessRunResult> => ({
      success: true,
      exitCode: 0,
      stdout: "All tests passed",
      stderr: "",
      stdoutSummary: "All tests passed",
      stderrSummary: "",
      timedOut: false,
      durationMs: 12,
      commandSummary: "npm test",
      profile: "npm-test",
      command: "npm",
      args: ["test"],
    }),
  }) as unknown as ProcessRunner;

const createMockGhProcessRunner = (): ProcessRunner =>
  ({
    run: async (): Promise<ProcessRunResult> => ({
      success: true,
      exitCode: 0,
      stdout: "https://github.com/bank-p/loop-control-plane/pull/42",
      stderr: "",
      stdoutSummary: "https://github.com/bank-p/loop-control-plane/pull/42",
      stderrSummary: "",
      timedOut: false,
      durationMs: 8,
      commandSummary: "gh pr create",
      profile: "gh",
      command: "gh",
      args: ["pr", "create"],
    }),
  }) as unknown as ProcessRunner;

const toExecutorResult = (
  stepResult: Awaited<
    ReturnType<
      | typeof executeCreateGitHubIssues
      | typeof executeOpenPr
      | typeof dispatchWorkflowStepJob
    >
  >,
): ExecutorResult => ({
  success: stepResult.success,
  error: stepResult.error,
  result: {
    ...("result" in stepResult && stepResult.result ? stepResult.result : {}),
    errorCode: "errorCode" in stepResult ? stepResult.errorCode : undefined,
    branchLabel: "branchLabel" in stepResult ? stepResult.branchLabel : undefined,
    outputArtifacts:
      "outputArtifacts" in stepResult ? stepResult.outputArtifacts : undefined,
  },
  logs: stepResult.logs,
});

const createVerificationExecutorRegistry = (
  repository: LoopBoardRepository,
  repoPath: string,
): ExecutorRegistry =>
  new ExecutorRegistry([
    new StubExecutor({
      workflowStepHandler: async (context: ExecutorContext) => {
        const payload = parseWorkflowStepJobPayload(context.job.payload);
        const featureId =
          payload?.featureId ??
          (typeof context.job.payload.featureId === "string"
            ? context.job.payload.featureId
            : undefined);

        if (payload?.nodeType === "create-github-issues" && featureId) {
          const stepResult = await executeCreateGitHubIssues({
            repository,
            featureId,
            workflowRunId: payload.workflowRunId,
            outputArtifacts: payload.outputArtifacts,
            token: "verification-test-token",
            automationSettings: {
              ...repository.getAutomationSettings(),
              globalAutoRunEnabled: true,
            },
            createIssue: async ({ title }) => ({
              status: "created",
              repository: "bank-p/loop-control-plane",
              message: `Created GitHub issue for ${title}.`,
              issueNumber: 101,
              issueUrl: "https://github.com/bank-p/loop-control-plane/issues/101",
              labels: ["loopboard", "risk-low"],
              createdAt: "2026-06-16T12:00:00.000Z",
            }),
          });

          return toExecutorResult(stepResult);
        }

        if (payload?.nodeType === "open-pr" && featureId) {
          const stepResult = await executeOpenPr({
            repository,
            featureId,
            workflowRunId: payload.workflowRunId,
            inputArtifacts: payload.inputArtifacts,
            outputArtifacts: payload.outputArtifacts,
            projectRepoPath: repoPath,
            useGhCreateFallback: true,
            processRunner: createMockGhProcessRunner(),
            syncPullRequest: async () => ({
              status: "not-found",
              repository: "bank-p/loop-control-plane",
              message: "No pull request found for mocked verification walkthrough.",
              syncedAt: "2026-06-16T12:00:00.000Z",
              linkedIssueNumbers: [],
            }),
          });

          return toExecutorResult(stepResult);
        }

        if (payload?.nodeType === "agent-orchestrator-implement") {
          return {
            success: true,
            result: {
              branchLabel: "next",
              stdoutSummary:
                "Mocked AO implement completed for verification walkthrough.",
              outputArtifacts: [
                {
                  name: "implementation-branch",
                  path: `git://${context.job.projectId}/feature/${context.job.payload.featureId}`,
                  required: true,
                },
              ],
            },
            logs: [
              {
                timestamp: new Date().toISOString(),
                level: "info",
                message:
                  "Mocked AO implement completed for verification walkthrough.",
              },
            ],
          };
        }

        return dispatchWorkflowStepJob(context, {
          repository,
          processRunner:
            payload?.nodeType === "run-tests"
              ? createMockTestProcessRunner()
              : createMockSpecKitProcessRunner(repoPath),
        });
      },
    }),
  ]);

describe("workflow executor verification", () => {
  it("walks Feature Development Loop through open-pr with fixture brief and mocked externals", async () => {
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
      repository.updateProject(seedProject.id, {
        repoPath,
        automationPolicy: {
          ...seedProject.automationPolicy,
          allowLowRiskAutoIssueCreation: true,
        },
      });
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
      assert.equal(afterSpecKit.currentNodeId, "node-spec-kit-clarify");
      assert.equal(afterSpecKit.steps.at(-1)?.status, "completed");

      const clarifyPaused = runNextWorkflowStep({ repository, runId: run.id });
      assert.equal(clarifyPaused.status, "paused");
      assert.equal(clarifyPaused.currentNodeId, "node-spec-kit-clarify");

      const afterClarify = approveWorkflowRunStep({ repository, runId: run.id });
      assert.equal(afterClarify.currentNodeId, "node-human-review");

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

      const githubPaused = runNextWorkflowStep({ repository, runId: run.id });
      assert.equal(githubPaused.status, "paused");
      assert.equal(githubPaused.currentNodeId, "node-create-github-issues");

      const githubDelegated = approveWorkflowRunStep({ repository, runId: run.id });
      assert.equal(githubDelegated.steps.at(-1)?.status, "running");

      const githubTick = await scheduler.tick({ mode: "manual" });
      assert.equal(githubTick.job?.status, "completed");
      assert.equal(githubTick.job?.payload.nodeType, "create-github-issues");

      const afterGitHub = repository.getWorkflowRun(run.id);
      assert.equal(afterGitHub.currentNodeId, "node-agent-orchestrator-implement");
      assert.ok(
        boardTasks.every((task) =>
          repository
            .listBoardData(seedProject.id)
            .tasks.find((candidate) => candidate.id === task.id)?.github.issueNumber ===
            101,
        ),
      );

      const aoPaused = runNextWorkflowStep({ repository, runId: run.id });
      assert.equal(aoPaused.status, "paused");
      assert.equal(aoPaused.currentNodeId, "node-agent-orchestrator-implement");

      const aoDelegated = approveWorkflowRunStep({ repository, runId: run.id });
      assert.equal(aoDelegated.currentNodeId, "node-agent-orchestrator-implement");
      assert.equal(aoDelegated.steps.at(-1)?.status, "running");

      const aoTick = await scheduler.tick({ mode: "manual" });
      assert.equal(aoTick.job?.status, "completed");
      assert.equal(aoTick.job?.payload.nodeType, "agent-orchestrator-implement");

      const afterAo = repository.getWorkflowRun(run.id);
      assert.equal(afterAo.currentNodeId, "node-manual-claude-code-edit");
      assert.equal(afterAo.steps.at(-1)?.status, "completed");

      const manualPaused = runNextWorkflowStep({ repository, runId: run.id });
      assert.equal(manualPaused.status, "paused");
      assert.equal(manualPaused.currentNodeId, "node-manual-claude-code-edit");
      const manualApproved = approveWorkflowRunStep({ repository, runId: run.id });
      assert.equal(manualApproved.currentNodeId, "node-run-tests");

      const testsPaused = runNextWorkflowStep({ repository, runId: run.id });
      assert.equal(testsPaused.status, "paused");
      assert.equal(testsPaused.currentNodeId, "node-run-tests");

      const testsDelegated = approveWorkflowRunStep({ repository, runId: run.id });
      assert.equal(testsDelegated.steps.at(-1)?.status, "running");

      const testsTick = await scheduler.tick({ mode: "manual" });
      assert.equal(testsTick.job?.status, "completed");
      assert.equal(testsTick.job?.payload.nodeType, "run-tests");

      const afterTests = repository.getWorkflowRun(run.id);
      assert.equal(afterTests.currentNodeId, "node-open-pr");

      const openPrPaused = runNextWorkflowStep({ repository, runId: run.id });
      assert.equal(openPrPaused.status, "paused");
      assert.equal(openPrPaused.currentNodeId, "node-open-pr");

      const openPrDelegated = approveWorkflowRunStep({ repository, runId: run.id });
      assert.equal(openPrDelegated.steps.at(-1)?.status, "running");

      const openPrTick = await scheduler.tick({ mode: "manual" });
      assert.equal(openPrTick.job?.status, "completed");
      assert.equal(openPrTick.job?.payload.nodeType, "open-pr");

      const afterOpenPr = repository.getWorkflowRun(run.id);
      assert.equal(afterOpenPr.currentNodeId, "node-pr-review-agent");
      assert.equal(afterOpenPr.steps.at(-1)?.status, "completed");

      const prAgentPaused = runNextWorkflowStep({ repository, runId: run.id });
      assert.equal(prAgentPaused.status, "paused");
      assert.equal(prAgentPaused.currentNodeId, "node-pr-review-agent");
      assert.equal(prAgentPaused.steps.at(-1)?.status, "waiting-approval");

      const completedEvents = repository.getFeature(featureId).events;
      assert.ok(
        completedEvents.filter((event) => event.type === "WORKFLOW_STEP_COMPLETED").length >=
          8,
      );
    } finally {
      database.close();
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  });
});
