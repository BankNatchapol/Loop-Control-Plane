import type { LoopBoardRepository, PersistedTask } from "@/lib/db/loopboard-repository";
import type { AoRuntimeState, Task } from "@/lib/loopboard";
import { fetchAoSessions } from "@/lib/ao-bridge/ao-client";
import { normalizeAoSession, readIssueNumber } from "@/lib/ao-bridge/ao-session-mapper";
import type { AoDashboardSession } from "@/lib/ao-bridge/types";

export const buildIssueNumberIndex = (
  sessions: AoDashboardSession[],
): Map<number, AoDashboardSession[]> => {
  const index = new Map<number, AoDashboardSession[]>();

  for (const rawSession of sessions) {
    const session = normalizeAoSession(rawSession);
    const issueNumber = readIssueNumber(session);
    if (!issueNumber) {
      continue;
    }

    const existing = index.get(issueNumber) ?? [];
    existing.push(session);
    index.set(issueNumber, existing);
  }

  return index;
};

export const pickPreferredSession = (
  sessions: AoDashboardSession[],
  preferredSessionId?: string,
): AoDashboardSession | undefined => {
  if (sessions.length === 0) {
    return undefined;
  }

  if (preferredSessionId) {
    const matched = sessions.find((session) => session.id === preferredSessionId);
    if (matched) {
      return matched;
    }
  }

  return [...sessions].sort((left, right) => {
    const leftTime = Date.parse(left.lastActivityAt ?? left.createdAt);
    const rightTime = Date.parse(right.lastActivityAt ?? right.createdAt);
    return rightTime - leftTime;
  })[0];
};

export const sessionToAoRuntime = (session: AoDashboardSession): AoRuntimeState => ({
  sessionId: session.id,
  sessionStatus: session.status,
  attentionLevel: session.attentionLevel,
  activity: session.activity,
  prUrl: session.pr?.url ?? undefined,
  lastSyncedAt: new Date().toISOString(),
  untrusted: true,
});

export const linkTaskToAoSession = (
  task: Task,
  sessionsByIssue: Map<number, AoDashboardSession[]>,
  preferredSessionId?: string,
): AoRuntimeState | undefined => {
  const issueNumber = task.github.issueNumber;
  if (!issueNumber) {
    return undefined;
  }

  const sessions = sessionsByIssue.get(issueNumber) ?? [];
  const session = pickPreferredSession(sessions, preferredSessionId ?? task.aoRuntime?.sessionId);
  return session ? sessionToAoRuntime(session) : undefined;
};

export const linkTasksToAoSessions = (
  tasks: PersistedTask[],
  sessions: AoDashboardSession[],
): Map<string, AoRuntimeState> => {
  const sessionsByIssue = buildIssueNumberIndex(sessions);
  const linked = new Map<string, AoRuntimeState>();

  for (const task of tasks) {
    const runtime = linkTaskToAoSession(task, sessionsByIssue, task.aoRuntime?.sessionId);
    if (runtime) {
      linked.set(task.id, runtime);
    }
  }

  return linked;
};

export const syncProjectAoRuntime = async (
  repository: LoopBoardRepository,
  projectId: string,
  aoProjectId?: string,
): Promise<{ updated: number; sessions: number }> => {
  const board = repository.listBoardData(projectId);
  let sessions: AoDashboardSession[] = [];

  try {
    const response = await fetchAoSessions({
      ...(aoProjectId ? { projectId: aoProjectId } : {}),
    });
    sessions = response.sessions.map(normalizeAoSession);
  } catch {
    return { updated: 0, sessions: 0 };
  }

  const linked = linkTasksToAoSessions(board.tasks, sessions);
  let updated = 0;

  for (const task of board.tasks) {
    const runtime = linked.get(task.id);
    if (!runtime) {
      continue;
    }

    const current = JSON.stringify(task.aoRuntime ?? {});
    const next = JSON.stringify(runtime);
    if (current === next) {
      continue;
    }

    repository.updateTask(task.id, { aoRuntime: runtime });
    updated += 1;
  }

  return { updated, sessions: sessions.length };
};
