import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import type { Project, Workflow, WorkflowArtifact, WorkflowRun } from "@/lib/loopboard";
import { externalUntrustedPrefix } from "@/lib/security/safe-context";

export const resolveWorkflowArtifactPath = ({
  artifact,
  workflow,
  run,
  project,
}: {
  artifact: WorkflowArtifact;
  workflow: Workflow;
  run: WorkflowRun;
  project?: Pick<Project, "githubRepository" | "defaultBranch">;
}): WorkflowArtifact => ({
  ...artifact,
  path: artifact.path
    .replaceAll("{run}", run.id)
    .replaceAll("{feature}", run.featureId ?? "project")
    .replaceAll("{repository}", project?.githubRepository || workflow.projectId)
    .replaceAll("{defaultBranch}", project?.defaultBranch || "default"),
});

export const hasUnresolvedArtifactPlaceholders = (artifact: WorkflowArtifact): boolean =>
  /\{[A-Za-z][A-Za-z0-9]*\}/u.test(artifact.path);

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

export const markWorkflowArtifactUntrusted = (
  artifact: WorkflowArtifact,
  reason = "External content from untrusted sources.",
): WorkflowArtifact => ({
  ...artifact,
  description: artifact.description?.startsWith(externalUntrustedPrefix)
    ? artifact.description
    : `${externalUntrustedPrefix} ${reason}`,
});

export const parseGitArtifactBranch = (path: string): string | undefined => {
  const match = /^git:\/\/[^/]+\/(.+)$/u.exec(path.trim());
  return match?.[1];
};

export const resolveWorkflowArtifactPlaceholders = (
  artifact: WorkflowArtifact,
  replacements: Record<string, string>,
): WorkflowArtifact => {
  let path = artifact.path;

  for (const [key, value] of Object.entries(replacements)) {
    path = path.replaceAll(`{${key}}`, value);
  }

  return { ...artifact, path };
};
