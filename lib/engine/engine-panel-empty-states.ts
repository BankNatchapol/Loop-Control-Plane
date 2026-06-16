import type { BackendAvailabilityChip } from "@/lib/engine/backend-availability-service";
import type { EngineJobMetrics } from "@/lib/api/engine-actions";

export type EnginePanelEmptyStateKind =
  | "engine-never-run"
  | "no-jobs-queued"
  | "backends-unavailable"
  | "ao-not-configured";

export type EnginePanelEmptyState = {
  kind: EnginePanelEmptyStateKind;
  title: string;
  message: string;
  tone: "info" | "warning";
};

const CLI_BACKENDS = new Set([
  "cursor",
  "claude-code",
  "codex",
  "agent-orchestrator",
]);

export const deriveEnginePanelEmptyStates = (input: {
  tickCount: number;
  lastTickAt?: string | null;
  queuedCount: number;
  runningCount: number;
  backends?: BackendAvailabilityChip[];
}): EnginePanelEmptyState[] => {
  const states: EnginePanelEmptyState[] = [];
  const engineNeverRun = input.tickCount === 0 && !input.lastTickAt;
  const queueIdle = input.queuedCount === 0 && input.runningCount === 0;

  if (engineNeverRun) {
    states.push({
      kind: "engine-never-run",
      title: "Engine not started yet",
      message:
        "The scheduler has never ticked on this instance. Use Run Demo Job and Tick Once to verify the stub executor, or enable global auto-run and Start Scheduler for background processing.",
      tone: "info",
    });
  } else if (queueIdle) {
    states.push({
      kind: "no-jobs-queued",
      title: "Queue is idle",
      message:
        "No jobs are queued or running. Enqueue a demo job, run a workflow step, or pick up a Ready task to add work.",
      tone: "info",
    });
  }

  const cliBackends = (input.backends ?? []).filter((chip) =>
    CLI_BACKENDS.has(chip.backend),
  );
  const realCliBackends = cliBackends.filter((chip) => chip.backend !== "stub");

  if (
    realCliBackends.length > 0 &&
    realCliBackends.every((chip) => !chip.available)
  ) {
    states.push({
      kind: "backends-unavailable",
      title: "Execution backends unavailable",
      message:
        "Cursor, Claude Code, Codex, and Agent Orchestrator CLIs are not ready. Install a CLI or use the stub backend with Run Demo Job until backends are configured.",
      tone: "warning",
    });
  }

  const aoChip = cliBackends.find((chip) => chip.backend === "agent-orchestrator");
  if (aoChip && !aoChip.available) {
    const normalized = aoChip.message.toLowerCase();
    const aoConfigIssue =
      normalized.includes("disabled in project settings") ||
      normalized.includes("config path") ||
      normalized.includes("config missing") ||
      normalized.includes("requires a project context");

    if (aoConfigIssue) {
      states.push({
        kind: "ao-not-configured",
        title: "Agent Orchestrator not configured",
        message:
          "Enable Agent Orchestrator in project engine settings and set a valid config path inside the repository before enqueueing AO-backed jobs.",
        tone: "warning",
      });
    }
  }

  return states;
};

export const describeEngineMetricsEmptyHint = (
  metrics?: EngineJobMetrics | null,
): string | undefined => {
  if (!metrics) {
    return "No engine activity recorded in the last 24 hours.";
  }

  const finished = metrics.completed + metrics.failed;
  const active = metrics.queued + metrics.running;

  if (finished === 0 && active === 0) {
    return "No engine activity recorded in the last 24 hours.";
  }

  return undefined;
};

export const describeQueueDepthHint = (input: {
  tickCount: number;
  lastTickAt?: string | null;
  queuedCount: number;
  runningCount: number;
}): string => {
  const queueIdle = input.queuedCount === 0 && input.runningCount === 0;

  if (input.tickCount === 0 && !input.lastTickAt) {
    return "Scheduler idle · no ticks yet";
  }

  if (queueIdle) {
    return "No jobs waiting · queue idle";
  }

  return `${input.queuedCount} queued · ${input.runningCount} running`;
};
