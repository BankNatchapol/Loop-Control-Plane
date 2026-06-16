import { describeAgentOrchestratorAvailability } from "@/lib/engine/backends/agent-orchestrator-config";
import { probeCliAvailabilityForBackend } from "@/lib/engine/backends/cli-availability";
import {
  EXECUTOR_BACKENDS,
  type ExecutorBackend,
} from "@/lib/engine/loop-engine-types";
import type { Project } from "@/lib/loopboard";

export const BACKEND_AVAILABILITY_CACHE_TTL_MS = 60_000;

export type BackendAvailabilityChip = {
  backend: ExecutorBackend;
  label: string;
  available: boolean;
  message: string;
  version?: string;
};

export type BackendAvailabilityReport = {
  checkedAt: string;
  cacheTtlMs: number;
  backends: BackendAvailabilityChip[];
};

type CachedReport = {
  expiresAt: number;
  report: BackendAvailabilityReport;
};

const availabilityCache = new Map<string, CachedReport>();

export const resetBackendAvailabilityCache = (): void => {
  availabilityCache.clear();
};

export const formatBackendAvailabilityChipLabel = (
  backend: ExecutorBackend,
  available: boolean,
  message: string,
): string => {
  if (backend === "stub") {
    return available ? "stub: available" : "stub: unavailable";
  }

  if (available) {
    return `${backend}: installed`;
  }

  const normalized = message.toLowerCase();
  if (normalized.includes("not found") || normalized.includes("cli not found")) {
    return `${backend}: not installed`;
  }
  if (normalized.includes("disabled in project settings")) {
    return `${backend}: disabled`;
  }
  if (
    normalized.includes("config path does not exist") ||
    normalized.includes("config missing")
  ) {
    return `${backend}: config missing`;
  }
  if (normalized.includes("config path")) {
    return `${backend}: config invalid`;
  }

  return `${backend}: unavailable`;
};

const resolveBackendAvailability = (
  backend: ExecutorBackend,
  project?: Project,
): BackendAvailabilityChip => {
  if (backend === "stub") {
    return {
      backend,
      label: formatBackendAvailabilityChipLabel(backend, true, ""),
      available: true,
      message: "Stub executor is always available for demo and CI runs.",
    };
  }

  if (backend === "agent-orchestrator") {
    const cli = probeCliAvailabilityForBackend(backend);
    const availability = describeAgentOrchestratorAvailability({
      cliAvailable: cli.available,
      cliMessage: cli.message,
      ...(project ? { project } : {}),
    });

    return {
      backend,
      label: formatBackendAvailabilityChipLabel(
        backend,
        availability.available,
        availability.message,
      ),
      available: availability.available,
      message: availability.message,
      ...(cli.version ? { version: cli.version } : {}),
    };
  }

  const probe = probeCliAvailabilityForBackend(backend);

  return {
    backend,
    label: formatBackendAvailabilityChipLabel(
      backend,
      probe.available,
      probe.message,
    ),
    available: probe.available,
    message: probe.message,
    ...(probe.version ? { version: probe.version } : {}),
  };
};

export const buildBackendAvailabilityReport = (
  project?: Project,
): BackendAvailabilityReport => ({
  checkedAt: new Date().toISOString(),
  cacheTtlMs: BACKEND_AVAILABILITY_CACHE_TTL_MS,
  backends: EXECUTOR_BACKENDS.map((backend) =>
    resolveBackendAvailability(backend, project),
  ),
});

export const getBackendAvailabilityReport = (
  project?: Project,
  now = Date.now(),
): BackendAvailabilityReport => {
  const cacheKey = project?.id ?? "__global__";
  const cached = availabilityCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.report;
  }

  const report = buildBackendAvailabilityReport(project);
  availabilityCache.set(cacheKey, {
    expiresAt: now + BACKEND_AVAILABILITY_CACHE_TTL_MS,
    report,
  });

  return report;
};
