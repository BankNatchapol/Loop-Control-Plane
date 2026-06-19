import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export type AoTaskPullRequest = {
  issueNumber: number;
  taskId: string;
  prUrl: string;
};

export type AoIntegrationCommandResult = {
  success: boolean;
  stdout: string;
  stderr: string;
};

export type AoIntegrationCommandRunner = (
  cwd: string,
  args: string[],
) => AoIntegrationCommandResult;

export type AoFeatureIntegrationResult = {
  branch: string;
  integratedPullRequests: Array<
    AoTaskPullRequest & { pullRequestNumber: number; headSha: string }
  >;
};

const pullRequestNumber = (url: string): number | undefined => {
  const match = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)(?:[/?#].*)?$/u.exec(
    url.trim(),
  );
  const parsed = match?.[1] ? Number(match[1]) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
};

export const featureIntegrationBranch = (featureId: string): string => {
  const slug = featureId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return `feature/${slug || "integrated"}`;
};

const defaultRunCommand: AoIntegrationCommandRunner = (cwd, args) => {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
  });
  return {
    success: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
};

const runOrThrow = (
  runner: AoIntegrationCommandRunner,
  cwd: string,
  args: string[],
  description: string,
): void => {
  const result = runner(cwd, args);
  if (!result.success) {
    throw new Error(
      `${description}: ${result.stderr.trim() || result.stdout.trim() || "git command failed"}`,
    );
  }
};

export const integrateAoTaskPullRequests = (input: {
  repoPath: string;
  featureId: string;
  defaultBranch: string;
  pullRequests: AoTaskPullRequest[];
  runCommand?: AoIntegrationCommandRunner;
}): AoFeatureIntegrationResult => {
  if (input.pullRequests.length === 0) {
    throw new Error("No clean AO task pull requests were supplied for integration.");
  }

  const parsed = input.pullRequests.map((pullRequest) => {
    const number = pullRequestNumber(pullRequest.prUrl);
    if (!number) {
      throw new Error(
        `Task ${pullRequest.taskId} has no valid GitHub pull request URL.`,
      );
    }
    return { ...pullRequest, pullRequestNumber: number };
  });
  const runner = input.runCommand ?? defaultRunCommand;
  const branch = featureIntegrationBranch(input.featureId);
  const worktreePath = mkdtempSync(join(tmpdir(), "loopboard-ao-integration-"));
  rmSync(worktreePath, { recursive: true, force: true });
  let worktreeAdded = false;

  try {
    runOrThrow(
      runner,
      input.repoPath,
      ["fetch", "origin"],
      "Could not refresh origin before integration",
    );
    runOrThrow(
      runner,
      input.repoPath,
      ["worktree", "add", "--detach", worktreePath, `origin/${input.defaultBranch}`],
      "Could not create the integration worktree",
    );
    worktreeAdded = true;
    runOrThrow(
      runner,
      worktreePath,
      ["switch", "-C", branch, `origin/${input.defaultBranch}`],
      `Could not create integration branch ${branch}`,
    );

    const integratedPullRequests: AoFeatureIntegrationResult["integratedPullRequests"] = [];
    for (const pullRequest of parsed) {
      const remoteRef = `refs/remotes/origin/loopboard-pr-${pullRequest.pullRequestNumber}`;
      runOrThrow(
        runner,
        worktreePath,
        [
          "fetch",
          "origin",
          `pull/${pullRequest.pullRequestNumber}/head:${remoteRef}`,
        ],
        `Could not fetch PR #${pullRequest.pullRequestNumber}`,
      );
      const headResult = runner(worktreePath, ["rev-parse", remoteRef]);
      if (!headResult.success || !headResult.stdout.trim()) {
        throw new Error(`Could not resolve PR #${pullRequest.pullRequestNumber} head SHA.`);
      }
      integratedPullRequests.push({
        ...pullRequest,
        headSha: headResult.stdout.trim(),
      });
      runOrThrow(
        runner,
        worktreePath,
        ["merge", "--squash", remoteRef],
        `Could not squash PR #${pullRequest.pullRequestNumber}`,
      );
      runOrThrow(
        runner,
        worktreePath,
        [
          "-c",
          "user.name=Loop Control Plane",
          "-c",
          "user.email=loop-control-plane@local",
          "commit",
          "-m",
          `Integrate task PR #${pullRequest.pullRequestNumber} (issue #${pullRequest.issueNumber})`,
        ],
        `Could not commit PR #${pullRequest.pullRequestNumber}`,
      );
    }

    runOrThrow(
      runner,
      worktreePath,
      ["push", "--force-with-lease", "-u", "origin", branch],
      `Could not push integration branch ${branch}`,
    );

    return { branch, integratedPullRequests };
  } finally {
    if (worktreeAdded) {
      runner(input.repoPath, ["worktree", "remove", "--force", worktreePath]);
    }
    rmSync(worktreePath, { recursive: true, force: true });
  }
};
