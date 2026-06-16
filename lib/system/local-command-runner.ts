import { existsSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

export type FixedLocalCommand = "code" | "open" | "explorer.exe" | "xdg-open";

export interface LocalCommandRunner {
  commandAvailable: (command: FixedLocalCommand) => boolean;
  launch: (command: FixedLocalCommand, args: string[]) => void;
}

export type SafeCommandSummary = {
  command: FixedLocalCommand;
  args: string[];
  summary: string;
};

const sensitivePatterns: Array<{ pattern: RegExp; replacement: string }> = [
  {
    pattern: /(token|secret|password|authorization|api[_-]?key)=([^,\s]+)/giu,
    replacement: "$1=[redacted]",
  },
  { pattern: /(bearer\s+)[a-z0-9._-]+/giu, replacement: "$1[redacted]" },
  { pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/gu, replacement: "[redacted-github-token]" },
  { pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/gu, replacement: "[redacted-api-key]" },
];

const allowedCommands = new Set<FixedLocalCommand>([
  "code",
  "open",
  "explorer.exe",
  "xdg-open",
]);

const safeCommandEnv: NodeJS.ProcessEnv = {
  NODE_ENV: process.env.NODE_ENV ?? "production",
  PATH: process.env.PATH ?? "",
  SystemRoot: process.env.SystemRoot,
  windir: process.env.windir,
};

export class LocalCommandError extends Error {
  constructor(
    message: string,
    readonly statusCode = 500,
    readonly code = "local_command_failed",
  ) {
    super(message);
  }
}

export const redactSensitiveCommandValue = (value: string): string =>
  sensitivePatterns.reduce(
    (current, { pattern, replacement }) => current.replace(pattern, replacement),
    value,
  );

export const defaultLocalCommandRunner: LocalCommandRunner = {
  commandAvailable(command) {
    if (!allowedCommands.has(command)) {
      return false;
    }

    const result = spawnSync(command, ["--version"], {
      encoding: "utf8",
      env: safeCommandEnv,
      timeout: 2000,
    });

    return !result.error && result.status === 0;
  },
  launch(command, args) {
    if (!allowedCommands.has(command)) {
      throw new LocalCommandError(
        `Local command "${command}" is not allowed.`,
        400,
        "command_not_allowed",
      );
    }

    const child = spawn(command, args, {
      detached: true,
      env: safeCommandEnv,
      shell: false,
      stdio: "ignore" as const,
    });

    child.on("error", () => undefined);
    child.unref();
  },
};

export const validateLocalDirectory = ({
  path,
  missingCode,
  notDirectoryCode,
  traversalCode = "path_traversal_rejected",
  basePath,
}: {
  path: string;
  missingCode: string;
  notDirectoryCode: string;
  traversalCode?: string;
  basePath?: string;
}): string => {
  if (path.includes("\0")) {
    throw new LocalCommandError("Local path contains an invalid null byte.", 400, traversalCode);
  }

  const resolvedPath = resolve(path);

  if (basePath) {
    const resolvedBasePath = resolve(basePath);
    const relativePath = relative(resolvedBasePath, resolvedPath);

    if (
      relativePath === ".." ||
      relativePath.startsWith(`..${"/"}`) ||
      relativePath.startsWith(`..${"\\"}`) ||
      resolve(resolvedBasePath, relativePath) !== resolvedPath
    ) {
      throw new LocalCommandError(
        `Local path must stay inside the project repository: ${resolvedBasePath}`,
        400,
        traversalCode,
      );
    }
  }

  if (!existsSync(resolvedPath)) {
    throw new LocalCommandError(
      `Local path does not exist: ${redactSensitiveCommandValue(resolvedPath)}`,
      400,
      missingCode,
    );
  }

  if (!statSync(resolvedPath).isDirectory()) {
    throw new LocalCommandError(
      `Local path must be a directory: ${redactSensitiveCommandValue(resolvedPath)}`,
      400,
      notDirectoryCode,
    );
  }

  return resolvedPath;
};

export const fileExplorerCommand = (repoPath: string): SafeCommandSummary => {
  if (process.platform === "darwin") {
    return safeCommandSummary("open", [repoPath]);
  }

  if (process.platform === "win32") {
    return safeCommandSummary("explorer.exe", [repoPath]);
  }

  return safeCommandSummary("xdg-open", [repoPath]);
};

export const safeCommandSummary = (
  command: FixedLocalCommand,
  args: string[],
): SafeCommandSummary => ({
  command,
  args,
  summary: [command, ...args.map(redactSensitiveCommandValue)].join(" "),
});
