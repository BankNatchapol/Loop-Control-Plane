import type { LoopBoardRepository } from "@/lib/db/loopboard-repository";
import type { BackendAdapter } from "@/lib/engine/backends/backend-adapter";
import { createAgentOrchestratorBackendAdapter } from "@/lib/engine/backends/agent-orchestrator-backend";
import {
  createClaudeCodeBackendAdapter,
  createCodexBackendAdapter,
  createCursorBackendAdapter,
} from "@/lib/engine/backends/cli-backend-adapters";
import { TaskContextService } from "@/lib/context/task-context-service";
import type { ExecutorBackend } from "@/lib/engine/loop-engine-types";

export type BackendAdapterRegistry = ReadonlyMap<ExecutorBackend, BackendAdapter>;

export const createBackendAdapterRegistry = (
  repository: LoopBoardRepository,
  contextService: TaskContextService = new TaskContextService(),
): BackendAdapterRegistry => {
  const adapterDeps = {
    repository,
    contextService,
  };

  const adapters: BackendAdapter[] = [
    createCursorBackendAdapter(adapterDeps),
    createClaudeCodeBackendAdapter(adapterDeps),
    createCodexBackendAdapter(adapterDeps),
    createAgentOrchestratorBackendAdapter({ repository }),
  ];

  return new Map(adapters.map((adapter) => [adapter.backend, adapter]));
};

export const getBackendAdapter = (
  registry: BackendAdapterRegistry,
  backend: ExecutorBackend,
): BackendAdapter | undefined => registry.get(backend);
