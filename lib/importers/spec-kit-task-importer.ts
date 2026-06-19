import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { TaskContextActionError } from "@/lib/api/task-context-actions";
import { TaskContextService, type GeneratedTaskContext } from "@/lib/context/task-context-service";
import {
  type LoopBoardRepository,
  type PersistedTask,
  ValidationError,
} from "@/lib/db/loopboard-repository";
import { refreshFeatureArtifactStatus } from "@/lib/features/feature-artifacts";
import {
  parseSpecKitTasksMarkdown,
  type ParsedSpecKitTask,
  type SpecKitArtifactLink,
  type SpecKitParseWarning,
} from "@/lib/importers/spec-kit-task-parser";
import {
  KANBAN_COLUMNS,
  type Feature,
  type KanbanStatus,
  type Project,
  type RiskLevel,
  type TaskMode,
  type TaskOwner,
} from "@/lib/loopboard";

export interface SpecKitImportPreviewTask extends ParsedSpecKitTask {
  duplicate: boolean;
  duplicateTaskId?: string;
  sourceArtifactPaths: string[];
}

export interface SpecKitMissingArtifactNotice {
  name: SpecKitArtifactLink["name"];
  fileName: string;
  path: string;
  message: string;
}

export interface SpecKitImportPreview {
  project: Project;
  feature: Feature;
  tasksPath: string;
  tasks: SpecKitImportPreviewTask[];
  artifacts: SpecKitArtifactLink[];
  warnings: SpecKitParseWarning[];
  missingArtifacts: SpecKitMissingArtifactNotice[];
}

export interface SpecKitImportTaskInput {
  include?: boolean;
  sourceId: string;
  sourceLine?: number;
  completed?: boolean;
  headings?: string[];
  title: string;
  description?: string;
  fileReferences?: string[];
  dependencies?: string[];
  acceptanceCriteria?: string[];
  labels?: string[];
  owner?: TaskOwner;
  mode?: TaskMode;
  risk?: RiskLevel;
  notes?: string[];
  sourceText?: string;
  sourceArtifactPaths?: string[];
  status?: KanbanStatus;
}

export interface SpecKitImportInput {
  tasks?: SpecKitImportTaskInput[];
}

export interface SpecKitImportedTaskResult {
  task: PersistedTask;
  generated: GeneratedTaskContext;
  sourceId: string;
}

export interface SpecKitImportResult {
  project: Project;
  feature: Feature;
  imported: SpecKitImportedTaskResult[];
  skipped: Array<{
    sourceId: string;
    title: string;
    reason: "excluded" | "duplicate";
    duplicateTaskId?: string;
  }>;
  preview: SpecKitImportPreview;
}

export class SpecKitTaskImporter {
  constructor(
    private readonly repository: LoopBoardRepository,
    private readonly contextService = new TaskContextService(),
  ) {}

  previewFeature(featureId: string): SpecKitImportPreview {
    const { project, feature } = this.getImportContext(featureId);
    const tasksPath = absoluteProjectPath(project, feature.tasksPath);
    const parseResult = parseSpecKitTasksMarkdown(readFileSync(tasksPath, "utf8"), {
      tasksPath,
    });
    const sourceArtifactPaths = featureSourceArtifactPaths(feature);
    const duplicates = this.findDuplicateTasks(feature);
    const tasks = parseResult.tasks.map((task) => {
      const duplicate = findDuplicate(duplicates, task);

      return {
        ...task,
        sourceArtifactPaths,
        duplicate: Boolean(duplicate),
        duplicateTaskId: duplicate?.id,
      };
    });
    const artifacts = artifactLinksFromFeature(feature);

    return {
      project,
      feature,
      tasksPath: feature.tasksPath,
      tasks,
      artifacts,
      warnings: parseResult.warnings,
      missingArtifacts: artifacts
        .filter((artifact) => !artifact.exists)
        .map((artifact) => ({
          name: artifact.name,
          fileName: artifact.fileName,
          path: artifact.path,
          message: `${artifact.fileName} was not found next to tasks.md.`,
        })),
    };
  }

  importFeature(featureId: string, input: SpecKitImportInput = {}): SpecKitImportResult {
    const preview = this.previewFeature(featureId);
    const duplicateLookup = this.findDuplicateTasks(preview.feature);
    const providedTasks: SpecKitImportTaskInput[] =
      input.tasks?.map(normalizeImportTask) ??
      preview.tasks.map((task) => ({ ...task }));
    const imported: SpecKitImportedTaskResult[] = [];
    const skipped: SpecKitImportResult["skipped"] = [];
    const usedIds = new Set(duplicateLookup.tasks.map((task) => task.id));

    for (const taskInput of providedTasks) {
      if (taskInput.include === false) {
        skipped.push({
          sourceId: taskInput.sourceId,
          title: taskInput.title,
          reason: "excluded",
        });
        continue;
      }

      const duplicate = findDuplicate(duplicateLookup, taskInput);
      if (duplicate) {
        skipped.push({
          sourceId: taskInput.sourceId,
          title: taskInput.title,
          reason: "duplicate",
          duplicateTaskId: duplicate.id,
        });
        continue;
      }

      const contextPaths = sourceArtifactPathsForTask(taskInput, preview);
      const created = this.repository.createTask({
        id: uniqueTaskId(
          `task-${preview.feature.id}-${taskInput.sourceId}`,
          usedIds,
        ),
        projectId: preview.project.id,
        featureId: preview.feature.id,
        title: taskInput.title,
        description: taskInput.description || fallbackDescription(taskInput),
        status: taskInput.status ?? "backlog",
        owner: taskInput.owner ?? "unassigned",
        mode: taskInput.mode ?? "execute",
        risk: taskInput.risk ?? "low",
        source: "spec-kit",
        labels: uniqueStrings(["spec-kit", ...(taskInput.labels ?? [])]),
        acceptanceCriteria: taskInput.acceptanceCriteria ?? [],
        dependencies: taskInput.dependencies ?? [],
        handoff: {
          available: false,
          contextPaths,
        },
      });
      const task = this.repository.appendTaskEvent(created.id, {
        type: "TASK_IMPORTED",
        actor: "system",
        message: `Imported from Spec Kit task ${taskInput.sourceId}.`,
        metadata: {
          sourceId: taskInput.sourceId,
          sourceLine: taskInput.sourceLine ?? null,
          tasksPath: preview.tasksPath,
          sourceArtifactPaths: contextPaths.join("\n"),
        },
      });
      const generated = this.generateContext({
        task,
        project: preview.project,
        feature: preview.feature,
      });

      imported.push({ task, generated, sourceId: taskInput.sourceId });
      duplicateLookup.tasks.push(task);
      addDuplicateKeys(duplicateLookup, task);
    }

    return {
      project: preview.project,
      feature: preview.feature,
      imported,
      skipped,
      preview,
    };
  }

  private getImportContext(featureId: string): { project: Project; feature: Feature } {
    const persistedFeature = this.repository.getFeature(featureId);
    const project = this.repository.getProject(persistedFeature.projectId);
    const feature = refreshFeatureArtifactStatus(project, persistedFeature);

    if (!feature.tasksPath || !feature.artifacts.tasks.exists) {
      throw new ValidationError("Feature tasks.md artifact was not found.");
    }

    return { project, feature };
  }

  private findDuplicateTasks(feature: Feature): DuplicateLookup {
    const tasks = this.repository
      .listBoardData(feature.projectId)
      .tasks.filter(
        (task) => task.featureId === feature.id && task.source === "spec-kit",
      );
    const lookup: DuplicateLookup = {
      tasks: [...tasks],
      bySourceId: new Map(),
      byTitle: new Map(),
    };

    for (const task of tasks) {
      addDuplicateKeys(lookup, task);
    }

    return lookup;
  }

  private generateContext(input: {
    task: PersistedTask;
    project: Project;
    feature: Feature;
  }): GeneratedTaskContext {
    try {
      return this.contextService.generateTaskContext(input);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown file error.";
      throw new TaskContextActionError(
        `Loop Control Plane could not write imported task context files: ${reason}`,
      );
    }
  }
}

interface DuplicateLookup {
  tasks: PersistedTask[];
  bySourceId: Map<string, PersistedTask>;
  byTitle: Map<string, PersistedTask>;
}

const normalizeImportTask = (task: SpecKitImportTaskInput): SpecKitImportTaskInput => {
  if (!task || typeof task !== "object") {
    throw new ValidationError("Import task payload must be an object.");
  }

  if (typeof task.sourceId !== "string" || !task.sourceId.trim()) {
    throw new ValidationError("Import task sourceId must be a non-empty string.");
  }

  if (typeof task.title !== "string" || !task.title.trim()) {
    throw new ValidationError("Import task title must be a non-empty string.");
  }

  return {
    ...task,
    sourceId: task.sourceId.trim(),
    title: task.title.trim(),
    description: typeof task.description === "string" ? task.description.trim() : "",
    labels: assertOptionalStringArray(task.labels, "labels"),
    dependencies: assertOptionalStringArray(task.dependencies, "dependencies"),
    acceptanceCriteria: assertOptionalStringArray(
      task.acceptanceCriteria,
      "acceptanceCriteria",
    ),
    fileReferences: assertOptionalStringArray(task.fileReferences, "fileReferences"),
    notes: assertOptionalStringArray(task.notes, "notes"),
    sourceArtifactPaths: assertOptionalStringArray(
      task.sourceArtifactPaths,
      "sourceArtifactPaths",
    ),
    status: assertOptionalStatus(task.status),
  };
};

const assertOptionalStringArray = (
  value: unknown,
  fieldName: string,
): string[] | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ValidationError(`${fieldName} must be an array of strings.`);
  }

  return value.map((item) => item.trim()).filter(Boolean);
};

const assertOptionalStatus = (value: unknown): KanbanStatus | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (
    typeof value !== "string" ||
    !KANBAN_COLUMNS.some((column) => column.id === value)
  ) {
    throw new ValidationError("status must be a valid Kanban status.");
  }

  return value as KanbanStatus;
};

const addDuplicateKeys = (lookup: DuplicateLookup, task: PersistedTask): void => {
  const sourceId = task.events
    .find((event) => event.type === "TASK_IMPORTED")
    ?.metadata?.sourceId;

  if (typeof sourceId === "string" && sourceId) {
    lookup.bySourceId.set(sourceId, task);
  }

  lookup.byTitle.set(normalizeTitle(task.title), task);
};

const findDuplicate = (
  lookup: DuplicateLookup,
  task: Pick<SpecKitImportTaskInput, "sourceId" | "title">,
): PersistedTask | undefined =>
  lookup.bySourceId.get(task.sourceId) ?? lookup.byTitle.get(normalizeTitle(task.title));

const sourceArtifactPathsForTask = (
  task: SpecKitImportTaskInput,
  preview: SpecKitImportPreview,
): string[] =>
  uniqueStrings(
    task.sourceArtifactPaths && task.sourceArtifactPaths.length > 0
      ? task.sourceArtifactPaths
      : preview.tasks.find((candidate) => candidate.sourceId === task.sourceId)
          ?.sourceArtifactPaths ?? featureSourceArtifactPaths(preview.feature),
  );

const featureSourceArtifactPaths = (feature: Feature): string[] =>
  uniqueStrings(
    Object.values(feature.artifacts)
      .filter((artifact) => artifact.exists)
      .map((artifact) => artifact.path),
  );

const artifactLinksFromFeature = (feature: Feature): SpecKitArtifactLink[] =>
  Object.values(feature.artifacts).map((artifact) => ({
    name: artifact.name,
    fileName: artifact.fileName,
    path: artifact.path,
    exists: artifact.exists,
  }));

const absoluteProjectPath = (project: Project, storedPath: string): string =>
  isAbsolute(storedPath) ? resolve(storedPath) : resolve(project.repoPath, storedPath);

const uniqueTaskId = (baseId: string, usedIds: Set<string>): string => {
  const base = safeId(baseId);
  let candidate = base;
  let suffix = 2;

  while (usedIds.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }

  usedIds.add(candidate);
  return candidate;
};

const safeId = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "task-imported";

const normalizeTitle = (title: string): string =>
  title.trim().replace(/\s+/g, " ").toLowerCase();

const fallbackDescription = (task: SpecKitImportTaskInput): string =>
  [
    task.headings && task.headings.length > 0
      ? `Spec Kit headings: ${task.headings.join(" > ")}.`
      : "",
    task.notes && task.notes.length > 0 ? task.notes.join("\n") : "",
    task.sourceText ? `Source:\n${task.sourceText}` : "",
  ]
    .filter(Boolean)
    .join("\n\n") || "Imported from Spec Kit tasks.md.";

const uniqueStrings = (values: string[]): string[] =>
  Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
