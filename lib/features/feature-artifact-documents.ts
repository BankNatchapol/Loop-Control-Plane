import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isAbsolute, relative, resolve } from "node:path";

import {
  ValidationError,
  type LoopBoardRepository,
} from "@/lib/db/loopboard-repository";
import {
  FEATURE_ARTIFACT_FILES,
  type Feature,
  type FeatureArtifactName,
  type Project,
} from "@/lib/loopboard";

const artifactNames = Object.keys(FEATURE_ARTIFACT_FILES) as FeatureArtifactName[];

export class FeatureArtifactDocumentError extends Error {
  constructor(
    message: string,
    readonly statusCode = 500,
    readonly code = "artifact_document_error",
  ) {
    super(message);
  }
}

export interface FeatureArtifactDocument {
  featureId: string;
  artifactName: FeatureArtifactName;
  fileName: string;
  path: string;
  absolutePath: string;
  exists: boolean;
  content: string;
  loadedAt: string;
}

export const assertFeatureArtifactName = (value: string): FeatureArtifactName => {
  if (!artifactNames.includes(value as FeatureArtifactName)) {
    throw new ValidationError(`Feature artifact "${value}" is not supported.`);
  }

  return value as FeatureArtifactName;
};

export const readFeatureArtifactDocument = ({
  project,
  feature,
  artifactName,
}: {
  project: Project;
  feature: Feature;
  artifactName: FeatureArtifactName;
}): FeatureArtifactDocument => {
  const resolvedArtifact = resolveFeatureArtifactPath(project, feature, artifactName);

  if (!existsSync(resolvedArtifact.absolutePath)) {
    return {
      featureId: feature.id,
      artifactName,
      fileName: resolvedArtifact.fileName,
      path: resolvedArtifact.storedPath,
      absolutePath: resolvedArtifact.absolutePath,
      exists: false,
      content: "",
      loadedAt: new Date().toISOString(),
    };
  }

  try {
    const stats = statSync(resolvedArtifact.absolutePath);
    if (!stats.isFile()) {
      throw new FeatureArtifactDocumentError(
        `${resolvedArtifact.fileName} is not a file.`,
        400,
        "invalid_artifact_path",
      );
    }

    return {
      featureId: feature.id,
      artifactName,
      fileName: resolvedArtifact.fileName,
      path: resolvedArtifact.storedPath,
      absolutePath: resolvedArtifact.absolutePath,
      exists: true,
      content: readFileSync(resolvedArtifact.absolutePath, "utf8"),
      loadedAt: new Date().toISOString(),
    };
  } catch (error) {
    if (error instanceof FeatureArtifactDocumentError) {
      throw error;
    }

    throw new FeatureArtifactDocumentError(
      `LoopBoard could not read ${resolvedArtifact.fileName}.`,
      500,
      "read_error",
    );
  }
};

export const writeFeatureArtifactDocument = ({
  project,
  feature,
  artifactName,
  content,
}: {
  project: Project;
  feature: Feature;
  artifactName: FeatureArtifactName;
  content: string;
}): FeatureArtifactDocument => {
  if (typeof content !== "string") {
    throw new ValidationError("Artifact content must be a string.");
  }

  const resolvedArtifact = resolveFeatureArtifactPath(project, feature, artifactName);

  try {
    mkdirSync(dirname(resolvedArtifact.absolutePath), { recursive: true });
    writeFileSync(resolvedArtifact.absolutePath, content, "utf8");
  } catch {
    throw new FeatureArtifactDocumentError(
      `LoopBoard could not save ${resolvedArtifact.fileName}.`,
      500,
      "write_error",
    );
  }

  return readFeatureArtifactDocument({ project, feature, artifactName });
};

export const readRepositoryFeatureArtifactDocument = (
  repository: LoopBoardRepository,
  featureId: string,
  artifactName: FeatureArtifactName,
): FeatureArtifactDocument => {
  const feature = repository.getFeature(featureId);
  const project = repository.getProject(feature.projectId);

  return readFeatureArtifactDocument({ project, feature, artifactName });
};

export const writeRepositoryFeatureArtifactDocument = (
  repository: LoopBoardRepository,
  featureId: string,
  artifactName: FeatureArtifactName,
  content: string,
): FeatureArtifactDocument => {
  const feature = repository.getFeature(featureId);
  const project = repository.getProject(feature.projectId);

  return writeFeatureArtifactDocument({ project, feature, artifactName, content });
};

const resolveFeatureArtifactPath = (
  project: Project,
  feature: Feature,
  artifactName: FeatureArtifactName,
) => {
  const artifact = feature.artifacts[artifactName];
  const storedPath = artifact.path || featurePathForArtifact(feature, artifactName);

  if (!storedPath) {
    throw new ValidationError(`${FEATURE_ARTIFACT_FILES[artifactName]} is not linked.`);
  }

  const repoRoot = resolve(project.repoPath);
  const specsRoot = resolve(repoRoot, project.specKitRoot || project.specsPath || ".");
  const absolutePath = isAbsolute(storedPath)
    ? resolve(storedPath)
    : resolve(repoRoot, storedPath);

  if (!isInside(absolutePath, repoRoot) && !isInside(absolutePath, specsRoot)) {
    throw new ValidationError(
      "Artifact paths must stay inside the project repository or configured spec root.",
    );
  }

  if (!isInside(dirname(absolutePath), repoRoot) && !isInside(dirname(absolutePath), specsRoot)) {
    throw new ValidationError(
      "Artifact paths must stay inside the project repository or configured spec root.",
    );
  }

  return {
    fileName: FEATURE_ARTIFACT_FILES[artifactName],
    storedPath,
    absolutePath,
  };
};

const featurePathForArtifact = (
  feature: Feature,
  artifactName: FeatureArtifactName,
): string => {
  switch (artifactName) {
    case "prd":
      return feature.prdPath;
    case "spec":
      return feature.specPath;
    case "plan":
      return feature.planPath;
    case "tasks":
      return feature.tasksPath;
    case "decisions":
      return feature.decisionsPath;
  }
};

const isInside = (targetPath: string, rootPath: string): boolean => {
  const relativePath = relative(rootPath, targetPath);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
};
