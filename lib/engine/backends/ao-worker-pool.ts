import type { EngineRunLogEntry } from "@/lib/engine/loop-engine-types";
import {
  type AoPoolItemState,
  type AoSessionRecord,
  type AoWorkerPoolSnapshot,
  isAoPoolItemActive,
  isAoPoolItemTerminal,
} from "@/lib/engine/ao-worker-pool-types";
import {
  findSessionForRecord,
  mapAoSessionStatus,
  type AoSessionJson,
} from "@/lib/engine/backends/ao-session-status";

type PoolItem = {
  issueNumber: number;
  taskId?: string;
  sourceId?: string;
  state: AoPoolItemState;
  sessionId?: string;
  prUrl?: string;
  blockers?: string[];
  skipReason?: string;
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });

const poolItemToSnapshotItem = (item: PoolItem) => ({
  issueNumber: item.issueNumber,
  state: item.state,
  ...(item.taskId ? { taskId: item.taskId } : {}),
  ...(item.sourceId ? { sourceId: item.sourceId } : {}),
  ...(item.sessionId ? { sessionId: item.sessionId } : {}),
  ...(item.prUrl ? { prUrl: item.prUrl } : {}),
  ...(item.blockers?.length ? { blockers: item.blockers } : {}),
  ...(item.skipReason ? { skipReason: item.skipReason } : {}),
});

const buildSnapshot = (input: {
  items: Map<number, PoolItem>;
  maxWorkers: number;
  workflowRunId?: string;
  featureId?: string;
}): AoWorkerPoolSnapshot => ({
  maxWorkers: input.maxWorkers,
  updatedAt: new Date().toISOString(),
  ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
  ...(input.featureId ? { featureId: input.featureId } : {}),
  items: [...input.items.values()].map(poolItemToSnapshotItem),
});

const updateItemFromSession = (item: PoolItem, session: AoSessionJson | undefined): void => {
  if (!session) {
    return;
  }

  item.sessionId = session.id ?? item.sessionId;
  item.prUrl = session.pr?.url ?? item.prUrl ?? undefined;
  const mapped = mapAoSessionStatus(session.status);

  if (mapped === "completed") {
    item.state = "completed";
    return;
  }

  if (mapped === "failed" || mapped === "cancelled") {
    item.state = "failed";
    return;
  }

  if (item.state === "spawning") {
    item.state = "running";
  }
};

const sessionLooksActive = (
  sessions: AoSessionJson[],
  issueNumber: number,
): AoSessionJson | undefined => {
  const issueToken = String(issueNumber);
  return sessions.find((session) => {
    if (session.issueId === null || session.issueId === undefined) {
      return false;
    }

    if (String(session.issueId) !== issueToken) {
      return false;
    }

    return mapAoSessionStatus(session.status) === "running";
  });
};

export type RunAoWorkerPoolInput = {
  issueNumbers: number[];
  maxConcurrentWorkers: number;
  spawnOne: (issueNumber: number) => Promise<{ sessionId?: string; error?: string }>;
  pollSessions: () => Promise<AoSessionJson[]>;
  timeoutMs: number;
  pollIntervalMs: number;
  sleep?: (ms: number) => Promise<void>;
  isEligible?: (issueNumber: number, items: ReadonlyMap<number, PoolItem>) => boolean;
  getSkipReason?: (issueNumber: number, items: ReadonlyMap<number, PoolItem>) => string | undefined;
  resolveTaskMeta?: (
    issueNumber: number,
  ) => { taskId?: string; sourceId?: string; blockers?: string[] } | undefined;
  onSnapshot?: (snapshot: AoWorkerPoolSnapshot) => void;
  onSessionObserved?: (input: {
    issueNumber: number;
    sessionId?: string;
    prUrl?: string;
    session: AoSessionJson;
  }) => Promise<"approved" | "continue" | "hold" | "fail">;
  workflowRunId?: string;
  featureId?: string;
  initialItems?: AoWorkerPoolSnapshot["items"];
};

export type RunAoWorkerPoolResult = {
  records: AoSessionRecord[];
  logs: EngineRunLogEntry[];
  timedOut: boolean;
  spawnFailures: string[];
  snapshot: AoWorkerPoolSnapshot;
};

export const runAoWorkerPool = async (
  input: RunAoWorkerPoolInput,
): Promise<RunAoWorkerPoolResult> => {
  const sleep = input.sleep ?? defaultSleep;
  const logs: EngineRunLogEntry[] = [];
  const spawnFailures: string[] = [];
  const deadline = Date.now() + input.timeoutMs;
  const unlimited =
    !Number.isFinite(input.maxConcurrentWorkers) || input.maxConcurrentWorkers <= 0;
  const maxWorkers = unlimited ? Number.POSITIVE_INFINITY : input.maxConcurrentWorkers;

  const items = new Map<number, PoolItem>();
  const initialByIssue = new Map(
    (input.initialItems ?? []).map((item) => [item.issueNumber, item] as const),
  );
  for (const issueNumber of input.issueNumbers) {
    const meta = input.resolveTaskMeta?.(issueNumber);
    const initial = initialByIssue.get(issueNumber);
    items.set(issueNumber, {
      issueNumber,
      state: initial?.state ?? "queued",
      ...(meta?.taskId ? { taskId: meta.taskId } : {}),
      ...(meta?.sourceId ? { sourceId: meta.sourceId } : {}),
      ...(meta?.blockers?.length ? { blockers: meta.blockers } : {}),
      ...(initial?.sessionId ? { sessionId: initial.sessionId } : {}),
      ...(initial?.prUrl ? { prUrl: initial.prUrl } : {}),
      ...(initial?.skipReason ? { skipReason: initial.skipReason } : {}),
    });
  }

  const emitSnapshot = () => {
    const snapshot = buildSnapshot({
      items,
      maxWorkers: unlimited ? 0 : input.maxConcurrentWorkers,
      ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
      ...(input.featureId ? { featureId: input.featureId } : {}),
    });
    input.onSnapshot?.(snapshot);
    return snapshot;
  };

  let snapshot = emitSnapshot();

  while (Date.now() < deadline) {
    const sessions = await input.pollSessions();

    for (const item of items.values()) {
      if (isAoPoolItemTerminal(item.state)) {
        continue;
      }

      const record: AoSessionRecord = {
        issueNumber: item.issueNumber,
        ...(item.sessionId ? { sessionId: item.sessionId } : {}),
      };
      const session = findSessionForRecord(sessions, record);
      if (session) {
        item.sessionId = session.id ?? item.sessionId;
        item.prUrl = session.pr?.url ?? item.prUrl ?? undefined;
        const gate = await input.onSessionObserved?.({
          issueNumber: item.issueNumber,
          ...(item.sessionId ? { sessionId: item.sessionId } : {}),
          ...(item.prUrl ? { prUrl: item.prUrl } : {}),
          session,
        });
        if (gate === "approved") {
          item.state = "completed";
          continue;
        }
        if (gate === "fail") {
          item.state = "failed";
          item.skipReason = "AO task PR review loop failed.";
          continue;
        }
        if (gate === "hold") {
          item.state = "running";
          continue;
        }
      }
      updateItemFromSession(item, session);
    }

    for (const issueNumber of input.issueNumbers) {
      const item = items.get(issueNumber);
      if (!item || isAoPoolItemTerminal(item.state)) {
        continue;
      }

      const skipReason = input.getSkipReason?.(issueNumber, items);
      if (skipReason) {
        item.state = "skipped";
        item.skipReason = skipReason;
        continue;
      }

      const eligible = input.isEligible ? input.isEligible(issueNumber, items) : true;
      if (!eligible) {
        if (!isAoPoolItemActive(item.state)) {
          item.state = "blocked";
        }
        continue;
      }

      if (isAoPoolItemActive(item.state)) {
        continue;
      }

      const activeCount = [...items.values()].filter((entry) => isAoPoolItemActive(entry.state))
        .length;

      if (!unlimited && activeCount >= maxWorkers) {
        if (!isAoPoolItemActive(item.state)) {
          item.state = "queued";
        }
        continue;
      }

      item.state = "spawning";
      snapshot = emitSnapshot();

      const spawnResult = await input.spawnOne(issueNumber);
      if (spawnResult.sessionId) {
        item.sessionId = spawnResult.sessionId;
        item.state = "running";
        logs.push({
          timestamp: new Date().toISOString(),
          level: "info",
          message: "Spawned AO worker session.",
          metadata: { issueNumber, sessionId: spawnResult.sessionId },
        });
        continue;
      }

      const existing = sessionLooksActive(sessions, issueNumber);
      if (existing?.id) {
        item.sessionId = existing.id;
        item.state = "running";
        logs.push({
          timestamp: new Date().toISOString(),
          level: "info",
          message: "Reused active AO session for issue.",
          metadata: { issueNumber, sessionId: existing.id },
        });
        continue;
      }

      const message = spawnResult.error ?? "spawn failed";
      spawnFailures.push(`Issue #${issueNumber}: ${message}`);
      item.state = "failed";
      item.skipReason = message;
      logs.push({
        timestamp: new Date().toISOString(),
        level: "error",
        message: `AO worker spawn failed: ${message.split("\n").pop()?.trim() ?? message}`,
        metadata: { issueNumber, error: message },
      });
    }

    snapshot = emitSnapshot();

    const allTerminal = [...items.values()].every((item) => isAoPoolItemTerminal(item.state));
    if (allTerminal) {
      break;
    }

    await sleep(input.pollIntervalMs);
  }

  const timedOut = [...items.values()].some((item) => !isAoPoolItemTerminal(item.state));
  snapshot = emitSnapshot();

  const records: AoSessionRecord[] = [...items.values()].map((item) => ({
    issueNumber: item.issueNumber,
    ...(item.sessionId ? { sessionId: item.sessionId } : {}),
    ...(item.prUrl ? { prUrl: item.prUrl } : {}),
    status:
      item.state === "completed"
        ? "done"
        : item.state === "failed"
          ? "failed"
          : item.state === "skipped"
            ? "skipped"
            : item.state,
  }));

  if (timedOut) {
    logs.push({
      timestamp: new Date().toISOString(),
      level: "warn",
      message: "AO worker pool exceeded timeout before all issues finished.",
      metadata: { timeoutMs: input.timeoutMs },
    });
  }

  return {
    records,
    logs,
    timedOut,
    spawnFailures,
    snapshot,
  };
};
