import { resolve } from "node:path";

import type { PersistedTask } from "@/lib/db/loopboard-repository";
import type { Project } from "@/lib/loopboard";
import {
  defaultLocalCommandRunner,
  LocalCommandError,
  safeCommandSummary,
  type LocalCommandRunner,
  validateLocalDirectory,
} from "@/lib/system/local-command-runner";

export type TaskOpenAction = "open-worktree-vscode" | "open-repo-vscode";

export interface TaskOpenActionResult {
  action: TaskOpenAction;
  taskId: string;
  projectId: string;
  path: string;
  pathKind: "worktree" | "repo";
  usedFallback: boolean;
  command: string;
  message: string;
}

export class TaskOpenActionError extends Error {
  constructor(
    message: string,
    readonly statusCode = 500,
    readonly code = "task_open_failed",
  ) {
    super(message);
  }
}

export type TaskCommandRunner = LocalCommandRunner;

const convertLocalCommandError = (error: unknown): never => {
  if (error instanceof LocalCommandError) {
    throw new TaskOpenActionError(error.message, error.statusCode, error.code);
  }

  throw error;
};

const resolveRepoPath = (project: Project): string => {
  const repoPath = project.repoPath.trim();

  if (!repoPath) {
    throw new TaskOpenActionError(
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

  throw new TaskOpenActionError("Project repository path could not be validated.");
};

const resolveWorktreePath = (
  project: Project,
  task: PersistedTask,
): { path: string; kind: "worktree" | "repo"; usedFallback: boolean } => {
  const repoPath = resolveRepoPath(project);
  const worktree = task.worktree.trim();

  if (!worktree) {
    return { path: repoPath, kind: "repo", usedFallback: true };
  }

  const worktreePath = resolve(repoPath, worktree);

  return {
    path: (() => {
      try {
        return validateLocalDirectory({
          path: worktreePath,
          basePath: repoPath,
          missingCode: "worktree_path_missing",
          notDirectoryCode: "worktree_path_not_directory",
          traversalCode: "worktree_path_traversal",
        });
      } catch (error) {
        convertLocalCommandError(error);
      }
      throw new TaskOpenActionError("Task worktree path could not be validated.");
    })(),
    kind: "worktree",
    usedFallback: false,
  };
};

export const openTaskPath = (
  project: Project,
  task: PersistedTask,
  action: TaskOpenAction,
  runner: TaskCommandRunner = defaultLocalCommandRunner,
): TaskOpenActionResult => {
  const target =
    action === "open-worktree-vscode"
      ? resolveWorktreePath(project, task)
      : action === "open-repo-vscode"
        ? { path: resolveRepoPath(project), kind: "repo" as const, usedFallback: false }
        : null;

  if (!target) {
    throw new TaskOpenActionError(
      "Task open action is not supported.",
      400,
      "unsupported_task_open_action",
    );
  }

  if (!runner.commandAvailable("code")) {
    throw new TaskOpenActionError(
      "The VS Code command line tool `code` is not installed or is not on PATH.",
      424,
      "command_unavailable",
    );
  }

  try {
    runner.launch("code", [target.path]);
  } catch {
    throw new TaskOpenActionError(
      "Loop Control Plane could not launch VS Code.",
      500,
      "task_open_failed",
    );
  }
  const command = safeCommandSummary("code", [target.path]);

  return {
    action,
    taskId: task.id,
    projectId: project.id,
    path: target.path,
    pathKind: target.kind,
    usedFallback: target.usedFallback,
    command: command.command,
    message:
      target.kind === "worktree"
        ? `Opening ${task.title} worktree in VS Code.`
        : target.usedFallback
          ? `Task "${task.title}" does not have a worktree path, so Loop Control Plane is opening the project repository in VS Code.`
          : `Opening ${project.name} repository in VS Code.`,
  };
};
