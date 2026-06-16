import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  ProcessRunner,
  ProcessRunnerError,
  assertProcessRunPolicyAllowed,
  buildProcessCommandSummary,
  isAllowedProcessCommand,
  type ProcessSpawnOutcome,
  type ProcessSpawner,
} from "@/lib/engine/process-runner";
import { defaultAutomationSettings } from "@/lib/policies/automation-policy";
import type { WorkflowNode } from "@/lib/loopboard";

const workflowNodeWith = (
  overrides: Partial<WorkflowNode>,
): Pick<
  WorkflowNode,
  "type" | "name" | "mode" | "requireApproval" | "riskPolicy" | "config"
> => ({
  type: "run-tests",
  name: "Run Tests",
  mode: "auto",
  requireApproval: false,
  riskPolicy: "low",
  config: { command: "npm test" },
  ...overrides,
});

const autoRunEnabled = {
  globalAutoRunEnabled: true,
};

const successSpawner =
  (stdout = "ok", stderr = ""): ProcessSpawner =>
  async () => ({
    exitCode: 0,
    stdout,
    stderr,
    timedOut: false,
  });

describe("process-runner", () => {
  it("rejects commands outside the fixed allowlist", () => {
    assert.equal(isAllowedProcessCommand("git"), true);
    assert.equal(isAllowedProcessCommand("npm"), true);
    assert.equal(isAllowedProcessCommand("gh"), true);
    assert.equal(isAllowedProcessCommand("spec-kit"), true);
    assert.equal(isAllowedProcessCommand("bash"), false);
    assert.equal(isAllowedProcessCommand("sh"), false);
    assert.equal(isAllowedProcessCommand("curl"), false);
  });

  it("blocks cwd traversal outside the project repository", async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "loopboard-process-cwd-"));
    const outsidePath = mkdtempSync(join(tmpdir(), "loopboard-process-outside-"));
    const runner = new ProcessRunner(successSpawner());

    try {
      await assert.rejects(
        () =>
          runner.run({
            profile: "npm-test",
            cwd: outsidePath,
            projectRepoPath: repoPath,
          }),
        (error) =>
          error instanceof ProcessRunnerError && error.code === "cwd_traversal_rejected",
      );
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
      rmSync(outsidePath, { recursive: true, force: true });
    }
  });

  it("enforces timeout and reports timedOut results", async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "loopboard-process-timeout-"));
    const runner = new ProcessRunner();

    const slowSpawner: ProcessSpawner = () =>
      new Promise<ProcessSpawnOutcome>((resolve) => {
        setTimeout(
          () =>
            resolve({
              exitCode: null,
              stdout: "",
              stderr: "",
              timedOut: true,
            }),
          20,
        );
      });

    try {
      const result = await runner.run(
        {
          profile: "npm-test",
          cwd: repoPath,
          projectRepoPath: repoPath,
          timeoutMs: 5,
        },
        slowSpawner,
      );

      assert.equal(result.timedOut, true);
      assert.equal(result.success, false);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it("redacts secrets in command and output summaries", async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "loopboard-process-redact-"));
    const runner = new ProcessRunner();

    const secretOutput =
      "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz1234567890 done";

    try {
      const result = await runner.run(
        {
          profile: "npm-test",
          args: ["test"],
          cwd: repoPath,
          projectRepoPath: repoPath,
        },
        successSpawner(secretOutput),
      );

      assert.match(result.stdoutSummary, /\[redacted\]/i);
      assert.doesNotMatch(result.stdoutSummary, /ghp_/);
      assert.match(
        buildProcessCommandSummary("npm", ["test", "token=super-secret"]),
        /token=\[redacted\]/,
      );
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it("requires workflow policy approval for shell-capable auto nodes", () => {
    const node = workflowNodeWith({
      mode: "auto",
      riskPolicy: "low",
      config: { command: "npm test" },
    });

    assert.throws(
      () =>
        assertProcessRunPolicyAllowed({
          node,
          automated: true,
          automationSettings: autoRunEnabled,
        }),
      (error) =>
        error instanceof ProcessRunnerError &&
        error.code === "workflow_shell_command_approval_required",
    );

    const approved = assertProcessRunPolicyAllowed({
      node,
      automated: true,
      approved: true,
      automationSettings: autoRunEnabled,
    });

    assert.equal(approved.kind, "allow");
  });

  it("blocks shell-capable workflow nodes when global auto-run is disabled", () => {
    assert.throws(
      () =>
        assertProcessRunPolicyAllowed({
          node: workflowNodeWith({ mode: "auto", riskPolicy: "low" }),
          automated: true,
          approved: true,
          automationSettings: defaultAutomationSettings,
        }),
      (error) =>
        error instanceof ProcessRunnerError &&
        error.code === "global_auto_run_disabled",
    );
  });

  it("runs npm-test profile inside the validated repo cwd", async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "loopboard-process-run-"));
    const runner = new ProcessRunner();
    const calls: Array<{ command: string; args: string[]; cwd: string }> = [];

    try {
      const result = await runner.run(
        {
          profile: "npm-test",
          cwd: repoPath,
          projectRepoPath: repoPath,
          policy: {
            node: workflowNodeWith({ mode: "auto", riskPolicy: "low" }),
            automated: true,
            approved: true,
            automationSettings: autoRunEnabled,
          },
        },
        async (command, args, options) => {
          calls.push({ command, args, cwd: options.cwd });
          return {
            exitCode: 0,
            stdout: "tests passed",
            stderr: "",
            timedOut: false,
          };
        },
      );

      assert.equal(result.success, true);
      assert.deepEqual(calls, [{ command: "npm", args: ["test"], cwd: repoPath }]);
      assert.equal(result.stdoutSummary, "tests passed");
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it("rejects shell metacharacters in args", async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "loopboard-process-shell-"));
    const runner = new ProcessRunner(successSpawner());

    try {
      await assert.rejects(
        () =>
          runner.run({
            profile: "git",
            args: ["status; rm -rf /"],
            cwd: repoPath,
            projectRepoPath: repoPath,
          }),
        (error) =>
          error instanceof ProcessRunnerError && error.code === "shell_metachar_rejected",
      );
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it("returns placeholder errors for cursor, claude, and codex profiles", async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "loopboard-process-placeholder-"));
    const runner = new ProcessRunner(successSpawner());

    try {
      for (const profile of ["cursor", "claude", "codex"] as const) {
        await assert.rejects(
          () =>
            runner.run({
              profile,
              cwd: repoPath,
              projectRepoPath: repoPath,
            }),
          (error) =>
            error instanceof ProcessRunnerError &&
            error.code === "process_profile_placeholder",
        );
      }
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });
});
