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
  ValidationError,
} from "@/lib/db/loopboard-repository";
import { seedFeatures, seedProject, seedTasks, seedWorkflows } from "@/lib/loopboard";
import { createDefaultFeatureWorkflowInput } from "@/lib/workflows/default-workflow";

const withRepository = (test: (repository: LoopBoardRepository) => void) => {
  const tempDirectory = mkdtempSync(join(tmpdir(), "loopboard-repository-"));
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

describe("LoopBoard repository", () => {
  it("seeds the default feature development workflow graph", () => {
    withRepository((repository) => {
      const workflows = repository.listWorkflows(seedProject.id);
      const workflow = repository.getWorkflow("workflow-feature-development-loop");

      assert.equal(workflows.length, seedWorkflows.length);
      assert.equal(workflow.name, "Feature Development Loop");
      assert.equal(workflow.nodes.length, 12);
      assert.equal(workflow.edges.length, 14);
      assert.deepEqual(
        workflow.nodes.map((node) => node.mode).sort(),
        [
          "auto",
          "auto",
          "auto",
          "human",
          "human",
          "human",
          "human",
          "human",
          "semi",
          "semi",
          "semi",
          "semi",
        ],
      );
      assert.equal(
        workflow.nodes.find((node) => node.id === "node-run-tests")?.maxRetries,
        2,
      );
      assert.equal(
        workflow.nodes.find((node) => node.id === "node-merge")?.riskPolicy,
        "manual-only",
      );
      assert.ok(
        workflow.edges.some(
          (edge) =>
            edge.sourceNodeId === "node-manual-claude-code-edit" &&
            edge.targetNodeId === "node-run-tests" &&
            edge.label === "next",
        ),
      );
    });
  });

  it("creates workflow definitions and validates node modes and edge references", () => {
    withRepository((repository) => {
      const workflow = repository.createWorkflow({
        id: "workflow-custom",
        projectId: seedProject.id,
        name: "Custom Workflow",
        description: "A minimal persisted workflow.",
        createdAt: "2026-06-15T01:00:00.000Z",
        nodes: [
          {
            id: "node-a",
            type: "human-input",
            name: "Human Input",
            mode: "human",
            position: { x: 0, y: 0 },
            inputArtifacts: [],
            outputArtifacts: [
              {
                name: "brief",
                path: "specs/custom/PRD.md",
                required: true,
              },
            ],
            requireApproval: true,
            maxRetries: 0,
            riskPolicy: "manual-only",
            config: {},
            currentState: "idle",
          },
          {
            id: "node-b",
            type: "run-tests",
            name: "Run Tests",
            mode: "auto",
            position: { x: 240, y: 0 },
            inputArtifacts: [
              {
                name: "brief",
                path: "specs/custom/PRD.md",
                required: true,
              },
            ],
            outputArtifacts: [],
            requireApproval: false,
            maxRetries: 1,
            riskPolicy: "low",
            config: { command: "npm test" },
            currentState: "idle",
          },
        ],
        edges: [
          {
            id: "edge-a-b",
            sourceNodeId: "node-a",
            targetNodeId: "node-b",
            label: "next",
            condition: {},
          },
        ],
        config: { pauseOnHumanNodes: true },
      });

      assert.equal(workflow.nodes.length, 2);
      assert.equal(workflow.edges[0]?.sourceNodeId, "node-a");
      assert.equal(workflow.config.pauseOnHumanNodes, true);

      assert.throws(
        () =>
          repository.createWorkflow({
            projectId: seedProject.id,
            name: "Invalid Mode",
            nodes: [
              {
                ...workflow.nodes[0]!,
                id: "node-invalid",
                mode: "manual" as never,
              },
            ],
          }),
        (error) =>
          error instanceof ValidationError &&
          error.message === "workflow node mode is not supported.",
      );

      assert.throws(
        () =>
          repository.updateWorkflow(workflow.id, {
            edges: [
              {
                id: "edge-missing",
                sourceNodeId: "node-a",
                targetNodeId: "node-missing",
                label: "broken",
                condition: {},
              },
            ],
          }),
        (error) =>
          error instanceof ValidationError &&
          error.message ===
            "Workflow edges must reference nodes in the same workflow.",
      );

      const updated = repository.updateWorkflow(workflow.id, {
        edges: [
          {
            ...workflow.edges[0]!,
            sourceHandle: "bottom",
            targetHandle: "top",
            dashed: true,
          },
        ],
      });

      assert.equal(updated.edges[0]?.sourceHandle, "bottom");
      assert.equal(updated.edges[0]?.targetHandle, "top");
      assert.equal(updated.edges[0]?.dashed, true);

      const reloaded = repository.getWorkflow(workflow.id);
      assert.equal(reloaded.edges[0]?.sourceHandle, "bottom");
      assert.equal(reloaded.edges[0]?.targetHandle, "top");
      assert.equal(reloaded.edges[0]?.dashed, true);
    });
  });

  it("persists workflow runs, current node state, step logs, and artifacts", () => {
    withRepository((repository) => {
      const run = repository.createWorkflowRun({
        id: "workflow-run-fixture",
        workflowId: "workflow-feature-development-loop",
        featureId: seedFeatures[0].id,
        status: "paused",
        currentNodeId: "node-human-review",
        inputArtifacts: [
          {
            name: "feature-brief",
            path: "specs/loopboard-mvp/kanban-control-plane/PRD.md",
            required: true,
          },
        ],
        executionLogs: [
          {
            timestamp: "2026-06-15T02:00:00.000Z",
            level: "info",
            message: "Workflow run created.",
            metadata: { featureId: seedFeatures[0].id },
          },
        ],
        steps: [
          {
            id: "workflow-run-step-human-review",
            workflowNodeId: "node-human-review",
            status: "waiting-approval",
            attempt: 1,
            inputArtifacts: [],
            outputArtifacts: [],
            executionLogs: [
              {
                timestamp: "2026-06-15T02:01:00.000Z",
                level: "warn",
                message: "Human approval required.",
              },
            ],
            requireApproval: true,
          },
        ],
        createdAt: "2026-06-15T02:00:00.000Z",
      });

      assert.equal(run.status, "paused");
      assert.equal(run.currentNodeId, "node-human-review");
      assert.equal(run.steps.length, 1);
      assert.equal(run.steps[0]?.status, "waiting-approval");
      assert.equal(run.steps[0]?.executionLogs[0]?.message, "Human approval required.");
      assert.equal(repository.listWorkflowRuns(run.workflowId)[0]?.id, run.id);
      assert.equal(repository.getLatestWorkflowRunForProject(seedProject.id)?.id, run.id);
    });
  });

  it("lists persisted board data with events and latest workflow runs attached", () => {
    withRepository((repository) => {
      const run = repository.createWorkflowRun({
        id: "workflow-run-dashboard-latest",
        workflowId: "workflow-feature-development-loop",
        featureId: seedFeatures[0].id,
        status: "running",
        currentNodeId: "node-human-input",
        createdAt: "2026-06-15T03:00:00.000Z",
      });
      const board = repository.listBoardData(seedProject.id);

      assert.equal(board.projects.length, 1);
      assert.equal(board.features.length, seedFeatures.length);
      assert.equal(board.tasks.length, seedTasks.length);
      assert.equal(board.latestWorkflowRuns[0]?.id, run.id);
      assert.equal(board.automationSettings.globalAutoRunEnabled, false);
      assert.ok(board.tasks.every((task) => Array.isArray(task.dependencies)));
      assert.deepEqual(
        board.tasks.find((task) => task.id === seedTasks[1].id)?.events,
        seedTasks[1].events,
      );
    });
  });

  it("creates a task and records TASK_CREATED in the same operation", () => {
    withRepository((repository) => {
      const task = repository.createTask({
        id: "task-api-created",
        projectId: seedProject.id,
        featureId: seedFeatures[0].id,
        title: "Create tasks through the API",
        description: "Persist a new task and its initial event.",
        acceptanceCriteria: ["The task has a creation event."],
        dependencies: ["task-local-persistence-reset"],
        createdAt: "2026-06-14T05:00:00.000Z",
      });

      assert.equal(task.status, "backlog");
      assert.equal(task.owner, "unassigned");
      assert.deepEqual(task.dependencies, ["task-local-persistence-reset"]);
      assert.equal(task.events.length, 1);
      assert.equal(task.events[0]?.type, "TASK_CREATED");
      assert.equal(task.events[0]?.toStatus, "backlog");
      assert.equal(task.events[0]?.toOwner, "unassigned");
    });
  });

  it("creates, updates, and deletes local projects", () => {
    withRepository((repository) => {
      const project = repository.createProject({
        id: "project-local-fixture",
        name: "Local Fixture",
        description: "A local repository managed by LoopBoard.",
        repoPath: "/tmp/local-fixture",
        repository: "owner/local-fixture",
        isGitRepository: true,
        currentBranch: "feature/local",
        defaultBranch: "main",
        githubRemoteUrl: "https://github.com/owner/local-fixture",
        specKitRoot: "specs/local-fixture",
        specsPath: "specs",
        tasksPath: "docs/tasks",
        workflowsPath: ".github/workflows",
        handoffsPath: "handoffs",
        automationPolicy: {
          allowLowRiskAutoIssueCreation: false,
          allowLowRiskAutoAoReadyLabeling: true,
          mediumRiskRequiresReview: true,
          highRiskManualOnly: true,
        },
        createdAt: "2026-06-14T05:00:00.000Z",
      });

      assert.equal(project.repoPath, "/tmp/local-fixture");
      assert.equal(project.isGitRepository, true);
      assert.equal(project.currentBranch, "feature/local");
      assert.equal(project.tasksPath, "docs/tasks");
      assert.equal(project.automationPolicy.allowLowRiskAutoIssueCreation, false);

      const updated = repository.updateProject(project.id, {
        name: "Local Fixture Updated",
        repoPath: "/tmp/local-fixture-updated",
        currentBranch: "main",
        automationPolicy: {
          allowLowRiskAutoAoReadyLabeling: false,
        },
        updatedAt: "2026-06-14T05:15:00.000Z",
      });

      assert.equal(updated.name, "Local Fixture Updated");
      assert.equal(updated.repoPath, "/tmp/local-fixture-updated");
      assert.equal(updated.currentBranch, "main");
      assert.equal(updated.automationPolicy.allowLowRiskAutoIssueCreation, false);
      assert.equal(updated.automationPolicy.allowLowRiskAutoAoReadyLabeling, false);
      assert.equal(updated.updatedAt, "2026-06-14T05:15:00.000Z");

      repository.deleteProject(project.id);
      assert.equal(
        repository.listProjects().some((item) => item.id === project.id),
        false,
      );
    });
  });

  it("creates an isolated default workflow for a new project", () => {
    withRepository((repository) => {
      const project = repository.createProject({
        id: "project-default-workflow-fixture",
        name: "Default Workflow Fixture",
        repoPath: "/tmp/default-workflow-fixture",
      });
      const workflow = repository.createWorkflow(
        createDefaultFeatureWorkflowInput(project.id),
      );

      assert.equal(workflow.projectId, project.id);
      assert.equal(workflow.name, "Feature Development Loop");
      assert.equal(workflow.nodes.length, seedWorkflows[0]?.nodes.length);
      assert.equal(workflow.edges.length, seedWorkflows[0]?.edges.length);
      assert.notEqual(workflow.id, seedWorkflows[0]?.id);
      assert.ok(
        workflow.nodes.every(
          (node) =>
            node.workflowId === workflow.id &&
            !seedWorkflows[0]?.nodes.some((template) => template.id === node.id),
        ),
      );
      assert.equal("defaultFeatureId" in workflow.config, false);
    });
  });

  it("persists global automation settings locally", () => {
    withRepository((repository) => {
      assert.equal(repository.getAutomationSettings().globalAutoRunEnabled, false);

      const updated = repository.updateAutomationSettings({
        globalAutoRunEnabled: true,
      });

      assert.equal(updated.globalAutoRunEnabled, true);
      assert.equal(
        repository.listBoardData(seedProject.id).automationSettings
          .globalAutoRunEnabled,
        true,
      );
    });
  });

  it("creates, updates, and deletes feature artifact records", () => {
    withRepository((repository) => {
      const feature = repository.createFeature({
        id: "feature-local-artifacts",
        projectId: seedProject.id,
        name: "Local Artifacts",
        summary: "Track local Spec Kit files.",
        source: "spec-kit",
        artifactFolderPath: "specs/local-artifacts",
        prdPath: "specs/local-artifacts/PRD.md",
        specPath: "specs/local-artifacts/spec.md",
        planPath: "specs/local-artifacts/plan.md",
        tasksPath: "specs/local-artifacts/tasks.md",
        decisionsPath: "specs/local-artifacts/decisions.md",
        status: "spec-review",
        createdAt: "2026-06-14T05:00:00.000Z",
      });

      assert.equal(feature.status, "spec-review");
      assert.equal(feature.artifactFolderPath, "specs/local-artifacts");
      assert.equal(feature.artifacts.spec.path, "specs/local-artifacts/spec.md");

      const updated = repository.updateFeature(feature.id, {
        status: "tasks-ready",
        tasksPath: "specs/local-artifacts/tasks-v2.md",
        updatedAt: "2026-06-14T05:30:00.000Z",
      });

      assert.equal(updated.status, "tasks-ready");
      assert.equal(updated.tasksPath, "specs/local-artifacts/tasks-v2.md");
      assert.equal(updated.updatedAt, "2026-06-14T05:30:00.000Z");

      repository.deleteFeature(feature.id);
      assert.equal(
        repository.listFeatures(seedProject.id).some((item) => item.id === feature.id),
        false,
      );
    });
  });

  it("approves feature artifacts with status transitions and feature events", () => {
    withRepository((repository) => {
      const feature = repository.createFeature({
        id: "feature-approval-flow",
        projectId: seedProject.id,
        name: "Approval Flow",
        summary: "Approve feature artifacts explicitly.",
        artifactFolderPath: "specs/approval-flow",
        status: "spec-review",
        createdAt: "2026-06-14T05:00:00.000Z",
      });

      const specApproved = repository.approveFeatureArtifact(feature.id, {
        artifactName: "spec",
        createdAt: "2026-06-14T05:10:00.000Z",
      });

      assert.equal(specApproved.status, "spec-approved");
      assert.equal(specApproved.events.length, 1);
      assert.equal(specApproved.events[0]?.type, "SPEC_APPROVED");
      assert.equal(specApproved.events[0]?.fromStatus, "spec-review");
      assert.equal(specApproved.events[0]?.toStatus, "spec-approved");
      assert.equal(specApproved.events[0]?.metadata?.artifactName, "spec");

      const planApproved = repository.approveFeatureArtifact(feature.id, {
        artifactName: "plan",
        createdAt: "2026-06-14T05:20:00.000Z",
      });

      assert.equal(planApproved.status, "plan-approved");
      assert.equal(planApproved.events.at(-1)?.type, "PLAN_APPROVED");
      assert.equal(planApproved.events.length, 2);

      const duplicatePlanApproved = repository.approveFeatureArtifact(feature.id, {
        artifactName: "plan",
        createdAt: "2026-06-14T05:25:00.000Z",
      });

      assert.equal(duplicatePlanApproved.status, "plan-approved");
      assert.equal(duplicatePlanApproved.events.length, 2);

      const tasksApproved = repository.approveFeatureArtifact(feature.id, {
        artifactName: "tasks",
        createdAt: "2026-06-14T05:30:00.000Z",
      });

      assert.equal(tasksApproved.status, "tasks-ready");
      assert.equal(tasksApproved.events.at(-1)?.type, "TASKS_APPROVED");
      assert.equal(repository.listBoardData(seedProject.id).features
        .find((item) => item.id === feature.id)?.events.length, 3);
    });
  });

  it("keeps later feature statuses when earlier artifact approvals are clicked", () => {
    withRepository((repository) => {
      const feature = repository.createFeature({
        id: "feature-late-approval",
        projectId: seedProject.id,
        name: "Late Approval",
        summary: "Avoid downgrading active execution work.",
        artifactFolderPath: "specs/late-approval",
        status: "in-execution",
        createdAt: "2026-06-14T06:00:00.000Z",
      });

      const approvedFeature = repository.approveFeatureArtifact(feature.id, {
        artifactName: "spec",
        createdAt: "2026-06-14T06:10:00.000Z",
      });

      assert.equal(approvedFeature.status, "in-execution");
      assert.equal(approvedFeature.events.length, 0);
    });
  });

  it("moves tasks and appends a TASK_MOVED event", () => {
    withRepository((repository) => {
      const task = repository.moveTask(
        "task-local-persistence-reset",
        "ai-running",
        "human",
      );

      assert.equal(task.status, "ai-running");
      assert.equal(task.events.at(-1)?.type, "TASK_MOVED");
      assert.equal(task.events.at(-1)?.fromStatus, "ready");
      assert.equal(task.events.at(-1)?.toStatus, "ai-running");
    });
  });

  it("updates owner, mode, and risk with a mutation event", () => {
    withRepository((repository) => {
      const task = repository.updateTask("task-local-persistence-reset", {
        owner: "ai",
        mode: "execute",
        risk: "medium",
        updatedAt: "2026-06-14T05:10:00.000Z",
      });

      assert.equal(task.owner, "ai");
      assert.equal(task.mode, "execute");
      assert.equal(task.risk, "medium");
      assert.equal(task.updatedAt, "2026-06-14T05:10:00.000Z");
      assert.equal(task.events.at(-1)?.type, "OWNER_CHANGED");
      assert.equal(task.events.at(-1)?.fromOwner, "unassigned");
      assert.equal(task.events.at(-1)?.toOwner, "ai");
      assert.equal(
        task.events.at(-1)?.metadata?.changedFields,
        "owner,mode,risk",
      );
    });
  });

  it("applies task actions with persisted status, labels, and event types", () => {
    withRepository((repository) => {
      repository.updateAutomationSettings({ globalAutoRunEnabled: true });
      const task = repository.applyTaskAction(
        "task-local-persistence-reset",
        "assign-ai",
      );

      assert.equal(task.status, "ai-running");
      assert.equal(task.owner, "ai");
      assert.equal(task.mode, "execute");
      assert.ok(task.labels.includes("ai-assigned"));
      assert.ok(task.github.issueLabels?.includes("ao-ready"));
      assert.equal(task.events.at(-2)?.type, "ASSIGNED_TO_AI");
      assert.equal(task.events.at(-2)?.fromStatus, "ready");
      assert.equal(task.events.at(-2)?.toStatus, "ai-running");
      assert.equal(task.events.at(-2)?.fromOwner, "unassigned");
      assert.equal(task.events.at(-2)?.toOwner, "ai");
      assert.equal(task.events.at(-1)?.type, "HANDOFF_READY");

      const repeated = repository.applyTaskAction(
        "task-local-persistence-reset",
        "assign-ai",
      );

      assert.equal(repeated.events.length, task.events.length);
    });
  });

  it("persists human takeover as state change, label update, and assignment events", () => {
    withRepository((repository) => {
      repository.updateAutomationSettings({ globalAutoRunEnabled: true });
      const assigned = repository.applyTaskAction(
        "task-local-persistence-reset",
        "assign-ai",
      );
      assert.ok(assigned.github.issueLabels?.includes("ao-ready"));

      const claimed = repository.applyTaskAction(
        "task-local-persistence-reset",
        "claim-human",
      );

      assert.equal(claimed.status, "human-working");
      assert.equal(claimed.owner, "human");
      assert.equal(claimed.mode, "handoff");
      assert.ok(claimed.labels.includes("human-takeover"));
      assert.ok(claimed.labels.includes("ai-paused"));
      assert.equal(claimed.labels.includes("ai-assigned"), false);
      assert.equal(claimed.github.issueLabels?.includes("ao-ready"), false);
      assert.ok(claimed.github.issueLabels?.includes("human-working"));
      assert.ok(claimed.github.issueLastSyncedAt);
      assert.equal(claimed.events.at(-2)?.type, "HUMAN_TAKEOVER");
      assert.equal(claimed.events.at(-2)?.metadata?.branch, claimed.branch);
      assert.equal(claimed.events.at(-2)?.metadata?.worktree, claimed.worktree);
      assert.equal(claimed.events.at(-1)?.type, "ASSIGNED_TO_HUMAN");
      assert.equal(claimed.events.at(-1)?.fromOwner, "ai");
      assert.equal(claimed.events.at(-1)?.toOwner, "human");

      const returned = repository.applyTaskAction(
        "task-local-persistence-reset",
        "return-ai",
      );

      assert.equal(returned.status, "ready");
      assert.equal(returned.owner, "ai");
      assert.equal(returned.mode, "execute");
      assert.ok(returned.labels.includes("handoff-ready"));
      assert.equal(returned.github.issueLabels?.includes("human-working"), false);
      assert.ok(returned.github.issueLabels?.includes("ao-ready"));
      assert.equal(returned.events.at(-2)?.type, "RETURNED_TO_AI");
      assert.equal(returned.events.at(-1)?.type, "ASSIGNED_TO_AI");
    });
  });

  it("requires local approval before ao-ready is applied to medium and high risk issues", () => {
    withRepository((repository) => {
      repository.updateAutomationSettings({ globalAutoRunEnabled: true });
      const mediumTask = repository.createTask({
        id: "task-medium-ao-gate",
        projectId: seedProject.id,
        featureId: seedFeatures[1].id,
        title: "Gate AO handoff for medium risk",
        description: "Verify local approval is required before ao-ready.",
        status: "ready",
        risk: "medium",
        github: {
          issueNumber: 101,
          issueUrl: "https://github.com/bank-p/loop-control-plane/issues/101",
          issueLabels: ["loopboard", "risk-medium"],
        },
        createdAt: "2026-06-15T01:00:00.000Z",
      });

      const assigned = repository.applyTaskAction(mediumTask.id, "assign-ai");

      assert.equal(assigned.owner, "ai");
      assert.equal(assigned.github.issueLabels?.includes("ao-ready"), false);
      assert.equal(assigned.events.at(-1)?.type, "ASSIGNED_TO_AI");

      const approved = repository.applyTaskAction(
        mediumTask.id,
        "approve-ao-ready",
      );

      assert.ok(approved.github.aoReadyApprovedAt);
      assert.ok(approved.github.issueLabels?.includes("ao-ready"));
      assert.equal(approved.events.at(-2)?.type, "AO_READY_APPROVED");
      assert.equal(approved.events.at(-1)?.type, "HANDOFF_READY");

      const repeated = repository.applyTaskAction(
        mediumTask.id,
        "approve-ao-ready",
      );

      assert.equal(repeated.events.length, approved.events.length);
    });
  });

  it("rejects AO ready approval without a linked GitHub issue", () => {
    withRepository((repository) => {
      assert.throws(
        () =>
          repository.applyTaskAction(
            "task-blocked-automation-policy",
            "approve-ao-ready",
          ),
        (error) =>
          error instanceof ValidationError &&
          error.message === "AO ready approval requires a linked GitHub issue.",
      );
    });
  });

  it("rejects unsupported direct owner transitions with a friendly error", () => {
    withRepository((repository) => {
      assert.throws(
        () =>
          repository.updateTask("task-local-persistence-reset", {
            owner: "pairing",
          }),
        (error) =>
          error instanceof UnsupportedTransitionError &&
          error.message ===
            'Task owner cannot transition from "unassigned" to "pairing".',
      );
    });
  });

  it("appends manual task events without changing task fields", () => {
    withRepository((repository) => {
      const task = repository.appendTaskEvent("task-local-persistence-reset", {
        type: "HANDOFF_READY",
        actor: "human",
        message: "Prepared handoff notes.",
        createdAt: "2026-06-14T05:20:00.000Z",
        metadata: {
          path: "contexts/task-local-persistence-reset/handoff.md",
          ignored: null,
        },
      });

      assert.equal(task.status, "ready");
      assert.equal(task.events.at(-1)?.type, "HANDOFF_READY");
      assert.deepEqual(task.events.at(-1)?.metadata, {
        path: "contexts/task-local-persistence-reset/handoff.md",
        ignored: null,
      });
    });
  });

  it("links created GitHub issues with task state and ISSUE_CREATED events", () => {
    withRepository((repository) => {
      const task = repository.linkGitHubIssue("task-local-persistence-reset", {
        issueNumber: 88,
        issueUrl: "https://github.com/bank-p/loop-control-plane/issues/88",
        issueLabels: ["loopboard", "risk-low", "ao-ready"],
        createdAt: "2026-06-15T00:00:00.000Z",
      });

      assert.equal(task.github.issueNumber, 88);
      assert.equal(
        task.github.issueUrl,
        "https://github.com/bank-p/loop-control-plane/issues/88",
      );
      assert.equal(task.github.issueState, "open");
      assert.deepEqual(task.github.issueLabels, [
        "loopboard",
        "risk-low",
        "ao-ready",
      ]);
      assert.equal(task.github.issueLastSyncedAt, "2026-06-15T00:00:00.000Z");
      assert.equal(task.events.at(-1)?.type, "ISSUE_CREATED");
      assert.equal(task.events.at(-1)?.metadata?.issueNumber, 88);
    });
  });

  it("syncs GitHub issue labels with a persisted sync event", () => {
    withRepository((repository) => {
      repository.linkGitHubIssue("task-local-persistence-reset", {
        issueNumber: 88,
        issueUrl: "https://github.com/bank-p/loop-control-plane/issues/88",
        issueLabels: ["loopboard", "risk-low", "ao-ready"],
        createdAt: "2026-06-15T00:00:00.000Z",
      });

      const task = repository.syncTaskGitHubIssueLabels("task-local-persistence-reset", {
        issueLabels: ["loopboard", "risk-low"],
        syncedAt: "2026-06-15T00:10:00.000Z",
        actor: "human",
        message: "Synced after removing ao-ready.",
      });

      assert.deepEqual(task.github.issueLabels, ["loopboard", "risk-low"]);
      assert.equal(task.github.issueLastSyncedAt, "2026-06-15T00:10:00.000Z");
      assert.equal(task.events.at(-1)?.type, "ISSUE_LABELS_SYNCED");
      assert.equal(task.events.at(-1)?.actor, "human");
      assert.equal(task.events.at(-1)?.metadata?.issueLabels, "loopboard,risk-low");
    });
  });

  it("syncs GitHub PR state, moves open PRs to review, and de-duplicates events", () => {
    withRepository((repository) => {
      const created = repository.createTask({
        id: "task-pr-review-sync",
        projectId: seedProject.id,
        featureId: seedFeatures[1].id,
        title: "Sync PR state",
        description: "Move open pull requests into review.",
        status: "ai-running",
        owner: "ai",
        mode: "execute",
        branch: "feature/pr-review-sync",
        github: {
          issueNumber: 144,
          issueUrl: "https://github.com/bank-p/loop-control-plane/issues/144",
        },
        createdAt: "2026-06-15T01:00:00.000Z",
      });
      const synced = repository.syncTaskGitHubPullRequest(created.id, {
        github: {
          pullRequestNumber: 145,
          pullRequestUrl: "https://github.com/bank-p/loop-control-plane/pull/145",
          pullRequestBranch: "feature/pr-review-sync",
          pullRequestState: "open",
          mergeStatus: "mergeable",
          reviewStatus: "requested",
        },
        syncedAt: "2026-06-15T01:05:00.000Z",
      });

      assert.equal(synced.status, "needs-review");
      assert.equal(synced.mode, "review");
      assert.equal(synced.github.deliveryStatus, "review-requested");
      assert.equal(synced.github.prCiLastSyncedAt, "2026-06-15T01:05:00.000Z");
      assert.deepEqual(
        synced.events.slice(-3).map((event) => event.type),
        ["PR_OPENED", "REVIEW_REQUESTED", "TASK_MOVED"],
      );

      const repeated = repository.syncTaskGitHubPullRequest(created.id, {
        github: {
          pullRequestNumber: 145,
          pullRequestUrl: "https://github.com/bank-p/loop-control-plane/pull/145",
          pullRequestBranch: "feature/pr-review-sync",
          pullRequestState: "open",
          mergeStatus: "mergeable",
          reviewStatus: "requested",
        },
        syncedAt: "2026-06-15T01:05:00.000Z",
      });

      assert.equal(repeated.events.length, synced.events.length);
    });
  });

  it("records review changes, approval, and merged PR completion events", () => {
    withRepository((repository) => {
      const created = repository.createTask({
        id: "task-pr-completion-sync",
        projectId: seedProject.id,
        featureId: seedFeatures[1].id,
        title: "Complete merged PR",
        description: "Track review transitions through merge.",
        status: "needs-review",
        owner: "ai",
        mode: "review",
        github: {
          pullRequestNumber: 146,
          pullRequestUrl: "https://github.com/bank-p/loop-control-plane/pull/146",
          pullRequestState: "open",
          reviewStatus: "requested",
        },
        createdAt: "2026-06-15T01:00:00.000Z",
      });
      const changesRequested = repository.syncTaskGitHubPullRequest(created.id, {
        github: {
          pullRequestNumber: 146,
          pullRequestUrl: "https://github.com/bank-p/loop-control-plane/pull/146",
          pullRequestState: "open",
          reviewStatus: "changes-requested",
        },
        syncedAt: "2026-06-15T01:10:00.000Z",
      });
      const approved = repository.syncTaskGitHubPullRequest(created.id, {
        github: {
          pullRequestNumber: 146,
          pullRequestUrl: "https://github.com/bank-p/loop-control-plane/pull/146",
          pullRequestState: "open",
          reviewStatus: "approved",
        },
        syncedAt: "2026-06-15T01:20:00.000Z",
      });
      const merged = repository.syncTaskGitHubPullRequest(created.id, {
        github: {
          pullRequestNumber: 146,
          pullRequestUrl: "https://github.com/bank-p/loop-control-plane/pull/146",
          pullRequestState: "merged",
          mergeStatus: "merged",
          reviewStatus: "approved",
        },
        syncedAt: "2026-06-15T01:30:00.000Z",
      });

      assert.equal(changesRequested.events.at(-1)?.type, "REVIEW_CHANGES_REQUESTED");
      assert.equal(approved.events.at(-1)?.type, "REVIEW_APPROVED");
      assert.equal(merged.status, "done");
      assert.equal(merged.github.deliveryStatus, "merged");
      assert.equal(merged.events.at(-1)?.type, "DONE");
      assert.equal(merged.events.at(-1)?.fromStatus, "needs-review");
      assert.equal(merged.events.at(-1)?.toStatus, "done");
    });
  });

  it("records CI status transitions and de-duplicates repeated CI syncs", () => {
    withRepository((repository) => {
      const created = repository.createTask({
        id: "task-pr-ci-sync",
        projectId: seedProject.id,
        featureId: seedFeatures[1].id,
        title: "Sync PR CI state",
        description: "Track CI transitions for a pull request.",
        status: "needs-review",
        owner: "ai",
        mode: "review",
        github: {
          pullRequestNumber: 147,
          pullRequestUrl: "https://github.com/bank-p/loop-control-plane/pull/147",
          pullRequestState: "open",
          reviewStatus: "not-requested",
        },
        createdAt: "2026-06-15T01:00:00.000Z",
      });
      const running = repository.syncTaskGitHubPullRequest(created.id, {
        github: {
          ciStatus: "pending",
          pullRequestNumber: 147,
          pullRequestUrl: "https://github.com/bank-p/loop-control-plane/pull/147",
          pullRequestState: "open",
          reviewStatus: "not-requested",
        },
        syncedAt: "2026-06-15T01:05:00.000Z",
      });
      const failed = repository.syncTaskGitHubPullRequest(created.id, {
        github: {
          ciStatus: "failing",
          ciFailureSummary:
            "unit tests (https://github.com/bank-p/loop-control-plane/actions/runs/3/job/4)",
          pullRequestNumber: 147,
          pullRequestUrl: "https://github.com/bank-p/loop-control-plane/pull/147",
          pullRequestState: "open",
          reviewStatus: "not-requested",
        },
        syncedAt: "2026-06-15T01:10:00.000Z",
      });
      const repeated = repository.syncTaskGitHubPullRequest(created.id, {
        github: {
          ciStatus: "failing",
          ciFailureSummary:
            "unit tests (https://github.com/bank-p/loop-control-plane/actions/runs/3/job/4)",
          pullRequestNumber: 147,
          pullRequestUrl: "https://github.com/bank-p/loop-control-plane/pull/147",
          pullRequestState: "open",
          reviewStatus: "not-requested",
        },
        syncedAt: "2026-06-15T01:10:00.000Z",
      });
      const passed = repository.syncTaskGitHubPullRequest(created.id, {
        github: {
          ciStatus: "passing",
          pullRequestNumber: 147,
          pullRequestUrl: "https://github.com/bank-p/loop-control-plane/pull/147",
          pullRequestState: "open",
          reviewStatus: "not-requested",
        },
        syncedAt: "2026-06-15T01:20:00.000Z",
      });

      assert.equal(running.events.at(-1)?.type, "CI_RUNNING");
      assert.equal(failed.events.at(-1)?.type, "CI_FAILED");
      assert.equal(failed.github.deliveryStatus, "ci-failed");
      assert.equal(failed.github.ciFailureSummary?.startsWith("unit tests"), true);
      assert.equal(repeated.events.length, failed.events.length);
      assert.equal(passed.events.at(-1)?.type, "CI_PASSED");
      assert.equal(passed.github.deliveryStatus, "ci-passed");
      assert.equal(passed.github.ciFailureSummary, undefined);
    });
  });
});
