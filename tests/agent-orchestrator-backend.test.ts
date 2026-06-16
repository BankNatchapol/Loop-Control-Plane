import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { buildBackendExecutionContext } from "@/lib/engine/backends/backend-adapter";
import {
  createAgentOrchestratorBackendAdapter,
  extractAoSessionId,
  mapAoSessionStatus,
  mapPollStatusToBranchLabel,
  pollAoSessionsUntilTerminal,
  spawnAoSessionsWithConcurrency,
} from "@/lib/engine/backends/agent-orchestrator-backend";
import {
  resolveAgentOrchestratorSettings,
  validateRepoRelativePath,
} from "@/lib/engine/backends/agent-orchestrator-config";
import { ProcessRunner, type ProcessSpawnOutcome, type ProcessSpawner } from "@/lib/engine/process-runner";
import { seedProject } from "@/lib/loopboard";

const aoProject = (repoPath: string) => ({
  ...seedProject,
  repoPath,
  engineSettings: {
    agentOrchestrator: {
      enabled: true,
      configPath: "agent-orchestrator.yaml",
      projectId: "loop-control-plane",
      dashboardUrl: "http://localhost:3000",
      pollIntervalMs: 1,
    },
  },
});

const sampleJob = () => ({
  id: "job-ao-1",
  kind: "task-run" as const,
  status: "running" as const,
  backend: "agent-orchestrator" as const,
  taskId: "task-ao-1",
  projectId: seedProject.id,
  payload: {
    taskId: "task-ao-1",
    projectId: seedProject.id,
    action: "execute",
    executorConfig: { backend: "agent-orchestrator", issueNumber: 42 },
    trigger: "manual",
  },
  executionLogs: [],
  attempt: 1,
  maxAttempts: 1,
  queuedAt: "2026-06-16T12:00:00.000Z",
  createdAt: "2026-06-16T12:00:00.000Z",
  updatedAt: "2026-06-16T12:00:00.000Z",
});

const createAoSpawner = (handlers: {
  spawn?: (args: string[]) => ProcessSpawnOutcome;
  status?: (args: string[]) => ProcessSpawnOutcome;
}): ProcessSpawner => {
  let statusCalls = 0;

  return async (_command, args) => {
    if (args[0] === "spawn") {
      return (
        handlers.spawn?.(args) ?? {
          exitCode: 0,
          stdout: `Spawned session loop-control-plane-${args[1]}`,
          stderr: "",
          timedOut: false,
        }
      );
    }

    if (args[0] === "status") {
      statusCalls += 1;
      if (handlers.status) {
        return handlers.status(args);
      }

      const status = statusCalls >= 2 ? "done" : "working";
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          data: [
            {
              id: "loop-control-plane-42",
              status,
              issueId: "42",
              pr: status === "done" ? { url: "https://github.com/org/repo/pull/9" } : null,
            },
          ],
          meta: { hiddenTerminatedCount: 0 },
        }),
        stderr: "",
        timedOut: false,
      };
    }

    return {
      exitCode: 1,
      stdout: "",
      stderr: "unexpected ao command",
      timedOut: false,
    };
  };
};

describe("agent orchestrator config", () => {
  it("rejects config paths outside the project repository", () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "ao-config-"));

    try {
      assert.throws(
        () =>
          validateRepoRelativePath({
            projectRepoPath: tempDirectory,
            path: "../outside.yaml",
            kind: "file",
          }),
        /inside the project repository/u,
      );
    } finally {
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  });
});

describe("agent orchestrator backend adapter", () => {
  it("maps AO session statuses to poll and branch labels", () => {
    assert.equal(mapAoSessionStatus("done"), "completed");
    assert.equal(mapAoSessionStatus("errored"), "failed");
    assert.equal(mapAoSessionStatus("terminated"), "cancelled");
    assert.equal(mapAoSessionStatus("working"), "running");
    assert.equal(mapPollStatusToBranchLabel("completed"), "completed");
    assert.equal(mapPollStatusToBranchLabel("failed"), "blocked");
  });

  it("extracts session ids from spawn stdout", () => {
    assert.equal(
      extractAoSessionId("Spawned session loop-control-plane-42"),
      "loop-control-plane-42",
    );
  });

  it("spawns AO sessions with project and issue args", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "ao-spawn-"));
    writeFileSync(join(tempDirectory, "agent-orchestrator.yaml"), "projects: {}\n");

    const captured: string[][] = [];
    const runner = new ProcessRunner(async (_command, args) => {
      captured.push(args);
      return {
        exitCode: 0,
        stdout: "Spawned session loop-control-plane-42",
        stderr: "",
        timedOut: false,
      };
    });

    const context = buildBackendExecutionContext({
      job: sampleJob(),
      config: { backend: "agent-orchestrator", issueNumber: 42 },
      projectRepoPath: tempDirectory,
    });

    try {
      const result = await spawnAoSessionsWithConcurrency({
        issueNumbers: [42],
        maxConcurrency: 1,
        context,
        settings: resolveAgentOrchestratorSettings({
          project: aoProject(tempDirectory),
          executorConfig: context.config,
        }),
        processRunner: runner,
      });

      assert.equal(result.records.length, 1);
      assert.equal(result.records[0]?.sessionId, "loop-control-plane-42");
      assert.deepEqual(captured[0], [
        "spawn",
        "42",
        "--project",
        "loop-control-plane",
      ]);
    } finally {
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  it("caps fan-out concurrency and dedupes issue numbers", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "ao-fanout-"));
    writeFileSync(join(tempDirectory, "agent-orchestrator.yaml"), "projects: {}\n");

    let active = 0;
    let maxActive = 0;
    const runner = new ProcessRunner(async (_command, args) => {
      if (args[0] !== "spawn") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ data: [], meta: { hiddenTerminatedCount: 0 } }),
          stderr: "",
          timedOut: false,
        };
      }

      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;

      return {
        exitCode: 0,
        stdout: `Spawned session loop-control-plane-${args[1]}`,
        stderr: "",
        timedOut: false,
      };
    });

    const context = buildBackendExecutionContext({
      job: sampleJob(),
      config: {
        backend: "agent-orchestrator",
        fanOut: {
          maxConcurrency: 2,
          issueIds: [101, 102, 101, 103],
        },
      },
      projectRepoPath: tempDirectory,
    });

    try {
      const result = await spawnAoSessionsWithConcurrency({
        issueNumbers: [101, 102, 103],
        maxConcurrency: 2,
        context,
        settings: resolveAgentOrchestratorSettings({
          project: aoProject(tempDirectory),
          executorConfig: context.config,
        }),
        processRunner: runner,
      });

      assert.equal(result.records.length, 3);
      assert.ok(maxActive <= 2);
    } finally {
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  it("spawns AO session and defers terminal polling to engine sync", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "ao-poll-"));
    writeFileSync(join(tempDirectory, "agent-orchestrator.yaml"), "projects: {}\n");

    const runner = new ProcessRunner(createAoSpawner({}));
    const context = buildBackendExecutionContext({
      job: sampleJob(),
      config: { backend: "agent-orchestrator", issueNumber: 42, timeoutMs: 5_000 },
      projectRepoPath: tempDirectory,
    });

    const repository = {
      getProject: () => aoProject(tempDirectory),
      getTask: () => ({
        id: "task-ao-1",
        projectId: seedProject.id,
        featureId: "feature-1",
        title: "AO task",
        description: "desc",
        status: "ready",
        owner: "ai",
        mode: "execute",
        risk: "low",
        source: "manual",
        labels: [],
        acceptanceCriteria: [],
        dependencies: [],
        branch: "",
        worktree: "",
        github: {
          issueNumber: 42,
          issueUrl: "https://github.com/org/repo/issues/42",
          prNumber: null,
          prUrl: "",
          issueLabels: ["ao-ready"],
        },
        handoff: { contextPaths: [], notes: "" },
        events: [],
        createdAt: "2026-06-16T12:00:00.000Z",
        updatedAt: "2026-06-16T12:00:00.000Z",
      }),
      applyTaskAction: (_taskId: string, action: string) => ({
        id: "task-ao-1",
        projectId: seedProject.id,
        featureId: "feature-1",
        title: "AO task",
        description: "desc",
        status: "ai-running",
        owner: "ai",
        mode: "execute",
        risk: "low",
        source: "manual",
        labels: [],
        acceptanceCriteria: [],
        dependencies: [],
        branch: "",
        worktree: "",
        github: {
          issueNumber: 42,
          issueUrl: "https://github.com/org/repo/issues/42",
          prNumber: null,
          prUrl: "",
          issueLabels: action === "mark-ao-ready" ? ["ao-ready"] : ["ao-ready"],
        },
        handoff: { contextPaths: [], notes: "" },
        events: [],
        createdAt: "2026-06-16T12:00:00.000Z",
        updatedAt: "2026-06-16T12:00:00.000Z",
      }),
    };

    const adapter = createAgentOrchestratorBackendAdapter({
      repository: repository as never,
      processRunner: runner,
      availabilityCheck: async () => ({
        backend: "agent-orchestrator",
        available: true,
        message: "ao available (mocked).",
      }),
      sleep: async () => undefined,
    });

    try {
      const result = await adapter.execute(context);

      assert.equal(result.success, true);
      assert.equal(result.externalSessionId, "loop-control-plane-42");
      assert.equal(result.result?.awaitingExternalSync, true);
      assert.equal(result.result?.branchLabel, "running");
      assert.equal(result.result?.untrusted, true);
      assert.equal(result.result?.prUrl, undefined);
    } finally {
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  it("returns ao_handoff_not_ready when ao-ready cannot be applied", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "ao-handoff-"));
    writeFileSync(join(tempDirectory, "agent-orchestrator.yaml"), "projects: {}\n");

    const repository = {
      getProject: () => aoProject(tempDirectory),
      getTask: () => ({
        id: "task-ao-1",
        projectId: seedProject.id,
        featureId: "feature-1",
        title: "AO task",
        description: "desc",
        status: "ready",
        owner: "ai",
        mode: "execute",
        risk: "medium",
        source: "manual",
        labels: [],
        acceptanceCriteria: [],
        dependencies: [],
        branch: "",
        worktree: "",
        github: {
          issueNumber: 42,
          issueUrl: "https://github.com/org/repo/issues/42",
          prNumber: null,
          prUrl: "",
          issueLabels: [],
        },
        handoff: { contextPaths: [], notes: "" },
        events: [],
        createdAt: "2026-06-16T12:00:00.000Z",
        updatedAt: "2026-06-16T12:00:00.000Z",
      }),
      applyTaskAction: () => {
        throw new Error("Local approval required before ao-ready.");
      },
    };

    const adapter = createAgentOrchestratorBackendAdapter({
      repository: repository as never,
      processRunner: new ProcessRunner(createAoSpawner({})),
      availabilityCheck: async () => ({
        backend: "agent-orchestrator",
        available: true,
        message: "ao available (mocked).",
      }),
    });

    try {
      const result = await adapter.execute(
        buildBackendExecutionContext({
          job: sampleJob(),
          config: { backend: "agent-orchestrator" },
          projectRepoPath: tempDirectory,
        }),
      );

      assert.equal(result.success, false);
      assert.equal(result.errorCode, "ao_handoff_not_ready");
    } finally {
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  it("poll maps terminal AO sessions through adapter.poll", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "ao-poll-method-"));
    writeFileSync(join(tempDirectory, "agent-orchestrator.yaml"), "projects: {}\n");

    const runner = new ProcessRunner(
      createAoSpawner({
        status: () => ({
          exitCode: 0,
          stdout: JSON.stringify({
            data: [
              {
                id: "loop-control-plane-42",
                status: "done",
                issueId: "42",
                pr: { url: "https://github.com/org/repo/pull/9" },
              },
            ],
            meta: { hiddenTerminatedCount: 0 },
          }),
          stderr: "",
          timedOut: false,
        }),
      }),
    );

    const adapter = createAgentOrchestratorBackendAdapter({
      repository: {
        getProject: () => aoProject(tempDirectory),
      } as never,
      processRunner: runner,
    });

    try {
      const poll = await adapter.poll!(
        {
          ...sampleJob(),
          result: { externalSessionId: "loop-control-plane-42" },
        },
        {
          projectRepoPath: tempDirectory,
          cwd: tempDirectory,
          config: { backend: "agent-orchestrator", issueNumber: 42 },
        },
      );

      assert.equal(poll.status, "completed");
      assert.equal(poll.artifacts?.branchLabel, "completed");
      assert.equal(poll.artifacts?.prUrl, "https://github.com/org/repo/pull/9");
    } finally {
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  it("marks poll timeout as failed without killing external sessions", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "ao-timeout-"));
    writeFileSync(join(tempDirectory, "agent-orchestrator.yaml"), "projects: {}\n");

    const pollResult = await pollAoSessionsUntilTerminal({
      records: [{ issueNumber: 42, sessionId: "loop-control-plane-42", status: "working" }],
      context: buildBackendExecutionContext({
        job: sampleJob(),
        config: { backend: "agent-orchestrator", timeoutMs: 1 },
        projectRepoPath: tempDirectory,
      }),
      settings: resolveAgentOrchestratorSettings({
        project: aoProject(tempDirectory),
        executorConfig: { backend: "agent-orchestrator" },
      }),
      processRunner: new ProcessRunner(
        createAoSpawner({
          status: () => ({
            exitCode: 0,
            stdout: JSON.stringify({
              data: [
                {
                  id: "loop-control-plane-42",
                  status: "working",
                  issueId: "42",
                },
              ],
              meta: { hiddenTerminatedCount: 0 },
            }),
            stderr: "",
            timedOut: false,
          }),
        }),
      ),
      timeoutMs: 1,
      sleep: async () => undefined,
    });

    assert.equal(pollResult.timedOut, true);
  });
});
