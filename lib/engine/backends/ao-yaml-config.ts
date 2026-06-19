import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const jsYaml = require("js-yaml") as {
  load: (src: string) => unknown;
  dump: (obj: unknown, opts?: { lineWidth?: number; quotingType?: string }) => string;
};

const AO_YAML_FILENAME = "agent-orchestrator.yaml";

type AoProjectEntry = Record<string, unknown> & {
  path?: string;
  agentConfig?: Record<string, unknown>;
};

type AoYamlDoc =
  | ({ projects?: Record<string, AoProjectEntry> } & AoProjectEntry)
  | null
  | undefined;

/**
 * Ensure a valid agent-orchestrator.yaml exists at repoPath with the required
 * `projects` section. Safe to call when the file already exists — it will not
 * overwrite an existing file.
 */
export const ensureAoProjectYaml = (opts: {
  repoPath: string;
  repo: string;
  defaultBranch: string;
  model?: string;
}): void => {
  const yamlPath = join(opts.repoPath, AO_YAML_FILENAME);
  if (existsSync(yamlPath)) return;

  const projectName = basename(opts.repoPath);
  const doc = {
    projects: {
      [projectName]: {
        name: projectName,
        repo: opts.repo,
        path: opts.repoPath,
        defaultBranch: opts.defaultBranch,
        ...(opts.model ? { agentConfig: { model: opts.model } } : {}),
      },
    },
  };
  writeFileSync(yamlPath, jsYaml.dump(doc, { lineWidth: 120 }), "utf8");
};

/**
 * Read, update `agentConfig.model`, and write back the agent-orchestrator.yaml.
 * Checks the project-local YAML first (the vendored CLI reads from CWD), then
 * falls back to the control-plane YAML for multi-project setups.
 */
export const updateAoYamlAgentModel = (repoPath: string, model: string): void => {
  const projectYaml = join(repoPath, AO_YAML_FILENAME);
  const controlPlaneYaml = join(process.cwd(), AO_YAML_FILENAME);

  // Prefer the project-local YAML (read by the vendored CLI when cwd=repoPath).
  // Fall back to the control-plane YAML if no local file exists.
  const yamlPath = existsSync(projectYaml) ? projectYaml : controlPlaneYaml;

  if (!existsSync(yamlPath)) {
    writeFileSync(yamlPath, jsYaml.dump({ agentConfig: { model } }, { lineWidth: 120 }), "utf8");
    return;
  }

  const raw = readFileSync(yamlPath, "utf8");
  const doc = jsYaml.load(raw) as AoYamlDoc;

  if (!doc || typeof doc !== "object") {
    throw new Error(`${AO_YAML_FILENAME} is empty or not a valid YAML object.`);
  }

  if (doc.projects && typeof doc.projects === "object") {
    // Multi-project format: find the project whose `path` matches repoPath,
    // or fall back to updating all entries.
    const entries = Object.values(doc.projects) as AoProjectEntry[];
    const matched = entries.filter((p) => p.path === repoPath);
    const targets = matched.length > 0 ? matched : entries;
    for (const project of targets) {
      project.agentConfig = { ...(project.agentConfig ?? {}), model };
    }
  } else {
    // Single-project format: agentConfig lives at the top level.
    const single = doc as AoProjectEntry;
    single.agentConfig = { ...(single.agentConfig ?? {}), model };
  }

  writeFileSync(yamlPath, jsYaml.dump(doc, { lineWidth: 120 }), "utf8");
};
