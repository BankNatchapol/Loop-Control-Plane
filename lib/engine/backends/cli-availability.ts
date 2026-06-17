import { spawnSync } from "node:child_process";
import { homedir } from "node:os";

import type { ExecutorBackend } from "@/lib/engine/loop-engine-types";

import type { BackendAvailabilityResult } from "@/lib/engine/backends/backend-adapter";

export type CliProbe = {
  backend: ExecutorBackend;
  command: string;
  args: readonly string[];
  fallbackCommands?: readonly {
    command: string;
    args: readonly string[];
  }[];
  unavailableMessage: string;
};

const VERSION_PROBE_TIMEOUT_MS = 2_000;

export const CLI_PROBES: readonly CliProbe[] = [
  {
    backend: "cursor",
    command: "cursor-agent",
    args: ["--version"],
    fallbackCommands: [{ command: "cursor", args: ["agent", "--version"] }],
    unavailableMessage:
      "Cursor Agent CLI not found. Install Cursor Agent and ensure `cursor-agent --version` or `cursor agent --version` succeeds.",
  },
  {
    backend: "claude-code",
    command: "claude",
    args: ["--version"],
    fallbackCommands: [
      { command: "/opt/homebrew/bin/claude", args: ["--version"] },
      { command: "/usr/local/bin/claude", args: ["--version"] },
    ],
    unavailableMessage:
      "Claude Code CLI not found. Install Claude Code and ensure `claude --version` succeeds.",
  },
  {
    backend: "codex",
    command: "codex",
    args: ["--version"],
    unavailableMessage:
      "Codex CLI not found. Install Codex and ensure `codex --version` succeeds.",
  },
  {
    backend: "agent-orchestrator",
    command: "ao",
    args: ["--version"],
    unavailableMessage:
      "Agent Orchestrator CLI not found. Install with `npm install -g @aoagents/ao`.",
  },
] as const;

const summarizeProbeOutput = (stdout: string, stderr: string): string | undefined => {
  const combined = `${stdout}\n${stderr}`.trim();
  if (combined.length === 0) {
    return undefined;
  }

  const firstLine = combined.split(/\r?\n/u).find((line) => line.trim().length > 0);
  return firstLine?.trim();
};

type ProbeEnv = Record<string, string | undefined>;

// Common CLI installation paths that may be missing when the server is launched
// from an IDE or non-login shell (Homebrew, npm global, local bin, nix).
const augmentedPath = (existingPath: string | undefined): string => {
  const home = homedir();
  const extras = [
    "/opt/homebrew/bin",       // macOS Apple Silicon Homebrew
    "/usr/local/bin",          // macOS Intel Homebrew / manual installs
    `${home}/.npm-global/bin`, // npm --global-dir
    `${home}/.local/bin`,      // pip / pipx / manual installs
    `${home}/.nix-profile/bin`,
    "/nix/var/nix/profiles/default/bin",
  ];
  const parts = existingPath ? existingPath.split(":") : [];
  const augmented = [...new Set([...extras, ...parts])];
  return augmented.join(":");
};

export const probeCliAvailability = (
  probe: CliProbe,
  env: ProbeEnv = process.env,
): BackendAvailabilityResult => {
  const probeEnv = {
    ...env,
    PATH: augmentedPath(env.PATH as string | undefined),
  } as unknown as NodeJS.ProcessEnv;

  const candidates = [
    { command: probe.command, args: probe.args },
    ...(probe.fallbackCommands ?? []),
  ];

  for (const candidate of candidates) {
    const result = spawnSync(candidate.command, [...candidate.args], {
      encoding: "utf8",
      env: probeEnv,
      timeout: VERSION_PROBE_TIMEOUT_MS,
    });

    if (result.error || result.status !== 0) {
      continue;
    }

    const version = summarizeProbeOutput(result.stdout ?? "", result.stderr ?? "");

    return {
      backend: probe.backend,
      available: true,
      message: version
        ? `${candidate.command} available (${version}).`
        : `${candidate.command} available.`,
      ...(version ? { version } : {}),
    };
  }

  return {
    backend: probe.backend,
    available: false,
    message: probe.unavailableMessage,
  };
};

export const probeCliAvailabilityForBackend = (
  backend: Exclude<ExecutorBackend, "stub">,
  env: ProbeEnv = process.env,
): BackendAvailabilityResult => {
  const probe = CLI_PROBES.find((entry) => entry.backend === backend);
  if (!probe) {
    return {
      backend,
      available: false,
      message: `No CLI probe registered for backend "${backend}".`,
    };
  }

  return probeCliAvailability(probe, env);
};

export const probeAllExternalCliAvailability = (
  env: ProbeEnv = process.env,
): BackendAvailabilityResult[] => CLI_PROBES.map((probe) => probeCliAvailability(probe, env));
