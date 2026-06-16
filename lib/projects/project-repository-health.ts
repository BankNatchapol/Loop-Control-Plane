import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

export interface RepositoryHealth {
  repoPath: string;
  pathExists: boolean;
  isDirectory: boolean;
  isGitRepository: boolean;
  currentBranch: string;
  defaultBranch: string;
  githubRemoteUrl: string;
  githubRepository: string;
}

const runGit = (repoPath: string, args: string[]): string => {
  const result = spawnSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    timeout: 3000,
  });

  if (result.status !== 0) {
    return "";
  }

  return result.stdout.trim();
};

export const parseGitHubRemoteUrl = (remoteUrl: string): string => {
  const value = remoteUrl.trim();

  if (value.length === 0) {
    return "";
  }

  const sshMatch = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/u.exec(value);
  if (sshMatch) {
    return `https://github.com/${sshMatch[1]}/${sshMatch[2]}`;
  }

  try {
    const url = new URL(value);
    if (url.hostname !== "github.com") {
      return value;
    }

    const path = url.pathname.replace(/\.git$/u, "").replace(/^\/+/u, "");
    return path ? `https://github.com/${path}` : value;
  } catch {
    return value;
  }
};

export const normalizeGitHubRepository = (repository: string): string => {
  const value = repository.trim().replace(/^\/+/u, "").replace(/\/+$/u, "");

  if (!value) {
    return "";
  }

  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/u.exec(value);
  if (!match) {
    return "";
  }

  return `${match[1]}/${match[2].replace(/\.git$/u, "")}`;
};

export const parseGitHubRepository = (remoteOrRepository: string): string => {
  const value = remoteOrRepository.trim();

  if (!value) {
    return "";
  }

  const direct = normalizeGitHubRepository(value);
  if (direct) {
    return direct;
  }

  const sshMatch = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/u.exec(value);
  if (sshMatch) {
    return normalizeGitHubRepository(`${sshMatch[1]}/${sshMatch[2]}`);
  }

  try {
    const url = new URL(value);
    if (url.hostname !== "github.com") {
      return "";
    }

    return normalizeGitHubRepository(url.pathname.replace(/^\/+/u, ""));
  } catch {
    return "";
  }
};

const detectDefaultBranch = (repoPath: string, currentBranch: string): string => {
  const originHead = runGit(repoPath, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (originHead.startsWith("origin/")) {
    return originHead.slice("origin/".length);
  }

  const remoteDefault = runGit(repoPath, ["remote", "show", "origin"])
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("HEAD branch:"))
    ?.replace("HEAD branch:", "")
    .trim();

  return remoteDefault || currentBranch;
};

export const inspectRepositoryHealth = (repoPath: string): RepositoryHealth => {
  const resolvedPath = resolve(repoPath.trim());
  const pathExists = existsSync(resolvedPath);
  const isDirectory = pathExists ? statSync(resolvedPath).isDirectory() : false;

  if (!pathExists || !isDirectory) {
    return {
      repoPath: resolvedPath,
      pathExists,
      isDirectory,
      isGitRepository: false,
      currentBranch: "",
      defaultBranch: "",
      githubRemoteUrl: "",
      githubRepository: "",
    };
  }

  const gitRoot = runGit(resolvedPath, ["rev-parse", "--show-toplevel"]);
  const isGitRepository = gitRoot.length > 0;
  const currentBranch = isGitRepository
    ? runGit(resolvedPath, ["branch", "--show-current"])
    : "";
  const defaultBranch = isGitRepository
    ? detectDefaultBranch(resolvedPath, currentBranch)
    : "";
  const githubRemoteUrl = isGitRepository
    ? parseGitHubRemoteUrl(runGit(resolvedPath, ["remote", "get-url", "origin"]))
    : "";
  const githubRepository = parseGitHubRepository(githubRemoteUrl);

  return {
    repoPath: resolvedPath,
    pathExists,
    isDirectory,
    isGitRepository,
    currentBranch,
    defaultBranch,
    githubRemoteUrl,
    githubRepository,
  };
};
