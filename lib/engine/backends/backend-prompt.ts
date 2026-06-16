import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import {
  TaskContextService,
  type TaskContextInput,
} from "@/lib/context/task-context-service";
import type { LoopBoardRepository } from "@/lib/db/loopboard-repository";
import type { BackendExecutionContext } from "@/lib/engine/backends/backend-adapter";
import {
  parseTaskRunJobPayload,
  type EngineJob,
} from "@/lib/engine/loop-engine-types";
import { redactSensitiveText } from "@/lib/security/safe-context";

export type ResolvedBackendPrompt = {
  prompt: string;
  taskPath?: string;
  contextPath?: string;
  promptFile?: string;
};

const readRepoRelativeFile = (
  projectRepoPath: string,
  filePath: string,
): string => {
  const absolutePath = resolve(
    projectRepoPath,
    isAbsolute(filePath) ? relative(projectRepoPath, filePath) : filePath,
  );
  const relativePath = relative(projectRepoPath, absolutePath);

  if (relativePath.startsWith("..") || relativePath.includes("\0")) {
    throw new Error("Prompt file path must stay inside the project repository.");
  }

  return readFileSync(absolutePath, "utf8");
};

const assemblePromptFromTaskFiles = (taskContent: string, contextContent: string): string =>
  redactSensitiveText(
    [
      "# Task",
      "",
      taskContent.trim(),
      "",
      "# Context",
      "",
      contextContent.trim(),
    ].join("\n"),
  );

export const resolvePromptPathsFromTaskId = (
  taskId: string,
  contextService: TaskContextService,
): { taskPath: string; contextPath: string } => {
  const paths = contextService.pathsForTask({ id: taskId });

  return {
    taskPath: paths.task,
    contextPath: paths.context,
  };
};

export const resolveBackendPromptFromFiles = (input: {
  projectRepoPath: string;
  promptFile?: string;
  taskPath?: string;
  contextPath?: string;
}): ResolvedBackendPrompt => {
  if (input.promptFile) {
    const prompt = readRepoRelativeFile(input.projectRepoPath, input.promptFile);
    return {
      prompt: redactSensitiveText(prompt.trim()),
      promptFile: input.promptFile,
    };
  }

  if (input.taskPath && input.contextPath) {
    const taskContent = readFileSync(input.taskPath, "utf8");
    const contextContent = readFileSync(input.contextPath, "utf8");

    return {
      prompt: assemblePromptFromTaskFiles(taskContent, contextContent),
      taskPath: input.taskPath,
      contextPath: input.contextPath,
    };
  }

  throw new Error(
    "Backend prompt could not be resolved. Provide promptFile or generated task/context paths.",
  );
};

export const resolveTaskContextInputForJob = (
  job: EngineJob,
  repository: LoopBoardRepository,
): TaskContextInput | undefined => {
  const payload = parseTaskRunJobPayload(job.payload);
  const taskId = job.taskId ?? payload?.taskId;
  if (!taskId) {
    return undefined;
  }

  const task = repository.getTask(taskId);
  const board = repository.listBoardData(task.projectId);
  const project = board.projects.find((candidate) => candidate.id === task.projectId);
  const feature = board.features.find((candidate) => candidate.id === task.featureId);

  if (!project || !feature) {
    return undefined;
  }

  return { task, project, feature };
};

export const resolveBackendPromptForJob = (input: {
  context: BackendExecutionContext;
  contextService: TaskContextService;
  repository?: LoopBoardRepository;
  claudePrompt?: string;
}): ResolvedBackendPrompt => {
  if (input.claudePrompt) {
    return { prompt: input.claudePrompt };
  }

  const payload = parseTaskRunJobPayload(input.context.job.payload);
  const taskId = input.context.job.taskId ?? payload?.taskId;

  if (taskId) {
    const paths = resolvePromptPathsFromTaskId(taskId, input.contextService);
    return resolveBackendPromptFromFiles({
      projectRepoPath: input.context.projectRepoPath,
      promptFile: input.context.config.promptFile,
      taskPath: paths.taskPath,
      contextPath: paths.contextPath,
    });
  }

  if (input.context.config.promptFile) {
    return resolveBackendPromptFromFiles({
      projectRepoPath: input.context.projectRepoPath,
      promptFile: input.context.config.promptFile,
    });
  }

  throw new Error(
    "Backend prompt could not be resolved from job payload or executor config.",
  );
};
