import type { Project } from "@/lib/loopboard";
import {
  defaultLocalCommandRunner,
  fileExplorerCommand,
  LocalCommandError,
  safeCommandSummary,
  type LocalCommandRunner,
  validateLocalDirectory,
} from "@/lib/system/local-command-runner";

export type ProjectOpenAction = "open-folder" | "open-vscode";

export interface ProjectOpenActionResult {
  action: ProjectOpenAction;
  projectId: string;
  repoPath: string;
  command: string;
  message: string;
}

export class ProjectOpenActionError extends Error {
  constructor(
    message: string,
    readonly statusCode = 500,
    readonly code = "project_open_failed",
  ) {
    super(message);
  }
}

export type ProjectCommandRunner = LocalCommandRunner;

const convertLocalCommandError = (error: unknown): never => {
  if (error instanceof LocalCommandError) {
    throw new ProjectOpenActionError(error.message, error.statusCode, error.code);
  }

  throw error;
};

const validateRepoPath = (project: Project): string => {
  const repoPath = project.repoPath.trim();

  if (!repoPath) {
    throw new ProjectOpenActionError(
      `Project "${project.name}" does not have a repository path configured.`,
      400,
      "missing_repo_path",
    );
  }

  try {
    return validateLocalDirectory({
      path: repoPath,
      missingCode: "repo_path_missing",
      notDirectoryCode: "repo_path_not_directory",
    });
  } catch (error) {
    convertLocalCommandError(error);
  }

  throw new ProjectOpenActionError("Project repository path could not be validated.");
};

export const openProjectPath = (
  project: Project,
  action: ProjectOpenAction,
  runner: ProjectCommandRunner = defaultLocalCommandRunner,
): ProjectOpenActionResult => {
  const repoPath = validateRepoPath(project);
  const command =
    action === "open-folder"
      ? fileExplorerCommand(repoPath)
    : action === "open-vscode"
        ? safeCommandSummary("code", [repoPath])
        : null;

  if (!command) {
    throw new ProjectOpenActionError(
      "Project open action is not supported.",
      400,
      "unsupported_project_open_action",
    );
  }

  if (action === "open-vscode" && !runner.commandAvailable("code")) {
    throw new ProjectOpenActionError(
      "The VS Code command line tool `code` is not installed or is not on PATH.",
      424,
      "command_unavailable",
    );
  }

  try {
    runner.launch(command.command, command.args);
  } catch {
    throw new ProjectOpenActionError(
      `Loop Control Plane could not launch ${command.command}.`,
      500,
      "project_open_failed",
    );
  }

  return {
    action,
    projectId: project.id,
    repoPath,
    command: command.command,
    message:
      action === "open-folder"
        ? `Opening ${project.name} in the file explorer.`
        : `Opening ${project.name} in VS Code.`,
  };
};
