import { TaskContextService } from "@/lib/context/task-context-service";
import type { LoopBoardRepository } from "@/lib/db/loopboard-repository";
import type {
  BackendAdapter,
  BackendExecutionContext,
  BackendExecutionResult,
} from "@/lib/engine/backends/backend-adapter";
import {
  backendLogEntry,
  backendUnavailableResult,
  cancelTrackedBackendJob,
  processRunToBackendResult,
  releaseBackendJob,
  runBackendProcessProfile,
  trackBackendJob,
  truncatePromptForCli,
} from "@/lib/engine/backends/backend-common";
import {
  resolveBackendPromptForJob,
  resolveTaskContextInputForJob,
} from "@/lib/engine/backends/backend-prompt";
import { probeCliAvailabilityForBackend } from "@/lib/engine/backends/cli-availability";
import type { ProcessRunner } from "@/lib/engine/process-runner";

export type CliBackendAdapterOptions = {
  contextService?: TaskContextService;
  repository?: LoopBoardRepository;
  processRunner?: ProcessRunner;
  availabilityCheck?: () => Promise<import("@/lib/engine/backends/backend-adapter").BackendAvailabilityResult>;
};

export type CliBackendDefinition = {
  backend: "cursor" | "claude-code" | "codex";
  profile: "cursor" | "claude" | "codex";
  buildArgs: (input: { prompt: string; model?: string }) => string[];
  resolvePrompt?: (
    context: BackendExecutionContext,
    deps: CliBackendAdapterOptions,
  ) => Promise<string> | string;
};

export const createCliBackendAdapter = (
  definition: CliBackendDefinition,
  deps: CliBackendAdapterOptions = {},
): BackendAdapter => {
  const contextService = deps.contextService ?? new TaskContextService();

  const checkAvailability = async () => {
    if (deps.availabilityCheck) {
      return deps.availabilityCheck();
    }

    return probeCliAvailabilityForBackend(definition.backend);
  };

  return {
    backend: definition.backend,

    async checkAvailability() {
      return checkAvailability();
    },

    async execute(context: BackendExecutionContext): Promise<BackendExecutionResult> {
      const availability = await checkAvailability();
      if (!availability.available) {
        return backendUnavailableResult(definition.backend, availability.message);
      }

      trackBackendJob(context.job.id);

      const logs = [
        backendLogEntry("info", `${definition.backend} backend execution started.`, {
          jobId: context.job.id,
        }),
      ];

      try {
        let prompt: string;

        if (definition.resolvePrompt) {
          prompt = await definition.resolvePrompt(context, deps);
        } else {
          const resolved = resolveBackendPromptForJob({
            context,
            contextService,
            ...(deps.repository ? { repository: deps.repository } : {}),
          });
          prompt = resolved.prompt;
        }

        const truncated = truncatePromptForCli(prompt);
        if (truncated.truncated) {
          logs.push(
            backendLogEntry("warn", "Prompt truncated before CLI invocation.", {
              originalLength: prompt.length,
            }),
          );
        }

        const args = definition.buildArgs({
          prompt: truncated.prompt,
          ...(context.config.model ? { model: context.config.model } : {}),
        });

        const { run, logs: runLogs } = await runBackendProcessProfile({
          profile: definition.profile,
          args,
          context,
          ...(deps.processRunner ? { processRunner: deps.processRunner } : {}),
        });

        return processRunToBackendResult(run, [...logs, ...runLogs]);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Backend execution failed unexpectedly.";

        return {
          success: false,
          error: message,
          errorCode: "backend_adapter_failed",
          logs: [...logs, backendLogEntry("error", message)],
        };
      } finally {
        releaseBackendJob(context.job.id);
      }
    },

    async cancel(jobId: string): Promise<void> {
      await cancelTrackedBackendJob(jobId);
    },
  };
};

export const createClaudeCodeBackendAdapter = (
  deps: CliBackendAdapterOptions = {},
): BackendAdapter => {
  const contextService = deps.contextService ?? new TaskContextService();

  return createCliBackendAdapter(
    {
      backend: "claude-code",
      profile: "claude",
      buildArgs: ({ prompt, model }) => [
        "--print",
        ...(model ? ["--model", model] : []),
        prompt,
      ],
      resolvePrompt: (context, adapterDeps) => {
        if (adapterDeps.repository) {
          const input = resolveTaskContextInputForJob(context.job, adapterDeps.repository);
          if (input) {
            return contextService.generateClaudeCodePrompt(input).prompt;
          }
        }

        return resolveBackendPromptForJob({
          context,
          contextService,
          ...(adapterDeps.repository ? { repository: adapterDeps.repository } : {}),
        }).prompt;
      },
    },
    { ...deps, contextService },
  );
};

export const createCursorBackendAdapter = (
  deps: CliBackendAdapterOptions = {},
): BackendAdapter =>
  createCliBackendAdapter(
    {
      backend: "cursor",
      profile: "cursor",
      buildArgs: ({ prompt, model }) => [
        "--print",
        "--force",
        ...(model ? ["--model", model] : []),
        prompt,
      ],
    },
    deps,
  );

export const createCodexBackendAdapter = (
  deps: CliBackendAdapterOptions = {},
): BackendAdapter =>
  createCliBackendAdapter(
    {
      backend: "codex",
      profile: "codex",
      buildArgs: ({ prompt, model }) => [
        "exec",
        ...(model ? ["--model", model] : []),
        prompt,
      ],
    },
    deps,
  );

export const cursorBackendAdapter = createCursorBackendAdapter();
export const claudeCodeBackendAdapter = createClaudeCodeBackendAdapter();
export const codexBackendAdapter = createCodexBackendAdapter();
