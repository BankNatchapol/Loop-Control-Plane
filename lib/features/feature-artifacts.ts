import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { ValidationError } from "@/lib/db/loopboard-repository";
import {
  FEATURE_ARTIFACT_FILES,
  emptyFeatureArtifacts,
  type Feature,
  type FeatureArtifactName,
  type FeatureArtifactStatus,
  type FeatureStatus,
  type Project,
} from "@/lib/loopboard";

const artifactNames = Object.keys(FEATURE_ARTIFACT_FILES) as FeatureArtifactName[];

export interface FeatureArtifactDiscoveryInput {
  project: Project;
  artifactFolderPath?: string;
  status?: FeatureStatus;
}

export interface FeatureArtifactDiscoveryResult {
  artifactFolderPath: string;
  prdPath: string;
  specPath: string;
  planPath: string;
  tasksPath: string;
  decisionsPath: string;
  artifacts: FeatureArtifactStatus;
}

export const discoverFeatureArtifacts = ({
  project,
  artifactFolderPath = "",
  status = "prd-draft",
}: FeatureArtifactDiscoveryInput): FeatureArtifactDiscoveryResult => {
  const repoRoot = resolve(project.repoPath);
  const requestedFolderPath = artifactFolderPath.trim();
  const rootContainsArtifacts = artifactNames.some((name) => {
    const path = join(repoRoot, FEATURE_ARTIFACT_FILES[name]);
    return existsSync(path) && statSync(path).isFile();
  });
  const folderPath =
    requestedFolderPath || (rootContainsArtifacts ? "." : "");

  if (!folderPath) {
    const artifacts = artifactsForStatus(emptyFeatureArtifacts(), status);

    return {
      artifactFolderPath: "",
      prdPath: "",
      specPath: "",
      planPath: "",
      tasksPath: "",
      decisionsPath: "",
      artifacts,
    };
  }

  const specsRoot = resolve(repoRoot, project.specKitRoot || project.specsPath || ".");
  const absoluteFolder = resolvePath(repoRoot, folderPath);

  if (!isInside(absoluteFolder, repoRoot) && !isInside(absoluteFolder, specsRoot)) {
    throw new ValidationError(
      "artifactFolderPath must stay inside the project repository or configured spec root.",
    );
  }

  if (!existsSync(absoluteFolder)) {
    throw new ValidationError(`artifactFolderPath does not exist: ${absoluteFolder}`);
  }

  if (!statSync(absoluteFolder).isDirectory()) {
    throw new ValidationError(`artifactFolderPath must be a directory: ${absoluteFolder}`);
  }

  const paths = Object.fromEntries(
    artifactNames.map((name) => [
      name,
      toStoredPath(repoRoot, join(absoluteFolder, FEATURE_ARTIFACT_FILES[name])),
    ]),
  ) as Record<FeatureArtifactName, string>;
  const artifacts = artifactsForStatus(
    Object.fromEntries(
      artifactNames.map((name) => {
        const absolutePath = join(absoluteFolder, FEATURE_ARTIFACT_FILES[name]);

        return [
          name,
          {
            name,
            fileName: FEATURE_ARTIFACT_FILES[name],
            path: paths[name],
            exists: existsSync(absolutePath) && statSync(absolutePath).isFile(),
            approved: false,
          },
        ];
      }),
    ) as FeatureArtifactStatus,
    status,
  );

  return {
    artifactFolderPath: toStoredPath(repoRoot, absoluteFolder),
    prdPath: paths.prd,
    specPath: paths.spec,
    planPath: paths.plan,
    tasksPath: paths.tasks,
    decisionsPath: paths.decisions,
    artifacts,
  };
};

export const refreshFeatureArtifactStatus = (
  project: Project,
  feature: Feature,
): Feature => {
  if (!feature.artifactFolderPath) {
    return {
      ...feature,
      artifacts: artifactsForStatus(feature.artifacts, feature.status),
    };
  }

  try {
    const discovered = discoverFeatureArtifacts({
      project,
      artifactFolderPath: feature.artifactFolderPath,
      status: feature.status,
    });

    return {
      ...feature,
      ...discovered,
    };
  } catch {
    return {
      ...feature,
      artifacts: artifactsForStatus(
        emptyFeatureArtifacts({
          prd: feature.prdPath,
          spec: feature.specPath,
          plan: feature.planPath,
          tasks: feature.tasksPath,
          decisions: feature.decisionsPath,
        }),
        feature.status,
      ),
    };
  }
};

export const refreshBoardFeatureArtifacts = <T extends { projects: Project[]; features: Feature[] }>(
  board: T,
): T => {
  const projects = new Map(board.projects.map((project) => [project.id, project]));

  return {
    ...board,
    features: board.features.map((feature) => {
      const project = projects.get(feature.projectId);
      return project ? refreshFeatureArtifactStatus(project, feature) : feature;
    }),
  };
};

const artifactsForStatus = (
  artifacts: FeatureArtifactStatus,
  status: FeatureStatus,
): FeatureArtifactStatus => {
  const approved = {
    spec: ["spec-approved", "plan-review", "plan-approved", "tasks-ready", "in-execution", "done"].includes(status),
    plan: ["plan-approved", "tasks-ready", "in-execution", "done"].includes(status),
    tasks: ["tasks-ready", "in-execution", "done"].includes(status),
  };

  return {
    ...artifacts,
    prd: { ...artifacts.prd, approved: artifacts.prd.exists },
    spec: { ...artifacts.spec, approved: approved.spec },
    plan: { ...artifacts.plan, approved: approved.plan },
    tasks: { ...artifacts.tasks, approved: approved.tasks },
    decisions: { ...artifacts.decisions, approved: false },
  };
};

const resolvePath = (repoRoot: string, inputPath: string): string =>
  isAbsolute(inputPath) ? resolve(inputPath) : resolve(repoRoot, inputPath);

const isInside = (targetPath: string, rootPath: string): boolean => {
  const relativePath = relative(rootPath, targetPath);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
};

const toStoredPath = (repoRoot: string, absolutePath: string): string => {
  const relativePath = relative(repoRoot, absolutePath);
  if (relativePath === "") {
    return ".";
  }
  return !relativePath.startsWith("..") && !isAbsolute(relativePath)
    ? relativePath
    : absolutePath;
};
