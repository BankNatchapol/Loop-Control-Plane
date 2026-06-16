import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

import {
  inspectRepositoryHealth,
  parseGitHubRemoteUrl,
} from "@/lib/projects/project-repository-health";

const git = (repoPath: string, args: string[]) => {
  const result = spawnSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
};

describe("project repository health", () => {
  it("normalizes GitHub remote URLs", () => {
    assert.equal(
      parseGitHubRemoteUrl("git@github.com:owner/repo.git"),
      "https://github.com/owner/repo",
    );
    assert.equal(
      parseGitHubRemoteUrl("https://github.com/owner/repo.git"),
      "https://github.com/owner/repo",
    );
    assert.equal(
      parseGitHubRemoteUrl("https://example.com/owner/repo.git"),
      "https://example.com/owner/repo.git",
    );
    assert.equal(
      parseGitHubRemoteUrl("  git@github.com:owner/repo-with-dashes.git  "),
      "https://github.com/owner/repo-with-dashes",
    );
  });

  it("detects path and Git repository metadata", () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "loopboard-project-"));

    try {
      const repositoryPath = join(tempDirectory, "repo");
      spawnSync("git", ["init", repositoryPath], { encoding: "utf8" });
      git(repositoryPath, ["checkout", "-b", "feature/project-management"]);
      git(repositoryPath, ["config", "user.email", "loopboard@example.com"]);
      git(repositoryPath, ["config", "user.name", "LoopBoard Test"]);
      writeFileSync(join(repositoryPath, "README.md"), "# fixture\n");
      git(repositoryPath, ["add", "README.md"]);
      git(repositoryPath, ["commit", "-m", "Initial commit"]);
      git(repositoryPath, [
        "remote",
        "add",
        "origin",
        "git@github.com:owner/repo.git",
      ]);

      const health = inspectRepositoryHealth(repositoryPath);

      assert.equal(health.pathExists, true);
      assert.equal(health.isDirectory, true);
      assert.equal(health.isGitRepository, true);
      assert.equal(health.currentBranch, "feature/project-management");
      assert.equal(health.defaultBranch, "feature/project-management");
      assert.equal(health.githubRemoteUrl, "https://github.com/owner/repo");

      const missing = inspectRepositoryHealth(join(tempDirectory, "missing"));
      assert.equal(missing.pathExists, false);
      assert.equal(missing.isGitRepository, false);
    } finally {
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  it("reports existing non-Git project folders without branch metadata", () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "loopboard-project-"));

    try {
      const health = inspectRepositoryHealth(tempDirectory);

      assert.equal(health.pathExists, true);
      assert.equal(health.isDirectory, true);
      assert.equal(health.isGitRepository, false);
      assert.equal(health.currentBranch, "");
      assert.equal(health.defaultBranch, "");
      assert.equal(health.githubRemoteUrl, "");
    } finally {
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  });
});
