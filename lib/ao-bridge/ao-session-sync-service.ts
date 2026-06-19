import type { LoopBoardRepository } from "@/lib/db/loopboard-repository";
import { syncProjectAoRuntime } from "@/lib/ao-bridge/ao-task-linker";

export type AoSessionSyncResult = {
  projects: number;
  updatedTasks: number;
  sessions: number;
};

export const syncAoRuntimeForRepository = async (
  repository: LoopBoardRepository,
  projectId?: string,
): Promise<AoSessionSyncResult> => {
  const projects = projectId
    ? [repository.getProject(projectId)]
    : repository.listBoardData().projects;

  let updatedTasks = 0;
  let sessions = 0;

  for (const project of projects) {
    if (!project.engineSettings.agentOrchestrator?.enabled) {
      continue;
    }

    const result = await syncProjectAoRuntime(
      repository,
      project.id,
      project.engineSettings.agentOrchestrator.projectId,
    );
    updatedTasks += result.updated;
    sessions += result.sessions;
  }

  return {
    projects: projects.length,
    updatedTasks,
    sessions,
  };
};
