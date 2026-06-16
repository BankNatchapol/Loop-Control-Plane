import type { PersistedTask } from "@/lib/db/loopboard-repository";
import { resolveGlobalDefaultExecutorBackend } from "@/lib/engine/global-executor-defaults";
import {
  defaultExecutorConfig,
  type ExecutorBackend,
  type ExecutorConfig,
  type TaskRunAction,
} from "@/lib/engine/loop-engine-types";
import {
  readTaskExecutorBackendLabel,
} from "@/lib/engine/task-run-executor";
import { resolveWorkflowNodeExecutorConfig } from "@/lib/engine/workflow-node-config";
import type { Project, WorkflowNode } from "@/lib/loopboard";

export type ExecutorConfigResolutionInput = {
  explicitConfig?: ExecutorConfig;
  project: Project;
  task?: PersistedTask;
  taskAction?: TaskRunAction;
  workflowNode?: Pick<WorkflowNode, "type" | "config">;
};

const resolveProjectDefaultBackend = (
  project: Project,
  taskAction?: TaskRunAction,
): ExecutorBackend | undefined => {
  const settings = project.engineSettings;

  if (taskAction === "review") {
    return settings.defaultReviewBackend;
  }

  return settings.defaultTaskBackend;
};

const isNonStubBackend = (backend: ExecutorBackend): boolean => backend !== "stub";

export const resolveExecutorConfigWithFallbacks = (
  input: ExecutorConfigResolutionInput,
): ExecutorConfig => {
  const explicit = input.explicitConfig;

  if (explicit && isNonStubBackend(explicit.backend)) {
    return explicit;
  }

  if (input.workflowNode) {
    const workflowConfig = resolveWorkflowNodeExecutorConfig(input.workflowNode);
    if (isNonStubBackend(workflowConfig.backend)) {
      return workflowConfig;
    }
  }

  if (input.task) {
    const labelBackend = readTaskExecutorBackendLabel(input.task);
    if (labelBackend && isNonStubBackend(labelBackend)) {
      return {
        ...(explicit ?? defaultExecutorConfig(labelBackend)),
        backend: labelBackend,
      };
    }
  }

  const projectBackend = resolveProjectDefaultBackend(input.project, input.taskAction);
  if (projectBackend && isNonStubBackend(projectBackend)) {
    return {
      ...(explicit ?? defaultExecutorConfig(projectBackend)),
      backend: projectBackend,
    };
  }

  const globalDefault = resolveGlobalDefaultExecutorBackend();
  if (explicit) {
    return {
      ...explicit,
      backend: globalDefault,
    };
  }

  return defaultExecutorConfig(globalDefault);
};
