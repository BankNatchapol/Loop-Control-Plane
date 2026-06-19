import type { PersistedTask } from "@/lib/db/loopboard-repository";
import type { AoPoolItemState } from "@/lib/engine/ao-worker-pool-types";

export type ImplementQueueItem = {
  issueNumber: number;
  taskId: string;
  sourceId?: string;
  blockers: string[];
};

const normalizeKey = (value: string): string => value.trim().toLowerCase();

export const readTaskSourceId = (task: PersistedTask): string | undefined => {
  const sourceId = task.events.find((event) => event.type === "TASK_IMPORTED")?.metadata
    ?.sourceId;

  return typeof sourceId === "string" && sourceId.trim() ? sourceId.trim() : undefined;
};

const resolveDependencySourceIds = (
  task: PersistedTask,
  sourceIdByTaskId: Map<string, string>,
  titleBySourceId: Map<string, string>,
): string[] => {
  const resolved: string[] = [];

  for (const dependency of task.dependencies) {
    const trimmed = dependency.trim();
    if (!trimmed) {
      continue;
    }

    const normalized = normalizeKey(trimmed);
    if ([...sourceIdByTaskId.values()].some((sourceId) => normalizeKey(sourceId) === normalized)) {
      const match = [...sourceIdByTaskId.entries()].find(
        ([, sourceId]) => normalizeKey(sourceId) === normalized,
      );
      if (match?.[1]) {
        resolved.push(match[1]);
      }
      continue;
    }

    if (titleBySourceId.has(normalized)) {
      resolved.push(titleBySourceId.get(normalized)!);
      continue;
    }

    const titleMatch = [...titleBySourceId.entries()].find(
      ([title]) => title === normalized,
    );
    if (titleMatch?.[1]) {
      resolved.push(titleMatch[1]);
    }
  }

  return [...new Set(resolved)];
};

const topologicalSort = (
  items: ImplementQueueItem[],
  warnings: string[],
): ImplementQueueItem[] => {
  const bySourceId = new Map(
    items
      .filter((item) => item.sourceId)
      .map((item) => [normalizeKey(item.sourceId!), item] as const),
  );
  const indegree = new Map<number, number>();
  for (const item of items) {
    indegree.set(item.issueNumber, 0);
  }
  const dependents = new Map<number, number[]>();

  for (const item of items) {
    for (const blocker of item.blockers) {
      const blockerItem = bySourceId.get(normalizeKey(blocker));
      if (!blockerItem) {
        warnings.push(
          `Issue #${item.issueNumber}: unresolved dependency "${blocker}" — treating as no blocker.`,
        );
        continue;
      }

      indegree.set(item.issueNumber, (indegree.get(item.issueNumber) ?? 0) + 1);
      const next = dependents.get(blockerItem.issueNumber) ?? [];
      next.push(item.issueNumber);
      dependents.set(blockerItem.issueNumber, next);
    }
  }

  const queue = items
    .filter((item) => (indegree.get(item.issueNumber) ?? 0) === 0)
    .map((item) => item.issueNumber);
  const ordered: ImplementQueueItem[] = [];
  const itemByIssue = new Map(items.map((item) => [item.issueNumber, item] as const));

  while (queue.length > 0) {
    const issueNumber = queue.shift()!;
    const item = itemByIssue.get(issueNumber);
    if (item) {
      ordered.push(item);
    }

    for (const dependentIssue of dependents.get(issueNumber) ?? []) {
      const nextDegree = (indegree.get(dependentIssue) ?? 1) - 1;
      indegree.set(dependentIssue, nextDegree);
      if (nextDegree === 0) {
        queue.push(dependentIssue);
      }
    }
  }

  if (ordered.length !== items.length) {
    warnings.push("Dependency cycle detected — falling back to issue-number order for remaining tasks.");
    for (const item of items) {
      if (!ordered.some((entry) => entry.issueNumber === item.issueNumber)) {
        ordered.push(item);
      }
    }
  }

  return ordered;
};

export type AoImplementQueue = {
  orderedItems: ImplementQueueItem[];
  issueNumbers: number[];
  warnings: string[];
  isEligible: (
    issueNumber: number,
    items: ReadonlyMap<number, { state: AoPoolItemState }>,
  ) => boolean;
  getSkipReason: (
    issueNumber: number,
    items: ReadonlyMap<number, { state: AoPoolItemState }>,
  ) => string | undefined;
  resolveTaskMeta: (
    issueNumber: number,
  ) => { taskId?: string; sourceId?: string; blockers?: string[] } | undefined;
};

export const buildAoImplementQueue = (tasks: PersistedTask[]): AoImplementQueue => {
  const warnings: string[] = [];
  const featureTasks = tasks.filter((task) => task.github.issueNumber);
  const sourceIdByTaskId = new Map<string, string>();
  const titleBySourceId = new Map<string, string>();

  for (const task of featureTasks) {
    const sourceId = readTaskSourceId(task);
    if (sourceId) {
      sourceIdByTaskId.set(task.id, sourceId);
      titleBySourceId.set(normalizeKey(task.title), sourceId);
    }
  }

  const rawItems: ImplementQueueItem[] = featureTasks.map((task) => ({
    issueNumber: task.github.issueNumber!,
    taskId: task.id,
    ...(readTaskSourceId(task) ? { sourceId: readTaskSourceId(task) } : {}),
    blockers: resolveDependencySourceIds(task, sourceIdByTaskId, titleBySourceId),
  }));

  const orderedItems = topologicalSort(rawItems, warnings);
  const issueNumbers = orderedItems.map((item) => item.issueNumber);
  const itemByIssue = new Map(orderedItems.map((item) => [item.issueNumber, item] as const));
  const blockersByIssue = new Map(
    orderedItems.map((item) => [item.issueNumber, item.blockers] as const),
  );

  const stateForSourceId = (
    sourceId: string,
    items: ReadonlyMap<number, { state: AoPoolItemState }>,
  ): AoPoolItemState | undefined => {
    const blockerItem = orderedItems.find(
      (entry) => entry.sourceId && normalizeKey(entry.sourceId) === normalizeKey(sourceId),
    );
    if (!blockerItem) {
      return undefined;
    }

    return items.get(blockerItem.issueNumber)?.state;
  };

  const isEligible = (
    issueNumber: number,
    items: ReadonlyMap<number, { state: AoPoolItemState }>,
  ): boolean => {
    const blockers = blockersByIssue.get(issueNumber) ?? [];
    return blockers.every((blocker) => stateForSourceId(blocker, items) === "completed");
  };

  const getSkipReason = (
    issueNumber: number,
    items: ReadonlyMap<number, { state: AoPoolItemState }>,
  ): string | undefined => {
    const blockers = blockersByIssue.get(issueNumber) ?? [];
    for (const blocker of blockers) {
      const state = stateForSourceId(blocker, items);
      if (state === "failed" || state === "skipped") {
        return `Blocked by failed dependency ${blocker}.`;
      }
    }

    return undefined;
  };

  const resolveTaskMeta = (issueNumber: number) => {
    const item = itemByIssue.get(issueNumber);
    if (!item) {
      return undefined;
    }

    return {
      taskId: item.taskId,
      ...(item.sourceId ? { sourceId: item.sourceId } : {}),
      ...(item.blockers.length ? { blockers: item.blockers } : {}),
    };
  };

  return {
    orderedItems,
    issueNumbers,
    warnings,
    isEligible,
    getSkipReason,
    resolveTaskMeta,
  };
};
