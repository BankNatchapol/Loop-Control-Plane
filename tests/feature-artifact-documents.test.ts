import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { ValidationError } from "@/lib/db/loopboard-repository";
import {
  readFeatureArtifactDocument,
  writeFeatureArtifactDocument,
} from "@/lib/features/feature-artifact-documents";
import { discoverFeatureArtifacts } from "@/lib/features/feature-artifacts";
import { seedFeatures, seedProject } from "@/lib/loopboard";

const withFixtureFeature = (
  test: (fixture: {
    repoPath: string;
    project: typeof seedProject;
    feature: typeof seedFeatures[number];
    featureFolder: string;
  }) => void,
) => {
  const repoPath = mkdtempSync(join(tmpdir(), "loopboard-artifact-documents-"));
  const featureFolder = join(repoPath, "specs", "loopboard-mvp", "feature-a");
  mkdirSync(featureFolder, { recursive: true });

  const project = {
    ...seedProject,
    repoPath,
    specKitRoot: "specs/loopboard-mvp",
  };
  const discovered = discoverFeatureArtifacts({
    project,
    artifactFolderPath: "specs/loopboard-mvp/feature-a",
  });
  const feature = {
    ...seedFeatures[0],
    projectId: project.id,
    ...discovered,
  };

  try {
    test({ repoPath, project, feature, featureFolder });
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
};

describe("feature artifact documents", () => {
  it("reads linked markdown content from a feature artifact", () => {
    withFixtureFeature(({ project, feature, featureFolder }) => {
      writeFileSync(join(featureFolder, "spec.md"), "# Spec\n\nBody\n", "utf8");

      const document = readFeatureArtifactDocument({
        project,
        feature,
        artifactName: "spec",
      });

      assert.equal(document.exists, true);
      assert.equal(document.fileName, "spec.md");
      assert.equal(document.path, "specs/loopboard-mvp/feature-a/spec.md");
      assert.equal(document.content, "# Spec\n\nBody\n");
    });
  });

  it("returns a missing document state for linked files that do not exist yet", () => {
    withFixtureFeature(({ project, feature }) => {
      const document = readFeatureArtifactDocument({
        project,
        feature,
        artifactName: "tasks",
      });

      assert.equal(document.exists, false);
      assert.equal(document.content, "");
      assert.equal(document.fileName, "tasks.md");
    });
  });

  it("saves markdown content to linked artifact files", () => {
    withFixtureFeature(({ project, feature, featureFolder }) => {
      const document = writeFeatureArtifactDocument({
        project,
        feature,
        artifactName: "decisions",
        content: "# Decisions\n",
      });

      assert.equal(document.exists, true);
      assert.equal(document.content, "# Decisions\n");
      assert.equal(
        readFileSync(join(featureFolder, "decisions.md"), "utf8"),
        "# Decisions\n",
      );
    });
  });

  it("rejects linked artifact paths outside the project and spec roots", () => {
    withFixtureFeature(({ project, feature, repoPath }) => {
      const unsafeFeature = {
        ...feature,
        artifacts: {
          ...feature.artifacts,
          spec: {
            ...feature.artifacts.spec,
            path: join(repoPath, "..", "outside.md"),
          },
        },
      };

      assert.throws(
        () =>
          readFeatureArtifactDocument({
            project,
            feature: unsafeFeature,
            artifactName: "spec",
          }),
        (error) =>
          error instanceof ValidationError &&
          error.message ===
            "Artifact paths must stay inside the project repository or configured spec root.",
      );
    });
  });
});
