import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  openProjectPath,
  ProjectOpenActionError,
  type ProjectCommandRunner,
} from "@/lib/projects/project-open-actions";
import { seedProject } from "@/lib/loopboard";

const createRunner = (available = true) => {
  const launches: Array<{ command: string; args: string[] }> = [];
  const runner: ProjectCommandRunner = {
    commandAvailable: () => available,
    launch: (command, args) => {
      launches.push({ command, args });
    },
  };

  return { runner, launches };
};

describe("project open actions", () => {
  it("opens a project folder with a fixed file explorer command", () => {
    const repoPath = mkdtempSync(join(tmpdir(), "loopboard-open-folder-"));
    const { runner, launches } = createRunner();

    try {
      const result = openProjectPath(
        { ...seedProject, repoPath },
        "open-folder",
        runner,
      );

      assert.equal(result.action, "open-folder");
      assert.equal(result.repoPath, repoPath);
      assert.equal(launches.length, 1);
      assert.deepEqual(launches[0]?.args, [repoPath]);
      assert.notEqual(launches[0]?.command, "code");
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it("opens a project in VS Code only when the code command is available", () => {
    const repoPath = mkdtempSync(join(tmpdir(), "loopboard-open-code-"));
    const { runner, launches } = createRunner(true);

    try {
      const result = openProjectPath(
        { ...seedProject, repoPath },
        "open-vscode",
        runner,
      );

      assert.equal(result.action, "open-vscode");
      assert.equal(result.command, "code");
      assert.deepEqual(launches, [{ command: "code", args: [repoPath] }]);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it("returns a clear error when the VS Code command is unavailable", () => {
    const repoPath = mkdtempSync(join(tmpdir(), "loopboard-missing-code-"));
    const { runner, launches } = createRunner(false);

    try {
      assert.throws(
        () => openProjectPath({ ...seedProject, repoPath }, "open-vscode", runner),
        (error) =>
          error instanceof ProjectOpenActionError &&
          error.code === "command_unavailable" &&
          error.message.includes("`code` is not installed"),
      );
      assert.deepEqual(launches, []);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it("rejects missing and non-directory project paths before launching commands", () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "loopboard-invalid-open-"));
    const filePath = join(tempDirectory, "README.md");
    writeFileSync(filePath, "# fixture\n");
    const { runner, launches } = createRunner();

    try {
      assert.throws(
        () =>
          openProjectPath(
            { ...seedProject, repoPath: join(tempDirectory, "missing") },
            "open-folder",
            runner,
          ),
        (error) =>
          error instanceof ProjectOpenActionError &&
          error.code === "repo_path_missing",
      );

      assert.throws(
        () =>
          openProjectPath(
            { ...seedProject, repoPath: filePath },
            "open-folder",
            runner,
          ),
        (error) =>
          error instanceof ProjectOpenActionError &&
          error.code === "repo_path_not_directory",
      );
      assert.deepEqual(launches, []);
    } finally {
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  });
});
