import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";

export type PrAgentReviewResult = {
  success: boolean;
  verdict?: "approved" | "needs changes";
  summary?: string;
  rawOutput?: string;
  error?: string;
};

type ProxyHandle = {
  port: number;
  kill: () => void;
};

const PROXY_SCRIPT = join(process.cwd(), "scripts", "ai-review-proxy.py");
const TRANSPORT_MODEL = "gpt-5.5";

const parsePullRequestCoordinates = (
  prUrl: string,
): { owner: string; repository: string; number: number } | undefined => {
  const match =
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/u.exec(
      prUrl,
    );
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  return { owner: match[1], repository: match[2], number: Number(match[3]) };
};

const readPreparingCommentIds = (prUrl: string): Set<number> => {
  const coordinates = parsePullRequestCoordinates(prUrl);
  if (!coordinates) return new Set();
  const result = spawnSync(
    "gh",
    [
      "api",
      `repos/${coordinates.owner}/${coordinates.repository}/issues/${coordinates.number}/comments`,
      "--paginate",
      "--jq",
      '.[] | select(.body == "Preparing review...") | .id',
    ],
    { encoding: "utf8", timeout: 20_000 },
  );
  if (result.status !== 0) return new Set();
  return new Set(
    result.stdout
      .split(/\r?\n/u)
      .map(Number)
      .filter((value) => Number.isInteger(value) && value > 0),
  );
};

const cleanupNewPreparingComments = (
  prUrl: string,
  before: ReadonlySet<number>,
): void => {
  const coordinates = parsePullRequestCoordinates(prUrl);
  if (!coordinates) return;
  for (const id of readPreparingCommentIds(prUrl)) {
    if (before.has(id)) continue;
    spawnSync(
      "gh",
      [
        "api",
        "--method",
        "DELETE",
        `repos/${coordinates.owner}/${coordinates.repository}/issues/comments/${id}`,
      ],
      { encoding: "utf8", timeout: 20_000 },
    );
  }
};

export const parsePrAgentVerdict = (
  text: string,
): "approved" | "needs changes" => {
  if (/key_issues_to_review:\s*(?:\r?\n)[ \t]+-/iu.test(text)) {
    return "needs changes";
  }
  const securityValue =
    /security_concerns:\s*\|?\s*(?:\r?\n)?[ \t]*([^\r\n]+)/iu.exec(text)?.[1]?.trim();
  const explicitlyEmptyIssues = /key_issues_to_review:\s*\[\s*\]/iu.test(text);
  return explicitlyEmptyIssues && securityValue && /^no[.!]?$/iu.test(securityValue)
    ? "approved"
    : "needs changes";
};

const extractReviewYaml = (output: string): string | undefined => {
  const marker = output.lastIndexOf("AI response:");
  if (marker < 0) return undefined;
  const after = output.slice(marker + "AI response:".length);
  const nextLog = after.search(/\n(?:\u001b\[[0-9;]*m)*\d{4}-\d{2}-\d{2}/u);
  return (nextLog >= 0 ? after.slice(0, nextLog) : after).trim() || undefined;
};

const startProxy = (
  plugin: string,
  model: string,
): Promise<ProxyHandle> =>
  new Promise((resolve, reject) => {
    const child = spawn("python3", [PROXY_SCRIPT, "0"], {
      env: {
        ...process.env,
        AGENT_PLUGIN: plugin,
        AGENT_MODEL: model,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("PR-Agent proxy did not start within 15 seconds."));
    }, 15_000);

    child.stdout?.on("data", (chunk: Buffer) => {
      const match = /PROXY_READY port=(\d+)/u.exec(chunk.toString());
      if (!match?.[1]) return;
      clearTimeout(timeout);
      resolve({
        port: Number(match[1]),
        kill: () => child.kill(),
      });
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code) => {
      if (code && code !== 0) {
        clearTimeout(timeout);
        reject(new Error(`PR-Agent proxy exited with code ${code}.`));
      }
    });
  });

export const runPrAgentReview = async (input: {
  prUrl: string;
  plugin: string;
  model: string;
  publishOutput?: boolean;
}): Promise<PrAgentReviewResult> => {
  if (!["claude-code", "codex", "cursor"].includes(input.plugin)) {
    return { success: false, error: `Unsupported PR-Agent backend "${input.plugin}".` };
  }

  const tokenResult = spawnSync("gh", ["auth", "token"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  const githubToken = tokenResult.status === 0 ? tokenResult.stdout.trim() : "";
  if (!githubToken) {
    return { success: false, error: "Could not retrieve GitHub token via gh auth token." };
  }

  let proxy: ProxyHandle;
  try {
    proxy = await startProxy(input.plugin, input.model);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Could not start PR-Agent proxy.",
    };
  }

  try {
    const preparingCommentsBefore = readPreparingCommentIds(input.prUrl);
    const result = spawnSync(
      "uvx",
      ["pr-agent", "--pr_url", input.prUrl, "review"],
      {
        encoding: "utf8",
        timeout: 300_000,
        env: {
          ...process.env,
          GITHUB__USER_TOKEN: githubToken,
          OPENAI_API_BASE: `http://127.0.0.1:${proxy.port}/v1`,
          OPENAI_API_KEY: "headless-subscription",
          CONFIG__MODEL: TRANSPORT_MODEL,
          CONFIG__FALLBACK_MODELS: `["${TRANSPORT_MODEL}"]`,
          CONFIG__PUBLISH_OUTPUT: input.publishOutput === false ? "false" : "true",
          CONFIG__VERBOSITY_LEVEL: "2",
          ANTHROPIC_API_KEY: "",
          ANTHROPIC_KEY: "",
        },
      },
    );
    const rawOutput = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    const summary = extractReviewYaml(rawOutput);
    const failure =
      result.status !== 0 ||
      /failed to (?:parse review data|review pr)|body cannot be blank|proxy error|cli error|review timed out/iu
        .test(rawOutput);

    if (failure || !summary) {
      cleanupNewPreparingComments(input.prUrl, preparingCommentsBefore);
      return {
        success: false,
        rawOutput,
        error: "PR-Agent did not produce a valid structured review.",
      };
    }

    return {
      success: true,
      verdict: parsePrAgentVerdict(summary),
      summary,
      rawOutput,
    };
  } finally {
    proxy.kill();
  }
};
