import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { TaskContextService } from "@/lib/context/task-context-service";
import { buildBackendExecutionContext } from "@/lib/engine/backends/backend-adapter";
import {
  createClaudeCodeBackendAdapter,
  createCodexBackendAdapter,
  createCursorBackendAdapter,
} from "@/lib/engine/backends/cli-backend-adapters";
import { resolveExecutorConfigWithFallbacks } from "@/lib/engine/executor-config-resolver";
import { ProcessRunner, type ProcessSpawnOutcome, type ProcessSpawner } from "@/lib/engine/process-runner";
import { seedProject } from "@/lib/loopboard";

const sampleJob = () => ({
  id: "job-backend-1",
  kind: "task-run" as const,
  status: "running" as const,
  backend: "cursor" as const,
  taskId: "task-1",
  projectId: seedProject.id,
  payload: {
    taskId: "task-1",
    projectId: seedProject.id,
    action: "execute",
    executorConfig: { backend: "cursor" },
    trigger: "manual",
  },
  executionLogs: [],
  attempt: 1,
  maxAttempts: 1,
  queuedAt: "2026-06-16T12:00:00.000Z",
  createdAt: "2026-06-16T12:00:00.000Z",
  updatedAt: "2026-06-16T12:00:00.000Z",
});

const successSpawner =
  (stdout = "agent completed"): ProcessSpawner =>
  async () => ({
    exitCode: 0,
    stdout,
    stderr: "",
    timedOut: false,
  });

const missingBinarySpawner: ProcessSpawner = async () => {
  throw new Error("spawn ENOENT");
};

describe("CLI backend adapters", () => {
  it("returns backend_unavailable when CLI probe fails", async () => {
    const adapter = createCodexBackendAdapter({
      processRunner: new ProcessRunner(successSpawner()),
    });

    const originalProbe = process.env.PATH;
    process.env.PATH = "";

    try {
      const result = await adapter.execute(
        buildBackendExecutionContext({
          job: { ...sampleJob(), backend: "codex" },
          config: { backend: "codex" },
          projectRepoPath: process.cwd(),
        }),
      );

      assert.equal(result.success, false);
      assert.equal(result.errorCode, "backend_unavailable");
    } finally {
      process.env.PATH = originalProbe;
    }
  });

  it("invokes cursor CLI with print mode and redacts stdout tail", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "backend-adapters-"));
    const contextRoot = join(tempDirectory, "contexts");
    const taskDirectory = join(contextRoot, "task-1");
    mkdirSync(taskDirectory, { recursive: true });
    writeFileSync(join(taskDirectory, "task.md"), "# Do the thing\n\nImplement feature.");
    writeFileSync(join(taskDirectory, "context.md"), "Context details.");

    let capturedArgs: string[] = [];
    const runner = new ProcessRunner(async (_command, args) => {
      capturedArgs = args;
      return {
        exitCode: 0,
        stdout: "token=super-secret-value completed",
        stderr: "",
        timedOut: false,
      } satisfies ProcessSpawnOutcome;
    });

    const adapter = createCursorBackendAdapter({
      contextService: new TaskContextService(contextRoot),
      processRunner: runner,
      availabilityCheck: async () => ({
        backend: "cursor",
        available: true,
        message: "cursor available (mocked).",
      }),
    });

    try {
      const result = await adapter.execute(
        buildBackendExecutionContext({
          job: sampleJob(),
          config: { backend: "cursor", model: "composer-2.5" },
          projectRepoPath: tempDirectory,
        }),
      );

      assert.equal(result.success, true);
      assert.deepEqual(capturedArgs.slice(0, 4), ["agent", "--print", "--force", "--model"]);
      assert.equal(capturedArgs[4], "composer-2.5");
      assert.match(result.stdoutSummary ?? "", /completed/u);
      assert.doesNotMatch(result.stdoutSummary ?? "", /super-secret-value/u);
    } finally {
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  it("uses Claude Code print mode via generateClaudeCodePrompt when repository is provided", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "backend-adapters-claude-"));
    const contextRoot = join(tempDirectory, "contexts");

    let capturedArgs: string[] = [];
    const runner = new ProcessRunner(async (_command, args) => {
      capturedArgs = args;
      return {
        exitCode: 0,
        stdout: "done",
        stderr: "",
        timedOut: false,
      };
    });

    const repository = {
      getTask: () => ({
        id: "task-1",
        projectId: seedProject.id,
        featureId: "feature-1",
        title: "Sample",
        description: "desc",
        status: "ready",
        owner: "human",
        mode: "semi",
        risk: "low",
        source: "manual",
        labels: [],
        acceptanceCriteria: [],
        dependencies: [],
        branch: "",
        worktree: "",
        github: {
          issueNumber: null,
          issueUrl: "",
          prNumber: null,
          prUrl: "",
          aoReadyApprovedAt: null,
        },
        handoff: { contextPaths: [], notes: "" },
        events: [],
        createdAt: "2026-06-16T12:00:00.000Z",
        updatedAt: "2026-06-16T12:00:00.000Z",
      }),
      listBoardData: () => ({
        projects: [seedProject],
        features: [
          {
            id: "feature-1",
            projectId: seedProject.id,
            name: "Feature",
            summary: "summary",
            source: "manual",
            artifactFolderPath: "specs/feature",
            prdPath: "specs/feature/prd.md",
            specPath: "specs/feature/spec.md",
            planPath: "specs/feature/plan.md",
            tasksPath: "specs/feature/tasks.md",
            decisionsPath: "specs/feature/decisions.md",
            status: "active",
            artifacts: {},
            createdAt: "2026-06-16T12:00:00.000Z",
            updatedAt: "2026-06-16T12:00:00.000Z",
          },
        ],
        tasks: [],
        workflows: [],
        workflowRuns: [],
      }),
    };

    const adapter = createClaudeCodeBackendAdapter({
      contextService: new TaskContextService(contextRoot),
      repository: repository as never,
      processRunner: runner,
    });

    try {
      const result = await adapter.execute(
        buildBackendExecutionContext({
          job: { ...sampleJob(), backend: "claude-code" },
          config: { backend: "claude-code" },
          projectRepoPath: tempDirectory,
        }),
      );

      assert.equal(result.success, true);
      assert.equal(capturedArgs[0], "--print");
      assert.match(capturedArgs[capturedArgs.length - 1], /Sample/u);
    } finally {
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  it("reports backend_timeout when mocked process runner times out", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "backend-adapters-timeout-"));
    const contextRoot = join(tempDirectory, "contexts");
    const taskDirectory = join(contextRoot, "task-1");
    mkdirSync(taskDirectory, { recursive: true });
    writeFileSync(join(taskDirectory, "task.md"), "# Timed out task\n");
    writeFileSync(join(taskDirectory, "context.md"), "Context.");

    const runner = new ProcessRunner(async () => ({
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: true,
    }));

    const adapter = createCursorBackendAdapter({
      contextService: new TaskContextService(contextRoot),
      processRunner: runner,
      availabilityCheck: async () => ({
        backend: "cursor",
        available: true,
        message: "cursor available (mocked).",
      }),
    });

    try {
      const result = await adapter.execute(
        buildBackendExecutionContext({
          job: sampleJob(),
          config: { backend: "cursor", timeoutMs: 1_000 },
          projectRepoPath: tempDirectory,
        }),
      );

      assert.equal(result.success, false);
      assert.equal(result.errorCode, "backend_timeout");
    } finally {
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  it("reports CLI spawn failures from mocked process runner", async () => {
    const adapter = createCodexBackendAdapter({
      processRunner: new ProcessRunner(missingBinarySpawner),
      availabilityCheck: async () => ({
        backend: "codex",
        available: true,
        message: "codex available (mocked).",
      }),
    });

    const tempDirectory = mkdtempSync(join(tmpdir(), "backend-adapters-codex-"));
    writeFileSync(join(tempDirectory, "prompt.md"), "Run codex task");

    try {
      const result = await adapter.execute(
        buildBackendExecutionContext({
          job: { ...sampleJob(), backend: "codex" },
          config: { backend: "codex", promptFile: "prompt.md" },
          projectRepoPath: tempDirectory,
        }),
      );

      assert.equal(result.success, false);
      assert.equal(result.errorCode, "backend_cli_failed");
    } finally {
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  });
});

describe("executor config resolver", () => {
  it("falls back node config → project default → global default", () => {
    const project = {
      ...seedProject,
      engineSettings: {
        defaultTaskBackend: "claude-code" as const,
      },
    };

    const fromProject = resolveExecutorConfigWithFallbacks({
      explicitConfig: { backend: "stub" },
      project,
      taskAction: "execute",
    });

    assert.equal(fromProject.backend, "claude-code");

    const fromReview = resolveExecutorConfigWithFallbacks({
      explicitConfig: { backend: "stub" },
      project: {
        ...project,
        engineSettings: {
          defaultReviewBackend: "codex" as const,
        },
      },
      taskAction: "review",
    });

    assert.equal(fromReview.backend, "codex");
  });
});
