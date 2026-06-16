import { existsSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

import {
  FEATURE_ARTIFACT_FILES,
  type FeatureArtifactName,
  type RiskLevel,
  type TaskMode,
  type TaskOwner,
} from "@/lib/loopboard";

const checkboxTaskPattern = /^(\s*)[-*]\s+\[([ xX])\]\s+(.+?)\s*$/;
const headingPattern = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const bulletPattern = /^\s{0,8}[-*+]\s+(.+?)\s*$/;
const orderedBulletPattern = /^\s{0,8}\d+[.)]\s+(.+?)\s*$/;
const taskIdPattern = /^([A-Z]+-\d+|[A-Z]+\d+|\d+(?:\.\d+)*)[\s:.)-]+(.+)$/;
const dependencyLinePattern = /^(?:dependencies|deps|depends on|blocked by|after)\s*:\s*(.+)$/i;
const acceptanceHeaderPattern = /^(?:acceptance criteria|acceptance|criteria|ac)\s*:?\s*$/i;
const acceptanceInlinePattern = /^(?:acceptance criteria|acceptance|criteria|ac)\s*:\s*(.+)$/i;
const filePathPattern =
  /`([^`\n]+\.(?:[cm]?[jt]sx?|tsx?|json|ya?ml|md|mdx|css|scss|sql|sh|py|go|rs|java|kt|swift|rb|php|html|env|toml|lock))`|(?:^|[\s([:])((?:\.{1,2}\/|\/|[A-Za-z0-9_.-]+\/)[A-Za-z0-9_./@-]+\.(?:[cm]?[jt]sx?|tsx?|json|ya?ml|md|mdx|css|scss|sql|sh|py|go|rs|java|kt|swift|rb|php|html|env|toml|lock))/g;
const dependencyIdPattern = /\b([A-Z]+-\d+|[A-Z]+\d+|\d+(?:\.\d+)*)\b/g;

const artifactNames = Object.keys(FEATURE_ARTIFACT_FILES) as FeatureArtifactName[];

export type SpecKitAreaLabel = "frontend" | "backend" | "infra" | "test" | "docs";

export interface SpecKitArtifactLink {
  name: FeatureArtifactName;
  fileName: string;
  path: string;
  exists: boolean;
}

export interface ParsedSpecKitTask {
  sourceId: string;
  sourceLine: number;
  completed: boolean;
  headings: string[];
  title: string;
  description: string;
  fileReferences: string[];
  dependencies: string[];
  acceptanceCriteria: string[];
  labels: SpecKitAreaLabel[];
  owner: TaskOwner;
  mode: TaskMode;
  risk: RiskLevel;
  notes: string[];
  sourceText: string;
  sourceArtifactPaths: string[];
}

export interface SpecKitParseWarning {
  line: number;
  message: string;
}

export interface SpecKitTaskParseResult {
  tasks: ParsedSpecKitTask[];
  artifacts: SpecKitArtifactLink[];
  warnings: SpecKitParseWarning[];
}

export interface SpecKitTaskParserOptions {
  tasksPath?: string;
  artifactPaths?: Partial<Record<FeatureArtifactName, string>>;
}

interface DraftTask {
  sourceLine: number;
  completed: boolean;
  headings: string[];
  checkboxText: string;
  bodyLines: string[];
  rawLines: string[];
}

export const parseSpecKitTasksMarkdown = (
  markdown: string,
  options: SpecKitTaskParserOptions = {},
): SpecKitTaskParseResult => {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const warnings: SpecKitParseWarning[] = [];
  const drafts: DraftTask[] = [];
  const headingStack: { level: number; title: string }[] = [];
  let currentTask: DraftTask | undefined;

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const heading = line.match(headingPattern);

    if (heading) {
      const level = heading[1].length;
      const existingIndex = headingStack.findIndex((entry) => entry.level >= level);
      if (existingIndex >= 0) {
        headingStack.splice(existingIndex);
      }
      headingStack.push({ level, title: cleanText(heading[2]) });
      currentTask = undefined;
      return;
    }

    const checkbox = line.match(checkboxTaskPattern);

    if (checkbox) {
      const draft: DraftTask = {
        sourceLine: lineNumber,
        completed: checkbox[2].toLowerCase() === "x",
        headings: headingStack.map((entry) => entry.title),
        checkboxText: cleanText(checkbox[3]),
        bodyLines: [],
        rawLines: [line],
      };
      drafts.push(draft);
      currentTask = draft;
      return;
    }

    if (currentTask && belongsToTask(line)) {
      currentTask.bodyLines.push(line);
      currentTask.rawLines.push(line);
    } else if (line.trim().startsWith("- [") || line.trim().startsWith("* [")) {
      warnings.push({
        line: lineNumber,
        message: "Skipped malformed checkbox task.",
      });
      currentTask = undefined;
    } else if (line.trim()) {
      currentTask = undefined;
    }
  });

  const artifacts = discoverLinkedArtifacts(options);
  const sourceArtifactPaths = artifacts
    .filter((artifact) => artifact.exists)
    .map((artifact) => artifact.path);

  return {
    tasks: drafts.map((draft, index) =>
      normalizeDraftTask(draft, index, sourceArtifactPaths),
    ),
    artifacts,
    warnings,
  };
};

const normalizeDraftTask = (
  draft: DraftTask,
  index: number,
  sourceArtifactPaths: string[],
): ParsedSpecKitTask => {
  const { sourceId, title: rawTitle } = parseTaskTitle(
    draft.checkboxText,
    draft.sourceLine,
  );
  const details = parseTaskDetails(draft.bodyLines);
  const combinedText = [
    draft.checkboxText,
    ...draft.bodyLines,
    ...details.fileReferences,
  ].join("\n");
  const fileReferences = uniqueStrings([
    ...extractFileReferences(draft.checkboxText),
    ...details.fileReferences,
  ]);
  const notes = uniqueStrings(details.notes);
  const description = details.description.join("\n").trim() || notes.join("\n").trim();
  const labels = inferAreaLabels(`${combinedText}\n${fileReferences.join("\n")}`);
  const risk = inferRiskLevel(`${combinedText}\n${fileReferences.join("\n")}`);
  const dependencies = uniqueStrings([
    ...extractDependencies(draft.checkboxText),
    ...details.dependencies,
  ]).filter((dependency) => dependency !== sourceId);

  return {
    sourceId,
    sourceLine: draft.sourceLine,
    completed: draft.completed,
    headings: draft.headings,
    title: stripKnownMarkers(rawTitle),
    description,
    fileReferences,
    dependencies,
    acceptanceCriteria: uniqueStrings(details.acceptanceCriteria),
    labels,
    owner: "unassigned",
    mode: "execute",
    risk,
    notes,
    sourceText: draft.rawLines.join("\n"),
    sourceArtifactPaths,
  };
};

const parseTaskTitle = (
  checkboxText: string,
  sourceLine: number,
): { sourceId: string; title: string } => {
  const match = checkboxText.match(taskIdPattern);

  if (!match) {
    return {
      sourceId: `line-${sourceLine}`,
      title: checkboxText,
    };
  }

  return {
    sourceId: match[1],
    title: match[2],
  };
};

const parseTaskDetails = (bodyLines: string[]) => {
  const description: string[] = [];
  const notes: string[] = [];
  const dependencies: string[] = [];
  const acceptanceCriteria: string[] = [];
  const fileReferences: string[] = [];
  let collectingAcceptance = false;

  bodyLines.forEach((line) => {
    const trimmed = cleanText(line);

    if (!trimmed) {
      return;
    }

    const inlineAcceptance = trimmed.match(acceptanceInlinePattern);
    if (inlineAcceptance) {
      acceptanceCriteria.push(cleanText(inlineAcceptance[1]));
      collectingAcceptance = true;
      return;
    }

    if (acceptanceHeaderPattern.test(trimmed)) {
      collectingAcceptance = true;
      return;
    }

    const dependencyLine = trimmed.match(dependencyLinePattern);
    if (dependencyLine) {
      dependencies.push(...extractDependencies(dependencyLine[1]));
      collectingAcceptance = false;
      return;
    }

    const bullet = parseBulletText(line);
    if (collectingAcceptance && bullet) {
      acceptanceCriteria.push(cleanText(bullet));
      return;
    }

    fileReferences.push(...extractFileReferences(line));

    if (isRecognizedMetadataLine(trimmed) || looksLikeStandaloneNote(trimmed)) {
      notes.push(trimmed);
      collectingAcceptance = false;
      return;
    }

    if (bullet && looksLikeStandaloneNote(bullet)) {
      notes.push(cleanText(bullet));
      collectingAcceptance = false;
      return;
    }

    if (bullet) {
      description.push(cleanText(bullet));
      collectingAcceptance = false;
      return;
    }

    description.push(trimmed);
    collectingAcceptance = false;
  });

  return {
    description,
    notes,
    dependencies: uniqueStrings(dependencies),
    acceptanceCriteria: uniqueStrings(acceptanceCriteria),
    fileReferences: uniqueStrings(fileReferences),
  };
};

const discoverLinkedArtifacts = ({
  tasksPath,
  artifactPaths,
}: SpecKitTaskParserOptions): SpecKitArtifactLink[] => {
  const taskDirectory = tasksPath ? dirname(resolve(tasksPath)) : "";
  const explicitPaths = artifactPaths ?? {};

  return artifactNames.flatMap((name) => {
    const explicitPath = explicitPaths[name];
    const artifactPath =
      explicitPath ?? (taskDirectory ? join(taskDirectory, FEATURE_ARTIFACT_FILES[name]) : "");

    if (!artifactPath) {
      return [];
    }

    const absolutePath = resolve(artifactPath);
    const path =
      tasksPath && !explicitPath
        ? toPathRelativeToTasks(tasksPath, absolutePath)
        : artifactPath;

    return [
      {
        name,
        fileName: FEATURE_ARTIFACT_FILES[name],
        path,
        exists: existsSync(absolutePath),
      },
    ];
  });
};

export const inferAreaLabels = (text: string): SpecKitAreaLabel[] => {
  const normalized = text.toLowerCase();
  const labels: SpecKitAreaLabel[] = [];

  if (matchesAny(normalized, ["frontend", "ui", "ux", "react", "component", "page", "tsx", "css"])) {
    labels.push("frontend");
  }

  if (matchesAny(normalized, ["backend", "api", "route", "server", "database", "db/", "service", "repository"])) {
    labels.push("backend");
  }

  if (matchesAny(normalized, ["infra", "deploy", "docker", "workflow", "terraform", "kubernetes", ".github/"])) {
    labels.push("infra");
  }

  if (matchesAny(normalized, ["test", "tests/", ".test.", ".spec.", "fixture", "coverage", "playwright"])) {
    labels.push("test");
  }

  if (matchesAny(normalized, ["docs", "documentation", "readme", ".md", "adr", "decision"])) {
    labels.push("docs");
  }

  return labels;
};

export const inferRiskLevel = (text: string): RiskLevel => {
  const normalized = text.toLowerCase();
  const criticalTerms = [
    "payment",
    "payments",
    "billing",
    "secret",
    "secrets",
    "credential",
    "credentials",
    "private key",
    "delete user",
    "drop table",
    "data loss",
  ];
  const highTerms = [
    "auth",
    "authentication",
    "authorization",
    "permission",
    "permissions",
    "security",
    "migration",
    "migrations",
    "delete",
    "deletion",
    "destructive",
    "large refactor",
    "refactor all",
    "access control",
    "pii",
  ];
  const mediumTerms = [
    "api",
    "database",
    "schema",
    "repository",
    "integration",
    "webhook",
    "background job",
    "concurrency",
  ];

  if (matchesAny(normalized, criticalTerms)) {
    return "critical";
  }

  if (matchesAny(normalized, highTerms)) {
    return "high";
  }

  if (matchesAny(normalized, mediumTerms)) {
    return "medium";
  }

  return "low";
};

const belongsToTask = (line: string): boolean =>
  line.trim() === "" || /^\s{2,}\S/.test(line) || /^\s{0,8}[-*+]\s+/.test(line) || /^\s{0,8}\d+[.)]\s+/.test(line);

const parseBulletText = (line: string): string => {
  const bullet = line.match(bulletPattern);
  if (bullet) {
    return bullet[1];
  }

  const orderedBullet = line.match(orderedBulletPattern);
  return orderedBullet ? orderedBullet[1] : "";
};

const extractDependencies = (text: string): string[] =>
  Array.from(text.matchAll(dependencyIdPattern), (match) => match[1]);

const extractFileReferences = (text: string): string[] => {
  const references: string[] = [];

  for (const match of text.matchAll(filePathPattern)) {
    references.push(cleanText(match[1] ?? match[2] ?? ""));
  }

  return uniqueStrings(references);
};

const stripKnownMarkers = (title: string): string =>
  cleanText(title.replace(/\[(?:P|US\d+|FE|BE|AI|HUMAN|MVP|OPTIONAL)\]\s*/gi, ""));

const cleanText = (text: string): string =>
  text
    .trim()
    .replace(/^#+\s*/, "")
    .replace(/\s+/g, " ");

const isRecognizedMetadataLine = (text: string): boolean =>
  /^(?:owner|mode|status|risk|priority|estimate|source|area|labels?)\s*:/i.test(text);

const looksLikeStandaloneNote = (text: string): boolean =>
  /^(?:note|notes|unknown|todo|question|open question|assumption|non-goal)\s*:/i.test(text);

const matchesAny = (text: string, terms: string[]): boolean =>
  terms.some((term) => text.includes(term));

const uniqueStrings = (values: string[]): string[] =>
  Array.from(new Set(values.map((value) => cleanText(value)).filter(Boolean)));

const toPathRelativeToTasks = (tasksPath: string, absolutePath: string): string => {
  const taskDirectory = dirname(resolve(tasksPath));
  const relativePath = relative(taskDirectory, absolutePath);

  return relativePath.startsWith("..") ? absolutePath : basename(relativePath);
};
