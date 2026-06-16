import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import type { Workflow, WorkflowArtifact, WorkflowRun } from "@/lib/loopboard";

export const resolveWorkflowArtifactPath = ({
  artifact,
  workflow,
  run,
}: {
  artifact: WorkflowArtifact;
  workflow: Workflow;
  run: WorkflowRun;
}): WorkflowArtifact => ({
  ...artifact,
  path: artifact.path
    .replaceAll("{run}", run.id)
    .replaceAll("{feature}", run.featureId ?? "project")
    .replaceAll("{repository}", workflow.projectId)
    .replaceAll("{defaultBranch}", "default"),
});

export const resolveProjectArtifactAbsolutePath = (
  projectRepoPath: string,
  storedPath: string,
): string =>
  isAbsolute(storedPath) ? resolve(storedPath) : resolve(projectRepoPath, storedPath);

export const artifactExistsOnDisk = (
  projectRepoPath: string,
  storedPath: string,
): boolean => {
  const absolutePath = resolveProjectArtifactAbsolutePath(projectRepoPath, storedPath);
  return existsSync(absolutePath);
};

export const findWorkflowArtifactByName = (
  artifacts: WorkflowArtifact[],
  names: string[],
): WorkflowArtifact | undefined =>
  artifacts.find((artifact) => names.includes(artifact.name));
