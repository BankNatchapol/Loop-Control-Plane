import { existsSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import type { LoopBoardRepository } from "@/lib/db/loopboard-repository";
import type { ExecutorConfig } from "@/lib/engine/loop-engine-types";
import type { Project, ProjectAgentOrchestratorSettings } from "@/lib/loopboard";
import { LocalCommandError } from "@/lib/system/local-command-runner";

export const DEFAULT_AO_POLL_INTERVAL_MS = 5_000;
export const DEFAULT_AO_POLL_TIMEOUT_MS = 1_800_000;

export type ResolvedAgentOrchestratorSettings = {
  enabled: boolean;
  configPath?: string;
  projectId?: string;
  dashboardUrl?: string;
  pollIntervalMs: number;
};

export class AgentOrchestratorConfigError extends Error {
  constructor(
    message: string,
    readonly code = "ao_config_invalid",
  ) {
    super(message);
  }
}

export const validateRepoRelativePath = (input: {
  projectRepoPath: string;
  path: string;
  kind: "file" | "directory";
  missingCode?: string;
  traversalCode?: string;
}): string => {
  const relativePath = isAbsolute(input.path)
    ? relative(resolve(input.projectRepoPath), resolve(input.path))
    : input.path;

  if (
    relativePath.startsWith("..") ||
    relativePath.includes("\0") ||
    relativePath.includes("\\")
  ) {
    throw new AgentOrchestratorConfigError(
      "Agent Orchestrator config path must stay inside the project repository.",
      input.traversalCode ?? "ao_config_path_traversal_rejected",
    );
  }

  const absolutePath = resolve(input.projectRepoPath, relativePath);

  if (!existsSync(absolutePath)) {
    throw new AgentOrchestratorConfigError(
      `Agent Orchestrator config path does not exist: ${relativePath}`,
      input.missingCode ?? "ao_config_path_missing",
    );
  }

  const stats = statSync(absolutePath);
  if (input.kind === "file" && !stats.isFile()) {
    throw new AgentOrchestratorConfigError(
      `Agent Orchestrator config path must be a file: ${relativePath}`,
      "ao_config_path_not_file",
    );
  }

  if (input.kind === "directory" && !stats.isDirectory()) {
    throw new AgentOrchestratorConfigError(
      `Agent Orchestrator working path must be a directory: ${relativePath}`,
      "ao_config_path_not_directory",
    );
  }

  return absolutePath;
};

export const resolveAgentOrchestratorSettings = (input: {
  project: Project;
  executorConfig: ExecutorConfig;
}): ResolvedAgentOrchestratorSettings => {
  const projectSettings: ProjectAgentOrchestratorSettings =
    input.project.engineSettings.agentOrchestrator ?? {};

  const enabled = projectSettings.enabled === true;
  const pollIntervalMs =
    typeof projectSettings.pollIntervalMs === "number" &&
    Number.isInteger(projectSettings.pollIntervalMs) &&
    projectSettings.pollIntervalMs > 0
      ? projectSettings.pollIntervalMs
      : DEFAULT_AO_POLL_INTERVAL_MS;

  let configPath: string | undefined;
  if (typeof projectSettings.configPath === "string" && projectSettings.configPath.trim()) {
    configPath = validateRepoRelativePath({
      projectRepoPath: input.project.repoPath,
      path: projectSettings.configPath.trim(),
      kind: "file",
    });
  }

  const projectId =
    input.executorConfig.aoProjectId?.trim() ||
    projectSettings.projectId?.trim() ||
    undefined;

  const dashboardUrl =
    typeof projectSettings.dashboardUrl === "string" && projectSettings.dashboardUrl.trim()
      ? projectSettings.dashboardUrl.trim()
      : undefined;

  return {
    enabled,
    ...(configPath ? { configPath } : {}),
    ...(projectId ? { projectId } : {}),
    ...(dashboardUrl ? { dashboardUrl } : {}),
    pollIntervalMs,
  };
};

export const describeAgentOrchestratorAvailability = (input: {
  cliAvailable: boolean;
  cliMessage: string;
  project?: Project;
}): { available: boolean; message: string } => {
  if (!input.cliAvailable) {
    return {
      available: false,
      message: input.cliMessage,
    };
  }

  if (!input.project) {
    return {
      available: false,
      message: "Agent Orchestrator requires a project context.",
    };
  }

  const settings = input.project.engineSettings.agentOrchestrator;
  if (!settings?.enabled) {
    return {
      available: false,
      message: "Agent Orchestrator is disabled in project settings.",
    };
  }

  if (settings.configPath) {
    try {
      validateRepoRelativePath({
        projectRepoPath: input.project.repoPath,
        path: settings.configPath,
        kind: "file",
      });
    } catch (error) {
      const message =
        error instanceof AgentOrchestratorConfigError
          ? error.message
          : "Agent Orchestrator config path is invalid.";
      return { available: false, message };
    }
  }

  return {
    available: true,
    message: input.cliMessage,
  };
};

export const resolveIssueNumbersForExecution = (input: {
  config: ExecutorConfig;
  repository?: LoopBoardRepository;
  jobTaskId?: string;
}): number[] => {
  if (input.config.fanOut?.issueIds?.length) {
    return Array.from(new Set(input.config.fanOut.issueIds));
  }

  if (typeof input.config.issueNumber === "number") {
    return [input.config.issueNumber];
  }

  if (input.repository && input.jobTaskId) {
    const task = input.repository.getTask(input.jobTaskId);
    if (typeof task.github.issueNumber === "number" && task.github.issueNumber > 0) {
      return [task.github.issueNumber];
    }
  }

  return [];
};

export const taskHasAoReadyHandoff = (task: {
  github: { issueLabels?: string[]; issueNumber?: number | null };
}): boolean => Boolean(task.github.issueLabels?.includes("ao-ready"));

export const ensureAoReadyHandoff = (
  repository: LoopBoardRepository,
  taskId: string,
): { ok: true; issueNumber: number } | { ok: false; message: string } => {
  let task = repository.getTask(taskId);

  if (!task.github.issueNumber) {
    return {
      ok: false,
      message: "Task requires a linked GitHub issue before Agent Orchestrator handoff.",
    };
  }

  if (taskHasAoReadyHandoff(task)) {
    return { ok: true, issueNumber: task.github.issueNumber };
  }

  try {
    task = repository.applyTaskAction(taskId, "mark-ao-ready");
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to apply ao-ready label for Agent Orchestrator handoff.";
    return { ok: false, message };
  }

  if (!taskHasAoReadyHandoff(task)) {
    return {
      ok: false,
      message:
        "Task is not ao-ready. Apply ao-ready on the linked GitHub issue or record local approval first.",
    };
  }

  return { ok: true, issueNumber: task.github.issueNumber! };
};

export const isLocalCommandPathError = (error: unknown): error is LocalCommandError =>
  error instanceof LocalCommandError;
