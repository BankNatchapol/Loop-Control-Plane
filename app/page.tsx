"use client";

import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import clsx from "clsx";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  CircleDot,
  Columns3,
  Code2,
  Copy,
  Database,
  ExternalLink,
  FileDown,
  FileText,
  FolderGit2,
  FolderOpen,
  GitBranch,
  GitPullRequest,
  GripVertical,
  Hand,
  Hash,
  Import as ImportIcon,
  ListRestart,
  PauseCircle,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldAlert,
  SquareCheck,
  Trash2,
  UserCheck,
  User,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  LoopBoardApiError,
  approveFeatureArtifact,
  applyPersistedTaskAction,
  checkProjectGitHubConnection,
  createPersistedTaskGitHubIssue,
  createFeature,
  createProject,
  deleteFeature,
  deleteProject,
  exportPersistedTaskEvents,
  fetchPersistedTaskHandoff,
  fetchFeatureArtifactDocument,
  fetchTaskContextStatus,
  enqueueEngineDemoJob,
  enqueueTaskLoop,
  fetchBoardData,
  fetchBackendAvailability,
  fetchEngineStatus,
  generatePersistedTaskClaudeCodePrompt,
  importSpecKitTasks,
  movePersistedTask,
  openProject,
  openTask,
  previewSpecKitTasks,
  refreshPersistedTaskHandoff,
  savePersistedTaskHandoff,
  saveFeatureArtifactDocument,
  startEngineScheduler,
  stopEngineScheduler,
  setupProjectGitHubLabels,
  tickEngine,
  syncPersistedTaskGitHubIssueLabels,
  syncPersistedTaskGitHubPullRequest,
  updateAutomationSettings,
  updateFeature,
  updateProject,
  type FeatureArtifactDocument,
  type GitHubConnectionCheck,
  type GitHubLabelSetupResult,
  type SpecKitImportPreview,
  type SpecKitImportPreviewTask,
  type ClaudeCodePromptActionResult,
  type HandoffDocumentActionResult,
  type TaskContextActionResult,
  type TaskOpenActionResult,
  type BackendAvailabilityResponse,
} from "@/lib/api/loopboard-client";
import type { EngineStatusResponse, EngineJobSummary } from "@/lib/api/engine-actions";
import { isTaskStructurallyEligible } from "@/lib/engine/task-loop-planner";
import {
  EXECUTOR_BACKENDS,
  type EngineJobStatus,
  type EngineSchedulerState,
  type ExecutorBackend,
} from "@/lib/engine/loop-engine-types";
import type { TaskContextStatus } from "@/lib/context/task-context-service";
import type { BoardData, PersistedTask } from "@/lib/db/loopboard-repository";
import { WorkflowEditor } from "@/app/workflow-editor";
import {
  defaultAutomationSettings,
  describeEffectiveAutomationPolicy,
  evaluateTaskActionPolicy,
} from "@/lib/policies/automation-policy";
import {
  KANBAN_COLUMNS,
  FEATURE_ARTIFACT_FILES,
  featureArtifactCompleteness,
  featureStatusLabel,
  defaultProjectEngineSettings,
  type KanbanStatus,
  type Feature,
  type FeatureApprovalArtifactName,
  type FeatureArtifactName,
  type FeatureStatus,
  type RiskLevel,
  type Project,
  type ProjectAutomationPolicy,
  type ProjectEngineSettings,
  type TaskMode,
  type TaskOwner,
  type TaskSource,
  type TaskAction,
  type Task,
  type TaskEvent,
  formatTimestamp,
  riskStyle,
  statusLabel,
  tasksByStatus,
} from "@/lib/loopboard";

const SELECTED_PROJECT_STORAGE_KEY = "loopboard.ui.selected-project-id";
const SELECTED_TASK_STORAGE_KEY = "loopboard.ui.selected-task-id";
const SELECTED_FEATURE_STORAGE_KEY = "loopboard.ui.selected-feature-id";
const BOARD_QUICK_FILTER_STORAGE_KEY = "loopboard.ui.board-quick-filter";

const emptyBoardData: BoardData = {
  projects: [],
  features: [],
  tasks: [],
  latestWorkflowRuns: [],
  automationSettings: defaultAutomationSettings,
};

type ProjectFormState = {
  name: string;
  description: string;
  repoPath: string;
  repository: string;
  githubRepository: string;
  specKitRoot: string;
  specsPath: string;
  tasksPath: string;
  workflowsPath: string;
  handoffsPath: string;
  automationPolicy: ProjectAutomationPolicy;
  engineSettings: ProjectEngineSettings;
};

type FeatureFormState = {
  name: string;
  summary: string;
  source: TaskSource;
  artifactFolderPath: string;
  status: FeatureStatus;
};

type EditableSpecKitTask = SpecKitImportPreviewTask & {
  include: boolean;
  status: KanbanStatus;
};

type BoardQuickFilter =
  | "all"
  | "ai-running"
  | "human-working"
  | "needs-review"
  | "blocked"
  | "ci-failed"
  | "done";

type DashboardMetric = {
  id?: BoardQuickFilter;
  label: string;
  value: number;
  detail?: string;
};

const boardQuickFilters: BoardQuickFilter[] = [
  "all",
  "ai-running",
  "human-working",
  "needs-review",
  "blocked",
  "ci-failed",
  "done",
];

const emptyProjectForm: ProjectFormState = {
  name: "",
  description: "",
  repoPath: "",
  repository: "",
  githubRepository: "",
  specKitRoot: "",
  specsPath: "specs",
  tasksPath: "tasks",
  workflowsPath: "workflows",
  handoffsPath: "handoffs",
  automationPolicy: {
    allowLowRiskAutoIssueCreation: true,
    allowLowRiskAutoAoReadyLabeling: true,
    allowLowRiskAutoTaskExecution: false,
    mediumRiskRequiresReview: true,
    highRiskManualOnly: true,
  },
  engineSettings: defaultProjectEngineSettings,
};

const projectToForm = (project?: Project): ProjectFormState =>
  project
    ? {
        name: project.name,
        description: project.description,
        repoPath: project.repoPath,
        repository: project.repository,
        githubRepository: project.githubRepository,
        specKitRoot: project.specKitRoot,
        specsPath: project.specsPath,
        tasksPath: project.tasksPath,
        workflowsPath: project.workflowsPath,
        handoffsPath: project.handoffsPath,
        automationPolicy: project.automationPolicy,
        engineSettings: project.engineSettings,
      }
    : emptyProjectForm;

const emptyFeatureForm: FeatureFormState = {
  name: "",
  summary: "",
  source: "spec-kit",
  artifactFolderPath: "",
  status: "prd-draft",
};

const featureStatuses: FeatureStatus[] = [
  "prd-draft",
  "spec-review",
  "spec-approved",
  "plan-review",
  "plan-approved",
  "tasks-ready",
  "in-execution",
  "done",
];

const featureSources: TaskSource[] = ["spec-kit", "github", "manual", "playbook"];
const featureArtifactNames = Object.keys(FEATURE_ARTIFACT_FILES) as FeatureArtifactName[];
const taskOwners: TaskOwner[] = ["unassigned", "ai", "human", "pairing"];
const taskModes: TaskMode[] = ["spec", "plan", "execute", "review", "handoff"];
const riskLevels: RiskLevel[] = ["low", "medium", "high", "critical"];

const splitEditableList = (value: string): string[] =>
  value
    .split(/\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);

const joinEditableList = (values: string[]): string => values.join("\n");

const specKitTaskKey = (task: Pick<SpecKitImportPreviewTask, "sourceId" | "sourceLine">) =>
  `${task.sourceId}:${task.sourceLine}`;

const previewTaskToEditable = (task: SpecKitImportPreviewTask): EditableSpecKitTask => ({
  ...task,
  include: !task.duplicate,
  status: task.completed ? "done" : "backlog",
});

const taskImportEvent = (task: Task) =>
  [...task.events].reverse().find((event) => event.type === "TASK_IMPORTED");

const taskSourceArtifactPaths = (task: Task): string[] => {
  const metadataPaths = taskImportEvent(task)?.metadata?.sourceArtifactPaths;

  if (typeof metadataPaths === "string" && metadataPaths.trim()) {
    return metadataPaths
      .split("\n")
      .map((path) => path.trim())
      .filter(Boolean);
  }

  return task.handoff.contextPaths;
};

const fileHref = (path: string): string =>
  /^(https?:|file:)/.test(path) ? path : `file://${path}`;

const displayLocalPath = (repoPath: string, path: string): string => {
  const trimmedPath = path.trim();

  if (!trimmedPath) {
    return "";
  }

  if (trimmedPath.startsWith("/")) {
    return trimmedPath;
  }

  return `${repoPath.replace(/\/+$/, "")}/${trimmedPath}`;
};

const featureToForm = (feature?: Feature): FeatureFormState =>
  feature
    ? {
        name: feature.name,
        summary: feature.summary,
        source: feature.source,
        artifactFolderPath: feature.artifactFolderPath,
        status: feature.status,
      }
    : emptyFeatureForm;

const ownerIcon = {
  unassigned: CircleDot,
  ai: Bot,
  human: User,
  pairing: Hand,
} as const;

const healthTone = {
  passing: "border-emerald-200 bg-emerald-50 text-emerald-800",
  failing: "border-red-200 bg-red-50 text-red-800",
  pending: "border-amber-200 bg-amber-50 text-amber-800",
  "not-started": "border-slate-200 bg-slate-50 text-slate-700",
} as const;

const reviewTone = {
  approved: "border-emerald-200 bg-emerald-50 text-emerald-800",
  requested: "border-sky-200 bg-sky-50 text-sky-800",
  "changes-requested": "border-orange-200 bg-orange-50 text-orange-800",
  "not-requested": "border-slate-200 bg-slate-50 text-slate-700",
} as const;

const taskActions: {
  id: TaskAction;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { id: "assign-ai", label: "Assign to AI", icon: Bot },
  { id: "approve-ao-ready", label: "Approve AO Ready", icon: ShieldAlert },
  { id: "claim-human", label: "Claim for Myself", icon: UserCheck },
  { id: "pause-ai", label: "Pause AI", icon: PauseCircle },
  { id: "return-ai", label: "Return to AI", icon: RotateCcw },
  { id: "mark-blocked", label: "Mark Blocked", icon: AlertTriangle },
  { id: "mark-done", label: "Mark Done", icon: SquareCheck },
];

function compactText(value: string) {
  return value.replaceAll("-", " ");
}

const gitHubSyncEventTypes = new Set<string>([
  "PR_OPENED",
  "CI_RUNNING",
  "CI_FAILED",
  "CI_PASSED",
  "REVIEW_REQUESTED",
  "REVIEW_CHANGES_REQUESTED",
  "REVIEW_APPROVED",
]);

type EventTimelineGroup = {
  id: string;
  createdAt: string;
  actor: TaskEvent["actor"];
  type: string;
  events: TaskEvent[];
  links: Array<{ label: string; url: string }>;
  isExternalGitHubSignal: boolean;
};

const groupEventTimeline = (events: TaskEvent[]): EventTimelineGroup[] => {
  const groups: EventTimelineGroup[] = [];

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];

    if (gitHubSyncEventTypes.has(event.type)) {
      const groupedEvents = [event];
      while (
        index + 1 < events.length &&
        gitHubSyncEventTypes.has(events[index + 1].type) &&
        events[index + 1].createdAt === event.createdAt
      ) {
        groupedEvents.push(events[index + 1]);
        index += 1;
      }

      groups.push({
        id: groupedEvents.map((item) => item.id).join(":"),
        createdAt: event.createdAt,
        actor: event.actor,
        type: "GITHUB_SYNC",
        events: groupedEvents,
        links: eventLinkEntries(groupedEvents),
        isExternalGitHubSignal: groupedEvents.some(isExternalGitHubEvent),
      });
      continue;
    }

    groups.push({
      id: event.id,
      createdAt: event.createdAt,
      actor: event.actor,
      type: event.type,
      events: [event],
      links: eventLinkEntries([event]),
      isExternalGitHubSignal: isExternalGitHubEvent(event),
    });
  }

  return groups;
};

const isExternalGitHubEvent = (event: TaskEvent): boolean =>
  event.type === "CI_FAILED" ||
  event.type === "REVIEW_REQUESTED" ||
  event.type === "REVIEW_CHANGES_REQUESTED" ||
  event.type === "REVIEW_APPROVED";

const eventLinkEntries = (
  events: TaskEvent[],
): Array<{ label: string; url: string }> => {
  const links: Array<{ label: string; url: string }> = [];

  for (const event of events) {
    const metadata = event.metadata ?? {};
    if (typeof metadata.pullRequestUrl === "string" && metadata.pullRequestUrl) {
      links.push({ label: "PR", url: metadata.pullRequestUrl });
    }
    if (typeof metadata.reviewUrl === "string" && metadata.reviewUrl) {
      links.push({ label: "review", url: metadata.reviewUrl });
    }
    if (typeof metadata.ciFailureSummary === "string") {
      for (const url of extractUrls(metadata.ciFailureSummary)) {
        links.push({ label: "failed check", url });
      }
    }
  }

  return Array.from(
    new Map(links.map((link) => [`${link.label}:${link.url}`, link])).values(),
  );
};

const extractUrls = (value: string): string[] =>
  Array.from(new Set(value.match(/https?:\/\/[^\s)]+/gu) ?? []));

function aoHandoffState(task: Task): {
  label: string;
  message: string;
  className: string;
} {
  const hasIssue = Boolean(task.github.issueNumber || task.github.issueUrl);

  if (!hasIssue) {
    return {
      label: "ao not linked",
      message: "Create a GitHub issue before preparing Agent Orchestrator handoff.",
      className: "border-slate-200 bg-slate-50 text-slate-600",
    };
  }

  if (task.github.issueLabels?.includes("ao-ready")) {
    return {
      label: "ao ready",
      message: "This linked issue is marked ao-ready for Agent Orchestrator handoff.",
      className: "border-emerald-200 bg-emerald-50 text-emerald-800",
    };
  }

  if (task.owner !== "ai") {
    return {
      label: "ao waiting",
      message: "Assign this task to AI before applying ao-ready.",
      className: "border-slate-200 bg-slate-50 text-slate-600",
    };
  }

  if (task.risk === "low") {
    return {
      label: "ao pending",
      message: "Low-risk AI assignment can receive ao-ready on assignment.",
      className: "border-sky-200 bg-sky-50 text-sky-800",
    };
  }

  if (task.github.aoReadyApprovedAt) {
    return {
      label: "ao approved",
      message: "Local risk approval is recorded; ao-ready can be applied on assignment.",
      className: "border-sky-200 bg-sky-50 text-sky-800",
    };
  }

  return {
    label: "ao approval needed",
    message: "Medium, high, and critical risk tasks require local approval before ao-ready.",
    className: "border-orange-200 bg-orange-50 text-orange-800",
  };
}

const taskHasFailedCi = (task: Task) =>
  task.github.ciStatus === "failing" ||
  task.github.deliveryStatus === "ci-failed";

function workflowCounters(tasks: Task[]): DashboardMetric[] {
  return [
    {
      id: "ai-running",
      label: "AI Running",
      value: tasks.filter((task) => task.status === "ai-running").length,
    },
    {
      id: "human-working",
      label: "Human Working",
      value: tasks.filter((task) => task.status === "human-working").length,
    },
    {
      id: "needs-review",
      label: "Needs Review",
      value: tasks.filter((task) => task.status === "needs-review").length,
    },
    {
      id: "blocked",
      label: "Blocked",
      value: tasks.filter((task) => task.status === "blocked").length,
    },
    {
      id: "ci-failed",
      label: "CI Failed",
      value: tasks.filter(taskHasFailedCi).length,
    },
    {
      id: "done",
      label: "Done",
      value: tasks.filter((task) => task.status === "done").length,
    },
    {
      id: "all",
      label: "All Tasks",
      value: tasks.length,
    },
  ];
}

function statusMetrics(tasks: Task[]): DashboardMetric[] {
  return KANBAN_COLUMNS.map((column) => ({
    label: column.label,
    value: tasks.filter((task) => task.status === column.id).length,
  }));
}

function ownerMetrics(tasks: Task[]): DashboardMetric[] {
  return taskOwners.map((owner) => ({
    label: compactText(owner),
    value: tasks.filter((task) => task.owner === owner).length,
  }));
}

function riskMetrics(tasks: Task[]): DashboardMetric[] {
  return riskLevels.map((risk) => ({
    label: risk,
    value: tasks.filter((task) => task.risk === risk).length,
  }));
}

function applyBoardQuickFilter(tasks: Task[], filter: BoardQuickFilter): Task[] {
  if (filter === "needs-review") {
    return tasks.filter((task) => task.status === "needs-review");
  }

  if (filter === "ci-failed") {
    return tasks.filter(taskHasFailedCi);
  }

  if (filter === "ai-running") {
    return tasks.filter((task) => task.status === "ai-running");
  }

  if (filter === "human-working") {
    return tasks.filter((task) => task.status === "human-working");
  }

  if (filter === "blocked") {
    return tasks.filter((task) => task.status === "blocked");
  }

  if (filter === "done") {
    return tasks.filter((task) => task.status === "done");
  }

  return tasks;
}

const isBoardQuickFilter = (value: string | null): value is BoardQuickFilter =>
  value !== null && boardQuickFilters.includes(value as BoardQuickFilter);

function BoardColumn({
  id,
  label,
  tasks,
  featuresById,
  selectedTaskId,
  taskRunJobsByTaskId,
  onSelectTask,
}: {
  id: KanbanStatus;
  label: string;
  tasks: Task[];
  featuresById: Map<string, Feature>;
  selectedTaskId: string;
  taskRunJobsByTaskId: Map<string, EngineJobSummary>;
  onSelectTask: (taskId: string) => void;
}) {
  const { isOver, setNodeRef } = useDroppable({ id });

  return (
    <section
      ref={setNodeRef}
      className={clsx(
        "flex min-h-[28rem] w-[min(82vw,18.5rem)] shrink-0 flex-col border-r border-slate-200 bg-slate-50/80 sm:min-h-[34rem] sm:w-[19rem]",
        isOver && "bg-sky-50",
      )}
    >
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/95 px-3 py-3 backdrop-blur">
        <div className="flex items-center justify-between gap-3">
          <h2 className="min-w-0 text-sm font-semibold text-slate-950">
            {label}
          </h2>
          <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs font-semibold text-slate-600">
            {tasks.length}
          </span>
        </div>
      </header>

      <div className="flex flex-1 flex-col gap-2 p-2">
        {tasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            feature={featuresById.get(task.featureId)}
            selected={task.id === selectedTaskId}
            engineJob={taskRunJobsByTaskId.get(task.id)}
            onSelectTask={onSelectTask}
          />
        ))}
        {tasks.length === 0 ? (
          <div className="flex min-h-24 items-center justify-center border border-dashed border-slate-300 bg-white/70 px-3 text-center text-xs font-medium text-slate-500">
            Drop tasks here
          </div>
        ) : null}
      </div>
    </section>
  );
}

function TaskCard({
  task,
  feature,
  selected,
  engineJob,
  onSelectTask,
}: {
  task: Task;
  feature?: Feature;
  selected: boolean;
  engineJob?: EngineJobSummary;
  onSelectTask: (taskId: string) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    isDragging,
  } = useDraggable({ id: task.id });
  const OwnerIcon = ownerIcon[task.owner];
  const sourceArtifactPaths = taskSourceArtifactPaths(task);
  const aoState = aoHandoffState(task);
  const style = {
    transform: CSS.Translate.toString(transform),
  };

  return (
    <article
      ref={setNodeRef}
      style={style}
      className={clsx(
        "border bg-white p-3 text-left shadow-sm transition",
        selected ? "border-sky-400 ring-2 ring-sky-100" : "border-slate-200",
        isDragging && "z-20 opacity-80 shadow-lg",
      )}
    >
      <button
        type="button"
        className="block w-full text-left"
        onClick={() => onSelectTask(task.id)}
        {...listeners}
        {...attributes}
      >
        <div className="flex min-w-0 items-start justify-between gap-2">
          <GripVertical className="mt-0.5 h-4 w-4 shrink-0 text-slate-300" />
          <h3 className="min-w-0 text-sm font-semibold leading-5 text-slate-950 [overflow-wrap:anywhere]">
            {task.title}
          </h3>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
            {engineJob?.status === "queued" ? (
              <span
                className="border border-sky-200 bg-sky-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-sky-800"
                data-testid={`task-engine-badge-${task.id}`}
              >
                engine queued
              </span>
            ) : engineJob?.status === "running" ? (
              <span
                className="border border-indigo-200 bg-indigo-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-indigo-800"
                data-testid={`task-engine-badge-${task.id}`}
              >
                engine running
              </span>
            ) : null}
            <span className={clsx("border px-1.5 py-0.5 text-[10px] font-semibold uppercase", riskStyle(task.risk))}>
              {task.risk}
            </span>
          </div>
        </div>
        <p className="mt-2 line-clamp-2 text-xs leading-5 text-slate-600">
          {task.description}
        </p>

        <div className="mt-3 flex flex-wrap gap-1.5">
          <MetaPill icon={OwnerIcon} text={task.owner} />
          <MetaPill icon={PauseCircle} text={task.mode} />
          {feature ? (
            <MetaPill icon={Columns3} text={feature.name} />
          ) : null}
          {task.source === "spec-kit" ? (
            <MetaPill icon={ImportIcon} text="spec kit" />
          ) : null}
          {task.source === "spec-kit" && sourceArtifactPaths.length > 0 ? (
            <MetaPill
              icon={FileText}
              text={`${sourceArtifactPaths.length} source file${
                sourceArtifactPaths.length === 1 ? "" : "s"
              }`}
            />
          ) : null}
          {task.handoff.available ? <MetaPill icon={Hand} text="handoff" /> : null}
        </div>
        {feature ? <FeatureCompletenessBar feature={feature} compact /> : null}

        <div className="mt-3 grid gap-1.5 text-[11px] text-slate-600">
          <MetaLine icon={GitBranch} text={task.branch} />
          <MetaLine icon={Hash} text={task.worktree} />
          {task.github.issueUrl ? (
            <MetaLine icon={ExternalLink} text={task.github.issueUrl} />
          ) : null}
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {task.github.issueNumber ? (
            <MetaPill icon={Hash} text={`issue ${task.github.issueNumber}`} />
          ) : null}
          {task.github.issueLabels?.map((label) => (
            <MetaPill
              key={`${task.id}-${label}`}
              icon={label === "ao-ready" ? Bot : Hash}
              text={label}
            />
          ))}
          {task.github.issueNumber || task.github.issueUrl ? (
            <span className={clsx("border px-1.5 py-0.5 text-[10px] font-semibold uppercase", aoState.className)}>
              {aoState.label}
            </span>
          ) : null}
          {task.github.pullRequestNumber ? (
            <MetaPill
              icon={GitPullRequest}
              text={`pr ${task.github.pullRequestNumber}`}
            />
          ) : null}
          {task.github.ciStatus ? (
            <span className={clsx("border px-1.5 py-0.5 text-[10px] font-semibold uppercase", healthTone[task.github.ciStatus])}>
              ci {compactText(task.github.ciStatus)}
            </span>
          ) : null}
          {task.github.reviewStatus ? (
            <span className={clsx("border px-1.5 py-0.5 text-[10px] font-semibold uppercase", reviewTone[task.github.reviewStatus])}>
              review {compactText(task.github.reviewStatus)}
            </span>
          ) : null}
        </div>

        <div className="mt-3 flex flex-wrap gap-1">
          {task.labels.slice(0, 4).map((label) => (
            <span
              key={label}
              className="max-w-full border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-medium text-slate-600 [overflow-wrap:anywhere]"
            >
              {label}
            </span>
          ))}
        </div>
      </button>
    </article>
  );
}

function MetaPill({
  icon: Icon,
  text,
}: {
  icon: React.ComponentType<{ className?: string }>;
  text: string;
}) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-slate-700">
      <Icon className="h-3 w-3 shrink-0" />
      <span className="min-w-0 truncate">{compactText(text)}</span>
    </span>
  );
}

function MetaLine({
  icon: Icon,
  text,
}: {
  icon: React.ComponentType<{ className?: string }>;
  text: string;
}) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Icon className="h-3.5 w-3.5 shrink-0 text-slate-400" />
      <span className="min-w-0 truncate font-mono">{text}</span>
    </span>
  );
}

function DetailLink({
  href,
  label,
  icon: Icon,
}: {
  href?: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}) {
  if (!href) {
    return null;
  }

  return (
    <a
      href={href}
      className="inline-flex min-w-0 items-center gap-1.5 border border-slate-200 bg-slate-50 px-2 py-1 text-xs font-semibold text-slate-700 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-800"
      target="_blank"
      rel="noreferrer"
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{label}</span>
      <ExternalLink className="h-3 w-3 shrink-0 text-slate-400" />
    </a>
  );
}

function ContextPathRow({
  label,
  path,
  exists,
  onCopy,
}: {
  label: string;
  path: string;
  exists: boolean;
  onCopy: (path: string) => void;
}) {
  return (
    <div className="grid gap-2 border border-slate-200 bg-slate-50 p-2">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase text-slate-500">
            {label}
          </p>
          <p className="mt-1 truncate font-mono text-xs text-slate-700">
            {path}
          </p>
        </div>
        <span
          className={clsx(
            "shrink-0 border px-1.5 py-0.5 text-[10px] font-semibold uppercase",
            exists
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : "border-slate-200 bg-white text-slate-500",
          )}
        >
          {exists ? "exists" : "missing"}
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={() => onCopy(path)}
          className="inline-flex items-center gap-1.5 border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-800"
        >
          <Copy className="h-3.5 w-3.5" />
          Copy
        </button>
        {exists ? (
          <a
            href={`file://${path}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-800"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Open
          </a>
        ) : null}
      </div>
    </div>
  );
}

function CopyValueRow({
  label,
  value,
  badge,
  href,
  onCopy,
}: {
  label: string;
  value: string;
  badge?: string;
  href?: string;
  onCopy: (value: string) => void;
}) {
  return (
    <div className="grid gap-2 border border-slate-200 bg-slate-50 p-2">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase text-slate-500">
            {label}
          </p>
          <p className="mt-1 truncate font-mono text-xs text-slate-700">
            {value}
          </p>
        </div>
        {badge ? (
          <span className="shrink-0 border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] font-semibold uppercase text-slate-600">
            {badge}
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={() => onCopy(value)}
          className="inline-flex items-center gap-1.5 border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-800"
        >
          <Copy className="h-3.5 w-3.5" />
          Copy
        </button>
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-800"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Open
          </a>
        ) : null}
      </div>
    </div>
  );
}

function SourceArtifactRow({
  path,
  onCopy,
}: {
  path: string;
  onCopy: (path: string) => void;
}) {
  return (
    <div className="grid gap-2 border border-slate-200 bg-slate-50 p-2">
      <p className="truncate font-mono text-xs text-slate-700">{path}</p>
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={() => onCopy(path)}
          className="inline-flex items-center gap-1.5 border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-800"
        >
          <Copy className="h-3.5 w-3.5" />
          Copy
        </button>
        <a
          href={fileHref(path)}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-800"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          Open
        </a>
      </div>
    </div>
  );
}

function MetricGroup({
  title,
  metrics,
}: {
  title: string;
  metrics: DashboardMetric[];
}) {
  return (
    <div className="min-w-0">
      <p className="text-xs font-semibold uppercase text-slate-500">{title}</p>
      <div className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-3">
        {metrics.map((metric) => (
          <div
            key={`${title}-${metric.label}`}
            className="min-w-0 border border-slate-200 bg-white px-2 py-1.5"
          >
            <p className="truncate text-[11px] font-semibold uppercase text-slate-500">
              {metric.label}
            </p>
            <p className="mt-0.5 text-base font-semibold text-slate-950">
              {metric.value}
            </p>
            {metric.detail ? (
              <p className="truncate text-[10px] text-slate-500">{metric.detail}</p>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

const githubConnectionStyles: Record<GitHubConnectionCheck["status"], string> = {
  disconnected: "border-slate-200 bg-slate-100 text-slate-700",
  "token-missing": "border-amber-200 bg-amber-50 text-amber-800",
  "repo-missing": "border-orange-200 bg-orange-50 text-orange-800",
  connected: "border-emerald-200 bg-emerald-50 text-emerald-800",
  "api-error": "border-red-200 bg-red-50 text-red-800",
};

const githubLabelSetupStyles: Record<GitHubLabelSetupResult["status"], string> = {
  disconnected: "border-slate-200 bg-slate-100 text-slate-700",
  "token-missing": "border-amber-200 bg-amber-50 text-amber-800",
  "repo-missing": "border-orange-200 bg-orange-50 text-orange-800",
  ready: "border-emerald-200 bg-emerald-50 text-emerald-800",
  "api-error": "border-red-200 bg-red-50 text-red-800",
};

function ProjectHealth({
  project,
  githubConnection,
  githubLabelSetup,
  isCheckingGitHub,
  isSettingUpGitHubLabels,
  onCheckGitHub,
  onSetupGitHubLabels,
}: {
  project?: Project;
  githubConnection?: GitHubConnectionCheck | null;
  githubLabelSetup?: GitHubLabelSetupResult | null;
  isCheckingGitHub: boolean;
  isSettingUpGitHubLabels: boolean;
  onCheckGitHub: () => void;
  onSetupGitHubLabels: () => void;
}) {
  if (!project) {
    return null;
  }

  const healthClass = project.isGitRepository
    ? "border-emerald-200 bg-emerald-50 text-emerald-800"
    : "border-amber-200 bg-amber-50 text-amber-800";

  const connectionStatus = githubConnection?.status ?? "disconnected";
  const connectionMessage =
    githubConnection?.message ??
    (project.githubRepository
      ? "Connection has not been checked."
      : "No GitHub repository is configured for this project.");
  const labelSetupStatus = githubLabelSetup?.status ?? "disconnected";
  const labelSetupMessage =
    githubLabelSetup?.message ??
    (project.githubRepository
      ? "Required labels have not been checked."
      : "No GitHub repository is configured for this project.");
  const labelCounts = githubLabelSetup
    ? {
        created: githubLabelSetup.labels.filter((label) => label.status === "created").length,
        exists: githubLabelSetup.labels.filter((label) => label.status === "exists").length,
        error: githubLabelSetup.labels.filter((label) => label.status === "error").length,
      }
    : null;

  return (
    <div className="grid gap-2 border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700 sm:grid-cols-2 xl:grid-cols-6">
      <div className="min-w-0">
        <p className="font-semibold uppercase text-slate-500">Repo Path</p>
        <p className="mt-1 truncate font-mono">{project.repoPath || "not set"}</p>
      </div>
      <div className="min-w-0">
        <p className="font-semibold uppercase text-slate-500">Git Status</p>
        <span className={clsx("mt-1 inline-flex border px-1.5 py-0.5 text-[10px] font-semibold uppercase", healthClass)}>
          {project.isGitRepository ? "git repository" : "not a git repo"}
        </span>
      </div>
      <div className="min-w-0">
        <p className="font-semibold uppercase text-slate-500">Branches</p>
        <p className="mt-1 truncate">
          {project.currentBranch || "detached/unknown"} / {project.defaultBranch || "unknown"}
        </p>
      </div>
      <div className="min-w-0">
        <p className="font-semibold uppercase text-slate-500">GitHub Remote</p>
        <p className="mt-1 truncate">{project.githubRemoteUrl || "none detected"}</p>
      </div>
      <div className="min-w-0">
        <p className="font-semibold uppercase text-slate-500">GitHub Connection</p>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
          <span
            className={clsx(
              "inline-flex border px-1.5 py-0.5 text-[10px] font-semibold uppercase",
              githubConnectionStyles[connectionStatus],
            )}
          >
            {compactText(connectionStatus)}
          </span>
          <button
            type="button"
            onClick={onCheckGitHub}
            disabled={isCheckingGitHub}
            className="inline-flex items-center gap-1 border border-slate-300 bg-white px-1.5 py-0.5 text-[10px] font-semibold uppercase text-slate-700 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw className={clsx("h-3 w-3", isCheckingGitHub && "animate-spin")} />
            Check
          </button>
        </div>
        <p className="mt-1 break-words">{connectionMessage}</p>
        {!project.githubRepository ? (
          <p className="mt-1 border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] leading-5 text-amber-900">
            Add `owner/repo` in project settings before creating issues or syncing PR/CI state.
          </p>
        ) : null}
      </div>
      <div className="min-w-0">
        <p className="font-semibold uppercase text-slate-500">GitHub Labels</p>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
          <span
            className={clsx(
              "inline-flex border px-1.5 py-0.5 text-[10px] font-semibold uppercase",
              githubLabelSetupStyles[labelSetupStatus],
            )}
          >
            {compactText(labelSetupStatus)}
          </span>
          <button
            type="button"
            onClick={onSetupGitHubLabels}
            disabled={isSettingUpGitHubLabels}
            className="inline-flex items-center gap-1 border border-slate-300 bg-white px-1.5 py-0.5 text-[10px] font-semibold uppercase text-slate-700 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw className={clsx("h-3 w-3", isSettingUpGitHubLabels && "animate-spin")} />
            Set up
          </button>
        </div>
        <p className="mt-1 break-words">{labelSetupMessage}</p>
        {labelCounts ? (
          <p className="mt-1 text-[10px] font-semibold uppercase text-slate-500">
            {labelCounts.created} created / {labelCounts.exists} existing / {labelCounts.error} errors
          </p>
        ) : null}
      </div>
    </div>
  );
}

const engineSchedulerStyles: Record<EngineSchedulerState, string> = {
  stopped: "border-slate-200 bg-slate-100 text-slate-700",
  running: "border-emerald-200 bg-emerald-50 text-emerald-800",
  paused: "border-amber-200 bg-amber-50 text-amber-800",
};

const engineJobStatusStyles: Record<EngineJobStatus, string> = {
  queued: "border-sky-200 bg-sky-50 text-sky-800",
  running: "border-indigo-200 bg-indigo-50 text-indigo-800",
  completed: "border-emerald-200 bg-emerald-50 text-emerald-800",
  failed: "border-red-200 bg-red-50 text-red-800",
  cancelled: "border-slate-200 bg-slate-100 text-slate-600",
};

function LoopEnginePanel({
  project,
  engineStatus,
  backendAvailability,
  isLoadingBackendAvailability,
  isLoading,
  engineAction,
  engineError,
  engineMessage,
  globalAutoRunEnabled,
  automationPolicyMessage,
  onRunDemoJob,
  onTickOnce,
  onStartScheduler,
  onStopScheduler,
  onRefresh,
}: {
  project?: Project;
  engineStatus: EngineStatusResponse | null;
  backendAvailability: BackendAvailabilityResponse | null;
  isLoadingBackendAvailability: boolean;
  isLoading: boolean;
  engineAction: string;
  engineError: string;
  engineMessage: string;
  globalAutoRunEnabled: boolean;
  automationPolicyMessage: string;
  onRunDemoJob: () => void;
  onTickOnce: () => void;
  onStartScheduler: () => void;
  onStopScheduler: () => void;
  onRefresh: () => void;
}) {
  if (!project) {
    return null;
  }

  const schedulerStatus = engineStatus?.scheduler.status ?? "stopped";
  const queueDepth =
    (engineStatus?.queueCounts.queued ?? 0) +
    (engineStatus?.queueCounts.running ?? 0);
  const activeBackend =
    engineStatus?.recentJobs.find((job) => job.status === "running")?.backend ??
    engineStatus?.recentJobs[0]?.backend ??
    "none";
  const canStartScheduler = globalAutoRunEnabled;
  const schedulerIsRunning = schedulerStatus === "running";

  return (
    <section
      className="border border-slate-200 bg-slate-50 p-3"
      data-testid="loop-engine-panel"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Bot className="h-4 w-4 text-slate-500" />
            <h2 className="text-sm font-semibold uppercase text-slate-950">
              Loop Engine
            </h2>
            <span
              className={clsx(
                "inline-flex border px-1.5 py-0.5 text-[10px] font-semibold uppercase",
                engineSchedulerStyles[schedulerStatus],
              )}
            >
              {compactText(schedulerStatus)}
            </span>
          </div>
          <p className="mt-1 text-xs leading-5 text-slate-600">
            Hybrid in-app scheduler with stub executor jobs. Manual tick and demo
            enqueue work while global auto-run is disabled.
          </p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={isLoading}
          className="inline-flex items-center gap-1 border border-slate-300 bg-white px-2 py-1 text-[10px] font-semibold uppercase text-slate-700 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RefreshCw className={clsx("h-3 w-3", isLoading && "animate-spin")} />
          Refresh
        </button>
      </div>

      <div className="mt-3 grid gap-2 text-xs text-slate-700 sm:grid-cols-2 xl:grid-cols-4">
        <div className="min-w-0 border border-slate-200 bg-white px-2 py-1.5">
          <p className="font-semibold uppercase text-slate-500">Queue Depth</p>
          <p className="mt-0.5 text-base font-semibold text-slate-950">{queueDepth}</p>
          <p className="mt-0.5 truncate text-[10px] text-slate-500">
            {engineStatus?.queueCounts.queued ?? 0} queued ·{" "}
            {engineStatus?.queueCounts.running ?? 0} running
          </p>
        </div>
        <div className="min-w-0 border border-slate-200 bg-white px-2 py-1.5">
          <p className="font-semibold uppercase text-slate-500">Last Tick</p>
          <p className="mt-0.5 truncate font-semibold text-slate-950">
            {engineStatus?.scheduler.lastTickAt
              ? formatTimestamp(engineStatus.scheduler.lastTickAt)
              : "never"}
          </p>
          <p className="mt-0.5 truncate text-[10px] text-slate-500">
            {engineStatus?.scheduler.tickCount ?? 0} ticks total
          </p>
        </div>
        <div className="min-w-0 border border-slate-200 bg-white px-2 py-1.5">
          <p className="font-semibold uppercase text-slate-500">Active Backend</p>
          <p className="mt-0.5 truncate font-semibold uppercase text-slate-950">
            {activeBackend}
          </p>
          <p className="mt-0.5 truncate text-[10px] text-slate-500">
            {engineStatus?.queueCounts.completed ?? 0} completed ·{" "}
            {engineStatus?.queueCounts.failed ?? 0} failed
          </p>
        </div>
        <div className="min-w-0 border border-slate-200 bg-white px-2 py-1.5">
          <p className="font-semibold uppercase text-slate-500">Scheduler Error</p>
          <p className="mt-0.5 truncate font-semibold text-slate-950">
            {engineStatus?.scheduler.lastError ? "present" : "none"}
          </p>
          <p className="mt-0.5 line-clamp-2 text-[10px] text-slate-500">
            {engineStatus?.scheduler.lastError ?? "No scheduler errors recorded."}
          </p>
        </div>
      </div>

      <div className="mt-3 border border-slate-200 bg-white p-2" data-testid="backend-availability-chips">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-[10px] font-semibold uppercase text-slate-500">
            Backend Availability
          </p>
          {isLoadingBackendAvailability ? (
            <RefreshCw className="h-3 w-3 animate-spin text-slate-400" />
          ) : null}
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {(backendAvailability?.backends ?? []).map((chip) => (
            <span
              key={chip.backend}
              title={chip.message}
              className={clsx(
                "inline-flex border px-1.5 py-0.5 text-[10px] font-semibold uppercase",
                chip.available
                  ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                  : "border-amber-200 bg-amber-50 text-amber-900",
              )}
            >
              {chip.label}
            </span>
          ))}
          {!backendAvailability?.backends.length ? (
            <span className="text-[10px] leading-5 text-slate-500">
              Availability checks have not loaded yet.
            </span>
          ) : null}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onRunDemoJob}
          disabled={engineAction.length > 0}
          className="inline-flex items-center gap-1.5 border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-800 disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="engine-run-demo-job"
        >
          <CircleDot className="h-3.5 w-3.5 shrink-0" />
          Run Demo Job
        </button>
        <button
          type="button"
          onClick={onTickOnce}
          disabled={engineAction.length > 0}
          className="inline-flex items-center gap-1.5 border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-800 disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="engine-tick-once"
        >
          <RefreshCw
            className={clsx(
              "h-3.5 w-3.5 shrink-0",
              engineAction === "tick" && "animate-spin",
            )}
          />
          Tick Once
        </button>
        <button
          type="button"
          onClick={onStartScheduler}
          disabled={!canStartScheduler || schedulerIsRunning || engineAction.length > 0}
          title={
            canStartScheduler
              ? "Start background scheduler ticks"
              : automationPolicyMessage
          }
          className="inline-flex items-center gap-1.5 border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-800 disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="engine-start-scheduler"
        >
          <Play className="h-3.5 w-3.5 shrink-0" />
          Start Scheduler
        </button>
        <button
          type="button"
          onClick={onStopScheduler}
          disabled={!schedulerIsRunning || engineAction.length > 0}
          className="inline-flex items-center gap-1.5 border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-800 disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="engine-stop-scheduler"
        >
          <PauseCircle className="h-3.5 w-3.5 shrink-0" />
          Stop Scheduler
        </button>
      </div>

      {!canStartScheduler ? (
        <p className="mt-2 border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs leading-5 text-amber-900">
          Start Scheduler requires global auto-run. {automationPolicyMessage}
        </p>
      ) : null}

      {engineStatus?.autoAdvance ? (
        <div
          className="mt-2 border border-slate-200 bg-white px-2 py-1.5 text-xs leading-5 text-slate-700"
          data-testid="engine-auto-advance-status"
        >
          <p className="font-semibold uppercase text-slate-500">Auto-Advance</p>
          <p className="mt-1">
            Project:{" "}
            <span className="font-semibold text-slate-950">
              {engineStatus.autoAdvance.projectEnabled ? "enabled" : "disabled"}
            </span>
            {" · "}
            Global auto-run:{" "}
            <span className="font-semibold text-slate-950">
              {engineStatus.autoAdvance.globallyEnabled ? "on" : "off"}
            </span>
            {engineStatus.autoAdvance.active ? (
              <span className="ml-1 font-semibold text-emerald-700">· active</span>
            ) : null}
          </p>
          {engineStatus.autoAdvance.pauseReason ? (
            <p className="mt-1 border border-amber-200 bg-amber-50 px-2 py-1 text-amber-900">
              Paused: {engineStatus.autoAdvance.pauseReason.message}
            </p>
          ) : null}
        </div>
      ) : null}

      {engineError ? (
        <div className="mt-2 border border-red-200 bg-red-50 px-2 py-1.5 text-xs leading-5 text-red-800">
          {engineError}
        </div>
      ) : null}
      {engineMessage ? (
        <div className="mt-2 border border-emerald-200 bg-emerald-50 px-2 py-1.5 text-xs leading-5 text-emerald-800">
          {engineMessage}
        </div>
      ) : null}

      <div className="mt-3 overflow-x-auto border border-slate-200 bg-white">
        <table className="min-w-full text-left text-xs">
          <thead className="border-b border-slate-200 bg-slate-50 text-[10px] font-semibold uppercase text-slate-500">
            <tr>
              <th className="px-2 py-1.5">Job</th>
              <th className="px-2 py-1.5">Status</th>
              <th className="px-2 py-1.5">Backend</th>
              <th className="px-2 py-1.5">Logs</th>
              <th className="px-2 py-1.5">Updated</th>
            </tr>
          </thead>
          <tbody>
            {(engineStatus?.recentJobs ?? []).length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  className="px-2 py-3 text-center text-slate-500"
                >
                  No engine jobs yet. Run a demo job to seed the queue.
                </td>
              </tr>
            ) : (
              engineStatus?.recentJobs.map((job) => (
                <tr key={job.id} className="border-b border-slate-100 last:border-b-0">
                  <td className="px-2 py-1.5">
                    <p className="font-semibold text-slate-950">{job.kind}</p>
                    <p className="truncate font-mono text-[10px] text-slate-500">
                      {job.id}
                    </p>
                  </td>
                  <td className="px-2 py-1.5">
                    <span
                      className={clsx(
                        "inline-flex border px-1.5 py-0.5 text-[10px] font-semibold uppercase",
                        engineJobStatusStyles[job.status],
                      )}
                    >
                      {compactText(job.status)}
                    </span>
                  </td>
                  <td className="px-2 py-1.5 uppercase">{job.backend}</td>
                  <td className="max-w-xs px-2 py-1.5">
                    <p className="truncate text-slate-700">
                      {job.lastLogMessage ?? `${job.logCount} log entries`}
                    </p>
                    {job.error ? (
                      <p className="truncate text-[10px] text-red-700">{job.error}</p>
                    ) : null}
                  </td>
                  <td className="px-2 py-1.5 whitespace-nowrap text-slate-600">
                    {formatTimestamp(job.completedAt ?? job.startedAt ?? job.queuedAt)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ProjectForm({
  mode,
  form,
  onChange,
  onSubmit,
  onCancel,
  isSaving,
}: {
  mode: "create" | "edit";
  form: ProjectFormState;
  onChange: <K extends keyof ProjectFormState>(
    field: K,
    value: ProjectFormState[K],
  ) => void;
  onSubmit: () => void;
  onCancel: () => void;
  isSaving: boolean;
}) {
  const automationOptions: Array<{
    key: keyof ProjectAutomationPolicy;
    label: string;
    detail: string;
  }> = [
    {
      key: "allowLowRiskAutoIssueCreation",
      label: "Low-risk auto issues",
      detail: "Allow automatic GitHub issue creation only for low-risk tasks.",
    },
    {
      key: "allowLowRiskAutoAoReadyLabeling",
      label: "Low-risk AO-ready",
      detail: "Allow automatic AO-ready labeling only for low-risk tasks.",
    },
    {
      key: "allowLowRiskAutoTaskExecution",
      label: "Low-risk auto task loop",
      detail: "Allow the engine scheduler to pick up and run low-risk Ready tasks.",
    },
    {
      key: "mediumRiskRequiresReview",
      label: "Medium review gates",
      detail: "Require approval before medium-risk automation proceeds.",
    },
    {
      key: "highRiskManualOnly",
      label: "High-risk manual only",
      detail: "Keep high and critical risk work under explicit human control.",
    },
  ];

  return (
    <div className="border border-slate-200 bg-white p-3">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <label className="grid gap-1 text-xs font-semibold uppercase text-slate-500">
          Name
          <input
            value={form.name}
            onChange={(event) => onChange("name", event.target.value)}
            className="min-h-9 border border-slate-300 bg-white px-2 text-sm font-normal normal-case text-slate-950"
          />
        </label>
        <label className="grid gap-1 text-xs font-semibold uppercase text-slate-500 md:col-span-2 xl:col-span-3">
          Repository Path
          <input
            value={form.repoPath}
            onChange={(event) => onChange("repoPath", event.target.value)}
            className="min-h-9 border border-slate-300 bg-white px-2 font-mono text-sm font-normal normal-case text-slate-950"
          />
        </label>
        <label className="grid gap-1 text-xs font-semibold uppercase text-slate-500 md:col-span-2">
          Description
          <input
            value={form.description}
            onChange={(event) => onChange("description", event.target.value)}
            className="min-h-9 border border-slate-300 bg-white px-2 text-sm font-normal normal-case text-slate-950"
          />
        </label>
        <label className="grid gap-1 text-xs font-semibold uppercase text-slate-500">
          Repository Label
          <input
            value={form.repository}
            onChange={(event) => onChange("repository", event.target.value)}
            className="min-h-9 border border-slate-300 bg-white px-2 text-sm font-normal normal-case text-slate-950"
          />
        </label>
        <label className="grid gap-1 text-xs font-semibold uppercase text-slate-500">
          GitHub Repo
          <input
            value={form.githubRepository}
            onChange={(event) => onChange("githubRepository", event.target.value)}
            placeholder="owner/name"
            className="min-h-9 border border-slate-300 bg-white px-2 font-mono text-sm font-normal normal-case text-slate-950"
          />
        </label>
        <label className="grid gap-1 text-xs font-semibold uppercase text-slate-500">
          Spec Kit Root
          <input
            value={form.specKitRoot}
            onChange={(event) => onChange("specKitRoot", event.target.value)}
            className="min-h-9 border border-slate-300 bg-white px-2 font-mono text-sm font-normal normal-case text-slate-950"
          />
        </label>
        {(["specsPath", "tasksPath", "workflowsPath", "handoffsPath"] as const).map((field) => (
          <label
            key={field}
            className="grid gap-1 text-xs font-semibold uppercase text-slate-500"
          >
            {compactText(field)}
            <input
              value={form[field]}
              onChange={(event) => onChange(field, event.target.value)}
              className="min-h-9 border border-slate-300 bg-white px-2 font-mono text-sm font-normal normal-case text-slate-950"
            />
          </label>
        ))}
      </div>
      <div className="mt-3 border border-slate-200 bg-slate-50 p-3">
        <p className="text-xs font-semibold uppercase text-slate-500">
          Project Automation Policy
        </p>
        <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
          {automationOptions.map((option) => (
            <label
              key={option.key}
              className="flex min-h-24 gap-2 border border-slate-200 bg-white p-3 text-sm text-slate-700"
            >
              <input
                type="checkbox"
                checked={form.automationPolicy[option.key]}
                onChange={(event) =>
                  onChange("automationPolicy", {
                    ...form.automationPolicy,
                    [option.key]: event.target.checked,
                  })
                }
                className="mt-1 h-4 w-4 shrink-0 accent-slate-900"
              />
              <span className="min-w-0">
                <span className="block text-xs font-semibold uppercase text-slate-800">
                  {option.label}
                </span>
                <span className="mt-1 block text-xs leading-5 text-slate-500">
                  {option.detail}
                </span>
              </span>
            </label>
          ))}
        </div>
      </div>
      <div className="mt-3 border border-slate-200 bg-slate-50 p-3">
        <p className="text-xs font-semibold uppercase text-slate-500">
          Engine Backends
        </p>
        <p className="mt-1 text-xs leading-5 text-slate-500">
          Default executors for task runs and reviews. Node-level workflow config
          can override these per step.
        </p>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <label className="grid gap-1 text-xs font-semibold uppercase text-slate-500">
            Default Task Backend
            <select
              value={form.engineSettings.defaultTaskBackend ?? "stub"}
              onChange={(event) =>
                onChange("engineSettings", {
                  ...form.engineSettings,
                  defaultTaskBackend: event.target.value as ExecutorBackend,
                })
              }
              className="min-h-9 border border-slate-300 bg-white px-2 text-sm font-normal normal-case text-slate-950"
            >
              {EXECUTOR_BACKENDS.map((backend) => (
                <option key={backend} value={backend}>
                  {compactText(backend)}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-xs font-semibold uppercase text-slate-500">
            Default Review Backend
            <select
              value={form.engineSettings.defaultReviewBackend ?? "stub"}
              onChange={(event) =>
                onChange("engineSettings", {
                  ...form.engineSettings,
                  defaultReviewBackend: event.target.value as ExecutorBackend,
                })
              }
              className="min-h-9 border border-slate-300 bg-white px-2 text-sm font-normal normal-case text-slate-950"
            >
              {EXECUTOR_BACKENDS.map((backend) => (
                <option key={backend} value={backend}>
                  {compactText(backend)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="mt-3 flex min-h-9 items-center gap-2 text-xs font-semibold uppercase text-slate-700">
          <input
            type="checkbox"
            checked={form.engineSettings.autoAdvanceEnabled ?? false}
            onChange={(event) =>
              onChange("engineSettings", {
                ...form.engineSettings,
                autoAdvanceEnabled: event.target.checked,
              })
            }
            className="h-4 w-4 shrink-0 accent-slate-900"
            data-testid="project-auto-advance-enabled"
          />
          Enable workflow auto-advance
        </label>
        <p className="mt-1 text-xs leading-5 text-slate-500">
          When global auto-run is also enabled, completed workflow steps chain
          automatically until approval gates, failures, or manual-only nodes.
        </p>
      </div>
      <div className="mt-3 border border-slate-200 bg-slate-50 p-3">
        <p className="text-xs font-semibold uppercase text-slate-500">
          Agent Orchestrator
        </p>
        <p className="mt-1 text-xs leading-5 text-slate-500">
          Optional external AO handoff for linked GitHub issues with the ao-ready
          label. Config paths must stay inside the project repository.
        </p>
        <label className="mt-3 flex min-h-9 items-center gap-2 text-xs font-semibold uppercase text-slate-700">
          <input
            type="checkbox"
            checked={form.engineSettings.agentOrchestrator?.enabled ?? false}
            onChange={(event) =>
              onChange("engineSettings", {
                ...form.engineSettings,
                agentOrchestrator: {
                  ...form.engineSettings.agentOrchestrator,
                  enabled: event.target.checked,
                },
              })
            }
            className="h-4 w-4 shrink-0 accent-slate-900"
          />
          Enable Agent Orchestrator
        </label>
        <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          <label className="grid gap-1 text-xs font-semibold uppercase text-slate-500">
            AO Config Path
            <input
              value={form.engineSettings.agentOrchestrator?.configPath ?? ""}
              onChange={(event) =>
                onChange("engineSettings", {
                  ...form.engineSettings,
                  agentOrchestrator: {
                    ...form.engineSettings.agentOrchestrator,
                    configPath: event.target.value,
                  },
                })
              }
              placeholder="agent-orchestrator.yaml"
              className="min-h-9 border border-slate-300 bg-white px-2 font-mono text-sm font-normal normal-case text-slate-950"
            />
          </label>
          <label className="grid gap-1 text-xs font-semibold uppercase text-slate-500">
            AO Project ID
            <input
              value={form.engineSettings.agentOrchestrator?.projectId ?? ""}
              onChange={(event) =>
                onChange("engineSettings", {
                  ...form.engineSettings,
                  agentOrchestrator: {
                    ...form.engineSettings.agentOrchestrator,
                    projectId: event.target.value,
                  },
                })
              }
              placeholder="loop-control-plane"
              className="min-h-9 border border-slate-300 bg-white px-2 font-mono text-sm font-normal normal-case text-slate-950"
            />
          </label>
          <label className="grid gap-1 text-xs font-semibold uppercase text-slate-500 md:col-span-2 xl:col-span-1">
            AO Dashboard URL
            <input
              value={form.engineSettings.agentOrchestrator?.dashboardUrl ?? ""}
              onChange={(event) =>
                onChange("engineSettings", {
                  ...form.engineSettings,
                  agentOrchestrator: {
                    ...form.engineSettings.agentOrchestrator,
                    dashboardUrl: event.target.value,
                  },
                })
              }
              placeholder="http://localhost:3000"
              className="min-h-9 border border-slate-300 bg-white px-2 font-mono text-sm font-normal normal-case text-slate-950"
            />
          </label>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onSubmit}
          disabled={isSaving}
          className="inline-flex min-h-9 items-center gap-2 border border-slate-900 bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Save className="h-4 w-4" />
          {mode === "create" ? "Create Project" : "Save Project"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={isSaving}
          className="inline-flex min-h-9 items-center gap-2 border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <X className="h-4 w-4" />
          Cancel
        </button>
      </div>
    </div>
  );
}

function FeatureCompletenessBar({
  feature,
  compact = false,
}: {
  feature: Feature;
  compact?: boolean;
}) {
  const completeness = featureArtifactCompleteness(feature);
  const percent =
    completeness.total === 0
      ? 0
      : Math.round((completeness.existing / completeness.total) * 100);

  return (
    <div className={clsx(compact ? "mt-3" : "mt-2")}>
      <div className="flex items-center justify-between gap-2 text-[11px] font-semibold uppercase text-slate-500">
        <span>Artifacts</span>
        <span>
          {completeness.existing}/{completeness.total} files · {completeness.approved} approved
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden bg-slate-200">
        <div
          className="h-full bg-sky-500"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

function FeatureArtifactGrid({ feature }: { feature: Feature }) {
  return (
    <div className="mt-2 grid gap-1.5 sm:grid-cols-2 xl:grid-cols-5">
      {Object.values(feature.artifacts).map((artifact) => (
        <div
          key={artifact.name}
          className="min-w-0 border border-slate-200 bg-slate-50 p-2"
        >
          <div className="flex items-center justify-between gap-2">
            <p className="truncate text-[11px] font-semibold uppercase text-slate-600">
              {artifact.fileName}
            </p>
            <span
              className={clsx(
                "shrink-0 border px-1 py-0.5 text-[10px] font-semibold uppercase",
                artifact.exists
                  ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                  : "border-slate-200 bg-white text-slate-500",
              )}
            >
              {artifact.exists ? "found" : "missing"}
            </span>
          </div>
          <p className="mt-1 truncate font-mono text-[11px] text-slate-500">
            {artifact.path || "not linked"}
          </p>
          {artifact.approved ? (
            <p className="mt-1 text-[10px] font-semibold uppercase text-emerald-700">
              approved
            </p>
          ) : null}
        </div>
      ))}
    </div>
  );
}

const featureApprovalActions: Array<{
  artifactName: FeatureApprovalArtifactName;
  label: string;
}> = [
  { artifactName: "spec", label: "Mark Spec Approved" },
  { artifactName: "plan", label: "Mark Plan Approved" },
  { artifactName: "tasks", label: "Mark Tasks Approved" },
];

function FeatureApprovalActions({
  feature,
  approvingArtifactName,
  onApprove,
}: {
  feature: Feature;
  approvingArtifactName: FeatureApprovalArtifactName | "";
  onApprove: (artifactName: FeatureApprovalArtifactName) => void;
}) {
  return (
    <div className="mt-3 flex flex-wrap gap-1.5">
      {featureApprovalActions.map((action) => {
        const artifact = feature.artifacts[action.artifactName];
        const isApproved = artifact.approved;
        const isBusy = approvingArtifactName === action.artifactName;

        return (
          <button
            key={action.artifactName}
            type="button"
            onClick={() => onApprove(action.artifactName)}
            disabled={isApproved || Boolean(approvingArtifactName)}
            className={clsx(
              "inline-flex items-center gap-1.5 border px-2 py-1 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-60",
              isApproved
                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                : "border-slate-300 bg-white text-slate-700 hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-800",
            )}
          >
            <SquareCheck className="h-3.5 w-3.5" />
            {isApproved ? `${artifact.fileName} Approved` : isBusy ? "Approving" : action.label}
          </button>
        );
      })}
    </div>
  );
}

function MarkdownPreview({ content }: { content: string }) {
  const blocks = content.trim()
    ? content.split(/\n{2,}/)
    : [];

  if (blocks.length === 0) {
    return (
      <p className="text-sm leading-6 text-slate-500">
        This markdown file is empty.
      </p>
    );
  }

  return (
    <div className="grid gap-3 text-sm leading-6 text-slate-700">
      {blocks.map((block, blockIndex) => {
        const lines = block.split("\n");
        const firstLine = lines[0] ?? "";
        const headingMatch = firstLine.match(/^(#{1,4})\s+(.+)$/);
        const listLines = lines.filter((line) => /^[-*]\s+/.test(line));

        if (headingMatch && lines.length === 1) {
          const level = headingMatch[1].length;
          const text = headingMatch[2];
          const className = "font-semibold text-slate-950 [overflow-wrap:anywhere]";

          if (level === 1) {
            return <h2 key={`${blockIndex}-${text}`} className={className}>{text}</h2>;
          }

          if (level === 2) {
            return <h3 key={`${blockIndex}-${text}`} className={className}>{text}</h3>;
          }

          return <h4 key={`${blockIndex}-${text}`} className={className}>{text}</h4>;
        }

        if (listLines.length === lines.length) {
          return (
            <ul key={blockIndex} className="grid gap-1 pl-4">
              {listLines.map((line, lineIndex) => (
                <li key={`${blockIndex}-${lineIndex}`} className="list-disc [overflow-wrap:anywhere]">
                  {line.replace(/^[-*]\s+/, "")}
                </li>
              ))}
            </ul>
          );
        }

        if (block.startsWith("```")) {
          return (
            <pre
              key={blockIndex}
              className="overflow-x-auto border border-slate-200 bg-slate-950 p-3 text-xs leading-5 text-slate-100"
            >
              {block.replace(/^```[^\n]*\n?/, "").replace(/\n?```$/, "")}
            </pre>
          );
        }

        return (
          <p key={blockIndex} className="whitespace-pre-wrap [overflow-wrap:anywhere]">
            {block}
          </p>
        );
      })}
    </div>
  );
}

function FeatureArtifactViewer({
  feature,
  selectedArtifactName,
  document,
  content,
  isDirty,
  isLoading,
  isSaving,
  error,
  message,
  onSelectArtifact,
  onContentChange,
  onReload,
  onSave,
}: {
  feature: Feature;
  selectedArtifactName: FeatureArtifactName;
  document: FeatureArtifactDocument | null;
  content: string;
  isDirty: boolean;
  isLoading: boolean;
  isSaving: boolean;
  error: string;
  message: string;
  onSelectArtifact: (artifactName: FeatureArtifactName) => void;
  onContentChange: (content: string) => void;
  onReload: () => void;
  onSave: () => void;
}) {
  const selectedArtifact = feature.artifacts[selectedArtifactName];
  const isBusy = isLoading || isSaving;

  return (
    <section className="mt-3 border border-slate-200 bg-white p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-xs font-semibold uppercase text-slate-500">
          Artifact Viewer
        </h4>
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={onReload}
            disabled={isBusy}
            className="inline-flex items-center gap-1.5 border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Reload
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={isBusy || !isDirty}
            className="inline-flex items-center gap-1.5 border border-slate-900 bg-slate-900 px-2 py-1 text-xs font-semibold text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Save className="h-3.5 w-3.5" />
            Save
          </button>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {featureArtifactNames.map((artifactName) => {
          const artifact = feature.artifacts[artifactName];

          return (
            <button
              key={artifactName}
              type="button"
              onClick={() => onSelectArtifact(artifactName)}
              className={clsx(
                "inline-flex max-w-full items-center gap-1.5 border px-2 py-1 text-xs font-semibold",
                selectedArtifactName === artifactName
                  ? "border-sky-300 bg-sky-50 text-sky-800"
                  : "border-slate-200 bg-slate-50 text-slate-700",
              )}
            >
              <FileText className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{artifact.fileName}</span>
              <span
                className={clsx(
                  "border px-1 py-0.5 text-[10px] uppercase",
                  artifact.exists
                    ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                    : "border-slate-200 bg-white text-slate-500",
                )}
              >
                {artifact.exists ? "found" : "missing"}
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-3 grid gap-2 text-xs text-slate-600 sm:grid-cols-[minmax(0,1fr)_auto]">
        <p className="min-w-0 truncate font-mono">
          {document?.path || selectedArtifact.path || "not linked"}
        </p>
        <div className="flex flex-wrap gap-1.5">
          <span
            className={clsx(
              "border px-1.5 py-0.5 text-[10px] font-semibold uppercase",
              document?.exists || selectedArtifact.exists
                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                : "border-amber-200 bg-amber-50 text-amber-800",
            )}
          >
            {document?.exists || selectedArtifact.exists ? "file loaded" : "file missing"}
          </span>
          {isDirty ? (
            <span className="border border-sky-200 bg-sky-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-sky-800">
              unsaved changes
            </span>
          ) : null}
        </div>
      </div>

      {error ? (
        <div className="mt-3 border border-red-200 bg-red-50 p-2 text-sm leading-6 text-red-800">
          {error}
        </div>
      ) : null}
      {message ? (
        <div className="mt-3 border border-emerald-200 bg-emerald-50 p-2 text-sm leading-6 text-emerald-800">
          {message}
        </div>
      ) : null}

      <div className="mt-3 grid gap-3 xl:grid-cols-2">
        <div className="min-w-0 border border-slate-200 bg-slate-50 p-3">
          <h5 className="text-xs font-semibold uppercase text-slate-500">
            Preview
          </h5>
          <div className="mt-3 max-h-[28rem] overflow-auto bg-white p-3">
            {isLoading ? (
              <p className="text-sm leading-6 text-slate-500">
                Loading markdown preview.
              </p>
            ) : (
              <MarkdownPreview content={content} />
            )}
          </div>
        </div>
        <label className="grid min-w-0 gap-2 border border-slate-200 bg-slate-50 p-3 text-xs font-semibold uppercase text-slate-500">
          Editor
          <textarea
            value={content}
            onChange={(event) => onContentChange(event.target.value)}
            disabled={isBusy}
            className="min-h-[28rem] resize-y border border-slate-300 bg-white p-3 font-mono text-sm font-normal normal-case leading-6 text-slate-950 outline-none focus:border-sky-400 disabled:cursor-not-allowed disabled:opacity-60"
          />
        </label>
      </div>
    </section>
  );
}

function FeatureForm({
  mode,
  form,
  onChange,
  onSubmit,
  onCancel,
  isSaving,
}: {
  mode: "create" | "edit";
  form: FeatureFormState;
  onChange: <K extends keyof FeatureFormState>(
    field: K,
    value: FeatureFormState[K],
  ) => void;
  onSubmit: () => void;
  onCancel: () => void;
  isSaving: boolean;
}) {
  return (
    <div className="border border-slate-200 bg-white p-3">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <label className="grid gap-1 text-xs font-semibold uppercase text-slate-500">
          Name
          <input
            value={form.name}
            onChange={(event) => onChange("name", event.target.value)}
            className="min-h-9 border border-slate-300 bg-white px-2 text-sm font-normal normal-case text-slate-950"
          />
        </label>
        <label className="grid gap-1 text-xs font-semibold uppercase text-slate-500">
          Source
          <select
            value={form.source}
            onChange={(event) => onChange("source", event.target.value as TaskSource)}
            className="min-h-9 border border-slate-300 bg-white px-2 text-sm font-normal normal-case text-slate-950"
          >
            {featureSources.map((source) => (
              <option key={source} value={source}>
                {compactText(source)}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-xs font-semibold uppercase text-slate-500">
          Status
          <select
            value={form.status}
            onChange={(event) => onChange("status", event.target.value as FeatureStatus)}
            className="min-h-9 border border-slate-300 bg-white px-2 text-sm font-normal normal-case text-slate-950"
          >
            {featureStatuses.map((status) => (
              <option key={status} value={status}>
                {featureStatusLabel(status)}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-xs font-semibold uppercase text-slate-500 md:col-span-2 xl:col-span-1">
          Artifact Folder
          <input
            value={form.artifactFolderPath}
            onChange={(event) => onChange("artifactFolderPath", event.target.value)}
            className="min-h-9 border border-slate-300 bg-white px-2 font-mono text-sm font-normal normal-case text-slate-950"
          />
        </label>
        <label className="grid gap-1 text-xs font-semibold uppercase text-slate-500 md:col-span-2 xl:col-span-4">
          Summary
          <input
            value={form.summary}
            onChange={(event) => onChange("summary", event.target.value)}
            className="min-h-9 border border-slate-300 bg-white px-2 text-sm font-normal normal-case text-slate-950"
          />
        </label>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onSubmit}
          disabled={isSaving}
          className="inline-flex min-h-9 items-center gap-2 border border-slate-900 bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Save className="h-4 w-4" />
          {mode === "create" ? "Create Feature" : "Save Feature"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={isSaving}
          className="inline-flex min-h-9 items-center gap-2 border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <X className="h-4 w-4" />
          Cancel
        </button>
      </div>
    </div>
  );
}

function SpecKitImporterPreview({
  preview,
  tasks,
  isPreviewLoading,
  isImporting,
  error,
  message,
  onPreview,
  onCancel,
  onImport,
  onToggleTask,
  onChangeTask,
}: {
  preview: SpecKitImportPreview | null;
  tasks: EditableSpecKitTask[];
  isPreviewLoading: boolean;
  isImporting: boolean;
  error: string;
  message: string;
  onPreview: () => void;
  onCancel: () => void;
  onImport: () => void;
  onToggleTask: (taskKey: string) => void;
  onChangeTask: <K extends keyof EditableSpecKitTask>(
    taskKey: string,
    field: K,
    value: EditableSpecKitTask[K],
  ) => void;
}) {
  const selectedCount = tasks.filter((task) => task.include).length;
  const busy = isPreviewLoading || isImporting;

  return (
    <section className="mt-3 border border-slate-200 bg-slate-50 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="text-xs font-semibold uppercase text-slate-500">
            Spec Kit Import
          </h4>
          {preview ? (
            <p className="mt-1 max-w-3xl font-mono text-xs text-slate-500">
              {preview.tasksPath}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {preview ? (
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              className="inline-flex items-center gap-1.5 border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <X className="h-3.5 w-3.5" />
              Close
            </button>
          ) : null}
          <button
            type="button"
            onClick={onPreview}
            disabled={busy}
            className="inline-flex items-center gap-1.5 border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {isPreviewLoading ? "Parsing" : preview ? "Refresh Preview" : "Preview Tasks"}
          </button>
          {preview ? (
            <button
              type="button"
              onClick={onImport}
              disabled={busy || selectedCount === 0}
              className="inline-flex items-center gap-1.5 border border-slate-900 bg-slate-900 px-2 py-1 text-xs font-semibold text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <ImportIcon className="h-3.5 w-3.5" />
              {isImporting ? "Importing" : `Import ${selectedCount}`}
            </button>
          ) : null}
        </div>
      </div>

      {error ? (
        <div className="mt-3 border border-red-200 bg-red-50 p-2 text-sm leading-6 text-red-800">
          {error}
        </div>
      ) : null}
      {message ? (
        <div className="mt-3 border border-emerald-200 bg-emerald-50 p-2 text-sm leading-6 text-emerald-800">
          {message}
        </div>
      ) : null}

      {preview ? (
        <div className="mt-3 grid gap-3">
          <div className="grid gap-2 lg:grid-cols-3">
            <div className="border border-slate-200 bg-white p-2">
              <p className="text-[11px] font-semibold uppercase text-slate-500">
                Parsed Tasks
              </p>
              <p className="mt-1 text-lg font-semibold text-slate-950">
                {tasks.length}
              </p>
            </div>
            <div className="border border-slate-200 bg-white p-2">
              <p className="text-[11px] font-semibold uppercase text-slate-500">
                Selected
              </p>
              <p className="mt-1 text-lg font-semibold text-slate-950">
                {selectedCount}
              </p>
            </div>
            <div className="border border-slate-200 bg-white p-2">
              <p className="text-[11px] font-semibold uppercase text-slate-500">
                Duplicates
              </p>
              <p className="mt-1 text-lg font-semibold text-slate-950">
                {tasks.filter((task) => task.duplicate).length}
              </p>
            </div>
          </div>

          {preview.warnings.length > 0 || preview.missingArtifacts.length > 0 ? (
            <div className="grid gap-2 lg:grid-cols-2">
              {preview.warnings.length > 0 ? (
                <div className="border border-amber-200 bg-amber-50 p-2 text-sm leading-6 text-amber-900">
                  <p className="text-xs font-semibold uppercase">Parser Warnings</p>
                  <ul className="mt-1 grid gap-1">
                    {preview.warnings.map((warning) => (
                      <li key={`${warning.line}-${warning.message}`}>
                        Line {warning.line}: {warning.message}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {preview.missingArtifacts.length > 0 ? (
                <div className="border border-amber-200 bg-amber-50 p-2 text-sm leading-6 text-amber-900">
                  <p className="text-xs font-semibold uppercase">Missing Artifacts</p>
                  <ul className="mt-1 grid gap-1">
                    {preview.missingArtifacts.map((notice) => (
                      <li key={`${notice.name}-${notice.path}`}>
                        {notice.message}{" "}
                        <span className="font-mono text-xs">{notice.path}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="grid gap-3">
            {tasks.map((task) => {
              const taskKey = specKitTaskKey(task);

              return (
                <article
                  key={taskKey}
                  className={clsx(
                    "border bg-white p-3",
                    task.include ? "border-slate-200" : "border-slate-200 opacity-70",
                  )}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <label className="inline-flex items-center gap-2 text-xs font-semibold uppercase text-slate-600">
                      <input
                        type="checkbox"
                        checked={task.include}
                        onChange={() => onToggleTask(taskKey)}
                        disabled={busy}
                        className="h-4 w-4 accent-sky-600"
                      />
                      Include
                    </label>
                    <div className="flex flex-wrap gap-1.5">
                      <span className="border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase text-slate-600">
                        {task.sourceId}
                      </span>
                      <span className="border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-slate-600">
                        line {task.sourceLine}
                      </span>
                      {task.duplicate ? (
                        <span className="border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-800">
                          duplicate
                        </span>
                      ) : null}
                    </div>
                  </div>

                  <div className="mt-3 grid gap-3 lg:grid-cols-6">
                    <label className="grid gap-1 text-xs font-semibold uppercase text-slate-500 lg:col-span-4">
                      Title
                      <input
                        value={task.title}
                        onChange={(event) =>
                          onChangeTask(taskKey, "title", event.target.value)
                        }
                        disabled={busy}
                        className="min-h-9 border border-slate-300 bg-white px-2 text-sm font-normal normal-case text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
                      />
                    </label>
                    <label className="grid gap-1 text-xs font-semibold uppercase text-slate-500">
                      Status
                      <select
                        value={task.status}
                        onChange={(event) =>
                          onChangeTask(
                            taskKey,
                            "status",
                            event.target.value as KanbanStatus,
                          )
                        }
                        disabled={busy}
                        className="min-h-9 border border-slate-300 bg-white px-2 text-sm font-normal normal-case text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {KANBAN_COLUMNS.map((column) => (
                          <option key={column.id} value={column.id}>
                            {column.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="grid gap-1 text-xs font-semibold uppercase text-slate-500">
                      Risk
                      <select
                        value={task.risk}
                        onChange={(event) =>
                          onChangeTask(taskKey, "risk", event.target.value as RiskLevel)
                        }
                        disabled={busy}
                        className="min-h-9 border border-slate-300 bg-white px-2 text-sm font-normal normal-case text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {riskLevels.map((risk) => (
                          <option key={risk} value={risk}>
                            {risk}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="grid gap-1 text-xs font-semibold uppercase text-slate-500">
                      Owner
                      <select
                        value={task.owner}
                        onChange={(event) =>
                          onChangeTask(taskKey, "owner", event.target.value as TaskOwner)
                        }
                        disabled={busy}
                        className="min-h-9 border border-slate-300 bg-white px-2 text-sm font-normal normal-case text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {taskOwners.map((owner) => (
                          <option key={owner} value={owner}>
                            {compactText(owner)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="grid gap-1 text-xs font-semibold uppercase text-slate-500">
                      Mode
                      <select
                        value={task.mode}
                        onChange={(event) =>
                          onChangeTask(taskKey, "mode", event.target.value as TaskMode)
                        }
                        disabled={busy}
                        className="min-h-9 border border-slate-300 bg-white px-2 text-sm font-normal normal-case text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {taskModes.map((mode) => (
                          <option key={mode} value={mode}>
                            {mode}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="grid gap-1 text-xs font-semibold uppercase text-slate-500 lg:col-span-4">
                      Labels
                      <input
                        value={task.labels.join(", ")}
                        onChange={(event) =>
                          onChangeTask(
                            taskKey,
                            "labels",
                            splitEditableList(event.target.value),
                          )
                        }
                        disabled={busy}
                        className="min-h-9 border border-slate-300 bg-white px-2 text-sm font-normal normal-case text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
                      />
                    </label>
                    <label className="grid gap-1 text-xs font-semibold uppercase text-slate-500 lg:col-span-3">
                      Description
                      <textarea
                        value={task.description}
                        onChange={(event) =>
                          onChangeTask(taskKey, "description", event.target.value)
                        }
                        disabled={busy}
                        className="min-h-28 resize-y border border-slate-300 bg-white p-2 text-sm font-normal normal-case leading-6 text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
                      />
                    </label>
                    <label className="grid gap-1 text-xs font-semibold uppercase text-slate-500 lg:col-span-3">
                      Acceptance Criteria
                      <textarea
                        value={joinEditableList(task.acceptanceCriteria)}
                        onChange={(event) =>
                          onChangeTask(
                            taskKey,
                            "acceptanceCriteria",
                            splitEditableList(event.target.value),
                          )
                        }
                        disabled={busy}
                        className="min-h-28 resize-y border border-slate-300 bg-white p-2 text-sm font-normal normal-case leading-6 text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
                      />
                    </label>
                    <label className="grid gap-1 text-xs font-semibold uppercase text-slate-500 lg:col-span-3">
                      Dependencies
                      <textarea
                        value={joinEditableList(task.dependencies)}
                        onChange={(event) =>
                          onChangeTask(
                            taskKey,
                            "dependencies",
                            splitEditableList(event.target.value),
                          )
                        }
                        disabled={busy}
                        className="min-h-20 resize-y border border-slate-300 bg-white p-2 font-mono text-sm font-normal normal-case leading-6 text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
                      />
                    </label>
                    <div className="min-w-0 lg:col-span-3">
                      <p className="text-xs font-semibold uppercase text-slate-500">
                        File References
                      </p>
                      <div className="mt-1 grid gap-1">
                        {(task.fileReferences.length > 0
                          ? task.fileReferences
                          : ["No file references parsed."]
                        ).map((reference) => (
                          <p
                            key={reference}
                            className="truncate font-mono text-xs text-slate-500"
                          >
                            {reference}
                          </p>
                        ))}
                      </div>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function FeaturePanel({
  features,
  selectedFeature,
  selectedArtifactName,
  artifactDocument,
  artifactContent,
  artifactIsDirty,
  artifactIsLoading,
  artifactIsSaving,
  artifactError,
  artifactMessage,
  approvingArtifactName,
  importPreview,
  importPreviewTasks,
  isImportPreviewLoading,
  isImportingSpecKitTasks,
  importError,
  importMessage,
  onSelect,
  onCreate,
  onEdit,
  onDelete,
  onSelectArtifact,
  onArtifactContentChange,
  onReloadArtifact,
  onSaveArtifact,
  onApproveArtifact,
  onPreviewSpecKitTasks,
  onCancelSpecKitImport,
  onImportSpecKitTasks,
  onToggleSpecKitTask,
  onChangeSpecKitTask,
}: {
  features: Feature[];
  selectedFeature?: Feature;
  selectedArtifactName: FeatureArtifactName;
  artifactDocument: FeatureArtifactDocument | null;
  artifactContent: string;
  artifactIsDirty: boolean;
  artifactIsLoading: boolean;
  artifactIsSaving: boolean;
  artifactError: string;
  artifactMessage: string;
  approvingArtifactName: FeatureApprovalArtifactName | "";
  importPreview: SpecKitImportPreview | null;
  importPreviewTasks: EditableSpecKitTask[];
  isImportPreviewLoading: boolean;
  isImportingSpecKitTasks: boolean;
  importError: string;
  importMessage: string;
  onSelect: (featureId: string) => void;
  onCreate: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onSelectArtifact: (artifactName: FeatureArtifactName) => void;
  onArtifactContentChange: (content: string) => void;
  onReloadArtifact: () => void;
  onSaveArtifact: () => void;
  onApproveArtifact: (artifactName: FeatureApprovalArtifactName) => void;
  onPreviewSpecKitTasks: () => void;
  onCancelSpecKitImport: () => void;
  onImportSpecKitTasks: () => void;
  onToggleSpecKitTask: (taskKey: string) => void;
  onChangeSpecKitTask: <K extends keyof EditableSpecKitTask>(
    taskKey: string,
    field: K,
    value: EditableSpecKitTask[K],
  ) => void;
}) {
  return (
    <section className="border border-slate-200 bg-slate-50 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xs font-semibold uppercase text-slate-500">
          Features
        </h2>
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={onCreate}
            className="inline-flex items-center gap-1.5 border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-800"
          >
            <Plus className="h-3.5 w-3.5" />
            Add Feature
          </button>
          {selectedFeature ? (
            <>
              <button
                type="button"
                onClick={onEdit}
                className="inline-flex items-center gap-1.5 border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-800"
              >
                <Pencil className="h-3.5 w-3.5" />
                Edit
              </button>
              <button
                type="button"
                onClick={onPreviewSpecKitTasks}
                disabled={isImportPreviewLoading || isImportingSpecKitTasks}
                className="inline-flex items-center gap-1.5 border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <ImportIcon className="h-3.5 w-3.5" />
                Import Spec Kit Tasks
              </button>
              <button
                type="button"
                onClick={onDelete}
                className="inline-flex items-center gap-1.5 border border-red-200 bg-white px-2 py-1 text-xs font-semibold text-red-700 hover:border-red-300 hover:bg-red-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </button>
            </>
          ) : null}
        </div>
      </div>
      <div className="mt-3 grid gap-2 xl:grid-cols-3">
        {features.map((feature) => {
          const completeness = featureArtifactCompleteness(feature);

          return (
            <button
              key={feature.id}
              type="button"
              onClick={() => onSelect(feature.id)}
              className={clsx(
                "min-w-0 border bg-white p-3 text-left hover:border-sky-300 hover:bg-sky-50",
                selectedFeature?.id === feature.id
                  ? "border-sky-400 ring-2 ring-sky-100"
                  : "border-slate-200",
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-slate-950">
                    {feature.name}
                  </p>
                  <p className="mt-1 truncate text-xs text-slate-500">
                    {featureStatusLabel(feature.status)}
                  </p>
                </div>
                <span className="shrink-0 border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-slate-600">
                  {completeness.existing}/{completeness.total}
                </span>
              </div>
              <FeatureCompletenessBar feature={feature} />
            </button>
          );
        })}
        {features.length === 0 ? (
          <div className="border border-dashed border-slate-300 bg-white p-4 text-sm leading-6 text-slate-600 xl:col-span-3">
            <p className="font-semibold text-slate-950">No feature selected</p>
            <p className="mt-1">
              Create a feature to link PRD, spec, plan, task, and workflow artifacts
              before importing implementation tasks.
            </p>
          </div>
        ) : null}
      </div>
      {selectedFeature ? (
        <div className="mt-3 border border-slate-200 bg-white p-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-slate-950">
                {selectedFeature.name}
              </h3>
              <p className="mt-1 text-xs leading-5 text-slate-600">
                {selectedFeature.summary || "No feature summary provided."}
              </p>
            </div>
            <span className="border border-slate-200 bg-slate-50 px-2 py-1 text-xs font-semibold uppercase text-slate-700">
              {featureStatusLabel(selectedFeature.status)}
            </span>
          </div>
          <FeatureApprovalActions
            feature={selectedFeature}
            approvingArtifactName={approvingArtifactName}
            onApprove={onApproveArtifact}
          />
          <SpecKitImporterPreview
            preview={importPreview}
            tasks={importPreviewTasks}
            isPreviewLoading={isImportPreviewLoading}
            isImporting={isImportingSpecKitTasks}
            error={importError}
            message={importMessage}
            onPreview={onPreviewSpecKitTasks}
            onCancel={onCancelSpecKitImport}
            onImport={onImportSpecKitTasks}
            onToggleTask={onToggleSpecKitTask}
            onChangeTask={onChangeSpecKitTask}
          />
          <FeatureArtifactGrid feature={selectedFeature} />
          {selectedFeature.events.length > 0 ? (
            <div className="mt-3 border border-slate-200 bg-slate-50 p-2">
              <h4 className="text-xs font-semibold uppercase text-slate-500">
                Feature Events
              </h4>
              <div className="mt-2 grid gap-1.5">
                {selectedFeature.events.slice(-3).map((event) => (
                  <div key={event.id} className="text-xs leading-5 text-slate-600">
                    <span className="font-semibold uppercase text-slate-700">
                      {compactText(event.type)}
                    </span>{" "}
                    {event.message}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          <FeatureArtifactViewer
            feature={selectedFeature}
            selectedArtifactName={selectedArtifactName}
            document={artifactDocument}
            content={artifactContent}
            isDirty={artifactIsDirty}
            isLoading={artifactIsLoading}
            isSaving={artifactIsSaving}
            error={artifactError}
            message={artifactMessage}
            onSelectArtifact={onSelectArtifact}
            onContentChange={onArtifactContentChange}
            onReload={onReloadArtifact}
            onSave={onSaveArtifact}
          />
        </div>
      ) : null}
    </section>
  );
}

function BoardMessage({
  title,
  message,
  actionLabel,
  onAction,
}: {
  title: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="flex min-h-[22rem] items-center justify-center px-4 py-10 text-center">
      <div className="max-w-md">
        <Database className="mx-auto h-8 w-8 text-slate-400" />
        <h2 className="mt-3 text-base font-semibold text-slate-950">{title}</h2>
        <p className="mt-2 text-sm leading-6 text-slate-600">{message}</p>
        {actionLabel && onAction ? (
          <button
            type="button"
            onClick={onAction}
            className="mt-4 inline-flex items-center justify-center border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-800"
          >
            {actionLabel}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export default function Home() {
  const [boardData, setBoardData] = useState<BoardData>(emptyBoardData);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [isLoadingBoard, setIsLoadingBoard] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [mutationError, setMutationError] = useState("");
  const [contextMessage, setContextMessage] = useState("");
  const [contextError, setContextError] = useState("");
  const [contextStatus, setContextStatus] = useState<TaskContextStatus | null>(null);
  const [contextAction, setContextAction] = useState("");
  const [claudePromptIntent, setClaudePromptIntent] = useState("");
  const [claudePrompt, setClaudePrompt] =
    useState<ClaudeCodePromptActionResult["prompt"] | null>(null);
  const [claudePromptAction, setClaudePromptAction] = useState("");
  const [handoffDocument, setHandoffDocument] =
    useState<HandoffDocumentActionResult["handoff"] | null>(null);
  const [handoffContent, setHandoffContent] = useState("");
  const [handoffSavedContent, setHandoffSavedContent] = useState("");
  const [handoffAction, setHandoffAction] = useState("");
  const [returnAiHandoffNote, setReturnAiHandoffNote] = useState("");
  const [mutatingTaskId, setMutatingTaskId] = useState("");
  const [projectMode, setProjectMode] = useState<"idle" | "create" | "edit">("idle");
  const [projectForm, setProjectForm] = useState<ProjectFormState>(emptyProjectForm);
  const [projectMutationError, setProjectMutationError] = useState("");
  const [projectMutationMessage, setProjectMutationMessage] = useState("");
  const [isSavingProject, setIsSavingProject] = useState(false);
  const [projectOpenAction, setProjectOpenAction] = useState("");
  const [taskOpenAction, setTaskOpenAction] = useState<TaskOpenActionResult["action"] | "">("");
  const [githubConnection, setGitHubConnection] =
    useState<GitHubConnectionCheck | null>(null);
  const [isCheckingGitHub, setIsCheckingGitHub] = useState(false);
  const [githubLabelSetup, setGitHubLabelSetup] =
    useState<GitHubLabelSetupResult | null>(null);
  const [isSettingUpGitHubLabels, setIsSettingUpGitHubLabels] = useState(false);
  const [boardQuickFilter, setBoardQuickFilter] =
    useState<BoardQuickFilter>("all");
  const [selectedFeatureId, setSelectedFeatureId] = useState("");
  const [featureMode, setFeatureMode] = useState<"idle" | "create" | "edit">("idle");
  const [featureForm, setFeatureForm] = useState<FeatureFormState>(emptyFeatureForm);
  const [featureMutationError, setFeatureMutationError] = useState("");
  const [featureMutationMessage, setFeatureMutationMessage] = useState("");
  const [isSavingFeature, setIsSavingFeature] = useState(false);
  const [approvingArtifactName, setApprovingArtifactName] =
    useState<FeatureApprovalArtifactName | "">("");
  const [selectedArtifactName, setSelectedArtifactName] =
    useState<FeatureArtifactName>("prd");
  const [artifactDocument, setArtifactDocument] =
    useState<FeatureArtifactDocument | null>(null);
  const [artifactContent, setArtifactContent] = useState("");
  const [artifactSavedContent, setArtifactSavedContent] = useState("");
  const [artifactError, setArtifactError] = useState("");
  const [artifactMessage, setArtifactMessage] = useState("");
  const [isLoadingArtifact, setIsLoadingArtifact] = useState(false);
  const [isSavingArtifact, setIsSavingArtifact] = useState(false);
  const [importPreview, setImportPreview] = useState<SpecKitImportPreview | null>(null);
  const [importPreviewTasks, setImportPreviewTasks] = useState<EditableSpecKitTask[]>([]);
  const [importError, setImportError] = useState("");
  const [importMessage, setImportMessage] = useState("");
  const [isImportPreviewLoading, setIsImportPreviewLoading] = useState(false);
  const [isImportingSpecKitTasks, setIsImportingSpecKitTasks] = useState(false);
  const [engineStatus, setEngineStatus] = useState<EngineStatusResponse | null>(null);
  const [backendAvailability, setBackendAvailability] =
    useState<BackendAvailabilityResponse | null>(null);
  const [isLoadingBackendAvailability, setIsLoadingBackendAvailability] = useState(false);
  const [engineError, setEngineError] = useState("");
  const [engineMessage, setEngineMessage] = useState("");
  const [engineAction, setEngineAction] = useState("");
  const [isLoadingEngineStatus, setIsLoadingEngineStatus] = useState(false);
  const [taskLoopMessage, setTaskLoopMessage] = useState("");
  const [taskLoopError, setTaskLoopError] = useState("");
  const previousEngineJobStatusesRef = useRef<Map<string, EngineJobStatus>>(new Map());
  const { projects, features, tasks, latestWorkflowRuns } = boardData;
  const sensors = useSensors(useSensor(PointerSensor), useSensor(KeyboardSensor));

  const featuresById = useMemo(
    () => new Map(features.map((feature) => [feature.id, feature])),
    [features],
  );
  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? projects[0];
  const visibleFeatures = selectedProject
    ? features.filter((feature) => feature.projectId === selectedProject.id)
    : features;
  const projectTasks = useMemo(
    () =>
      selectedProject
        ? tasks.filter((task) => featuresById.get(task.featureId)?.projectId === selectedProject.id)
        : tasks,
    [featuresById, selectedProject, tasks],
  );
  const selectedFeature =
    visibleFeatures.find((feature) => feature.id === selectedFeatureId) ??
    visibleFeatures[0];
  const visibleTasks = useMemo(
    () =>
      selectedFeature
        ? tasks.filter((task) => task.featureId === selectedFeature.id)
        : tasks,
    [selectedFeature, tasks],
  );
  const boardSourceTasks = boardQuickFilter === "all" ? visibleTasks : projectTasks;
  const filteredVisibleTasks = useMemo(
    () => applyBoardQuickFilter(boardSourceTasks, boardQuickFilter),
    [boardQuickFilter, boardSourceTasks],
  );
  const groupedTasks = useMemo(
    () => tasksByStatus(filteredVisibleTasks),
    [filteredVisibleTasks],
  );
  const counters = useMemo(() => workflowCounters(projectTasks), [projectTasks]);
  const projectStatusMetrics = useMemo(() => statusMetrics(projectTasks), [projectTasks]);
  const projectOwnerMetrics = useMemo(() => ownerMetrics(projectTasks), [projectTasks]);
  const projectRiskMetrics = useMemo(() => riskMetrics(projectTasks), [projectTasks]);
  const selectedTask =
    visibleTasks.find((task) => task.id === selectedTaskId) ??
    visibleTasks[0] ??
    tasks.find((task) => task.id === selectedTaskId) ??
    tasks[0];
  const selectedTaskSourceArtifacts = selectedTask
    ? taskSourceArtifactPaths(selectedTask)
    : [];
  const selectedTaskImportEvent = selectedTask ? taskImportEvent(selectedTask) : undefined;
  const latestProjectWorkflowRun = selectedProject
    ? latestWorkflowRuns.find((run) => run.projectId === selectedProject.id)
    : undefined;
  const effectiveAutomationPolicy = useMemo(
    () =>
      describeEffectiveAutomationPolicy({
        automationSettings: boardData.automationSettings,
        projectPolicy: selectedProject?.automationPolicy,
      }),
    [boardData.automationSettings, selectedProject?.automationPolicy],
  );
  const taskRunJobsByTaskId = useMemo(() => {
    const map = new Map<string, EngineJobSummary>();

    for (const job of engineStatus?.recentJobs ?? []) {
      if (job.kind !== "task-run" || !job.taskId) {
        continue;
      }

      if (job.status !== "queued" && job.status !== "running") {
        continue;
      }

      map.set(job.taskId, job);
    }

    return map;
  }, [engineStatus?.recentJobs]);
  const selectedTaskEngineJob = useMemo(() => {
    if (!selectedTask) {
      return undefined;
    }

    return (engineStatus?.recentJobs ?? []).find(
      (job) => job.kind === "task-run" && job.taskId === selectedTask.id,
    );
  }, [engineStatus?.recentJobs, selectedTask]);
  const taskLoopPickupPolicy = useMemo(() => {
    if (!selectedTask || !selectedProject) {
      return null;
    }

    if (!isTaskStructurallyEligible(selectedTask)) {
      return {
        kind: "deny" as const,
        code: "task_not_structurally_eligible",
        message: "Task is not in Ready column with an unassigned or AI owner.",
        reasons: ["Only Ready tasks owned by AI or unassigned can run with the engine."],
      };
    }

    if (taskRunJobsByTaskId.has(selectedTask.id)) {
      return {
        kind: "deny" as const,
        code: "task_run_job_in_flight",
        message: "Task already has a queued or running engine job.",
        reasons: ["Wait for the current task-run job to finish before enqueueing another."],
      };
    }

    return evaluateTaskActionPolicy({
      action: "assign-ai",
      task: selectedTask,
      automated: false,
      approved: Boolean(selectedTask.github.aoReadyApprovedAt),
      automationSettings: boardData.automationSettings,
      projectPolicy: selectedProject.automationPolicy,
    });
  }, [
    boardData.automationSettings,
    selectedProject,
    selectedTask,
    taskRunJobsByTaskId,
  ]);
  const selectedRepoPath = selectedProject?.repoPath.trim() ?? "";
  const selectedWorktreePath =
    selectedRepoPath && selectedTask?.worktree.trim()
      ? displayLocalPath(selectedRepoPath, selectedTask.worktree)
      : "";
  const selectedWorkspacePath = selectedWorktreePath || selectedRepoPath;
  const selectedWorkspaceUsesFallback = Boolean(selectedTask && !selectedWorktreePath);
  const artifactIsDirty = artifactContent !== artifactSavedContent;
  const handoffIsDirty = handoffContent !== handoffSavedContent;

  const replaceTask = useCallback((updatedTask: PersistedTask) => {
    setBoardData((currentData) => ({
      ...currentData,
      tasks: currentData.tasks.map((task) =>
        task.id === updatedTask.id ? updatedTask : task,
      ),
    }));
    setSelectedTaskId(updatedTask.id);
    window.localStorage.setItem(SELECTED_TASK_STORAGE_KEY, updatedTask.id);
  }, []);

  const loadBoard = useCallback(async (projectId?: string, options: { silent?: boolean } = {}) => {
    if (!options.silent) {
      setIsLoadingBoard(true);
    }
    setLoadError("");

    try {
      const nextBoardData = await fetchBoardData(projectId);
      const nextProject =
        nextBoardData.projects.find((project) => project.id === projectId) ??
        nextBoardData.projects[0];
      const storedFeatureId = window.localStorage.getItem(SELECTED_FEATURE_STORAGE_KEY);
      const nextSelectedFeatureId =
        nextBoardData.features.find(
          (feature) =>
            feature.id === storedFeatureId &&
            (!nextProject || feature.projectId === nextProject.id),
        )?.id ??
        nextBoardData.features.find(
          (feature) => !nextProject || feature.projectId === nextProject.id,
        )?.id ??
        "";
      const storedTaskId = window.localStorage.getItem(SELECTED_TASK_STORAGE_KEY);
      const nextFeatureTasks = nextSelectedFeatureId
        ? nextBoardData.tasks.filter((task) => task.featureId === nextSelectedFeatureId)
        : nextBoardData.tasks;
      const nextSelectedTaskId =
        nextFeatureTasks.find((task) => task.id === storedTaskId)?.id ??
        nextFeatureTasks[0]?.id ??
        nextBoardData.tasks.find((task) => task.id === storedTaskId)?.id ??
        nextBoardData.tasks[0]?.id ??
        "";

      setBoardData(nextBoardData);
      setSelectedProjectId(nextProject?.id ?? "");
      setSelectedTaskId(nextSelectedTaskId);
      setSelectedFeatureId(nextSelectedFeatureId);

      if (nextProject) {
        window.localStorage.setItem(SELECTED_PROJECT_STORAGE_KEY, nextProject.id);
      }

      if (nextSelectedTaskId) {
        window.localStorage.setItem(SELECTED_TASK_STORAGE_KEY, nextSelectedTaskId);
      }

      if (nextSelectedFeatureId) {
        window.localStorage.setItem(SELECTED_FEATURE_STORAGE_KEY, nextSelectedFeatureId);
      }
    } catch (error) {
      setLoadError(
        error instanceof LoopBoardApiError
          ? error.message
          : "Loop Control Plane could not load persisted board data.",
      );
    } finally {
      if (!options.silent) {
        setIsLoadingBoard(false);
      }
    }
  }, []);

  const loadTaskContextStatus = useCallback(async (taskId: string) => {
    setContextError("");

    try {
      const result = await fetchTaskContextStatus(taskId);
      setContextStatus(result.context);
    } catch (error) {
      setContextStatus(null);
      setContextError(
        error instanceof LoopBoardApiError
          ? error.message
          : "Loop Control Plane could not load generated file paths.",
      );
    }
  }, []);

  const loadTaskHandoffDocument = useCallback(async (taskId: string) => {
    setContextError("");
    setHandoffAction("load");

    try {
      const result = await fetchPersistedTaskHandoff(taskId);
      setContextStatus(result.context);
      setHandoffDocument(result.handoff);
      setHandoffContent(result.handoff.content);
      setHandoffSavedContent(result.handoff.content);
    } catch (error) {
      setHandoffDocument(null);
      setHandoffContent("");
      setHandoffSavedContent("");
      setContextError(
        error instanceof LoopBoardApiError
          ? error.message
          : "Loop Control Plane could not load handoff.md.",
      );
    } finally {
      setHandoffAction("");
    }
  }, []);

  const loadFeatureArtifact = useCallback(
    async (featureId: string, artifactName: FeatureArtifactName) => {
      setIsLoadingArtifact(true);
      setArtifactError("");
      setArtifactMessage("");

      try {
        const document = await fetchFeatureArtifactDocument({
          featureId,
          artifactName,
        });

        setArtifactDocument(document);
        setArtifactContent(document.content);
        setArtifactSavedContent(document.content);
        setArtifactMessage(document.exists ? "" : `${document.fileName} is missing.`);
      } catch (error) {
        setArtifactDocument(null);
        setArtifactContent("");
        setArtifactSavedContent("");
        setArtifactError(
          error instanceof LoopBoardApiError
            ? error.message
            : "Loop Control Plane could not load the artifact file.",
        );
      } finally {
        setIsLoadingArtifact(false);
      }
    },
    [],
  );

  const loadEngineStatus = useCallback(
    async (projectId?: string, options: { silent?: boolean } = {}) => {
      if (!projectId) {
        setEngineStatus(null);
        return;
      }

      if (!options.silent) {
        setIsLoadingEngineStatus(true);
      }

      try {
        const status = await fetchEngineStatus(projectId);
        setEngineStatus(status);
      } catch (error) {
        setEngineError(
          error instanceof LoopBoardApiError
            ? error.message
            : "Loop Control Plane could not load engine status.",
        );
      } finally {
        if (!options.silent) {
          setIsLoadingEngineStatus(false);
        }
      }
    },
    [],
  );

  const loadBackendAvailability = useCallback(
    async (projectId?: string, options: { silent?: boolean } = {}) => {
      if (!projectId) {
        setBackendAvailability(null);
        return;
      }

      if (!options.silent) {
        setIsLoadingBackendAvailability(true);
      }

      try {
        const availability = await fetchBackendAvailability(projectId);
        setBackendAvailability(availability);
      } catch (error) {
        setEngineError(
          error instanceof LoopBoardApiError
            ? error.message
            : "Loop Control Plane could not load backend availability.",
        );
      } finally {
        if (!options.silent) {
          setIsLoadingBackendAvailability(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    const storedProjectId = window.localStorage.getItem(SELECTED_PROJECT_STORAGE_KEY);
    const storedBoardQuickFilter = window.localStorage.getItem(
      BOARD_QUICK_FILTER_STORAGE_KEY,
    );

    if (isBoardQuickFilter(storedBoardQuickFilter)) {
      setBoardQuickFilter(storedBoardQuickFilter);
    }

    void loadBoard(storedProjectId ?? undefined);
  }, [loadBoard]);

  useEffect(() => {
    setContextMessage("");
    setContextError("");
    setClaudePrompt(null);
    setClaudePromptAction("");
    setHandoffDocument(null);
    setHandoffContent("");
    setHandoffSavedContent("");

    if (selectedTask?.id) {
      void loadTaskContextStatus(selectedTask.id);
      void loadTaskHandoffDocument(selectedTask.id);
    } else {
      setContextStatus(null);
    }
  }, [loadTaskContextStatus, loadTaskHandoffDocument, selectedTask?.id]);

  useEffect(() => {
    setTaskLoopMessage("");
    setTaskLoopError("");
  }, [selectedTask?.id]);

  useEffect(() => {
    if (!selectedProject?.id || !engineStatus) {
      return;
    }

    let shouldRefreshBoard = false;

    for (const job of engineStatus.recentJobs) {
      if (job.kind !== "task-run") {
        continue;
      }

      const previousStatus = previousEngineJobStatusesRef.current.get(job.id);
      if (
        previousStatus &&
        (previousStatus === "queued" || previousStatus === "running") &&
        (job.status === "completed" ||
          job.status === "failed" ||
          job.status === "cancelled")
      ) {
        shouldRefreshBoard = true;
      }

      previousEngineJobStatusesRef.current.set(job.id, job.status);
    }

    if (shouldRefreshBoard) {
      void loadBoard(selectedProject.id, { silent: true });
      if (selectedTask?.id) {
        void loadTaskContextStatus(selectedTask.id);
      }
    }
  }, [
    engineStatus,
    loadBoard,
    loadTaskContextStatus,
    selectedProject?.id,
    selectedTask?.id,
  ]);

  useEffect(() => {
    if (selectedFeature?.id) {
      void loadFeatureArtifact(selectedFeature.id, selectedArtifactName);
    } else {
      setArtifactDocument(null);
      setArtifactContent("");
      setArtifactSavedContent("");
      setArtifactError("");
      setArtifactMessage("");
    }
  }, [loadFeatureArtifact, selectedArtifactName, selectedFeature?.id]);

  useEffect(() => {
    setImportPreview(null);
    setImportPreviewTasks([]);
    setImportError("");
    setImportMessage("");
  }, [selectedFeature?.id]);

  useEffect(() => {
    if (!selectedProject?.id) {
      setEngineStatus(null);
      setBackendAvailability(null);
      return;
    }

    void loadEngineStatus(selectedProject.id, { silent: true });
    void loadBackendAvailability(selectedProject.id, { silent: true });

    const interval = window.setInterval(() => {
      void loadEngineStatus(selectedProject.id, { silent: true });
    }, 3_000);

    return () => window.clearInterval(interval);
  }, [loadBackendAvailability, loadEngineStatus, selectedProject?.id]);

  function selectTask(taskId: string) {
    setSelectedTaskId(taskId);
    window.localStorage.setItem(SELECTED_TASK_STORAGE_KEY, taskId);
  }

  function selectProject(projectId: string) {
    setProjectMode("idle");
    setFeatureMode("idle");
    changeBoardQuickFilter("all");
    setSelectedArtifactName("prd");
    setProjectMutationError("");
    setProjectMutationMessage("");
    setFeatureMutationError("");
    setFeatureMutationMessage("");
    setImportPreview(null);
    setImportPreviewTasks([]);
    setImportError("");
    setImportMessage("");
    setGitHubConnection(null);
    setGitHubLabelSetup(null);
    window.localStorage.setItem(SELECTED_PROJECT_STORAGE_KEY, projectId);
    void loadBoard(projectId);
  }

  function updateProjectForm<K extends keyof ProjectFormState>(
    field: K,
    value: ProjectFormState[K],
  ) {
    setProjectForm((currentForm) => ({ ...currentForm, [field]: value }));
  }

  function updateFeatureForm<K extends keyof FeatureFormState>(
    field: K,
    value: FeatureFormState[K],
  ) {
    setFeatureForm((currentForm) => ({ ...currentForm, [field]: value }));
  }

  function startCreateProject() {
    setProjectMode("create");
    setProjectForm(emptyProjectForm);
    setProjectMutationError("");
    setProjectMutationMessage("");
    setGitHubConnection(null);
    setGitHubLabelSetup(null);
  }

  function selectFeature(featureId: string) {
    setSelectedFeatureId(featureId);
    setSelectedArtifactName("prd");
    changeBoardQuickFilter("all");
    window.localStorage.setItem(SELECTED_FEATURE_STORAGE_KEY, featureId);

    const featureTaskId = tasks.find((task) => task.featureId === featureId)?.id;
    if (featureTaskId) {
      setSelectedTaskId(featureTaskId);
      window.localStorage.setItem(SELECTED_TASK_STORAGE_KEY, featureTaskId);
    }
  }

  function selectArtifact(artifactName: FeatureArtifactName) {
    setSelectedArtifactName(artifactName);
  }

  function updateArtifactContent(content: string) {
    setArtifactContent(content);
    setArtifactError("");
    setArtifactMessage("");
  }

  function startCreateFeature() {
    setFeatureMode("create");
    setFeatureForm(emptyFeatureForm);
    setFeatureMutationError("");
    setFeatureMutationMessage("");
  }

  function startEditFeature() {
    setFeatureMode("edit");
    setFeatureForm(featureToForm(selectedFeature));
    setFeatureMutationError("");
    setFeatureMutationMessage("");
  }

  function startEditProject() {
    setProjectMode("edit");
    setProjectForm(projectToForm(selectedProject));
    setProjectMutationError("");
    setProjectMutationMessage("");
    setGitHubConnection(null);
    setGitHubLabelSetup(null);
  }

  async function saveProject() {
    setProjectMutationError("");
    setProjectMutationMessage("");
    setIsSavingProject(true);

    try {
      const savedProject =
        projectMode === "create"
          ? await createProject(projectForm)
          : selectedProject
            ? await updateProject({
                projectId: selectedProject.id,
                input: projectForm,
              })
            : null;

      if (savedProject) {
        setProjectMode("idle");
        setGitHubConnection(null);
        setGitHubLabelSetup(null);
        setProjectMutationMessage(
          projectMode === "create"
            ? "Project created and repository metadata detected."
            : "Project updated and repository metadata refreshed.",
        );
        window.localStorage.setItem(SELECTED_PROJECT_STORAGE_KEY, savedProject.id);
        await loadBoard(savedProject.id);
      }
    } catch (error) {
      setProjectMutationError(
        error instanceof LoopBoardApiError
          ? error.message
          : "Loop Control Plane could not save the project.",
      );
    } finally {
      setIsSavingProject(false);
    }
  }

  async function checkSelectedProjectGitHubConnection() {
    if (!selectedProject) {
      return;
    }

    setProjectMutationError("");
    setProjectMutationMessage("");
    setIsCheckingGitHub(true);

    try {
      const result = await checkProjectGitHubConnection(selectedProject.id);
      setGitHubConnection(result);
      setProjectMutationMessage(result.message);
    } catch (error) {
      setProjectMutationError(
        error instanceof LoopBoardApiError
          ? error.message
          : "Loop Control Plane could not check the GitHub connection.",
      );
    } finally {
      setIsCheckingGitHub(false);
    }
  }

  async function toggleGlobalAutoRun(enabled: boolean) {
    setProjectMutationError("");
    setProjectMutationMessage("");

    try {
      const settings = await updateAutomationSettings({
        globalAutoRunEnabled: enabled,
      });

      setBoardData((currentData) => ({
        ...currentData,
        automationSettings: settings,
      }));
      setProjectMutationMessage(
        settings.globalAutoRunEnabled
          ? "Global auto-run enabled. Project policy gates still apply."
          : "Global auto-run disabled.",
      );

      if (!settings.globalAutoRunEnabled && engineStatus?.scheduler.status === "running") {
        try {
          const stopped = await stopEngineScheduler();
          setEngineStatus((currentStatus) =>
            currentStatus
              ? { ...currentStatus, scheduler: stopped.scheduler }
              : currentStatus,
          );
        } catch {
          // Engine status polling will reconcile scheduler state.
        }
      }

      if (selectedProject?.id) {
        void loadEngineStatus(selectedProject.id, { silent: true });
      }
    } catch (error) {
      setProjectMutationError(
        error instanceof LoopBoardApiError
          ? error.message
          : "Loop Control Plane could not update automation settings.",
      );
    }
  }

  async function runEngineDemoJob() {
    if (!selectedProject) {
      return;
    }

    setEngineError("");
    setEngineMessage("");
    setEngineAction("demo");

    try {
      const result = await enqueueEngineDemoJob(selectedProject.id);
      setEngineMessage(`Demo job ${result.job.id} queued (${result.job.status}).`);
      await loadEngineStatus(selectedProject.id, { silent: true });
    } catch (error) {
      setEngineError(
        error instanceof LoopBoardApiError
          ? error.message
          : "Loop Control Plane could not enqueue the demo job.",
      );
    } finally {
      setEngineAction("");
    }
  }

  async function tickEngineOnce() {
    if (!selectedProject) {
      return;
    }

    setEngineError("");
    setEngineMessage("");
    setEngineAction("tick");

    try {
      const result = await tickEngine({ mode: "manual" });
      const jobSummary =
        result.job !== undefined
          ? `${result.job.id} → ${result.job.status}`
          : result.plan.action === "process"
            ? result.plan.jobId
            : result.plan.reason;
      setEngineMessage(`Manual tick: ${result.plan.action} (${jobSummary}).`);
      setEngineStatus((currentStatus) =>
        currentStatus
          ? {
              ...currentStatus,
              scheduler: result.scheduler,
            }
          : currentStatus,
      );
      await loadEngineStatus(selectedProject.id, { silent: true });
    } catch (error) {
      setEngineError(
        error instanceof LoopBoardApiError
          ? error.message
          : "Loop Control Plane could not run an engine tick.",
      );
    } finally {
      setEngineAction("");
    }
  }

  async function startEngineSchedulerAction() {
    if (!selectedProject) {
      return;
    }

    setEngineError("");
    setEngineMessage("");
    setEngineAction("start");

    try {
      const result = await startEngineScheduler();
      setEngineMessage("Engine scheduler started with background ticks.");
      setEngineStatus((currentStatus) =>
        currentStatus
          ? { ...currentStatus, scheduler: result.scheduler }
          : currentStatus,
      );
      await loadEngineStatus(selectedProject.id, { silent: true });
    } catch (error) {
      setEngineError(
        error instanceof LoopBoardApiError
          ? error.message
          : "Loop Control Plane could not start the engine scheduler.",
      );
    } finally {
      setEngineAction("");
    }
  }

  async function stopEngineSchedulerAction() {
    if (!selectedProject) {
      return;
    }

    setEngineError("");
    setEngineMessage("");
    setEngineAction("stop");

    try {
      const result = await stopEngineScheduler();
      setEngineMessage("Engine scheduler stopped.");
      setEngineStatus((currentStatus) =>
        currentStatus
          ? { ...currentStatus, scheduler: result.scheduler }
          : currentStatus,
      );
      await loadEngineStatus(selectedProject.id, { silent: true });
    } catch (error) {
      setEngineError(
        error instanceof LoopBoardApiError
          ? error.message
          : "Loop Control Plane could not stop the engine scheduler.",
      );
    } finally {
      setEngineAction("");
    }
  }

  async function setupSelectedProjectGitHubLabels() {
    if (!selectedProject) {
      return;
    }

    setProjectMutationError("");
    setProjectMutationMessage("");
    setIsSettingUpGitHubLabels(true);

    try {
      const result = await setupProjectGitHubLabels(selectedProject.id);
      setGitHubLabelSetup(result);
      setProjectMutationMessage(result.message);
    } catch (error) {
      setProjectMutationError(
        error instanceof LoopBoardApiError
          ? error.message
          : "Loop Control Plane could not set up GitHub labels.",
      );
    } finally {
      setIsSettingUpGitHubLabels(false);
    }
  }

  async function removeSelectedProject() {
    if (!selectedProject) {
      return;
    }

    setProjectMutationError("");
    setProjectMutationMessage("");
    setIsSavingProject(true);

    try {
      await deleteProject(selectedProject.id);
      window.localStorage.removeItem(SELECTED_PROJECT_STORAGE_KEY);
      setProjectMutationMessage("Project deleted.");
      await loadBoard(undefined);
    } catch (error) {
      setProjectMutationError(
        error instanceof LoopBoardApiError
          ? error.message
          : "Loop Control Plane could not delete the project.",
      );
    } finally {
      setIsSavingProject(false);
    }
  }

  async function saveFeature() {
    if (!selectedProject) {
      return;
    }

    setFeatureMutationError("");
    setFeatureMutationMessage("");
    setIsSavingFeature(true);

    try {
      const savedFeature =
        featureMode === "create"
          ? await createFeature({
              ...featureForm,
              projectId: selectedProject.id,
            })
          : selectedFeature
            ? await updateFeature({
                featureId: selectedFeature.id,
                input: featureForm,
              })
            : null;

      if (savedFeature) {
        setFeatureMode("idle");
        setSelectedFeatureId(savedFeature.id);
        window.localStorage.setItem(SELECTED_FEATURE_STORAGE_KEY, savedFeature.id);
        setFeatureMutationMessage(
          featureMode === "create"
            ? "Feature created and artifacts detected."
            : "Feature updated and artifacts refreshed.",
        );
        await loadBoard(selectedProject.id);
      }
    } catch (error) {
      setFeatureMutationError(
        error instanceof LoopBoardApiError
          ? error.message
          : "Loop Control Plane could not save the feature.",
      );
    } finally {
      setIsSavingFeature(false);
    }
  }

  async function removeSelectedFeature() {
    if (!selectedFeature || !selectedProject) {
      return;
    }

    setFeatureMutationError("");
    setFeatureMutationMessage("");
    setIsSavingFeature(true);

    try {
      await deleteFeature(selectedFeature.id);
      window.localStorage.removeItem(SELECTED_FEATURE_STORAGE_KEY);
      setFeatureMutationMessage("Feature deleted.");
      await loadBoard(selectedProject.id);
    } catch (error) {
      setFeatureMutationError(
        error instanceof LoopBoardApiError
          ? error.message
          : "Loop Control Plane could not delete the feature.",
      );
    } finally {
      setIsSavingFeature(false);
    }
  }

  async function approveSelectedFeatureArtifact(
    artifactName: FeatureApprovalArtifactName,
  ) {
    if (!selectedFeature || !selectedProject) {
      return;
    }

    setFeatureMutationError("");
    setFeatureMutationMessage("");
    setApprovingArtifactName(artifactName);

    try {
      const approvedFeature = await approveFeatureArtifact({
        featureId: selectedFeature.id,
        artifactName,
      });

      setSelectedFeatureId(approvedFeature.id);
      setFeatureMutationMessage(
        `${approvedFeature.artifacts[artifactName].fileName} approval recorded.`,
      );
      await loadBoard(selectedProject.id);
    } catch (error) {
      setFeatureMutationError(
        error instanceof LoopBoardApiError
          ? error.message
          : "Loop Control Plane could not approve the feature artifact.",
      );
    } finally {
      setApprovingArtifactName("");
    }
  }

  async function openSelectedProject(action: "open-folder" | "open-vscode") {
    if (!selectedProject) {
      return;
    }

    setProjectMutationError("");
    setProjectMutationMessage("");
    setProjectOpenAction(action);

    try {
      const result = await openProject({
        projectId: selectedProject.id,
        action,
      });

      setProjectMutationMessage(result.message);
    } catch (error) {
      setProjectMutationError(
        error instanceof LoopBoardApiError
          ? error.message
          : "Loop Control Plane could not open the project.",
      );
    } finally {
      setProjectOpenAction("");
    }
  }

  async function openSelectedTask(action: TaskOpenActionResult["action"]) {
    if (!selectedTask) {
      return;
    }

    setContextError("");
    setContextMessage("");
    setTaskOpenAction(action);

    try {
      const result = await openTask({
        taskId: selectedTask.id,
        action,
      });

      setContextMessage(result.message);
    } catch (error) {
      setContextError(
        error instanceof LoopBoardApiError
          ? error.message
          : "Loop Control Plane could not open the task workspace.",
      );
    } finally {
      setTaskOpenAction("");
    }
  }

  async function reloadSelectedArtifact() {
    if (!selectedFeature) {
      return;
    }

    await loadFeatureArtifact(selectedFeature.id, selectedArtifactName);
  }

  async function saveSelectedArtifact() {
    if (!selectedFeature || !selectedProject) {
      return;
    }

    setIsSavingArtifact(true);
    setArtifactError("");
    setArtifactMessage("");

    try {
      const document = await saveFeatureArtifactDocument({
        featureId: selectedFeature.id,
        artifactName: selectedArtifactName,
        content: artifactContent,
      });

      setArtifactDocument(document);
      setArtifactContent(document.content);
      setArtifactSavedContent(document.content);
      setArtifactMessage(`${document.fileName} saved.`);
      await loadBoard(selectedProject.id);
    } catch (error) {
      setArtifactError(
        error instanceof LoopBoardApiError
          ? error.message
          : "Loop Control Plane could not save the artifact file.",
      );
    } finally {
      setIsSavingArtifact(false);
    }
  }

  async function previewSelectedSpecKitTasks() {
    if (!selectedFeature) {
      return;
    }

    setImportError("");
    setImportMessage("");
    setIsImportPreviewLoading(true);

    try {
      const preview = await previewSpecKitTasks(selectedFeature.id);
      setImportPreview(preview);
      setImportPreviewTasks(preview.tasks.map(previewTaskToEditable));
      setImportMessage(
        `Parsed ${preview.tasks.length} Spec Kit task${
          preview.tasks.length === 1 ? "" : "s"
        }.`,
      );
    } catch (error) {
      setImportPreview(null);
      setImportPreviewTasks([]);
      setImportError(
        error instanceof LoopBoardApiError
          ? error.message
          : "Loop Control Plane could not parse Spec Kit tasks.",
      );
    } finally {
      setIsImportPreviewLoading(false);
    }
  }

  function cancelSpecKitImport() {
    setImportPreview(null);
    setImportPreviewTasks([]);
    setImportError("");
    setImportMessage("");
  }

  function toggleSpecKitPreviewTask(taskKey: string) {
    setImportPreviewTasks((currentTasks) =>
      currentTasks.map((task) =>
        specKitTaskKey(task) === taskKey
          ? { ...task, include: !task.include }
          : task,
      ),
    );
    setImportError("");
    setImportMessage("");
  }

  function changeSpecKitPreviewTask<K extends keyof EditableSpecKitTask>(
    taskKey: string,
    field: K,
    value: EditableSpecKitTask[K],
  ) {
    setImportPreviewTasks((currentTasks) =>
      currentTasks.map((task) =>
        specKitTaskKey(task) === taskKey ? { ...task, [field]: value } : task,
      ),
    );
    setImportError("");
    setImportMessage("");
  }

  async function importSelectedSpecKitTasks() {
    if (!selectedFeature || !selectedProject || importPreviewTasks.length === 0) {
      return;
    }

    setImportError("");
    setImportMessage("");
    setIsImportingSpecKitTasks(true);

    try {
      const result = await importSpecKitTasks({
        featureId: selectedFeature.id,
        tasks: importPreviewTasks.map((task) => ({
          include: task.include,
          sourceId: task.sourceId,
          sourceLine: task.sourceLine,
          completed: task.completed,
          headings: task.headings,
          title: task.title,
          description: task.description,
          fileReferences: task.fileReferences,
          dependencies: task.dependencies,
          acceptanceCriteria: task.acceptanceCriteria,
          labels: task.labels,
          owner: task.owner,
          mode: task.mode,
          risk: task.risk,
          notes: task.notes,
          sourceText: task.sourceText,
          sourceArtifactPaths: task.sourceArtifactPaths,
          status: task.status,
        })),
      });

      setImportMessage(
        `Imported ${result.imported.length} task${
          result.imported.length === 1 ? "" : "s"
        }; skipped ${result.skipped.length}.`,
      );
      setImportPreview(null);
      setImportPreviewTasks([]);
      setSelectedFeatureId(result.feature.id);
      window.localStorage.setItem(SELECTED_FEATURE_STORAGE_KEY, result.feature.id);
      if (result.imported[0]?.task.id) {
        setSelectedTaskId(result.imported[0].task.id);
        window.localStorage.setItem(
          SELECTED_TASK_STORAGE_KEY,
          result.imported[0].task.id,
        );
      }
      await loadBoard(result.project.id);
    } catch (error) {
      setImportError(
        error instanceof LoopBoardApiError
          ? error.message
          : "Loop Control Plane could not import Spec Kit tasks.",
      );
    } finally {
      setIsImportingSpecKitTasks(false);
    }
  }

  async function handleDragEnd(event: DragEndEvent) {
    const taskId = String(event.active.id);
    const toStatus = event.over?.id as KanbanStatus | undefined;
    const task = tasks.find((currentTask) => currentTask.id === taskId);

    if (
      !task ||
      !toStatus ||
      task.status === toStatus ||
      !KANBAN_COLUMNS.some((column) => column.id === toStatus)
    ) {
      return;
    }

    setMutationError("");
    setMutatingTaskId(taskId);

    try {
      const updatedTask = await movePersistedTask({
        taskId,
        toStatus,
        actor: "human",
      });
      replaceTask(updatedTask);
    } catch (error) {
      setMutationError(
        error instanceof LoopBoardApiError
          ? error.message
          : "Loop Control Plane could not move the task.",
      );
    } finally {
      setMutatingTaskId("");
    }
  }

  async function handleTaskAction(action: TaskAction) {
    if (!selectedTask) {
      return;
    }

    setMutationError("");
    setContextMessage("");
    setMutatingTaskId(selectedTask.id);

    try {
      const updatedTask = await applyPersistedTaskAction({
        taskId: selectedTask.id,
        action,
        handoffNote: action === "return-ai" ? returnAiHandoffNote : undefined,
      });
      replaceTask(updatedTask);
      if (action === "claim-human") {
        setContextMessage(
          [
            `Claimed for manual editing on ${updatedTask.branch || "no branch"}.`,
            `Worktree: ${updatedTask.worktree || "not set"}.`,
            `Issue: ${
              updatedTask.github.issueNumber
                ? `#${updatedTask.github.issueNumber}`
                : updatedTask.github.issueUrl
                  ? "linked"
                  : "none"
            }.`,
            `PR: ${
              updatedTask.github.pullRequestNumber
                ? `#${updatedTask.github.pullRequestNumber}`
                : updatedTask.github.pullRequestUrl
                  ? "linked"
                  : "none"
            }.`,
          ].join(" "),
        );
      }
      if (action === "return-ai") {
        setReturnAiHandoffNote("");
        setContextMessage(
          [
            `Returned to AI on ${updatedTask.status === "ai-running" ? "AI Running" : "Ready"}.`,
            `Issue labels: ${(updatedTask.github.issueLabels ?? []).join(", ") || "none"}.`,
            "handoff.md human notes were updated.",
          ].join(" "),
        );
      }
    } catch (error) {
      setMutationError(
        error instanceof LoopBoardApiError
          ? error.message
          : "Loop Control Plane could not apply that task action.",
      );
    } finally {
      setMutatingTaskId("");
    }
  }

  async function handleCreateGitHubIssue() {
    if (!selectedTask) {
      return;
    }

    setMutationError("");
    setContextMessage("");
    setMutatingTaskId(selectedTask.id);

    try {
      const result = await createPersistedTaskGitHubIssue(selectedTask.id);
      replaceTask(result.task);
      setContextMessage(result.issue.message);
    } catch (error) {
      setMutationError(
        error instanceof LoopBoardApiError
          ? error.message
          : "Loop Control Plane could not create the GitHub issue.",
      );
    } finally {
      setMutatingTaskId("");
    }
  }

  function handleOpenGitHubIssue() {
    if (!selectedTask?.github.issueUrl) {
      return;
    }

    window.open(selectedTask.github.issueUrl, "_blank", "noopener,noreferrer");
  }

  function handleOpenGitHubPullRequest() {
    if (!selectedTask?.github.pullRequestUrl) {
      return;
    }

    window.open(selectedTask.github.pullRequestUrl, "_blank", "noopener,noreferrer");
  }

  async function handleSyncGitHubIssueLabels(labels?: string[]) {
    if (!selectedTask) {
      return;
    }

    setMutationError("");
    setContextMessage("");
    setMutatingTaskId(selectedTask.id);

    try {
      const result = await syncPersistedTaskGitHubIssueLabels({
        taskId: selectedTask.id,
        labels,
      });
      replaceTask(result.task);
      setContextMessage(result.sync.message);
    } catch (error) {
      setMutationError(
        error instanceof LoopBoardApiError
          ? error.message
          : "Loop Control Plane could not sync GitHub issue labels.",
      );
    } finally {
      setMutatingTaskId("");
    }
  }

  async function handleSyncGitHubPullRequest() {
    if (!selectedTask) {
      return;
    }

    setMutationError("");
    setContextMessage("");
    setMutatingTaskId(selectedTask.id);

    try {
      const result = await syncPersistedTaskGitHubPullRequest({
        taskId: selectedTask.id,
        pullRequestUrl: selectedTask.github.pullRequestUrl,
      });
      replaceTask(result.task);
      setContextMessage(result.sync.message);
    } catch (error) {
      setMutationError(
        error instanceof LoopBoardApiError
          ? error.message
          : "Loop Control Plane could not sync GitHub PR/CI state.",
      );
    } finally {
      setMutatingTaskId("");
    }
  }

  function handleMarkAoReady() {
    if (!selectedTask) {
      return;
    }

    void handleSyncGitHubIssueLabels(
      Array.from(new Set([...(selectedTask.github.issueLabels ?? []), "ao-ready"])),
    );
  }

  function handleRemoveAoReady() {
    if (!selectedTask) {
      return;
    }

    void handleSyncGitHubIssueLabels(
      (selectedTask.github.issueLabels ?? []).filter((label) => label !== "ao-ready"),
    );
  }

  async function handleContextAction(
    action: "export-events" | "refresh-handoff",
  ) {
    if (!selectedTask) {
      return;
    }

    if (
      action === "refresh-handoff" &&
      handoffIsDirty &&
      !window.confirm(
        "Refresh generated handoff sections? Unsaved handoff.md edits in the editor will be discarded. Save first to keep them.",
      )
    ) {
      return;
    }

    setContextError("");
    setContextMessage("");
    setContextAction(action);

    try {
      const result: TaskContextActionResult =
        action === "export-events"
          ? await exportPersistedTaskEvents(selectedTask.id)
          : await refreshPersistedTaskHandoff(selectedTask.id);

      setContextStatus(result.context);
      if (action === "refresh-handoff") {
        await loadTaskHandoffDocument(selectedTask.id);
      }
      setContextMessage(
        action === "export-events"
          ? "events.jsonl was exported from the persisted event stream."
          : "handoff.md was refreshed from the latest task state.",
      );
    } catch (error) {
      setContextError(
        error instanceof LoopBoardApiError
          ? error.message
          : "Loop Control Plane could not update the generated context file.",
      );
    } finally {
      setContextAction("");
    }
  }

  async function saveSelectedHandoff() {
    if (!selectedTask) {
      return;
    }

    setContextError("");
    setContextMessage("");
    setHandoffAction("save");

    try {
      const result = await savePersistedTaskHandoff({
        taskId: selectedTask.id,
        content: handoffContent,
      });

      setContextStatus(result.context);
      setHandoffDocument(result.handoff);
      setHandoffContent(result.handoff.content);
      setHandoffSavedContent(result.handoff.content);
      setContextMessage("handoff.md manual edits saved.");
    } catch (error) {
      setContextError(
        error instanceof LoopBoardApiError
          ? error.message
          : "Loop Control Plane could not save handoff.md.",
      );
    } finally {
      setHandoffAction("");
    }
  }

  async function generateClaudePrompt() {
    if (!selectedTask) {
      return;
    }

    setContextError("");
    setContextMessage("");
    setClaudePromptAction("generate");

    try {
      const result = await generatePersistedTaskClaudeCodePrompt({
        taskId: selectedTask.id,
        manualIntent: claudePromptIntent,
      });

      setContextStatus(result.context);
      setClaudePrompt(result.prompt);
      setContextMessage("Claude Code prompt generated from the latest task context.");
    } catch (error) {
      setClaudePrompt(null);
      setContextError(
        error instanceof LoopBoardApiError
          ? error.message
          : "Loop Control Plane could not generate the Claude Code prompt.",
      );
    } finally {
      setClaudePromptAction("");
    }
  }

  async function copyClaudePrompt() {
    if (!claudePrompt) {
      await generateClaudePrompt();
      return;
    }

    try {
      await navigator.clipboard.writeText(claudePrompt.prompt);
      setContextError("");
      setContextMessage("Claude Code prompt copied to clipboard.");
    } catch {
      setContextMessage("");
      setContextError("Loop Control Plane could not copy the Claude Code prompt.");
    }
  }

  async function copyContextPath(path: string) {
    try {
      await navigator.clipboard.writeText(path);
      setContextError("");
      setContextMessage("Path copied to clipboard.");
    } catch {
      setContextMessage("");
      setContextError("Loop Control Plane could not copy the path to the clipboard.");
    }
  }

  async function handleRunTaskLoop() {
    if (!selectedTask || !selectedProject) {
      return;
    }

    setTaskLoopError("");
    setTaskLoopMessage("");
    setEngineAction("task-loop");

    try {
      const result = await enqueueTaskLoop({
        taskId: selectedTask.id,
        automated: false,
      });

      if (result.enqueued.length > 0) {
        setTaskLoopMessage(
          `Task-run job ${result.enqueued[0]!.id} queued (${result.enqueued[0]!.backend}).`,
        );
      } else if (result.deduped.length > 0) {
        setTaskLoopMessage(
          `Existing task-run job ${result.deduped[0]!.id} is already in flight.`,
        );
      } else if (result.skipped.length > 0) {
        setTaskLoopError(result.skipped[0]!.message);
      } else if (result.policy.kind !== "allow") {
        setTaskLoopError(result.policy.message);
      }

      await loadEngineStatus(selectedProject.id, { silent: true });
    } catch (error) {
      setTaskLoopError(
        error instanceof LoopBoardApiError
          ? error.message
          : "Loop Control Plane could not enqueue the task-run job.",
      );
    } finally {
      setEngineAction("");
    }
  }

  function reloadBoard() {
    void loadBoard(selectedProject?.id);
  }

  function changeBoardQuickFilter(filter: BoardQuickFilter) {
    setBoardQuickFilter(filter);
    window.localStorage.setItem(BOARD_QUICK_FILTER_STORAGE_KEY, filter);
  }

  return (
    <main className="min-h-screen bg-slate-100 text-slate-950">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-[112rem] flex-col gap-4 px-4 py-4 lg:px-6">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="border border-slate-200 bg-slate-50 px-2 py-1 text-xs font-semibold uppercase text-slate-600">
                  {selectedProject?.repository ?? "loading repository"}
                </span>
                <span className="border border-slate-200 bg-slate-50 px-2 py-1 text-xs font-semibold uppercase text-slate-600">
                  {selectedProject?.defaultBranch ?? "loading branch"}
                </span>
                <span
                  className={clsx(
                    "border px-2 py-1 text-xs font-semibold uppercase",
                    boardData.automationSettings.globalAutoRunEnabled
                      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                      : "border-rose-200 bg-rose-50 text-rose-700",
                  )}
                >
                  <ShieldAlert className="mr-1 inline h-3.5 w-3.5 align-[-2px]" />
                  {boardData.automationSettings.globalAutoRunEnabled
                    ? "global auto-run enabled"
                    : "global auto-run disabled"}
                </span>
              </div>
              <h1 className="mt-2 text-xl font-semibold tracking-normal text-slate-950 sm:text-2xl">
                {selectedProject?.name ?? "Loop Control Plane"}
              </h1>
              <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-600">
                {selectedProject?.description ?? "Loading persisted board data..."}
              </p>
            </div>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:shrink-0">
              {counters.map((counter) => (
                <button
                  key={counter.label}
                  type="button"
                  onClick={() =>
                    counter.id
                      ? changeBoardQuickFilter(
                          boardQuickFilter === counter.id ? "all" : counter.id,
                        )
                      : undefined
                  }
                  data-testid={`dashboard-filter-${counter.id}`}
                  className={clsx(
                    "min-w-0 border px-3 py-2 text-left hover:border-sky-300 hover:bg-sky-50",
                    boardQuickFilter === counter.id
                      ? "border-sky-300 bg-sky-50 ring-2 ring-sky-100"
                      : "border-slate-200 bg-slate-50",
                  )}
                >
                  <p className="truncate text-xs font-medium text-slate-500">
                    {counter.label}
                  </p>
                  <p className="mt-1 text-xl font-semibold text-slate-950">
                    {counter.value}
                  </p>
                </button>
              ))}
              <div className="col-span-2 min-w-0 border border-slate-200 bg-slate-50 px-3 py-2 text-left sm:col-span-4">
                <p className="truncate text-xs font-medium text-slate-500">
                  Latest Workflow Run
                </p>
                <p className="mt-1 truncate text-sm font-semibold uppercase text-slate-950">
                  {latestProjectWorkflowRun?.status ?? "no runs"}
                </p>
                {latestProjectWorkflowRun ? (
                  <p className="mt-1 truncate text-xs text-slate-500">
                    {latestProjectWorkflowRun.currentNodeId ?? "complete"} ·{" "}
                    {formatTimestamp(latestProjectWorkflowRun.updatedAt)}
                  </p>
                ) : null}
              </div>
            </div>
          </div>

          <section
            className="grid gap-3 border border-slate-200 bg-slate-50 p-3 lg:grid-cols-3"
            data-testid="project-metrics"
          >
            <MetricGroup title="Tasks By Status" metrics={projectStatusMetrics} />
            <MetricGroup title="Tasks By Owner" metrics={projectOwnerMetrics} />
            <MetricGroup title="Tasks By Risk" metrics={projectRiskMetrics} />
          </section>

          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex min-w-0 items-center gap-2 border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700">
              <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-slate-400" />
              <select
                value={selectedProject?.id ?? ""}
                onChange={(event) => selectProject(event.target.value)}
                className="max-w-60 bg-transparent text-xs font-semibold text-slate-700 outline-none"
                disabled={projects.length === 0}
              >
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={startCreateProject}
              className="inline-flex max-w-full items-center gap-1.5 border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-800"
            >
              <Plus className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">Add project</span>
            </button>
            {selectedProject ? (
              <>
                <button
                  type="button"
                  onClick={startEditProject}
                  className="inline-flex max-w-full items-center gap-1.5 border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-800"
                >
                  <Pencil className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">Edit project</span>
                </button>
                <button
                  type="button"
                  onClick={() => void openSelectedProject("open-folder")}
                  disabled={projectOpenAction.length > 0}
                  className="inline-flex max-w-full items-center gap-1.5 border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <FolderOpen className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">Open Folder</span>
                </button>
                <button
                  type="button"
                  onClick={() => void openSelectedProject("open-vscode")}
                  disabled={projectOpenAction.length > 0}
                  className="inline-flex max-w-full items-center gap-1.5 border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Code2 className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">Open VS Code</span>
                </button>
                <button
                  type="button"
                  onClick={removeSelectedProject}
                  disabled={isSavingProject}
                  className="inline-flex max-w-full items-center gap-1.5 border border-red-200 bg-white px-2.5 py-1 text-xs font-semibold text-red-700 hover:border-red-300 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Trash2 className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">Delete project</span>
                </button>
              </>
            ) : null}
            <label className="inline-flex max-w-full items-center gap-2 border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-800">
              <input
                type="checkbox"
                checked={boardData.automationSettings.globalAutoRunEnabled}
                onChange={(event) => void toggleGlobalAutoRun(event.target.checked)}
                className="h-3.5 w-3.5 accent-slate-900"
              />
              <span className="truncate">Global auto-run</span>
            </label>
            {visibleFeatures.map((feature) => (
              <button
                key={feature.id}
                type="button"
                onClick={() => selectFeature(feature.id)}
                className={clsx(
                  "inline-flex max-w-full items-center gap-1.5 border px-2.5 py-1 text-xs font-medium",
                  selectedFeature?.id === feature.id
                    ? "border-sky-300 bg-sky-50 text-sky-800"
                    : "border-slate-200 bg-slate-50 text-slate-700",
                )}
              >
                <Columns3 className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                <span className="min-w-0 truncate">
                  {feature.name}: {featureStatusLabel(feature.status)}
                </span>
              </button>
            ))}
            <button
              type="button"
              onClick={reloadBoard}
              className="inline-flex max-w-full items-center gap-1.5 border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-800"
            >
              <ListRestart className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">Reload persisted data</span>
            </button>
          </div>

          {projectMutationError ? (
            <div className="border border-red-200 bg-red-50 p-3 text-sm leading-6 text-red-800">
              {projectMutationError}
            </div>
          ) : null}
          {projectMutationMessage ? (
            <div className="border border-emerald-200 bg-emerald-50 p-3 text-sm leading-6 text-emerald-800">
              {projectMutationMessage}
            </div>
          ) : null}
          <div className="grid gap-2 border border-slate-200 bg-slate-50 p-3 text-sm leading-6 text-slate-700 md:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase text-slate-500">
                Effective Automation Policy
              </p>
              <p className="mt-1 font-semibold text-slate-950">
                {effectiveAutomationPolicy.message}
              </p>
            </div>
            <div className="grid gap-1 sm:grid-cols-2">
              {effectiveAutomationPolicy.reasons.map((reason) => (
                <span
                  key={reason}
                  className="min-w-0 border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600"
                >
                  {reason}
                </span>
              ))}
            </div>
          </div>
          <ProjectHealth
            project={selectedProject}
            githubConnection={githubConnection}
            githubLabelSetup={githubLabelSetup}
            isCheckingGitHub={isCheckingGitHub}
            isSettingUpGitHubLabels={isSettingUpGitHubLabels}
            onCheckGitHub={checkSelectedProjectGitHubConnection}
            onSetupGitHubLabels={setupSelectedProjectGitHubLabels}
          />
          <LoopEnginePanel
            project={selectedProject}
            engineStatus={engineStatus}
            backendAvailability={backendAvailability}
            isLoadingBackendAvailability={isLoadingBackendAvailability}
            isLoading={isLoadingEngineStatus}
            engineAction={engineAction}
            engineError={engineError}
            engineMessage={engineMessage}
            globalAutoRunEnabled={boardData.automationSettings.globalAutoRunEnabled}
            automationPolicyMessage={effectiveAutomationPolicy.message}
            onRunDemoJob={() => void runEngineDemoJob()}
            onTickOnce={() => void tickEngineOnce()}
            onStartScheduler={() => void startEngineSchedulerAction()}
            onStopScheduler={() => void stopEngineSchedulerAction()}
            onRefresh={() => {
              void loadEngineStatus(selectedProject?.id);
              void loadBackendAvailability(selectedProject?.id);
            }}
          />
          {projectMode !== "idle" ? (
            <ProjectForm
              mode={projectMode}
              form={projectForm}
              onChange={updateProjectForm}
              onSubmit={saveProject}
              onCancel={() => setProjectMode("idle")}
              isSaving={isSavingProject}
            />
          ) : null}
          {featureMutationError ? (
            <div className="border border-red-200 bg-red-50 p-3 text-sm leading-6 text-red-800">
              {featureMutationError}
            </div>
          ) : null}
          {featureMutationMessage ? (
            <div className="border border-emerald-200 bg-emerald-50 p-3 text-sm leading-6 text-emerald-800">
              {featureMutationMessage}
            </div>
          ) : null}
          {featureMode !== "idle" ? (
            <FeatureForm
              mode={featureMode}
              form={featureForm}
              onChange={updateFeatureForm}
              onSubmit={saveFeature}
              onCancel={() => setFeatureMode("idle")}
              isSaving={isSavingFeature}
            />
          ) : null}
          <FeaturePanel
            features={visibleFeatures}
            selectedFeature={selectedFeature}
            selectedArtifactName={selectedArtifactName}
            artifactDocument={artifactDocument}
            artifactContent={artifactContent}
            artifactIsDirty={artifactIsDirty}
            artifactIsLoading={isLoadingArtifact}
            artifactIsSaving={isSavingArtifact}
            artifactError={artifactError}
            artifactMessage={artifactMessage}
            approvingArtifactName={approvingArtifactName}
            importPreview={importPreview}
            importPreviewTasks={importPreviewTasks}
            isImportPreviewLoading={isImportPreviewLoading}
            isImportingSpecKitTasks={isImportingSpecKitTasks}
            importError={importError}
            importMessage={importMessage}
            onSelect={selectFeature}
            onCreate={startCreateFeature}
            onEdit={startEditFeature}
            onDelete={removeSelectedFeature}
            onSelectArtifact={selectArtifact}
            onArtifactContentChange={updateArtifactContent}
            onReloadArtifact={() => void reloadSelectedArtifact()}
            onSaveArtifact={() => void saveSelectedArtifact()}
            onApproveArtifact={(artifactName) =>
              void approveSelectedFeatureArtifact(artifactName)
            }
            onPreviewSpecKitTasks={() => void previewSelectedSpecKitTasks()}
            onCancelSpecKitImport={cancelSpecKitImport}
            onImportSpecKitTasks={() => void importSelectedSpecKitTasks()}
            onToggleSpecKitTask={toggleSpecKitPreviewTask}
            onChangeSpecKitTask={changeSpecKitPreviewTask}
          />
          <WorkflowEditor
            project={selectedProject}
            selectedFeature={selectedFeature}
            automationSettings={boardData.automationSettings}
          />
        </div>
      </header>

      <div className="mx-auto grid max-w-[112rem] gap-4 px-4 py-4 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,23rem)] lg:px-6">
        <DndContext id="loopboard-kanban" sensors={sensors} onDragEnd={handleDragEnd}>
          <div
            className="min-w-0 overflow-x-auto border border-slate-200 bg-white"
            data-board-scroll
          >
            {loadError ? (
              <BoardMessage
                title="Persisted board could not load"
                message={loadError}
                actionLabel="Try again"
                onAction={reloadBoard}
              />
            ) : isLoadingBoard && visibleTasks.length === 0 ? (
              <BoardMessage
                title="Loading persisted board"
                message="Reading projects, features, tasks, and event history from the local SQLite database."
              />
            ) : !selectedProject ? (
              <BoardMessage
                title="No project selected"
                message="Create a project to connect a local repository, configure automation policy, and start linking feature work."
                actionLabel="Create project"
                onAction={startCreateProject}
              />
            ) : visibleFeatures.length === 0 ? (
              <BoardMessage
                title="No feature selected"
                message="Create a feature for this project before importing Spec Kit tasks or running the execution board."
                actionLabel="Create feature"
                onAction={startCreateFeature}
              />
            ) : visibleTasks.length === 0 ? (
              <BoardMessage
                title="No tasks found"
                message={`The selected feature, ${selectedFeature?.name ?? "this feature"}, does not have persisted tasks yet. Import Spec Kit tasks from the feature panel or add tasks through the local persistence flow.`}
                actionLabel="Preview Spec Kit tasks"
                onAction={() => void previewSelectedSpecKitTasks()}
              />
            ) : filteredVisibleTasks.length === 0 ? (
              <BoardMessage
                title="No tasks match this filter"
                message={`The ${compactText(boardQuickFilter)} filter has no matching tasks for the selected project.`}
                actionLabel="Show all tasks"
                onAction={() => changeBoardQuickFilter("all")}
              />
            ) : (
              <div className="flex min-w-max">
                {KANBAN_COLUMNS.map((column) => (
                  <BoardColumn
                    key={column.id}
                    id={column.id}
                    label={column.label}
                    tasks={groupedTasks[column.id]}
                    featuresById={featuresById}
                    selectedTaskId={selectedTask?.id ?? ""}
                    taskRunJobsByTaskId={taskRunJobsByTaskId}
                    onSelectTask={selectTask}
                  />
                ))}
              </div>
            )}
          </div>
        </DndContext>

        <aside className="min-w-0 border border-slate-200 bg-white p-4 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto">
          {mutationError ? (
            <div className="mb-4 border border-red-200 bg-red-50 p-3 text-sm leading-6 text-red-800">
              {mutationError}
            </div>
          ) : null}
          {contextError ? (
            <div className="mb-4 border border-red-200 bg-red-50 p-3 text-sm leading-6 text-red-800">
              {contextError}
            </div>
          ) : null}
          {contextMessage ? (
            <div className="mb-4 border border-emerald-200 bg-emerald-50 p-3 text-sm leading-6 text-emerald-800">
              {contextMessage}
            </div>
          ) : null}
          {selectedTask ? (
            <div>
              <div className="flex min-w-0 items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-semibold uppercase text-slate-500">
                    {statusLabel(selectedTask.status)}
                  </p>
                  <h2 className="mt-1 text-lg font-semibold leading-6 text-slate-950 [overflow-wrap:anywhere]">
                    {selectedTask.title}
                  </h2>
                </div>
                {selectedTask.status === "done" ? (
                  <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600" />
                ) : selectedTask.status === "blocked" ? (
                  <AlertTriangle className="h-5 w-5 shrink-0 text-orange-600" />
                ) : null}
              </div>

              <p className="mt-3 text-sm leading-6 text-slate-600">
                {selectedTask.description}
              </p>

              {featuresById.get(selectedTask.featureId) ? (
                <section className="mt-4 border border-slate-200 bg-slate-50 p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="text-xs font-semibold uppercase text-slate-500">
                        Linked Feature
                      </h3>
                      <p className="mt-1 truncate text-sm font-semibold text-slate-950">
                        {featuresById.get(selectedTask.featureId)?.name}
                      </p>
                    </div>
                    <span className="border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] font-semibold uppercase text-slate-700">
                      {featureStatusLabel(featuresById.get(selectedTask.featureId)!.status)}
                    </span>
                  </div>
                  <FeatureCompletenessBar feature={featuresById.get(selectedTask.featureId)!} />
                </section>
              ) : null}

              <div className="mt-4 flex flex-wrap gap-1.5">
                <MetaPill icon={ownerIcon[selectedTask.owner]} text={selectedTask.owner} />
                <MetaPill icon={PauseCircle} text={selectedTask.mode} />
                <MetaPill icon={ImportIcon} text={selectedTask.source} />
                <span className={clsx("border px-1.5 py-0.5 text-[10px] font-semibold uppercase", riskStyle(selectedTask.risk))}>
                  {selectedTask.risk}
                </span>
              </div>

              <div className="mt-4 grid gap-2 text-xs">
                <MetaLine icon={GitBranch} text={selectedTask.branch} />
                <MetaLine
                  icon={Hash}
                  text={
                    selectedWorkspaceUsesFallback
                      ? "worktree not configured; using repo"
                      : selectedTask.worktree
                  }
                />
              </div>

              <section className="mt-5">
                <h3 className="text-xs font-semibold uppercase text-slate-500">
                  Local Workspace
                </h3>
                <div className="mt-2 grid gap-2 border border-slate-200 bg-slate-50 p-3">
                  <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-[11px] font-semibold uppercase text-slate-500">
                        {selectedWorkspaceUsesFallback ? "Repo fallback" : "Worktree path"}
                      </p>
                      <p className="mt-1 truncate font-mono text-sm font-semibold text-slate-900">
                        {selectedWorkspacePath || "No local path configured"}
                      </p>
                    </div>
                    <span
                      className={clsx(
                        "shrink-0 border px-1.5 py-0.5 text-[10px] font-semibold uppercase",
                        selectedWorkspaceUsesFallback
                          ? "border-amber-200 bg-amber-50 text-amber-800"
                          : "border-emerald-200 bg-emerald-50 text-emerald-800",
                      )}
                    >
                      {selectedWorkspaceUsesFallback ? "repo fallback" : "worktree"}
                    </span>
                  </div>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                    <button
                      type="button"
                      onClick={() => void openSelectedTask("open-worktree-vscode")}
                      disabled={taskOpenAction.length > 0 || !selectedRepoPath}
                      className="inline-flex min-h-10 min-w-0 items-center justify-center gap-2 border border-slate-200 bg-white px-2 py-2 text-xs font-semibold text-slate-700 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-800 disabled:cursor-not-allowed disabled:opacity-50"
                      title={
                        selectedWorkspaceUsesFallback
                          ? "Open the repository in VS Code because this task has no worktree path."
                          : "Open the configured task worktree in VS Code."
                      }
                    >
                      <Code2 className="h-4 w-4 shrink-0" />
                      <span className="min-w-0 truncate">Open Worktree in VS Code</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void openSelectedTask("open-repo-vscode")}
                      disabled={taskOpenAction.length > 0 || !selectedRepoPath}
                      className="inline-flex min-h-10 min-w-0 items-center justify-center gap-2 border border-slate-200 bg-white px-2 py-2 text-xs font-semibold text-slate-700 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-800 disabled:cursor-not-allowed disabled:opacity-50"
                      title="Open the project repository in VS Code."
                    >
                      <FolderGit2 className="h-4 w-4 shrink-0" />
                      <span className="min-w-0 truncate">Open Repo in VS Code</span>
                    </button>
                  </div>
                </div>
                <div className="mt-3 grid gap-2">
                  {selectedRepoPath ? (
                    <CopyValueRow
                      label="repo path"
                      value={selectedRepoPath}
                      badge="repo"
                      href={fileHref(selectedRepoPath)}
                      onCopy={copyContextPath}
                    />
                  ) : null}
                  {selectedWorkspacePath ? (
                    <CopyValueRow
                      label={
                        selectedWorkspaceUsesFallback
                          ? "worktree path fallback"
                          : "worktree path"
                      }
                      value={selectedWorkspacePath}
                      badge={selectedWorkspaceUsesFallback ? "fallback" : "worktree"}
                      href={fileHref(selectedWorkspacePath)}
                      onCopy={copyContextPath}
                    />
                  ) : null}
                </div>
              </section>

              {selectedTask.source === "spec-kit" ? (
                <section className="mt-5">
                  <h3 className="text-xs font-semibold uppercase text-slate-500">
                    Spec Kit Source
                  </h3>
                  <div className="mt-2 grid gap-2 border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
                    {selectedTaskImportEvent?.metadata?.sourceId ? (
                      <MetaLine
                        icon={Hash}
                        text={`source task ${selectedTaskImportEvent.metadata.sourceId}`}
                      />
                    ) : null}
                    {selectedTaskImportEvent?.metadata?.sourceLine ? (
                      <MetaLine
                        icon={FileText}
                        text={`line ${selectedTaskImportEvent.metadata.sourceLine}`}
                      />
                    ) : null}
                    {selectedTaskImportEvent?.metadata?.tasksPath ? (
                      <MetaLine
                        icon={FileText}
                        text={String(selectedTaskImportEvent.metadata.tasksPath)}
                      />
                    ) : null}
                    {!selectedTaskImportEvent ? (
                      <p className="text-xs leading-5 text-slate-500">
                        No import event metadata is attached to this task.
                      </p>
                    ) : null}
                  </div>
                </section>
              ) : null}

              <section className="mt-5">
                <h3 className="text-xs font-semibold uppercase text-slate-500">
                  GitHub Delivery
                </h3>
                <div className="mt-2 grid gap-2 border border-slate-200 bg-slate-50 p-3">
                  <div className="flex flex-wrap gap-1.5">
                    {selectedTask.github.pullRequestNumber ? (
                      <MetaPill
                        icon={GitPullRequest}
                        text={`pr ${selectedTask.github.pullRequestNumber}`}
                      />
                    ) : (
                      <span className="border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] font-semibold uppercase text-slate-600">
                        no pr
                      </span>
                    )}
                    {selectedTask.github.deliveryStatus ? (
                      <span className="border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] font-semibold uppercase text-slate-700">
                        {compactText(selectedTask.github.deliveryStatus)}
                      </span>
                    ) : null}
                    {selectedTask.github.ciStatus ? (
                      <span
                        className={clsx(
                          "border px-1.5 py-0.5 text-[10px] font-semibold uppercase",
                          healthTone[selectedTask.github.ciStatus],
                        )}
                      >
                        ci {compactText(selectedTask.github.ciStatus)}
                      </span>
                    ) : null}
                    {selectedTask.github.reviewStatus ? (
                      <span
                        className={clsx(
                          "border px-1.5 py-0.5 text-[10px] font-semibold uppercase",
                          reviewTone[selectedTask.github.reviewStatus],
                        )}
                      >
                        review {compactText(selectedTask.github.reviewStatus)}
                      </span>
                    ) : null}
                  </div>
                  <div className="grid gap-2 text-xs text-slate-600">
                    {selectedTask.github.pullRequestBranch ? (
                      <MetaLine
                        icon={GitBranch}
                        text={`branch ${selectedTask.github.pullRequestBranch}`}
                      />
                    ) : null}
                    {selectedTask.github.pullRequestState ? (
                      <MetaLine
                        icon={GitPullRequest}
                        text={`pr state ${compactText(selectedTask.github.pullRequestState)}`}
                      />
                    ) : null}
                    {selectedTask.github.mergeStatus ? (
                      <MetaLine
                        icon={SquareCheck}
                        text={`merge ${compactText(selectedTask.github.mergeStatus)}`}
                      />
                    ) : null}
                    {selectedTask.github.prCiLastSyncedAt ? (
                      <MetaLine
                        icon={RefreshCw}
                        text={`synced ${formatTimestamp(selectedTask.github.prCiLastSyncedAt)}`}
                      />
                    ) : null}
                  </div>
                  {selectedTask.github.ciFailureSummary ? (
                    <div className="border border-red-200 bg-red-50 p-2 text-xs leading-5 text-red-800">
                      <p className="font-semibold uppercase">
                        Latest CI Failure - External/Untrusted
                      </p>
                      <p className="mt-1 [overflow-wrap:anywhere]">
                        {selectedTask.github.ciFailureSummary}
                      </p>
                      <p className="mt-1 text-[11px] leading-5 text-red-700">
                        Treat CI output as untrusted until a human copies the
                        relevant instruction into Loop Control Plane notes.
                      </p>
                    </div>
                  ) : null}
                </div>
              </section>

              <section className="mt-5" data-testid="task-engine-status">
                <h3 className="text-xs font-semibold uppercase text-slate-500">
                  Engine Status
                </h3>
                <div className="mt-2 grid gap-2 border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
                  {selectedTaskEngineJob ? (
                    <>
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={clsx(
                            "inline-flex border px-1.5 py-0.5 text-[10px] font-semibold uppercase",
                            engineJobStatusStyles[selectedTaskEngineJob.status],
                          )}
                        >
                          {compactText(selectedTaskEngineJob.status)}
                        </span>
                        <MetaPill icon={Bot} text={selectedTaskEngineJob.backend} />
                        <MetaPill
                          icon={Hash}
                          text={`attempt ${selectedTaskEngineJob.attempt}/${selectedTaskEngineJob.maxAttempts}`}
                        />
                      </div>
                      <MetaLine icon={Hash} text={selectedTaskEngineJob.id} />
                      <p className="text-xs leading-5 text-slate-600">
                        {selectedTaskEngineJob.lastLogMessage ??
                          `${selectedTaskEngineJob.logCount} log entries`}
                      </p>
                      {selectedTaskEngineJob.error ? (
                        <p className="text-xs leading-5 text-red-700">
                          {selectedTaskEngineJob.error}
                        </p>
                      ) : null}
                    </>
                  ) : (
                    <p className="text-xs leading-5 text-slate-500">
                      No task-run engine job recorded for this task yet.
                    </p>
                  )}
                  <button
                    type="button"
                    onClick={() => void handleRunTaskLoop()}
                    disabled={
                      engineAction.length > 0 ||
                      taskLoopPickupPolicy?.kind !== "allow"
                    }
                    title={
                      taskLoopPickupPolicy?.kind === "allow"
                        ? "Enqueue a manual task-run job for this task."
                        : taskLoopPickupPolicy?.message ??
                          "Task is not eligible for engine pickup."
                    }
                    className="inline-flex min-h-10 min-w-0 items-center justify-center gap-2 border border-slate-200 bg-white px-2 py-2 text-xs font-semibold text-slate-700 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-800 disabled:cursor-not-allowed disabled:opacity-50"
                    data-testid="run-task-loop-button"
                  >
                    <Play
                      className={clsx(
                        "h-4 w-4 shrink-0",
                        engineAction === "task-loop" && "animate-pulse",
                      )}
                    />
                    <span className="min-w-0 truncate">Run with Engine</span>
                  </button>
                  {selectedProject?.engineSettings.agentOrchestrator?.dashboardUrl ? (
                    <a
                      href={selectedProject.engineSettings.agentOrchestrator.dashboardUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex min-h-10 min-w-0 items-center justify-center gap-2 border border-slate-200 bg-white px-2 py-2 text-xs font-semibold text-sky-800 hover:border-sky-300 hover:bg-sky-50"
                      data-testid="open-ao-dashboard-link"
                    >
                      <ExternalLink className="h-4 w-4 shrink-0" />
                      <span className="min-w-0 truncate">Open AO Dashboard</span>
                    </a>
                  ) : null}
                  {taskLoopPickupPolicy && taskLoopPickupPolicy.kind !== "allow" ? (
                    <p className="text-xs leading-5 text-amber-800">
                      {taskLoopPickupPolicy.message}
                    </p>
                  ) : null}
                  {taskLoopError ? (
                    <p className="text-xs leading-5 text-red-700">{taskLoopError}</p>
                  ) : null}
                  {taskLoopMessage ? (
                    <p className="text-xs leading-5 text-emerald-800">{taskLoopMessage}</p>
                  ) : null}
                </div>
              </section>

              <section className="mt-5">
                <h3 className="text-xs font-semibold uppercase text-slate-500">
                  Actions
                </h3>
                <label className="mt-2 grid gap-1.5 border border-slate-200 bg-slate-50 p-3">
                  <span className="text-[11px] font-semibold uppercase text-slate-500">
                    Return handoff note
                  </span>
                  <textarea
                    value={returnAiHandoffNote}
                    onChange={(event) => setReturnAiHandoffNote(event.target.value)}
                    rows={3}
                    className="min-h-20 w-full resize-y border border-slate-200 bg-white px-3 py-2 text-sm leading-6 text-slate-800 outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
                    placeholder="Optional note for the next AI pass"
                  />
                  <span className="text-xs leading-5 text-slate-500">
                    Used when returning this task to AI; a default handoff note is
                    written if left blank.
                  </span>
                </label>
                <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                  {(() => {
                    const projectHasGitHubRepo = Boolean(selectedProject?.githubRepository);
                    const hasGitHubIssue = Boolean(
                      selectedTask.github.issueNumber || selectedTask.github.issueUrl,
                    );
                    const hasGitHubPullRequest = Boolean(
                      selectedTask.github.pullRequestNumber ||
                        selectedTask.github.pullRequestUrl,
                    );
                    const isAoReady =
                      selectedTask.github.issueLabels?.includes("ao-ready") ?? false;
                    const requiresAoApproval =
                      selectedTask.risk !== "low" && !selectedTask.github.aoReadyApprovedAt;
                    const githubMutationDisabled =
                      mutatingTaskId === selectedTask.id || !projectHasGitHubRepo;

                    return (
                      <>
                        <button
                          type="button"
                          onClick={handleCreateGitHubIssue}
                          disabled={
                            mutatingTaskId === selectedTask.id ||
                            hasGitHubIssue ||
                            !projectHasGitHubRepo
                          }
                          className="inline-flex min-h-10 min-w-0 items-center justify-center gap-2 border border-slate-200 bg-white px-2 py-2 text-xs font-semibold text-slate-700 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-800 disabled:cursor-not-allowed disabled:opacity-50"
                          title={
                            hasGitHubIssue
                              ? "This task already has a GitHub issue."
                              : projectHasGitHubRepo
                                ? "Create a GitHub issue from this task."
                                : "Configure a GitHub repo in project settings first."
                          }
                        >
                          <Hash className="h-4 w-4 shrink-0" />
                          <span className="min-w-0 truncate">Create GitHub Issue</span>
                        </button>
                        <button
                          type="button"
                          onClick={handleOpenGitHubIssue}
                          disabled={!selectedTask.github.issueUrl}
                          className="inline-flex min-h-10 min-w-0 items-center justify-center gap-2 border border-slate-200 bg-white px-2 py-2 text-xs font-semibold text-slate-700 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-800 disabled:cursor-not-allowed disabled:opacity-50"
                          title={
                            selectedTask.github.issueUrl
                              ? "Open the linked GitHub issue in a new tab."
                              : "Create or link a GitHub issue first."
                          }
                        >
                          <ExternalLink className="h-4 w-4 shrink-0" />
                          <span className="min-w-0 truncate">Open Issue</span>
                        </button>
                        <button
                          type="button"
                          onClick={handleOpenGitHubPullRequest}
                          disabled={!selectedTask.github.pullRequestUrl}
                          className="inline-flex min-h-10 min-w-0 items-center justify-center gap-2 border border-slate-200 bg-white px-2 py-2 text-xs font-semibold text-slate-700 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-800 disabled:cursor-not-allowed disabled:opacity-50"
                          title={
                            selectedTask.github.pullRequestUrl
                              ? "Open the linked GitHub pull request in a new tab."
                              : "Sync PR/CI to discover or link a pull request first."
                          }
                        >
                          <GitPullRequest className="h-4 w-4 shrink-0" />
                          <span className="min-w-0 truncate">Open PR</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleSyncGitHubIssueLabels()}
                          disabled={githubMutationDisabled || !hasGitHubIssue}
                          className="inline-flex min-h-10 min-w-0 items-center justify-center gap-2 border border-slate-200 bg-white px-2 py-2 text-xs font-semibold text-slate-700 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-800 disabled:cursor-not-allowed disabled:opacity-50"
                          title={
                            !projectHasGitHubRepo
                              ? "Configure a GitHub repo in project settings first."
                              : hasGitHubIssue
                                ? "Recalculate and sync Loop Control Plane labels to the linked issue."
                                : "Create or link a GitHub issue first."
                          }
                        >
                          <RefreshCw className="h-4 w-4 shrink-0" />
                          <span className="min-w-0 truncate">Sync Issue Labels</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleSyncGitHubPullRequest()}
                          disabled={githubMutationDisabled}
                          className="inline-flex min-h-10 min-w-0 items-center justify-center gap-2 border border-slate-200 bg-white px-2 py-2 text-xs font-semibold text-slate-700 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-800 disabled:cursor-not-allowed disabled:opacity-50"
                          title={
                            !projectHasGitHubRepo
                              ? "Configure a GitHub repo in project settings first."
                              : hasGitHubPullRequest
                                ? "Refresh PR, CI, review, and merge state from GitHub."
                                : "Discover a linked PR from the issue timeline, branch, or task metadata."
                          }
                        >
                          <RefreshCw className="h-4 w-4 shrink-0" />
                          <span className="min-w-0 truncate">Sync PR/CI</span>
                        </button>
                        <button
                          type="button"
                          onClick={handleMarkAoReady}
                          disabled={
                            githubMutationDisabled ||
                            !hasGitHubIssue ||
                            isAoReady ||
                            requiresAoApproval
                          }
                          className="inline-flex min-h-10 min-w-0 items-center justify-center gap-2 border border-slate-200 bg-white px-2 py-2 text-xs font-semibold text-slate-700 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-800 disabled:cursor-not-allowed disabled:opacity-50"
                          title={
                            !projectHasGitHubRepo
                              ? "Configure a GitHub repo in project settings first."
                              : !hasGitHubIssue
                                ? "Create or link a GitHub issue first."
                                : isAoReady
                                  ? "This issue already has ao-ready."
                                  : requiresAoApproval
                                    ? "Approve AO ready locally before marking this risk level ao-ready."
                                    : "Apply ao-ready to the linked GitHub issue."
                          }
                        >
                          <Bot className="h-4 w-4 shrink-0" />
                          <span className="min-w-0 truncate">Mark AO Ready</span>
                        </button>
                        <button
                          type="button"
                          onClick={handleRemoveAoReady}
                          disabled={githubMutationDisabled || !hasGitHubIssue || !isAoReady}
                          className="inline-flex min-h-10 min-w-0 items-center justify-center gap-2 border border-red-200 bg-white px-2 py-2 text-xs font-semibold text-red-700 hover:border-red-300 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                          title={
                            !projectHasGitHubRepo
                              ? "Configure a GitHub repo in project settings first."
                              : !hasGitHubIssue
                                ? "Create or link a GitHub issue first."
                                : isAoReady
                                  ? "Remove ao-ready from the linked GitHub issue."
                                  : "The linked issue is not marked ao-ready."
                          }
                        >
                          <X className="h-4 w-4 shrink-0" />
                          <span className="min-w-0 truncate">Remove AO Ready</span>
                        </button>
                      </>
                    );
                  })()}
                  {taskActions.map((action) => {
                    const ActionIcon = action.icon;
                    const isAoApproval = action.id === "approve-ao-ready";
                    const hasGitHubIssue = Boolean(
                      selectedTask.github.issueNumber || selectedTask.github.issueUrl,
                    );
                    const isAoReady =
                      selectedTask.github.issueLabels?.includes("ao-ready") ?? false;
                    const approvalDisabled =
                      isAoApproval &&
                      (!hasGitHubIssue ||
                        selectedTask.risk === "low" ||
                        isAoReady ||
                        Boolean(selectedTask.github.aoReadyApprovedAt));
                    const approvalTitle = !isAoApproval
                      ? undefined
                      : !hasGitHubIssue
                        ? "Create or link a GitHub issue before approving AO ready."
                        : selectedTask.risk === "low"
                          ? "Low-risk tasks do not require local AO approval."
                          : isAoReady
                            ? "This issue already has the ao-ready label."
                            : selectedTask.github.aoReadyApprovedAt
                              ? "AO ready approval is already recorded."
                              : "Record local approval to allow ao-ready for this risk level.";

                    return (
                      <button
                        key={action.id}
                        type="button"
                        onClick={() => handleTaskAction(action.id)}
                        disabled={
                          mutatingTaskId === selectedTask.id || approvalDisabled
                        }
                        title={approvalTitle}
                        className="inline-flex min-h-10 min-w-0 items-center justify-center gap-2 border border-slate-200 bg-white px-2 py-2 text-xs font-semibold text-slate-700 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-800 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <ActionIcon className="h-4 w-4 shrink-0" />
                        <span className="min-w-0 truncate">{action.label}</span>
                      </button>
                    );
                  })}
                </div>
              </section>

              <section className="mt-5">
                <h3 className="text-xs font-semibold uppercase text-slate-500">
                  Context Files
                </h3>
                <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                  <button
                    type="button"
                    onClick={() => handleContextAction("export-events")}
                    disabled={contextAction.length > 0}
                    className="inline-flex min-h-10 min-w-0 items-center justify-center gap-2 border border-slate-200 bg-white px-2 py-2 text-xs font-semibold text-slate-700 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-800 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <FileDown className="h-4 w-4 shrink-0" />
                    <span className="min-w-0 truncate">Export events</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleContextAction("refresh-handoff")}
                    disabled={contextAction.length > 0}
                    className="inline-flex min-h-10 min-w-0 items-center justify-center gap-2 border border-slate-200 bg-white px-2 py-2 text-xs font-semibold text-slate-700 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-800 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <RefreshCw className="h-4 w-4 shrink-0" />
                    <span className="min-w-0 truncate">Refresh handoff</span>
                  </button>
                </div>
                <div className="mt-3 grid gap-2">
                  {contextStatus ? (
                    <>
                      <ContextPathRow
                        label="task.md"
                        path={contextStatus.files.task.path}
                        exists={contextStatus.files.task.exists}
                        onCopy={copyContextPath}
                      />
                      <ContextPathRow
                        label="context.md"
                        path={contextStatus.files.context.path}
                        exists={contextStatus.files.context.exists}
                        onCopy={copyContextPath}
                      />
                      <ContextPathRow
                        label="handoff.md"
                        path={contextStatus.files.handoff.path}
                        exists={contextStatus.files.handoff.exists}
                        onCopy={copyContextPath}
                      />
                      <ContextPathRow
                        label="events.jsonl"
                        path={contextStatus.files.events.path}
                        exists={contextStatus.files.events.exists}
                        onCopy={copyContextPath}
                      />
                    </>
                  ) : (
                    <p className="text-xs leading-5 text-slate-500">
                      Generated file paths are loading.
                    </p>
                  )}
                </div>
              </section>

              <section className="mt-5">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-xs font-semibold uppercase text-slate-500">
                    Handoff Editor
                  </h3>
                  {handoffIsDirty ? (
                    <span className="inline-flex items-center gap-1 text-[11px] font-semibold uppercase text-amber-700">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      Unsaved
                    </span>
                  ) : null}
                </div>
                <div className="mt-2 grid gap-3 border border-slate-200 bg-slate-50 p-3">
                  <div className="flex flex-wrap items-center gap-2 text-[11px] leading-5 text-slate-500">
                    <span className="border border-slate-200 bg-white px-1.5 py-0.5 font-semibold uppercase text-slate-600">
                      {handoffDocument?.updatedAt
                        ? `Updated ${formatTimestamp(handoffDocument.updatedAt)}`
                        : handoffDocument?.exists === false
                          ? "handoff.md missing"
                          : "Loading handoff.md"}
                    </span>
                    <span className="border border-sky-200 bg-sky-50 px-1.5 py-0.5 font-semibold uppercase text-sky-700">
                      Generated: {handoffDocument?.sections.generated.sourceOfTruth ?? "task state"}
                    </span>
                    <span className="border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 font-semibold uppercase text-emerald-700">
                      Human notes:{" "}
                      {handoffDocument?.sections.humanNotes.sourceOfTruth ?? "manual edits"}
                    </span>
                  </div>
                  <textarea
                    value={handoffContent}
                    onChange={(event) => setHandoffContent(event.target.value)}
                    rows={12}
                    disabled={handoffAction === "load"}
                    className="min-h-72 w-full resize-y border border-slate-200 bg-white px-3 py-2 font-mono text-xs leading-5 text-slate-800 outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100 disabled:cursor-wait disabled:opacity-60"
                    placeholder="Load or refresh handoff.md to edit it here."
                  />
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                    <button
                      type="button"
                      onClick={() => void saveSelectedHandoff()}
                      disabled={
                        !selectedTask ||
                        handoffAction.length > 0 ||
                        !handoffIsDirty
                      }
                      className="inline-flex min-h-10 min-w-0 items-center justify-center gap-2 border border-slate-200 bg-white px-2 py-2 text-xs font-semibold text-slate-700 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-800 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Save className="h-4 w-4 shrink-0" />
                      <span className="min-w-0 truncate">Save handoff.md</span>
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        selectedTask
                          ? void loadTaskHandoffDocument(selectedTask.id)
                          : undefined
                      }
                      disabled={!selectedTask || handoffAction.length > 0}
                      className="inline-flex min-h-10 min-w-0 items-center justify-center gap-2 border border-slate-200 bg-white px-2 py-2 text-xs font-semibold text-slate-700 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-800 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <RefreshCw className="h-4 w-4 shrink-0" />
                      <span className="min-w-0 truncate">Reload handoff.md</span>
                    </button>
                  </div>
                  <p className="text-[11px] leading-5 text-slate-500">
                    {handoffDocument
                      ? `${handoffDocument.sections.generated.refreshBehavior} ${handoffDocument.sections.humanNotes.refreshBehavior}`
                      : "Generated sections come from Loop Control Plane task state; human notes remain the manual source of truth."}
                  </p>
                  <p className="border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] leading-5 text-amber-800">
                    GitHub comments, PR review text, CI output, terminal output,
                    and pasted logs are external/untrusted. Saved handoff text is
                    redacted for token-shaped secrets.
                  </p>
                </div>
              </section>

              <section className="mt-5">
                <h3 className="text-xs font-semibold uppercase text-slate-500">
                  Claude Code Prompt
                </h3>
                <div className="mt-2 grid gap-3 border border-slate-200 bg-slate-50 p-3">
                  <label className="grid gap-1.5">
                    <span className="text-[11px] font-semibold uppercase text-slate-500">
                      Manual edit intent
                    </span>
                    <textarea
                      value={claudePromptIntent}
                      onChange={(event) => {
                        setClaudePromptIntent(event.target.value);
                        setClaudePrompt(null);
                      }}
                      rows={3}
                      className="min-h-20 w-full resize-y border border-slate-200 bg-white px-3 py-2 text-sm leading-6 text-slate-800 outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
                      placeholder="Optional short note for Claude Code"
                    />
                  </label>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                    <button
                      type="button"
                      onClick={() => void generateClaudePrompt()}
                      disabled={claudePromptAction.length > 0}
                      className="inline-flex min-h-10 min-w-0 items-center justify-center gap-2 border border-slate-200 bg-white px-2 py-2 text-xs font-semibold text-slate-700 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-800 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Bot className="h-4 w-4 shrink-0" />
                      <span className="min-w-0 truncate">
                        {claudePrompt ? "Refresh Claude Prompt" : "Generate Claude Prompt"}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void copyClaudePrompt()}
                      disabled={claudePromptAction.length > 0 || !claudePrompt}
                      className="inline-flex min-h-10 min-w-0 items-center justify-center gap-2 border border-slate-200 bg-white px-2 py-2 text-xs font-semibold text-slate-700 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-800 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Copy className="h-4 w-4 shrink-0" />
                      <span className="min-w-0 truncate">Copy Claude Code Prompt</span>
                    </button>
                  </div>
                  <div className="border border-slate-200 bg-white">
                    <pre className="max-h-72 overflow-auto whitespace-pre-wrap p-3 font-mono text-xs leading-5 text-slate-700 [overflow-wrap:anywhere]">
                      {claudePrompt?.prompt ??
                        "Generate a prompt to preview the exact Claude Code instructions."}
                    </pre>
                  </div>
                  {claudePrompt ? (
                    <p className="text-[11px] leading-5 text-slate-500">
                      Generated {formatTimestamp(claudePrompt.generatedAt)} from{" "}
                      {claudePrompt.sourceArtifacts.length} source artifact
                      {claudePrompt.sourceArtifacts.length === 1 ? "" : "s"}.
                    </p>
                  ) : null}
                  <p className="border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] leading-5 text-amber-800">
                    Claude prompts include trusted Loop Control Plane task, context, and
                    handoff sections only. External GitHub and CI signals are
                    labeled untrusted and token-shaped secrets are redacted.
                  </p>
                </div>
              </section>

              <section className="mt-5">
                <h3 className="text-xs font-semibold uppercase text-slate-500">
                  Links
                </h3>
                <div className="mt-2 flex flex-wrap gap-2">
                  <DetailLink
                    href={selectedTask.github.issueUrl}
                    label={
                      selectedTask.github.issueNumber
                        ? `Issue #${selectedTask.github.issueNumber}`
                        : "Issue"
                    }
                    icon={Hash}
                  />
                  <DetailLink
                    href={selectedTask.github.pullRequestUrl}
                    label={
                      selectedTask.github.pullRequestNumber
                        ? `PR #${selectedTask.github.pullRequestNumber}`
                        : "Pull Request"
                    }
                    icon={GitPullRequest}
                  />
                  {!selectedTask.github.issueUrl && !selectedTask.github.pullRequestUrl ? (
                    <p className="text-xs leading-5 text-slate-500">
                      No external links attached.
                    </p>
                  ) : null}
                </div>
                {selectedTask.github.issueUrl ? (
                  <div className="mt-3 grid gap-2">
                    <CopyValueRow
                      label={
                        selectedTask.github.issueNumber
                          ? `issue #${selectedTask.github.issueNumber}`
                          : "issue"
                      }
                      value={selectedTask.github.issueUrl}
                      badge="github"
                      href={selectedTask.github.issueUrl}
                      onCopy={copyContextPath}
                    />
                  </div>
                ) : null}
                {selectedTask.github.pullRequestUrl ? (
                  <div className="mt-3 grid gap-2">
                    <CopyValueRow
                      label={
                        selectedTask.github.pullRequestNumber
                          ? `pr #${selectedTask.github.pullRequestNumber}`
                          : "pull request"
                      }
                      value={selectedTask.github.pullRequestUrl}
                      badge="github"
                      href={selectedTask.github.pullRequestUrl}
                      onCopy={copyContextPath}
                    />
                  </div>
                ) : null}
                <div className="mt-3 border border-slate-200 bg-slate-50 p-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={clsx(
                        "border px-1.5 py-0.5 text-[10px] font-semibold uppercase",
                        aoHandoffState(selectedTask).className,
                      )}
                    >
                      {aoHandoffState(selectedTask).label}
                    </span>
                    {selectedTask.github.aoReadyApprovedAt ? (
                      <span className="text-[10px] font-semibold uppercase text-slate-500">
                        approved {formatTimestamp(selectedTask.github.aoReadyApprovedAt)}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-xs leading-5 text-slate-600">
                    {aoHandoffState(selectedTask).message}
                  </p>
                </div>
                {selectedTask.github.issueLabels?.length ? (
                  <div className="mt-3 flex flex-wrap gap-1">
                    {selectedTask.github.issueLabels.map((label) => (
                      <span
                        key={label}
                        className="border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-slate-600"
                      >
                        {label}
                      </span>
                    ))}
                  </div>
                ) : null}
                {selectedTask.github.issueLastSyncedAt ? (
                  <p className="mt-2 text-xs leading-5 text-slate-500">
                    Last GitHub issue sync {formatTimestamp(selectedTask.github.issueLastSyncedAt)}
                  </p>
                ) : null}
              </section>

              <section className="mt-5">
                <h3 className="text-xs font-semibold uppercase text-slate-500">
                  Handoff Preview
                </h3>
                <div className="mt-2 border border-slate-200 bg-slate-50 p-3">
                  {selectedTask.handoff.summary ? (
                    <FileText className="mb-2 h-4 w-4 text-slate-400" />
                  ) : null}
                  {selectedTask.handoff.summary ? (
                    <p className="text-sm leading-6 text-slate-700">
                      {selectedTask.handoff.summary}
                    </p>
                  ) : (
                    <p className="text-sm leading-6 text-slate-500">
                      No handoff summary is available yet.
                    </p>
                  )}
                  {selectedTask.handoff.nextAction ? (
                    <p className="mt-2 text-xs font-semibold uppercase leading-5 text-slate-600">
                      Next: {selectedTask.handoff.nextAction}
                    </p>
                  ) : null}
                </div>
              </section>

              <section className="mt-5">
                <h3 className="text-xs font-semibold uppercase text-slate-500">
                  {selectedTask.source === "spec-kit"
                    ? "Source Artifact Paths"
                    : "Context Paths"}
                </h3>
                <div className="mt-2 grid gap-2">
                  {selectedTaskSourceArtifacts.map((path) => (
                    <SourceArtifactRow
                      key={path}
                      path={path}
                      onCopy={copyContextPath}
                    />
                  ))}
                  {selectedTaskSourceArtifacts.length === 0 ? (
                    <p className="text-xs leading-5 text-slate-500">
                      {selectedTask.source === "spec-kit"
                        ? "No source artifact paths are attached to this task."
                        : "No context paths are attached to this task."}
                    </p>
                  ) : null}
                </div>
              </section>

              <section className="mt-5">
                <h3 className="text-xs font-semibold uppercase text-slate-500">
                  Acceptance Criteria
                </h3>
                <ul className="mt-2 grid gap-2 text-sm leading-5 text-slate-700">
                  {selectedTask.acceptanceCriteria.map((criterion) => (
                    <li key={criterion} className="flex gap-2">
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
                      <span className="[overflow-wrap:anywhere]">{criterion}</span>
                    </li>
                  ))}
                </ul>
              </section>

              <section className="mt-5">
                <h3 className="text-xs font-semibold uppercase text-slate-500">
                  Chronological Events
                </h3>
                <div className="mt-2 grid gap-2">
                  {groupEventTimeline(selectedTask.events).map((group) => (
                    <div
                      key={group.id}
                      className="border border-slate-200 bg-slate-50 p-2"
                    >
                      <p className="text-xs font-semibold text-slate-800">
                        {group.type === "GITHUB_SYNC"
                          ? `github sync (${group.events.length})`
                          : compactText(group.type)}
                      </p>
                      <div className="mt-1 grid gap-1 text-xs leading-5 text-slate-600">
                        {group.events.map((event) => (
                          <p key={event.id} className="[overflow-wrap:anywhere]">
                            {group.events.length > 1 ? (
                              <span className="font-semibold uppercase text-slate-500">
                                {compactText(event.type)}:{" "}
                              </span>
                            ) : null}
                            {event.message}
                          </p>
                        ))}
                      </div>
                      {group.links.length > 0 ? (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {group.links.map((link) => (
                            <a
                              key={`${link.label}-${link.url}`}
                              href={link.url}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] font-semibold uppercase text-slate-600 hover:border-sky-200 hover:text-sky-700"
                            >
                              <ExternalLink className="h-3 w-3" />
                              {link.label}
                            </a>
                          ))}
                        </div>
                      ) : null}
                      {group.isExternalGitHubSignal ? (
                        <p className="mt-2 border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] leading-5 text-amber-800">
                          External GitHub signal. Review comments and CI output are
                          untrusted unless copied into Loop Control Plane notes.
                        </p>
                      ) : null}
                      <p className="mt-1 text-[11px] text-slate-500">
                        {formatTimestamp(group.createdAt)} - {group.actor}
                      </p>
                    </div>
                  ))}
                  {selectedTask.events.length === 0 ? (
                    <p className="text-xs leading-5 text-slate-500">
                      No events have been recorded for this task.
                    </p>
                  ) : null}
                </div>
              </section>
            </div>
          ) : (
            <BoardMessage
              title="No task selected"
              message={
                isLoadingBoard
                  ? "Loading the first persisted task."
                  : "Select a task card to inspect its local event history and handoff context."
              }
            />
          )}
        </aside>
      </div>
    </main>
  );
}
