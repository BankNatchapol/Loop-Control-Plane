export type AoPoolItemState =
  | "queued"
  | "blocked"
  | "spawning"
  | "running"
  | "completed"
  | "failed"
  | "skipped";

export type AoWorkerPoolItem = {
  issueNumber: number;
  taskId?: string;
  sourceId?: string;
  state: AoPoolItemState;
  sessionId?: string;
  prUrl?: string;
  blockers?: string[];
  skipReason?: string;
};

export type AoWorkerPoolSnapshot = {
  maxWorkers: number;
  workflowRunId?: string;
  featureId?: string;
  updatedAt: string;
  items: AoWorkerPoolItem[];
};

export type AoSessionRecord = {
  issueNumber: number;
  sessionId?: string;
  status?: string;
  prUrl?: string;
};

export const isAoPoolItemTerminal = (state: AoPoolItemState): boolean =>
  state === "completed" || state === "failed" || state === "skipped";

export const isAoPoolItemActive = (state: AoPoolItemState): boolean =>
  state === "spawning" || state === "running";

export const readAoWorkerPoolSnapshot = (
  result: Record<string, unknown> | undefined,
): AoWorkerPoolSnapshot | undefined => {
  if (!result || typeof result.aoWorkerPool !== "object" || result.aoWorkerPool === null) {
    return undefined;
  }

  const raw = result.aoWorkerPool as Record<string, unknown>;
  if (!Array.isArray(raw.items)) {
    return undefined;
  }

  const items: AoWorkerPoolItem[] = [];
  for (const entry of raw.items) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const item = entry as Record<string, unknown>;
    if (typeof item.issueNumber !== "number" || !Number.isInteger(item.issueNumber)) {
      continue;
    }

    const state = item.state;
    if (
      state !== "queued" &&
      state !== "blocked" &&
      state !== "spawning" &&
      state !== "running" &&
      state !== "completed" &&
      state !== "failed" &&
      state !== "skipped"
    ) {
      continue;
    }

    items.push({
      issueNumber: item.issueNumber,
      state,
      ...(typeof item.taskId === "string" ? { taskId: item.taskId } : {}),
      ...(typeof item.sourceId === "string" ? { sourceId: item.sourceId } : {}),
      ...(typeof item.sessionId === "string" ? { sessionId: item.sessionId } : {}),
      ...(typeof item.prUrl === "string" ? { prUrl: item.prUrl } : {}),
      ...(Array.isArray(item.blockers)
        ? { blockers: item.blockers.filter((value): value is string => typeof value === "string") }
        : {}),
      ...(typeof item.skipReason === "string" ? { skipReason: item.skipReason } : {}),
    });
  }

  return {
    maxWorkers: typeof raw.maxWorkers === "number" ? raw.maxWorkers : 0,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
    ...(typeof raw.workflowRunId === "string" ? { workflowRunId: raw.workflowRunId } : {}),
    ...(typeof raw.featureId === "string" ? { featureId: raw.featureId } : {}),
    items,
  };
};
