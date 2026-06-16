import type { PersistedTask } from "@/lib/db/loopboard-repository";
import type { KanbanStatus, TaskOwner } from "@/lib/loopboard";

export type TaskLoopSkipKind =
  | "deny"
  | "requires-approval"
  | "ineligible"
  | "dedupe";

export type TaskLoopSkipReason = {
  taskId: string;
  code: string;
  kind: TaskLoopSkipKind;
  message: string;
  reasons: string[];
};

const READY_OWNERS = new Set<TaskOwner>(["unassigned", "ai"]);

export const isTaskStructurallyEligible = (task: PersistedTask): boolean => {
  if (task.status !== "ready") {
    return false;
  }

  if (!READY_OWNERS.has(task.owner)) {
    return false;
  }

  if (task.labels.includes("ai-paused")) {
    return false;
  }

  return true;
};

export const structuralIneligibilityReason = (
  task: PersistedTask,
): TaskLoopSkipReason | undefined => {
  if (task.status !== "ready") {
    return {
      taskId: task.id,
      code: "task_status_not_ready",
      kind: "ineligible",
      message: `Task status "${task.status}" is not eligible for engine pickup.`,
      reasons: ["Only Ready column tasks can be picked up automatically."],
    };
  }

  if (!READY_OWNERS.has(task.owner)) {
    return {
      taskId: task.id,
      code: "task_human_claimed",
      kind: "ineligible",
      message: `Task owner "${task.owner}" blocks automated pickup.`,
      reasons: ["Tasks owned by humans or pairing require manual action."],
    };
  }

  if (task.labels.includes("ai-paused")) {
    return {
      taskId: task.id,
      code: "task_ai_paused",
      kind: "ineligible",
      message: "Task is paused and cannot be picked up automatically.",
      reasons: ["AI pause indicates an active human takeover."],
    };
  }

  return undefined;
};

export type TaskLoopCandidate = {
  taskId: string;
  projectId: string;
  title: string;
  status: KanbanStatus;
  owner: TaskOwner;
  risk: PersistedTask["risk"];
};
