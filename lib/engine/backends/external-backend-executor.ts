import { TaskContextService } from "@/lib/context/task-context-service";
import type { LoopBoardRepository } from "@/lib/db/loopboard-repository";
import type { BackendAdapter } from "@/lib/engine/backends/backend-adapter";
import { buildBackendExecutionContext } from "@/lib/engine/backends/backend-adapter";
import { backendResultToExecutorResult } from "@/lib/engine/backends/backend-common";
import { createAgentOrchestratorBackendAdapter } from "@/lib/engine/backends/agent-orchestrator-backend";
import {
  createClaudeCodeBackendAdapter,
  createCodexBackendAdapter,
  createCursorBackendAdapter,
} from "@/lib/engine/backends/cli-backend-adapters";
import {
  parseTaskRunJobPayload,
  type EngineJobKind,
  type ExecutorBackend,
} from "@/lib/engine/loop-engine-types";
import type { Executor, ExecutorContext, ExecutorResult } from "@/lib/engine/executor-registry";
import { executeTaskRunJob } from "@/lib/engine/task-run-executor";

export type ExternalBackendExecutorDeps = {
  repository: LoopBoardRepository;
  contextService?: TaskContextService;
};

export class ExternalBackendExecutor implements Executor {
  readonly supportedJobKinds: readonly EngineJobKind[] = [
    "task-run",
    "workflow-step",
  ] as const;

  constructor(
    private readonly adapter: BackendAdapter,
    private readonly deps: ExternalBackendExecutorDeps,
  ) {}

  get backend(): ExecutorBackend {
    return this.adapter.backend;
  }

  canHandle(backend: ExecutorBackend, jobKind: EngineJobKind): boolean {
    return (
      backend === this.adapter.backend &&
      this.supportedJobKinds.includes(jobKind)
    );
  }

  async execute(context: ExecutorContext): Promise<ExecutorResult> {
    if (context.job.kind === "task-run") {
      return executeTaskRunJob(context, {
        repository: this.deps.repository,
        contextService: this.deps.contextService,
        invokeBackend: async (executorContext, config) =>
          backendResultToExecutorResult(
            await this.adapter.execute(
              this.buildExecutionContext(executorContext, config),
            ),
          ),
      });
    }

    const result = await this.adapter.execute(
      this.buildExecutionContext(context, context.config),
    );

    return backendResultToExecutorResult(result);
  }

  async cancel(jobId: string): Promise<void> {
    await this.adapter.cancel(jobId);
  }

  private buildExecutionContext(
    context: ExecutorContext,
    config: ExecutorContext["config"],
  ) {
    const payload = parseTaskRunJobPayload(context.job.payload);
    const projectId = context.job.projectId ?? payload?.projectId;
    if (!projectId) {
      throw new Error("External backend execution requires a project id on the engine job.");
    }

    const project = this.deps.repository.getProject(projectId);

    return buildBackendExecutionContext({
      job: context.job,
      config,
      projectRepoPath: project.repoPath,
      ...(context.signal ? { signal: context.signal } : {}),
    });
  }
}

export const createExternalBackendExecutor = (
  adapter: BackendAdapter,
  deps: ExternalBackendExecutorDeps,
): ExternalBackendExecutor => new ExternalBackendExecutor(adapter, deps);

export const createExternalBackendExecutors = (
  deps: ExternalBackendExecutorDeps,
): ExternalBackendExecutor[] => {
  const contextService = deps.contextService ?? new TaskContextService();
  const adapterDeps = {
    repository: deps.repository,
    contextService,
  };

  return [
    createExternalBackendExecutor(createCursorBackendAdapter(adapterDeps), deps),
    createExternalBackendExecutor(createClaudeCodeBackendAdapter(adapterDeps), deps),
    createExternalBackendExecutor(createCodexBackendAdapter(adapterDeps), deps),
    createExternalBackendExecutor(
      createAgentOrchestratorBackendAdapter({
        repository: deps.repository,
      }),
      deps,
    ),
  ];
};
