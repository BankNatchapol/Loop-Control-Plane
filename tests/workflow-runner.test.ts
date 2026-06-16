import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { applyMigrations } from "@/db/migrate";
import { seedDatabase } from "@/db/seed";
import {
  LoopBoardRepository,
  UnsupportedTransitionError,
} from "@/lib/db/loopboard-repository";
import { seedFeatures, seedProject, seedTasks, seedWorkflows } from "@/lib/loopboard";
import {
  approveWorkflowRunStep,
  failWorkflowRunStep,
  runNextWorkflowStep,
  startWorkflowRun,
} from "@/lib/workflows/workflow-runner";

const withRepository = (test: (repository: LoopBoardRepository) => void) => {
  const tempDirectory = mkdtempSync(join(tmpdir(), "loopboard-runner-"));
  const database = new DatabaseSync(join(tempDirectory, "loopboard.sqlite"));

  try {
    applyMigrations(database);
    seedDatabase(database);
    test(new LoopBoardRepository(database));
  } finally {
    database.close();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
};

describe("Workflow runner", () => {
  it("starts runs, pauses at human nodes, and advances after approval", () => {
    withRepository((repository) => {
      const run = startWorkflowRun({
        repository,
        input: { workflowId: seedWorkflows[0].id, featureId: seedFeatures[0].id },
      });

      assert.equal(run.status, "running");
      assert.equal(run.featureId, seedFeatures[0].id);
      assert.equal(run.currentNodeId, "node-human-input");
      assert.equal(
        repository.getFeature(seedFeatures[0].id).events.at(-1)?.type,
        "WORKFLOW_RUN_STARTED",
      );

      const paused = runNextWorkflowStep({ repository, runId: run.id });
      assert.equal(paused.status, "paused");
      assert.equal(paused.currentNodeId, "node-human-input");
      assert.equal(paused.steps[0]?.status, "waiting-approval");
      assert.equal(paused.steps[0]?.requireApproval, true);

      const approved = approveWorkflowRunStep({ repository, runId: run.id });
      assert.equal(approved.status, "running");
      assert.equal(approved.currentNodeId, "node-spec-kit-actions");
      assert.equal(approved.steps[0]?.status, "completed");
      assert.ok(approved.steps[0]?.approvedAt);
      assert.equal(
        repository.getFeature(seedFeatures[0].id).events.at(-1)?.type,
        "WORKFLOW_STEP_COMPLETED",
      );

      const semiPaused = runNextWorkflowStep({ repository, runId: run.id });
      assert.equal(semiPaused.status, "paused");
      assert.equal(semiPaused.currentNodeId, "node-spec-kit-actions");
      assert.equal(semiPaused.steps.at(-1)?.status, "waiting-approval");
    });
  });

  it("links completed workflow steps to task events when artifacts target tasks", () => {
    withRepository((repository) => {
      repository.updateAutomationSettings({ globalAutoRunEnabled: true });
      const workflow = repository.createWorkflow({
        id: "workflow-task-linking",
        projectId: seedProject.id,
        name: "Task Linking",
        description: "Links deterministic outputs to board task history.",
        nodes: [
          {
            id: "node-task-output",
            type: "ai-review",
            name: "AI Review",
            mode: "auto",
            position: { x: 0, y: 0 },
            inputArtifacts: [],
            outputArtifacts: [
              {
                name: "task-report",
                path: `loopboard://tasks/${seedTasks[0].id}/runs/{run}/report`,
                required: true,
              },
            ],
            requireApproval: false,
            maxRetries: 0,
            riskPolicy: "low",
            config: {},
            currentState: "idle",
          },
        ],
        edges: [],
      });
      const run = startWorkflowRun({
        repository,
        input: { workflowId: workflow.id, featureId: seedTasks[0].featureId },
      });
      const completed = runNextWorkflowStep({ repository, runId: run.id });
      const task = repository.getTask(seedTasks[0].id);

      assert.equal(completed.status, "completed");
      assert.equal(task.events.at(-1)?.type, "WORKFLOW_STEP_COMPLETED");
      assert.equal(task.events.at(-1)?.metadata?.workflowRunId, run.id);
      assert.equal(task.events.at(-1)?.metadata?.workflowNodeId, "node-task-output");
    });
  });

  it("skips disabled nodes and records completed auto node outputs", () => {
    withRepository((repository) => {
      repository.updateAutomationSettings({ globalAutoRunEnabled: true });
      const workflow = repository.createWorkflow({
        id: "workflow-disabled-runner",
        projectId: seedProject.id,
        name: "Disabled Runner",
        description: "Exercises deterministic runner skips.",
        nodes: [
          {
            id: "node-auto-a",
            type: "ai-review",
            name: "AI Review",
            mode: "auto",
            position: { x: 0, y: 0 },
            inputArtifacts: [],
            outputArtifacts: [
              {
                name: "test-report",
                path: "loopboard://runs/{run}/test-report",
                required: true,
              },
            ],
            requireApproval: false,
            maxRetries: 0,
            riskPolicy: "low",
            config: {},
            currentState: "idle",
          },
          {
            id: "node-disabled",
            type: "ai-review",
            name: "Disabled Review",
            mode: "disabled",
            position: { x: 220, y: 0 },
            inputArtifacts: [],
            outputArtifacts: [],
            requireApproval: false,
            maxRetries: 0,
            riskPolicy: "low",
            config: {},
            currentState: "idle",
          },
          {
            id: "node-auto-c",
            type: "open-pr",
            name: "Open PR",
            mode: "auto",
            position: { x: 440, y: 0 },
            inputArtifacts: [],
            outputArtifacts: [],
            requireApproval: false,
            maxRetries: 0,
            riskPolicy: "low",
            config: {},
            currentState: "idle",
          },
        ],
        edges: [
          {
            id: "edge-a-disabled",
            sourceNodeId: "node-auto-a",
            targetNodeId: "node-disabled",
            label: "next",
            condition: {},
          },
          {
            id: "edge-disabled-c",
            sourceNodeId: "node-disabled",
            targetNodeId: "node-auto-c",
            label: "next",
            condition: {},
          },
        ],
      });
      const run = startWorkflowRun({
        repository,
        input: { workflowId: workflow.id },
      });

      const first = runNextWorkflowStep({ repository, runId: run.id });
      assert.equal(first.status, "running");
      assert.equal(first.currentNodeId, "node-disabled");
      assert.equal(first.steps[0]?.status, "completed");
      assert.match(first.steps[0]?.outputArtifacts[0]?.path ?? "", new RegExp(run.id));

      const skipped = runNextWorkflowStep({ repository, runId: run.id });
      assert.equal(skipped.status, "running");
      assert.equal(skipped.currentNodeId, "node-auto-c");
      assert.equal(skipped.steps.at(-1)?.status, "skipped");

      const completed = runNextWorkflowStep({ repository, runId: run.id });
      assert.equal(completed.status, "completed");
      assert.equal(completed.currentNodeId, undefined);
      assert.equal(completed.steps.at(-1)?.status, "completed");
    });
  });

  it("pauses shell-capable auto nodes for explicit approval", () => {
    withRepository((repository) => {
      repository.updateAutomationSettings({ globalAutoRunEnabled: true });
      const workflow = repository.createWorkflow({
        id: "workflow-shell-gate",
        projectId: seedProject.id,
        name: "Shell Gate",
        description: "Requires approval before command-capable nodes proceed.",
        nodes: [
          {
            id: "node-shell-run-tests",
            type: "run-tests",
            name: "Run Tests",
            mode: "auto",
            position: { x: 0, y: 0 },
            inputArtifacts: [],
            outputArtifacts: [
              {
                name: "test-report",
                path: "loopboard://runs/{run}/test-report",
                required: true,
              },
            ],
            requireApproval: false,
            maxRetries: 0,
            riskPolicy: "low",
            config: { command: "npm test" },
            currentState: "idle",
          },
        ],
        edges: [],
      });
      const run = startWorkflowRun({
        repository,
        input: { workflowId: workflow.id },
      });

      const paused = runNextWorkflowStep({ repository, runId: run.id });

      assert.equal(paused.status, "paused");
      assert.equal(paused.steps[0]?.status, "waiting-approval");
      assert.equal(paused.steps[0]?.requireApproval, true);
      assert.match(paused.executionLogs.at(-1)?.message ?? "", /approval/u);
      assert.equal(
        paused.executionLogs.at(-1)?.metadata?.policyCode,
        "workflow_shell_command_approval_required",
      );
    });
  });

  it("redacts secrets from failed run logs", () => {
    withRepository((repository) => {
      const run = startWorkflowRun({
        repository,
        input: { workflowId: seedWorkflows[0].id },
      });
      const failed = failWorkflowRunStep({
        repository,
        runId: run.id,
        error: "Request failed token=super-secret-value",
      });

      assert.equal(failed.status, "failed");
      assert.match(failed.executionLogs.at(-1)?.message ?? "", /\[redacted\]/);
      assert.doesNotMatch(
        failed.steps.at(-1)?.executionLogs.at(-1)?.message ?? "",
        /super-secret-value/,
      );
    });
  });

  it("rejects running the next step while approval is pending", () => {
    withRepository((repository) => {
      const run = startWorkflowRun({
        repository,
        input: { workflowId: seedWorkflows[0].id },
      });
      runNextWorkflowStep({ repository, runId: run.id });

      assert.throws(
        () => runNextWorkflowStep({ repository, runId: run.id }),
        UnsupportedTransitionError,
      );
    });
  });

  it("enqueues engine jobs for spec-kit-actions after approval instead of completing inline", () => {
    withRepository((repository) => {
      const run = startWorkflowRun({
        repository,
        input: { workflowId: seedWorkflows[0].id, featureId: seedFeatures[0].id },
      });

      runNextWorkflowStep({ repository, runId: run.id });
      approveWorkflowRunStep({ repository, runId: run.id });
      runNextWorkflowStep({ repository, runId: run.id });
      const delegated = approveWorkflowRunStep({ repository, runId: run.id });

      assert.equal(delegated.status, "running");
      assert.equal(delegated.currentNodeId, "node-spec-kit-actions");
      assert.equal(delegated.steps.at(-1)?.status, "running");
      assert.match(
        delegated.steps.at(-1)?.executionLogs.at(-1)?.message ?? "",
        /enqueued engine job/u,
      );

      const jobs = repository
        .listEngineJobs({ status: "queued" })
        .filter((job) => job.workflowRunId === run.id);
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0]?.kind, "workflow-step");
      assert.equal(jobs[0]?.workflowNodeId, "node-spec-kit-actions");
      assert.equal(jobs[0]?.payload.nodeType, "spec-kit-actions");
    });
  });

  it("enqueues import-tasks engine jobs when auto mode policy allows", () => {
    withRepository((repository) => {
      repository.updateAutomationSettings({ globalAutoRunEnabled: true });
      const workflow = repository.createWorkflow({
        id: "workflow-import-tasks-auto",
        projectId: seedProject.id,
        name: "Import Tasks Auto",
        description: "Delegates import-tasks to the engine.",
        nodes: [
          {
            id: "node-import-tasks-auto",
            type: "import-tasks",
            name: "Import Tasks",
            mode: "auto",
            position: { x: 0, y: 0 },
            inputArtifacts: [
              {
                name: "tasks",
                path: "specs/{feature}/tasks.md",
                required: true,
              },
            ],
            outputArtifacts: [
              {
                name: "loopboard-tasks",
                path: "loopboard://feature/{feature}/tasks",
                required: true,
              },
            ],
            requireApproval: false,
            maxRetries: 1,
            riskPolicy: "low",
            config: {},
            currentState: "idle",
          },
        ],
        edges: [],
      });
      const run = startWorkflowRun({
        repository,
        input: { workflowId: workflow.id, featureId: seedFeatures[0].id },
      });

      const delegated = runNextWorkflowStep({ repository, runId: run.id });

      assert.equal(delegated.status, "running");
      assert.equal(delegated.steps[0]?.status, "running");
      const jobs = repository
        .listEngineJobs()
        .filter((job) => job.workflowRunId === run.id);
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0]?.payload.nodeType, "import-tasks");
    });
  });
});
