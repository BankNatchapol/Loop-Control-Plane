import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { ValidationError } from "@/lib/db/loopboard-repository";
import { discoverFeatureArtifacts } from "@/lib/features/feature-artifacts";
import { seedProject } from "@/lib/loopboard";

const withFixtureProject = (test: (repoPath: string) => void) => {
  const repoPath = mkdtempSync(join(tmpdir(), "loopboard-feature-artifacts-"));

  try {
    test(repoPath);
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
};

describe("feature artifact discovery", () => {
  it("detects Spec Kit artifact files inside a linked feature folder", () => {
    withFixtureProject((repoPath) => {
      const featureFolder = join(repoPath, "specs", "loopboard-mvp", "feature-a");
      mkdirSync(featureFolder, { recursive: true });
      writeFileSync(join(featureFolder, "PRD.md"), "# PRD\n", "utf8");
      writeFileSync(join(featureFolder, "spec.md"), "# Spec\n", "utf8");
      writeFileSync(join(featureFolder, "plan.md"), "# Plan\n", "utf8");

      const discovered = discoverFeatureArtifacts({
        project: {
          ...seedProject,
          repoPath,
          specKitRoot: "specs/loopboard-mvp",
        },
        artifactFolderPath: "specs/loopboard-mvp/feature-a",
        status: "plan-approved",
      });

      assert.equal(discovered.artifactFolderPath, "specs/loopboard-mvp/feature-a");
      assert.equal(discovered.specPath, "specs/loopboard-mvp/feature-a/spec.md");
      assert.equal(discovered.artifacts.prd.exists, true);
      assert.equal(discovered.artifacts.spec.exists, true);
      assert.equal(discovered.artifacts.plan.exists, true);
      assert.equal(discovered.artifacts.tasks.exists, false);
      assert.equal(discovered.artifacts.spec.approved, true);
      assert.equal(discovered.artifacts.plan.approved, true);
      assert.equal(discovered.artifacts.tasks.approved, false);
    });
  });

  it("rejects artifact folders outside the local project root", () => {
    withFixtureProject((repoPath) => {
      assert.throws(
        () =>
          discoverFeatureArtifacts({
            project: { ...seedProject, repoPath },
            artifactFolderPath: "../outside",
          }),
        (error) =>
          error instanceof ValidationError &&
          error.message ===
            "artifactFolderPath must stay inside the project repository or configured spec root.",
      );
    });
  });

  it("rejects artifact folder paths that resolve to files", () => {
    withFixtureProject((repoPath) => {
      const filePath = join(repoPath, "specs", "not-a-folder.md");
      mkdirSync(join(repoPath, "specs"), { recursive: true });
      writeFileSync(filePath, "# Not a folder\n", "utf8");

      assert.throws(
        () =>
          discoverFeatureArtifacts({
            project: { ...seedProject, repoPath },
            artifactFolderPath: "specs/not-a-folder.md",
          }),
        (error) =>
          error instanceof ValidationError &&
          error.message === `artifactFolderPath must be a directory: ${filePath}`,
      );
    });
  });
});
