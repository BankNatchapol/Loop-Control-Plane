import { normalizeGitHubRepository } from "@/lib/projects/project-repository-health";

export type GitHubConnectionStatus =
  | "disconnected"
  | "token-missing"
  | "repo-missing"
  | "connected"
  | "api-error";

export type GitHubConnectionCheck = {
  status: GitHubConnectionStatus;
  repository: string;
  message: string;
  checkedAt: string;
};

type FetchLike = typeof fetch;

export type GitHubLabelDefinition = {
  name: string;
  color: string;
  description: string;
};

export type GitHubLabelSetupStatus =
  | "disconnected"
  | "token-missing"
  | "repo-missing"
  | "ready"
  | "api-error";

export type GitHubLabelSetupResult = {
  status: GitHubLabelSetupStatus;
  repository: string;
  message: string;
  checkedAt: string;
  labels: Array<{
    name: string;
    status: "exists" | "created" | "error";
    message: string;
  }>;
};

export const loopBoardGitHubLabels: GitHubLabelDefinition[] = [
  {
    name: "loopboard",
    color: "475569",
    description: "Created or managed through Loop Control Plane.",
  },
  {
    name: "ao-ready",
    color: "2563eb",
    description: "Ready for Agent Orchestrator pickup.",
  },
  {
    name: "human-working",
    color: "7c3aed",
    description: "A human is actively working this task.",
  },
  {
    name: "human-review-needed",
    color: "f59e0b",
    description: "Human review is required before handoff or completion.",
  },
  {
    name: "risk-low",
    color: "10b981",
    description: "Low implementation or operational risk.",
  },
  {
    name: "risk-medium",
    color: "f97316",
    description: "Medium implementation or operational risk.",
  },
  {
    name: "risk-high",
    color: "dc2626",
    description: "High implementation or operational risk.",
  },
  {
    name: "area-frontend",
    color: "0ea5e9",
    description: "Frontend, interaction, or visual implementation area.",
  },
  {
    name: "area-backend",
    color: "64748b",
    description: "Backend, API, persistence, or server implementation area.",
  },
  {
    name: "area-infra",
    color: "84cc16",
    description: "Infrastructure, CI, deployment, or environment area.",
  },
  {
    name: "area-test",
    color: "14b8a6",
    description: "Testing, quality, or verification area.",
  },
];

export const githubTokenFromEnv = (): string =>
  process.env.LOOPBOARD_GITHUB_TOKEN?.trim() ||
  process.env.GITHUB_TOKEN?.trim() ||
  "";

export const redactGitHubToken = (message: string, token = githubTokenFromEnv()): string => {
  if (!token) {
    return message;
  }

  return message.split(token).join("[redacted]");
};

export const checkGitHubConnection = async ({
  repository,
  token = githubTokenFromEnv(),
  fetcher = fetch,
  now = new Date(),
}: {
  repository: string;
  token?: string;
  fetcher?: FetchLike;
  now?: Date;
}): Promise<GitHubConnectionCheck> => {
  const normalizedRepository = normalizeGitHubRepository(repository);
  const checkedAt = now.toISOString();

  if (!normalizedRepository) {
    return {
      status: "disconnected",
      repository: "",
      message: "No GitHub repository is configured for this project.",
      checkedAt,
    };
  }

  if (!token) {
    return {
      status: "token-missing",
      repository: normalizedRepository,
      message:
        "Set LOOPBOARD_GITHUB_TOKEN or GITHUB_TOKEN in the server environment to enable GitHub access.",
      checkedAt,
    };
  }

  try {
    const response = await fetcher(
      `https://api.github.com/repos/${normalizedRepository}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "Loop Control Plane",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );

    if (response.ok) {
      return {
        status: "connected",
        repository: normalizedRepository,
        message: "GitHub token can access the configured repository.",
        checkedAt,
      };
    }

    if (response.status === 404) {
      return {
        status: "repo-missing",
        repository: normalizedRepository,
        message:
          "GitHub repository was not found or the configured token cannot access it.",
        checkedAt,
      };
    }

    return {
      status: "api-error",
      repository: normalizedRepository,
      message: `GitHub API returned ${response.status} ${response.statusText || "error"}.`,
      checkedAt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown GitHub API error.";

    return {
      status: "api-error",
      repository: normalizedRepository,
      message: redactGitHubToken(message, token),
      checkedAt,
    };
  }
};

const githubApiHeaders = (token: string) => ({
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
  "User-Agent": "Loop Control Plane",
  "X-GitHub-Api-Version": "2022-11-28",
});

const labelApiUrl = (repository: string, labelName: string): string =>
  `https://api.github.com/repos/${repository}/labels/${encodeURIComponent(labelName)}`;

export const setupGitHubLabels = async ({
  repository,
  token = githubTokenFromEnv(),
  fetcher = fetch,
  now = new Date(),
}: {
  repository: string;
  token?: string;
  fetcher?: FetchLike;
  now?: Date;
}): Promise<GitHubLabelSetupResult> => {
  const normalizedRepository = normalizeGitHubRepository(repository);
  const checkedAt = now.toISOString();

  if (!normalizedRepository) {
    return {
      status: "disconnected",
      repository: "",
      message: "No GitHub repository is configured for this project.",
      checkedAt,
      labels: [],
    };
  }

  if (!token) {
    return {
      status: "token-missing",
      repository: normalizedRepository,
      message:
        "Set LOOPBOARD_GITHUB_TOKEN or GITHUB_TOKEN in the server environment to enable GitHub label setup.",
      checkedAt,
      labels: [],
    };
  }

  const labels: GitHubLabelSetupResult["labels"] = [];

  try {
    for (const label of loopBoardGitHubLabels) {
      const readResponse = await fetcher(labelApiUrl(normalizedRepository, label.name), {
        headers: githubApiHeaders(token),
      });

      if (readResponse.ok) {
        labels.push({
          name: label.name,
          status: "exists",
          message: "Label already exists; existing color and description were left unchanged.",
        });
        continue;
      }

      if (readResponse.status !== 404) {
        const message =
          readResponse.status === 401 || readResponse.status === 403
            ? "GitHub token cannot verify labels for this repository."
            : `GitHub API returned ${readResponse.status} ${readResponse.statusText || "error"} while checking label.`;

        labels.push({ name: label.name, status: "error", message });
        continue;
      }

      const createResponse = await fetcher(
        `https://api.github.com/repos/${normalizedRepository}/labels`,
        {
          method: "POST",
          headers: githubApiHeaders(token),
          body: JSON.stringify(label),
        },
      );

      if (createResponse.ok) {
        labels.push({
          name: label.name,
          status: "created",
          message: "Label created.",
        });
        continue;
      }

      if (createResponse.status === 404) {
        labels.push({
          name: label.name,
          status: "error",
          message:
            "GitHub repository was not found or the configured token cannot create labels in it.",
        });
        continue;
      }

      labels.push({
        name: label.name,
        status: "error",
        message: `GitHub API returned ${createResponse.status} ${createResponse.statusText || "error"} while creating label.`,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown GitHub API error.";

    return {
      status: "api-error",
      repository: normalizedRepository,
      message: redactGitHubToken(message, token),
      checkedAt,
      labels,
    };
  }

  const errorCount = labels.filter((label) => label.status === "error").length;
  const createdCount = labels.filter((label) => label.status === "created").length;
  const existingCount = labels.filter((label) => label.status === "exists").length;

  if (errorCount > 0) {
    const hasMissingRepository = labels.some(
      (label) =>
        label.status === "error" &&
        (label.message.includes("cannot verify labels") ||
          label.message.includes("repository was not found")),
    );

    return {
      status: hasMissingRepository ? "repo-missing" : "api-error",
      repository: normalizedRepository,
      message: `GitHub label setup completed with ${errorCount} error${errorCount === 1 ? "" : "s"}.`,
      checkedAt,
      labels,
    };
  }

  return {
    status: "ready",
    repository: normalizedRepository,
    message: `GitHub labels are ready: ${createdCount} created, ${existingCount} already existed.`,
    checkedAt,
    labels,
  };
};
