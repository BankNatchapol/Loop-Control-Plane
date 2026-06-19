import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";

import { buildAoArgv } from "@/lib/ao-bridge/ao-cli-path";

export type SpawnAoResult = { status: number | null; stdout: string; stderr: string };

// Async spawn that uses SIGKILL on timeout and does NOT wait for grandchild processes.
// spawnSync with timeout only sends SIGTERM; if the child forks grandchildren that
// inherit the stdout/stderr pipes, spawnSync blocks indefinitely even after timeout.
// This version resolves on child exit (not pipe close) so grandchildren can't cause hangs.
export const spawnAoAsync = (
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeout?: number;
  },
): Promise<SpawnAoResult> => {
  const argv = buildAoArgv(args);
  const command = argv[0]!;
  const commandArgs = argv.slice(1);
  const timeout = options.timeout ?? 60_000;

  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const settle = (result: SpawnAoResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });

    // Resolve on exit — does not wait for grandchild-held pipes to close.
    child.on("exit", (code) => { settle({ status: code, stdout, stderr }); });
    child.on("error", () => { settle({ status: null, stdout, stderr }); });

    // Hard kill on timeout so grandchildren cannot keep the process alive.
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      settle({ status: null, stdout, stderr });
    }, timeout);
  });
};

export const spawnAoSync = (
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeout?: number;
    encoding?: BufferEncoding;
  },
): SpawnSyncReturns<string> => {
  const argv = buildAoArgv(args);
  const command = argv[0]!;
  const commandArgs = argv.slice(1);

  return spawnSync(command, commandArgs, {
    cwd: options.cwd,
    encoding: options.encoding ?? "utf8",
    env: options.env ?? process.env,
    timeout: options.timeout ?? 60_000,
  }) as SpawnSyncReturns<string>;
};
