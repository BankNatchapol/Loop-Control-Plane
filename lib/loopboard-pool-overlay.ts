import type { AoWorkerPoolSnapshot } from "@/lib/engine/ao-worker-pool-types";
import {
  KANBAN_COLUMNS,
  type KanbanStatus,
  type Task,
  tasksByStatus,
} from "@/lib/loopboard";

const poolStateToColumn = (state: string): KanbanStatus => {
  if (state === "running" || state === "spawning") {
    return "ai-running";
  }

  if (state === "queued") {
    return "ready";
  }

  if (state === "blocked") {
    return "blocked";
  }

  if (state === "completed") {
    return "done";
  }

  return "blocked";
};

export const tasksByStatusWithPoolOverlay = (
  tasks: Task[],
  snapshot?: AoWorkerPoolSnapshot,
): Record<KanbanStatus, Task[]> => {
  if (!snapshot || snapshot.items.length === 0) {
    return tasksByStatus(tasks);
  }

  const poolTaskIds = new Set(
    snapshot.items
      .map((item) => item.taskId)
      .filter((taskId): taskId is string => typeof taskId === "string" && taskId.length > 0),
  );
  const poolStateByTaskId = new Map(
    snapshot.items
      .filter((item) => item.taskId)
      .map((item) => [item.taskId!, item.state] as const),
  );

  const groups = KANBAN_COLUMNS.reduce(
    (acc, column) => ({
      ...acc,
      [column.id]: [] as Task[],
    }),
    {} as Record<KanbanStatus, Task[]>,
  );

  for (const task of tasks) {
    if (poolTaskIds.has(task.id)) {
      const poolState = poolStateByTaskId.get(task.id) ?? "queued";
      groups[poolStateToColumn(poolState)].push(task);
      continue;
    }

    groups[task.status].push(task);
  }

  return groups;
};

export const countActivePoolSlots = (snapshot: AoWorkerPoolSnapshot): number =>
  snapshot.items.filter((item) => item.state === "running" || item.state === "spawning").length;

export const summarizePoolSnapshot = (snapshot: AoWorkerPoolSnapshot): string => {
  const active = countActivePoolSlots(snapshot);
  const maxLabel = snapshot.maxWorkers > 0 ? String(snapshot.maxWorkers) : "∞";
  const queued = snapshot.items.filter((item) => item.state === "queued").length;
  const blocked = snapshot.items.filter((item) => item.state === "blocked").length;

  return `${active} / ${maxLabel} slots · ${queued} queued · ${blocked} blocked`;
};

export const readPoolStateForTask = (
  taskId: string,
  snapshot?: AoWorkerPoolSnapshot,
): string | undefined => snapshot?.items.find((item) => item.taskId === taskId)?.state;
