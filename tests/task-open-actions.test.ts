import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  openTaskPath,
  TaskOpenActionError,
  type TaskCommandRunner,
} from "@/lib/tasks/task-open-actions";
import { seedProject, seedTasks } from "@/lib/loopboard";
import type { PersistedTask } from "@/lib/db/loopboard-repository";

const createRunner = (available = true) => {
  const launches: Array<{ command: string; args: string[] }> = [];
  const runner: TaskCommandRunner = {
    commandAvailable: () => available,
    launch: (command, args) => {
      launches.push({ command, args });
    },
  };

  return { runner, launches };
};

const seedPersistedTask: PersistedTask = {
  ...seedTasks[0],
  dependencies: [],
};

describe("task open actions", () => {
  it("opens a task worktree in VS Code with a validated local directory", () => {
    const repoPath = mkdtempSync(join(tmpdir(), "loopboard-task-open-repo-"));
    const worktreePath = join(repoPath, "worktrees", "manual-edit");
    mkdirSync(worktreePath, { recursive: true });
    const { runner, launches } = createRunner();

    try {
      const result = openTaskPath(
        { ...seedProject, repoPath },
        { ...seedPersistedTask, worktree: "worktrees/manual-edit" },
        "open-worktree-vscode",
        runner,
      );

      assert.equal(result.pathKind, "worktree");
      assert.equal(result.usedFallback, false);
      assert.equal(result.path, worktreePath);
      assert.deepEqual(launches, [{ command: "code", args: [worktreePath] }]);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it("falls back to the repository when a task has no worktree configured", () => {
    const repoPath = mkdtempSync(join(tmpdir(), "loopboard-task-open-fallback-"));
    const { runner, launches } = createRunner();

    try {
      const result = openTaskPath(
        { ...seedProject, repoPath },
        { ...seedPersistedTask, worktree: "" },
        "open-worktree-vscode",
        runner,
      );

      assert.equal(result.pathKind, "repo");
      assert.equal(result.usedFallback, true);
      assert.equal(result.path, repoPath);
      assert.match(result.message, /does not have a worktree path/);
      assert.deepEqual(launches, [{ command: "code", args: [repoPath] }]);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it("opens the repository in VS Code explicitly", () => {
    const repoPath = mkdtempSync(join(tmpdir(), "loopboard-task-open-explicit-repo-"));
    const { runner, launches } = createRunner();

    try {
      const result = openTaskPath(
        { ...seedProject, repoPath },
        { ...seedPersistedTask, worktree: "missing-worktree" },
        "open-repo-vscode",
        runner,
      );

      assert.equal(result.pathKind, "repo");
      assert.equal(result.usedFallback, false);
      assert.deepEqual(launches, [{ command: "code", args: [repoPath] }]);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it("returns actionable errors without launching for missing paths or VS Code", () => {
    const repoPath = mkdtempSync(join(tmpdir(), "loopboard-task-open-errors-"));
    const filePath = join(repoPath, "README.md");
    writeFileSync(filePath, "# fixture\n");
    const { runner, launches } = createRunner(false);

    try {
      assert.throws(
        () =>
          openTaskPath(
            { ...seedProject, repoPath },
            { ...seedPersistedTask, worktree: filePath },
            "open-worktree-vscode",
            createRunner().runner,
          ),
        (error) =>
          error instanceof TaskOpenActionError &&
          error.code === "worktree_path_not_directory",
      );

      assert.throws(
        () =>
          openTaskPath(
            { ...seedProject, repoPath: join(repoPath, "missing") },
            seedPersistedTask,
            "open-repo-vscode",
            createRunner().runner,
          ),
        (error) =>
          error instanceof TaskOpenActionError &&
          error.code === "repo_path_missing",
      );

      assert.throws(
        () =>
          openTaskPath(
            { ...seedProject, repoPath },
            { ...seedPersistedTask, worktree: "" },
            "open-worktree-vscode",
            runner,
          ),
        (error) =>
          error instanceof TaskOpenActionError &&
          error.code === "command_unavailable",
      );

      assert.deepEqual(launches, []);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it("rejects worktree paths that escape the project repository", () => {
    const repoPath = mkdtempSync(join(tmpdir(), "loopboard-task-open-traversal-"));
    const siblingPath = mkdtempSync(join(tmpdir(), "loopboard-task-open-sibling-"));
    const { runner, launches } = createRunner();

    try {
      assert.throws(
        () =>
          openTaskPath(
            { ...seedProject, repoPath },
            { ...seedPersistedTask, worktree: `../${siblingPath.split("/").at(-1)}` },
            "open-worktree-vscode",
            runner,
          ),
        (error) =>
          error instanceof TaskOpenActionError &&
          error.code === "worktree_path_traversal",
      );

      assert.throws(
        () =>
          openTaskPath(
            { ...seedProject, repoPath },
            { ...seedPersistedTask, worktree: siblingPath },
            "open-worktree-vscode",
            runner,
          ),
        (error) =>
          error instanceof TaskOpenActionError &&
          error.code === "worktree_path_traversal",
      );

      assert.deepEqual(launches, []);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
      rmSync(siblingPath, { recursive: true, force: true });
    }
  });
});
