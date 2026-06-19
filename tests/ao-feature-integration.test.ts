import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  featureIntegrationBranch,
  integrateAoTaskPullRequests,
} from "@/lib/engine/ao-feature-integration";

describe("AO feature integration", () => {
  it("squashes task PRs in supplied dependency order and pushes one branch", () => {
    const commands: string[][] = [];
    const integrated = integrateAoTaskPullRequests({
      repoPath: process.cwd(),
      featureId: "Feature Checkout",
      defaultBranch: "main",
      pullRequests: [
        {
          issueNumber: 11,
          taskId: "task-a",
          prUrl: "https://github.com/acme/shop/pull/101",
        },
        {
          issueNumber: 12,
          taskId: "task-b",
          prUrl: "https://github.com/acme/shop/pull/102",
        },
      ],
      runCommand: (_cwd, args) => {
        commands.push(args);
        return {
          success: true,
          stdout: args[0] === "rev-parse" ? `${args[1]}-sha\n` : "",
          stderr: "",
        };
      },
    });

    assert.equal(integrated.branch, "feature/feature-checkout");
    assert.deepEqual(
      commands
        .filter((args) => args[0] === "merge")
        .map((args) => args.at(-1)),
      [
        "refs/remotes/origin/loopboard-pr-101",
        "refs/remotes/origin/loopboard-pr-102",
      ],
    );
    assert.ok(
      commands.some(
        (args) =>
          args[0] === "push" &&
          args.includes("--force-with-lease") &&
          args.at(-1) === "feature/feature-checkout",
      ),
    );
  });

  it("fails closed on a squash conflict", () => {
    assert.throws(
      () =>
        integrateAoTaskPullRequests({
          repoPath: process.cwd(),
          featureId: "feature-conflict",
          defaultBranch: "main",
          pullRequests: [
            {
              issueNumber: 11,
              taskId: "task-a",
              prUrl: "https://github.com/acme/shop/pull/101",
            },
          ],
          runCommand: (_cwd, args) => ({
            success: args[0] !== "merge",
            stdout: args[0] === "rev-parse" ? "pr-head-sha\n" : "",
            stderr: args[0] === "merge" ? "CONFLICT" : "",
          }),
        }),
      /Could not squash PR #101/u,
    );
  });

  it("normalizes feature IDs into deterministic branch names", () => {
    assert.equal(featureIntegrationBranch(" Hello / World "), "feature/hello-world");
  });
});
