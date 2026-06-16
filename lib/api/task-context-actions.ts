import {
  type ClaudeCodePromptResult,
  type HandoffDocument,
  TaskContextService,
  type GeneratedTaskContext,
  type TaskContextStatus,
} from "@/lib/context/task-context-service";
import type {
  LoopBoardRepository,
  PersistedTask,
} from "@/lib/db/loopboard-repository";
import type { Feature, Project } from "@/lib/loopboard";

export type TaskContextActionResult = {
  task: PersistedTask;
  context: TaskContextStatus;
  generated?: GeneratedTaskContext;
};

export type ClaudeCodePromptActionResult = {
  task: PersistedTask;
  context: TaskContextStatus;
  prompt: ClaudeCodePromptResult;
};

export type HandoffDocumentActionResult = {
  task: PersistedTask;
  context: TaskContextStatus;
  handoff: HandoffDocument;
};

type TaskContextInput = {
  task: PersistedTask;
  project: Project;
  feature: Feature;
};

export class TaskContextActionError extends Error {
  readonly code = "context_file_error";
  readonly statusCode = 500;
}

export const getTaskContextStatus = (
  repository: LoopBoardRepository,
  taskId: string,
): TaskContextActionResult => {
  const task = repository.getTask(taskId);
  const service = new TaskContextService();

  return {
    task,
    context: service.getTaskContextStatus(task),
  };
};

export const exportTaskEvents = (
  repository: LoopBoardRepository,
  taskId: string,
): TaskContextActionResult => {
  const task = repository.getTask(taskId);
  const service = new TaskContextService();

  try {
    const generated = service.exportEvents(task);

    return {
      task,
      generated,
      context: service.getTaskContextStatus(task),
    };
  } catch (error) {
    throw contextActionError("events.jsonl", error);
  }
};

export const refreshTaskHandoff = (
  repository: LoopBoardRepository,
  taskId: string,
): TaskContextActionResult => {
  const input = getTaskContextInput(repository, taskId);
  const service = new TaskContextService();

  try {
    const generated = service.refreshHandoff(input);

    return {
      task: input.task,
      generated,
      context: service.getTaskContextStatus(input.task),
    };
  } catch (error) {
    throw contextActionError("handoff.md", error);
  }
};

export const readTaskHandoff = (
  repository: LoopBoardRepository,
  taskId: string,
): HandoffDocumentActionResult => {
  const task = repository.getTask(taskId);
  const service = new TaskContextService();

  try {
    return {
      task,
      handoff: service.readHandoffDocument(task),
      context: service.getTaskContextStatus(task),
    };
  } catch (error) {
    throw contextActionError("handoff.md", error);
  }
};

export const saveTaskHandoff = (
  repository: LoopBoardRepository,
  taskId: string,
  content: string,
): HandoffDocumentActionResult => {
  const task = repository.getTask(taskId);
  const service = new TaskContextService();

  try {
    const handoff = service.saveHandoffDocument(task, content);

    return {
      task,
      handoff,
      context: service.getTaskContextStatus(task),
    };
  } catch (error) {
    throw contextActionError("handoff.md", error);
  }
};

export const appendTaskHandoffNote = (
  repository: LoopBoardRepository,
  taskId: string,
  note?: string,
): TaskContextActionResult => {
  const input = getTaskContextInput(repository, taskId);
  const service = new TaskContextService();

  try {
    service.refreshHandoff(input);
    const generated = service.appendHumanHandoffNote(input.task, note, {
      createdAt: new Date().toISOString(),
    });

    return {
      task: input.task,
      generated,
      context: service.getTaskContextStatus(input.task),
    };
  } catch (error) {
    throw contextActionError("handoff.md", error);
  }
};

export const generateTaskClaudeCodePrompt = (
  repository: LoopBoardRepository,
  taskId: string,
  manualIntent?: string,
): ClaudeCodePromptActionResult => {
  const input = getTaskContextInput(repository, taskId);
  const service = new TaskContextService();

  try {
    const prompt = service.generateClaudeCodePrompt(input, { manualIntent });

    return {
      task: input.task,
      prompt,
      context: service.getTaskContextStatus(input.task),
    };
  } catch (error) {
    throw contextActionError("Claude Code prompt", error);
  }
};

export const syncExistingTaskEventsFile = (task: PersistedTask): void => {
  const service = new TaskContextService();

  try {
    service.syncExistingEventsFile(task);
  } catch (error) {
    console.error(`LoopBoard could not refresh events.jsonl for ${task.id}.`, error);
  }
};

const getTaskContextInput = (
  repository: LoopBoardRepository,
  taskId: string,
): TaskContextInput => {
  const task = repository.getTask(taskId);
  const board = repository.listBoardData(task.projectId);
  const project = board.projects.find((candidate) => candidate.id === task.projectId);
  const feature = board.features.find((candidate) => candidate.id === task.featureId);

  if (!project) {
    throw new TaskContextActionError(
      `Project "${task.projectId}" was not found for task "${task.id}".`,
    );
  }

  if (!feature) {
    throw new TaskContextActionError(
      `Feature "${task.featureId}" was not found for task "${task.id}".`,
    );
  }

  return { task, project, feature };
};

const contextActionError = (fileName: string, error: unknown): TaskContextActionError => {
  const reason = error instanceof Error ? error.message : "Unknown file error.";

  return new TaskContextActionError(`LoopBoard could not write ${fileName}: ${reason}`);
};
