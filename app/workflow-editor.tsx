"use client";

import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  ConnectionMode,
  Controls,
  EdgeLabelRenderer,
  getBezierPath,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  reconnectEdge,
  type Connection,
  type Edge,
  type EdgeChange,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import rough from "roughjs";
import clsx from "clsx";
import {
  AlertTriangle,
  Check,
  Download,
  ExternalLink,
  GitBranch,
  Plus,
  Redo2,
  RefreshCw,
  RotateCw,
  Save,
  SkipForward,
  StepForward,
  Undo2,
  Upload,
  Workflow as WorkflowIcon,
  XCircle,
} from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import {
  createProjectWorkflow,
  exportWorkflow,
  applyWorkflowRunAction,
  fetchEngineJobDetail,
  fetchEngineStatus,
  fetchWorkflowRun,
  fetchProjectWorkflows,
  importProjectWorkflow,
  startWorkflowRun,
  tickEngine,
  updateWorkflow,
  LoopBoardApiError,
} from "@/lib/api/loopboard-client";
import type {
  EngineJobDetail,
  EngineStatusResponse,
} from "@/lib/api/engine-actions";
import type {
  ExecutorBackend,
} from "@/lib/engine/loop-engine-types";
import type {
  Feature,
  Project,
  Workflow,
  WorkflowArtifact,
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeMode,
  WorkflowRiskPolicy,
  WorkflowRun,
} from "@/lib/loopboard";
import {
  defaultAutomationSettings,
  describeEffectiveAutomationPolicy,
  type AutomationSettings,
} from "@/lib/policies/automation-policy";
import { extractWorkflowRunPauseReason } from "@/lib/engine/auto-advance-ui";
import type {
  WorkflowFileImportResult,
  WorkflowFileValidationError,
} from "@/lib/workflows/workflow-files";
import {
  createCatalogWorkflowNode,
  hasBlockingWorkflowIssues,
  normalizeWorkflowEdge,
  validateWorkflowDefinition,
  workflowNodeCatalog,
  workflowNodeModes,
  workflowNodeWarnings,
  workflowRiskPolicies,
  type WorkflowEditorNodeType,
} from "@/lib/workflows/workflow-editor";
import {
  applyExecutorEditorPatch,
  executorBackendSupportsFanOut,
  executorBackendSupportsModel,
  extractEngineJobIdFromWorkflowStep,
  readExecutorEditorState,
  workflowExecutorBackendLabel,
  workflowExecutorBackendOptions,
  workflowNodeExecutorPolicyWarnings,
  workflowNodeExecutorRuntimeHint,
} from "@/lib/workflows/workflow-executor-editor";

type WorkflowCanvasNodeData = {
  label: string;
  mode: WorkflowNodeMode;
  type: string;
  active?: boolean;
};

const compactText = (value: string) => value.replaceAll("-", " ");

const nodeToCanvasNode = (
  node: WorkflowNode,
  activeNodeId?: string | null,
): Node<WorkflowCanvasNodeData> => ({
  id: node.id,
  type: "sketch",
  position: node.position,
  data: {
    label: node.name,
    mode: node.mode,
    type: node.type,
    active: node.id === activeNodeId,
  },
});

type NodePositionMap = Map<string, { x: number; y: number }>;

const bestHandles = (
  sourcePos: { x: number; y: number } | undefined,
  targetPos: { x: number; y: number } | undefined,
): { sourceHandle: string; targetHandle: string } => {
  if (!sourcePos || !targetPos) return { sourceHandle: "right", targetHandle: "left" };
  const dx = targetPos.x - sourcePos.x;
  const dy = targetPos.y - sourcePos.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? { sourceHandle: "right", targetHandle: "left" }
      : { sourceHandle: "left", targetHandle: "right" };
  }
  return dy >= 0
    ? { sourceHandle: "bottom", targetHandle: "top" }
    : { sourceHandle: "top", targetHandle: "bottom" };
};

const edgeToCanvasEdge = (edge: WorkflowEdge, posMap?: NodePositionMap): Edge => {
  const { sourceHandle, targetHandle } = bestHandles(
    posMap?.get(edge.sourceNodeId),
    posMap?.get(edge.targetNodeId),
  );
  return {
    id: edge.id,
    source: edge.sourceNodeId,
    target: edge.targetNodeId,
    label: edge.label || undefined,
    animated: edge.dashed === true,
    sourceHandle,
    targetHandle,
  };
};

const workflowPosMap = (workflow: Workflow): NodePositionMap =>
  new Map(workflow.nodes.map((n) => [n.id, n.position]));

// ===== Sketch canvas components =====

const SKETCH_MODE: Record<WorkflowNodeMode, { border: string; bg: string; labelColor: string }> = {
  auto:     { border: "#6f97c7", bg: "#eaf1fb", labelColor: "#3a5f96" },
  human:    { border: "#d3a64e", bg: "#fbf2dd", labelColor: "#9a6a1c" },
  semi:     { border: "#8e7bbf", bg: "#efeafb", labelColor: "#5a4b8f" },
  disabled: { border: "#9a978f", bg: "#f5f4f1", labelColor: "#6f6d67" },
};

const SketchNode = ({ data, selected }: NodeProps<Node<WorkflowCanvasNodeData>>) => {
  const m = SKETCH_MODE[data.mode as WorkflowNodeMode] ?? SKETCH_MODE.disabled;
  const borderColor = data.active ? "#86a87d" : selected ? "#6f97c7" : m.border;
  const bg = data.active ? "#eef5ea" : m.bg;
  const shadow = data.active
    ? "0 0 0 3px rgba(134,168,125,0.35), 3px 4px 0 rgba(35,34,31,0.10)"
    : selected
      ? "0 0 0 3px rgba(111,151,199,0.3)"
      : "3px 4px 0 rgba(35,34,31,0.10)";

  const handleStyle = {
    background: borderColor,
    border: `2px solid ${borderColor}`,
    width: 12,
    height: 12,
    zIndex: 10,
  };

  return (
    <div style={{
      borderRadius: "14px 11px 15px 12px / 12px 15px 11px 14px",
      border: `2px solid ${borderColor}`,
      boxShadow: shadow,
      background: bg,
      padding: "10px 16px",
      fontFamily: "var(--font-hand)",
      minWidth: 130,
      textAlign: "center",
      position: "relative",
      transition: "box-shadow 0.15s, border-color 0.15s",
    }}>
      <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: m.labelColor, marginBottom: 3 }}>
        {compactText(data.type)}
      </div>
      <div style={{ fontSize: 14, fontWeight: 600, color: "#23221f", lineHeight: 1.3 }}>
        {data.label}
      </div>
      {data.active && (
        <div style={{
          position: "absolute", top: 4, right: 4,
          width: 10, height: 10, borderRadius: "50%",
          background: "#86a87d", border: "2px solid #4a7340",
          zIndex: 5,
          pointerEvents: "none",
        }} />
      )}
      <Handle id="left"   type="source" position={Position.Left}   isConnectable isConnectableStart isConnectableEnd style={{ ...handleStyle, left: -7 }} />
      <Handle id="top"    type="source" position={Position.Top}    isConnectable isConnectableStart isConnectableEnd style={{ ...handleStyle, top: -7 }} />
      <Handle id="right"  type="source" position={Position.Right}  isConnectable isConnectableStart isConnectableEnd style={{ ...handleStyle, right: -7 }} />
      <Handle id="bottom" type="source" position={Position.Bottom} isConnectable isConnectableStart isConnectableEnd style={{ ...handleStyle, bottom: -7 }} />
    </div>
  );
};

const EdgeActionsContext = createContext<{
  onToggleDashed: (id: string) => void;
  getOutputCount: (nodeId: string) => number;
}>({
  onToggleDashed: () => {},
  getOutputCount: () => 0,
});

const roughGen = rough.generator();

const strSeed = (id: string) => id.split("").reduce((s, c) => s + c.charCodeAt(0), 0);

const opsToD = (ops: Array<{ op: string; data: number[] }>): string =>
  ops.map(op => {
    if (op.op === "move")     return `M ${op.data[0]} ${op.data[1]}`;
    if (op.op === "lineTo")   return `L ${op.data[0]} ${op.data[1]}`;
    if (op.op === "bcurveTo") return `C ${op.data[0]} ${op.data[1]} ${op.data[2]} ${op.data[3]} ${op.data[4]} ${op.data[5]}`;
    return "";
  }).filter(Boolean).join(" ");

// getBezierPath collapses to a straight line when the control-point offsets are
// zero — this happens when source and target are at the same height (dy≈0) for
// horizontal handles, or at the same position for same-direction handles.
// This wrapper forces a minimum arc so the sketch aesthetic always shows a curve.
const MIN_ARC = 44;
const getSketchEdgePath = (
  sourceX: number, sourceY: number, sourcePosition: Position,
  targetX: number, targetY: number, targetPosition: Position,
): [string, number, number] => {
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const mx = (sourceX + targetX) / 2;
  const my = (sourceY + targetY) / 2;

  // Horizontal handles (right→left or left→right) at nearly the same height
  if (
    ((sourcePosition === Position.Right && targetPosition === Position.Left) ||
     (sourcePosition === Position.Left  && targetPosition === Position.Right)) &&
    Math.abs(dy) < MIN_ARC
  ) {
    const bump = (MIN_ARC - Math.abs(dy) * 0.5) * (dx >= 0 ? -1 : 1);
    const c1x = sourceX + dx * 0.35;
    const c2x = targetX - dx * 0.35;
    return [
      `M ${sourceX} ${sourceY} C ${c1x} ${sourceY + bump} ${c2x} ${targetY + bump} ${targetX} ${targetY}`,
      mx, my + bump * 0.5,
    ];
  }

  // Same-direction handles (bottom→bottom, top→top) — always need explicit arc
  if (sourcePosition === Position.Bottom && targetPosition === Position.Bottom) {
    const bump = Math.max(MIN_ARC, Math.abs(dy) * 0.4);
    return [
      `M ${sourceX} ${sourceY} C ${sourceX} ${sourceY + bump} ${targetX} ${targetY + bump} ${targetX} ${targetY}`,
      mx, my + bump,
    ];
  }
  if (sourcePosition === Position.Top && targetPosition === Position.Top) {
    const bump = Math.max(MIN_ARC, Math.abs(dy) * 0.4);
    return [
      `M ${sourceX} ${sourceY} C ${sourceX} ${sourceY - bump} ${targetX} ${targetY - bump} ${targetX} ${targetY}`,
      mx, my - bump,
    ];
  }

  const [path, lx, ly] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  return [path, lx, ly] as [string, number, number];
};

const SketchEdge = ({
  id, source, sourceX, sourceY, targetX, targetY,
  sourcePosition, targetPosition, selected, animated,
}: EdgeProps) => {
  const { onToggleDashed, getOutputCount } = useContext(EdgeActionsContext);
  const outputCount = getOutputCount(source);
  const [edgePath, labelX, labelY] = getSketchEdgePath(sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition);
  const stroke = selected ? "#6f97c7" : "#23221f";

  const paths = useMemo(() => {
    const drawable = roughGen.path(edgePath, {
      roughness: 0.8,
      strokeWidth: 1.8,
      stroke,
      fill: "none",
      seed: strSeed(id),
      disableMultiStroke: true,
    });
    return drawable.sets.map(set => opsToD(set.ops));
  }, [edgePath, stroke, id]);

  const ENTRY_ANGLE: Record<string, number> = {
    [Position.Left]: 0,
    [Position.Right]: 180,
    [Position.Top]: 90,
    [Position.Bottom]: -90,
  };
  const arrowAngle = ENTRY_ANGLE[targetPosition] ??
    Math.atan2(targetY - sourceY, targetX - sourceX) * (180 / Math.PI);

  return (
    <>
      {/* Wide invisible stroke for a larger click/hover target */}
      <path d={edgePath} stroke="transparent" strokeWidth={20} fill="none" />
      {paths.map((d, i) => (
        <path key={i} d={d}
          stroke={stroke}
          strokeWidth={1.8}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray={animated ? "7 4" : undefined}
        />
      ))}
      <polygon
        points="-10,-5 0,0 -10,5"
        fill={stroke}
        transform={`translate(${targetX},${targetY}) rotate(${arrowAngle})`}
      />
      {outputCount >= 2 && <EdgeLabelRenderer>
        <button
          className="nodrag nopan"
          title={animated ? "Switch to solid (main flow)" : "Switch to dashed (optional path)"}
          onClick={(e) => { e.stopPropagation(); onToggleDashed(id); }}
          style={{
            position: "absolute",
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: "all",
            width: 18,
            height: 18,
            borderRadius: "50%",
            border: `1.5px solid ${selected ? "#6f97c7" : "#b0ac9f"}`,
            background: "#f5f4f1",
            cursor: "pointer",
            fontSize: 9,
            lineHeight: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 0,
            opacity: selected ? 1 : 0.5,
            transition: "opacity 0.15s, border-color 0.15s",
            fontFamily: "monospace",
            color: selected ? "#6f97c7" : "#6b6860",
          }}
        >
          {animated ? "—" : "⋯"}
        </button>
      </EdgeLabelRenderer>}
    </>
  );
};

const createDraftWorkflow = (projectId: string): Workflow => {
  const timestamp = new Date().toISOString();
  const workflowId = `workflow-draft-${Date.now().toString(36)}`;
  const nodes = ["human-input", "spec-kit-actions"].map((type, index) => ({
    ...createCatalogWorkflowNode({
      type: type as WorkflowEditorNodeType,
      workflowId,
      index,
    }),
    createdAt: timestamp,
    updatedAt: timestamp,
  }));

  return {
    id: workflowId,
    projectId,
    name: "New Workflow",
    description: "Draft Loop Control Plane workflow.",
    version: 1,
    nodes,
    edges: [
      {
        ...normalizeWorkflowEdge({
          workflowId,
          sourceNodeId: nodes[0]!.id,
          targetNodeId: nodes[1]!.id,
        }),
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    config: { pauseOnHumanNodes: true, redactSecretsInLogs: true },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
};

const parseJsonValue = <T,>(value: string, field: string): T => {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`${field} must be valid JSON.`);
  }
};

const formatJson = (value: unknown) => JSON.stringify(value, null, 2);

const formatLogTime = (timestamp: string): string => {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }

  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
};

const formatLogMetadata = (
  metadata?: Record<string, unknown>,
): string => {
  if (!metadata) {
    return "";
  }

  return Object.entries(metadata)
    .filter(([, value]) =>
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean",
    )
    .filter(([, value]) => value !== "")
    .slice(0, 4)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" · ");
};

const logLevelClassName = (level: string): string =>
  clsx(
    level === "error" && "text-red-300",
    level === "warn" && "text-amber-300",
    level === "info" && "text-emerald-300",
    level === "debug" && "text-sky-300",
  );

export function WorkflowEditor({
  project,
  selectedFeature,
  automationSettings = defaultAutomationSettings,
}: {
  project?: Project;
  selectedFeature?: Feature;
  automationSettings?: AutomationSettings;
}) {
  const nodeTypes = useMemo(() => ({ sketch: SketchNode }), []);
  const edgeTypes = useMemo(() => ({ default: SketchEdge }), []);

  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState("");
  const selectedWorkflowIdRef = useRef("");
  const [draftWorkflow, setDraftWorkflow] = useState<Workflow | null>(null);
  const [nodes, setNodes] = useState<Array<Node<WorkflowCanvasNodeData>>>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const [connectTargetNodeId, setConnectTargetNodeId] = useState("");
  const [inputArtifactsJson, setInputArtifactsJson] = useState("[]");
  const [outputArtifactsJson, setOutputArtifactsJson] = useState("[]");
  const [configJson, setConfigJson] = useState("{}");
  const [workflowConfigJson, setWorkflowConfigJson] = useState("{}");
  const [exportFileName, setExportFileName] = useState("");
  const [importPath, setImportPath] = useState("feature-development-loop.json");
  const [importOverwrite, setImportOverwrite] =
    useState<WorkflowFileImportResult | null>(null);
  const [fileValidationErrors, setFileValidationErrors] = useState<
    WorkflowFileValidationError[]
  >([]);
  const [currentRun, setCurrentRun] = useState<WorkflowRun | null>(null);
  const [engineStatus, setEngineStatus] = useState<EngineStatusResponse | null>(null);
  const [currentJobDetail, setCurrentJobDetail] = useState<EngineJobDetail | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isFileBusy, setIsFileBusy] = useState(false);
  const [isRunBusy, setIsRunBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const historyRef = useRef<Workflow[]>([]);
  const futureRef = useRef<Workflow[]>([]);
  const draftWorkflowRef = useRef<Workflow | null>(null);
  const reconnectingEdgeRef = useRef<Edge | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const selectedNode = useMemo(
    () => draftWorkflow?.nodes.find((node) => node.id === selectedNodeId),
    [draftWorkflow, selectedNodeId],
  );
  const connectTargetOptions = useMemo(
    () =>
      draftWorkflow?.nodes.filter((node) => node.id !== selectedNode?.id) ?? [],
    [draftWorkflow, selectedNode],
  );
  const selectedConnectTargetId = useMemo(
    () =>
      connectTargetOptions.some((node) => node.id === connectTargetNodeId)
        ? connectTargetNodeId
        : connectTargetOptions[0]?.id ?? "",
    [connectTargetNodeId, connectTargetOptions],
  );
  const validationIssues = useMemo(
    () =>
      draftWorkflow
        ? validateWorkflowDefinition({
            nodes: draftWorkflow.nodes,
            edges: draftWorkflow.edges,
          })
      : [],
    [draftWorkflow],
  );
  const selectedNodeWarnings = useMemo(
    () =>
      selectedNode
        ? [
            ...workflowNodeWarnings(selectedNode),
            ...workflowNodeExecutorPolicyWarnings(selectedNode),
          ]
        : [],
    [selectedNode],
  );
  const selectedNodeExecutor = useMemo(
    () => (selectedNode ? readExecutorEditorState(selectedNode) : null),
    [selectedNode],
  );
  const selectedNodeExecutorHint = useMemo(
    () =>
      selectedNode && selectedNodeExecutor
        ? workflowNodeExecutorRuntimeHint(selectedNode, selectedNodeExecutor)
        : undefined,
    [selectedNode, selectedNodeExecutor],
  );
  const currentWorkflowStep = useMemo(() => {
    if (!currentRun?.currentNodeId) {
      return undefined;
    }

    return currentRun.steps
      .filter((step) => step.workflowNodeId === currentRun.currentNodeId)
      .at(-1);
  }, [currentRun]);
  const currentEngineJob = useMemo(() => {
    if (!engineStatus || !currentRun) {
      return undefined;
    }

    const engineJobId = extractEngineJobIdFromWorkflowStep(currentWorkflowStep);
    if (engineJobId) {
      return engineStatus.recentJobs.find((job) => job.id === engineJobId);
    }

    return engineStatus.recentJobs.find(
      (job) =>
        job.workflowRunId === currentRun.id &&
        job.workflowNodeId === currentRun.currentNodeId,
    );
  }, [currentRun, currentWorkflowStep, engineStatus]);
  const visibleWorkflowLogs = useMemo(
    () => currentWorkflowStep?.executionLogs.slice(-6) ?? [],
    [currentWorkflowStep],
  );
  const visibleEngineLogs = useMemo(
    () => currentJobDetail?.executionLogs.slice(-10) ?? [],
    [currentJobDetail],
  );
  const currentEngineSchedulerWarning = useMemo(() => {
    const lastError = engineStatus?.scheduler.lastError;
    if (!currentEngineJob || !lastError) {
      return undefined;
    }

    if (currentEngineJob.status === "queued" || currentEngineJob.status === "running") {
      return lastError;
    }

    return undefined;
  }, [currentEngineJob, engineStatus?.scheduler.lastError]);
  const showEngineRunNext = !automationSettings.globalAutoRunEnabled;
  const effectiveAutomationPolicy = useMemo(
    () =>
      describeEffectiveAutomationPolicy({
        automationSettings,
        projectPolicy: project?.automationPolicy,
        engineSettings: project?.engineSettings,
      }),
    [automationSettings, project?.automationPolicy, project?.engineSettings],
  );
  const workflowPauseReason = useMemo(
    () =>
      currentRun
        ? extractWorkflowRunPauseReason(currentRun, draftWorkflow ?? undefined)
        : undefined,
    [currentRun, draftWorkflow],
  );

  useEffect(() => {
    selectedWorkflowIdRef.current = selectedWorkflowId;
  }, [selectedWorkflowId]);

  const refreshEngineStatus = useCallback(async () => {
    if (!project) {
      setEngineStatus(null);
      return;
    }

    try {
      const status = await fetchEngineStatus(project.id);
      setEngineStatus(status);
    } catch {
      setEngineStatus(null);
    }
  }, [project]);

  useEffect(() => {
    void refreshEngineStatus();
  }, [
    refreshEngineStatus,
    currentRun?.id,
    currentRun?.currentNodeId,
    currentRun?.steps.length,
  ]);

  useEffect(() => {
    if (!project || !currentRun) {
      return;
    }

    const shouldPoll =
      currentRun.status === "running" ||
      currentRun.status === "paused" ||
      currentRun.steps.some((step) => step.status === "running");

    if (!shouldPoll) {
      return;
    }

    let cancelled = false;

    const refreshProgress = async () => {
      try {
        const [status, run] = await Promise.all([
          fetchEngineStatus(project.id),
          fetchWorkflowRun(currentRun.id),
        ]);

        if (cancelled) {
          return;
        }

        setEngineStatus(status);
        setCurrentRun(run);
      } catch {
        // Keep the last visible progress while the next poll retries.
      }
    };

    const pollMs = currentRun.status === "running" ? 5_000 : 8_000;
    const interval = window.setInterval(() => {
      void refreshProgress();
    }, pollMs);

    void refreshProgress();

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [currentRun, project]);

  useEffect(() => {
    if (!currentEngineJob?.id) {
      setCurrentJobDetail(null);
      return;
    }

    let cancelled = false;

    void fetchEngineJobDetail(currentEngineJob.id)
      .then((detail) => {
        if (!cancelled) {
          setCurrentJobDetail(detail);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCurrentJobDetail(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [currentEngineJob?.id, currentEngineJob?.logCount, currentEngineJob?.status]);

  const syncCanvas = useCallback((workflow: Workflow) => {
    const posMap = workflowPosMap(workflow);
    setNodes(workflow.nodes.map((node) => nodeToCanvasNode(node)));
    setEdges(workflow.edges.map((e) => edgeToCanvasEdge(e, posMap)));
    setWorkflowConfigJson(formatJson(workflow.config));
    setSelectedNodeId((currentNodeId) =>
      workflow.nodes.some((node) => node.id === currentNodeId)
        ? currentNodeId
        : workflow.nodes[0]?.id ?? "",
    );
  }, []);

  const loadWorkflows = useCallback(async () => {
    if (!project) {
      setWorkflows([]);
      setDraftWorkflow(null);
      setNodes([]);
      setEdges([]);
      return;
    }

    setIsLoading(true);
    setError("");
    setMessage("");

    try {
      const loadedWorkflows = await fetchProjectWorkflows(project.id);
      const preferredWorkflowId = selectedWorkflowIdRef.current;
      const workflow =
        loadedWorkflows.find((item) => item.id === preferredWorkflowId) ??
        loadedWorkflows[0] ??
        createDraftWorkflow(project.id);

      setWorkflows(loadedWorkflows);
      setSelectedWorkflowId(workflow.id);
      setDraftWorkflow(workflow);
      syncCanvas(workflow);
    } catch (loadError) {
      setError(
        loadError instanceof LoopBoardApiError
          ? loadError.message
          : "Loop Control Plane could not load workflows.",
      );
    } finally {
      setIsLoading(false);
    }
  }, [project, syncCanvas]);

  useEffect(() => {
    void loadWorkflows();
  }, [loadWorkflows]);

  useEffect(() => {
    if (!selectedNode) {
      setInputArtifactsJson("[]");
      setOutputArtifactsJson("[]");
      setConfigJson("{}");
      return;
    }

    setInputArtifactsJson(formatJson(selectedNode.inputArtifacts));
    setOutputArtifactsJson(formatJson(selectedNode.outputArtifacts));
    setConfigJson(formatJson(selectedNode.config));
  }, [selectedNode]);

  useEffect(() => {
    const activeNodeId = currentRun?.currentNodeId ?? null;
    setNodes((prevNodes) =>
      prevNodes.map((n) => ({
        ...n,
        data: { ...n.data, active: n.id === activeNodeId },
      }))
    );
  }, [currentRun?.currentNodeId]);

  useEffect(() => {
    draftWorkflowRef.current = draftWorkflow;
  }, [draftWorkflow]);

  const pushToHistory = useCallback((snapshot: Workflow) => {
    historyRef.current = [...historyRef.current.slice(-49), snapshot];
    futureRef.current = [];
    setCanUndo(true);
    setCanRedo(false);
  }, []);

  const resetHistory = useCallback(() => {
    historyRef.current = [];
    futureRef.current = [];
    setCanUndo(false);
    setCanRedo(false);
  }, []);

  const getOutputCount = useCallback((nodeId: string) =>
    draftWorkflowRef.current?.edges.filter(e => e.sourceNodeId === nodeId).length ?? 0
  , []);

  const toggleEdgeDashed = useCallback((edgeId: string) => {
    const wf = draftWorkflowRef.current;
    if (!wf) return;
    const target = wf.edges.find(e => e.id === edgeId);
    if (!target) return;
    pushToHistory(wf);

    const newDashed = !target.dashed;
    // Sibling edge from the same source — flip it to the opposite style
    const sibling = wf.edges.find(
      e => e.sourceNodeId === target.sourceNodeId && e.id !== edgeId
    );
    const now = new Date().toISOString();

    setEdges((currentEdges) =>
      currentEdges.map((e) => {
        if (e.id === edgeId) return { ...e, animated: newDashed };
        if (sibling && e.id === sibling.id) return { ...e, animated: !newDashed };
        return e;
      })
    );
    setDraftWorkflow((currentWorkflow) => {
      if (!currentWorkflow) return currentWorkflow;
      return {
        ...currentWorkflow,
        edges: currentWorkflow.edges.map((e) => {
          if (e.id === edgeId) return { ...e, dashed: newDashed, updatedAt: now };
          if (sibling && e.id === sibling.id) return { ...e, dashed: !newDashed, updatedAt: now };
          return e;
        }),
      };
    });
  }, [pushToHistory]);

  const replaceDraftWorkflow = useCallback(
    (nextWorkflow: Workflow) => {
      const posMap = workflowPosMap(nextWorkflow);
      setDraftWorkflow(nextWorkflow);
      setNodes(nextWorkflow.nodes.map((node) => nodeToCanvasNode(node)));
      setEdges(nextWorkflow.edges.map((e) => edgeToCanvasEdge(e, posMap)));
    },
    [],
  );

  const undo = useCallback(() => {
    const history = historyRef.current;
    if (history.length === 0) return;
    const previous = history[history.length - 1]!;
    const current = draftWorkflowRef.current;
    historyRef.current = history.slice(0, -1);
    if (current) futureRef.current = [current, ...futureRef.current.slice(0, 49)];
    setCanUndo(historyRef.current.length > 0);
    setCanRedo(true);
    replaceDraftWorkflow(previous);
  }, [replaceDraftWorkflow]);

  const redo = useCallback(() => {
    const future = futureRef.current;
    if (future.length === 0) return;
    const next = future[0]!;
    const current = draftWorkflowRef.current;
    futureRef.current = future.slice(1);
    if (current) historyRef.current = [...historyRef.current.slice(-49), current];
    setCanUndo(true);
    setCanRedo(futureRef.current.length > 0);
    replaceDraftWorkflow(next);
  }, [replaceDraftWorkflow]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      if (e.key === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      if ((e.key === "z" && e.shiftKey) || e.key === "y") { e.preventDefault(); redo(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [undo, redo]);

  const updateSelectedNode = useCallback(
    (patch: Partial<WorkflowNode>) => {
      if (!draftWorkflow || !selectedNode) {
        return;
      }

      pushToHistory(draftWorkflow);
      const nextWorkflow = {
        ...draftWorkflow,
        nodes: draftWorkflow.nodes.map((node) =>
          node.id === selectedNode.id ? { ...node, ...patch } : node,
        ),
      };
      replaceDraftWorkflow(nextWorkflow);
    },
    [draftWorkflow, pushToHistory, replaceDraftWorkflow, selectedNode],
  );

  const onNodesChange = useCallback(
    (changes: Array<NodeChange<Node<WorkflowCanvasNodeData>>>) => {
      // Push history snapshot when a drag ends (not on every pixel move)
      const dragEnd = changes.some((c) => c.type === "position" && c.dragging === false);
      if (dragEnd && draftWorkflowRef.current) {
        pushToHistory(draftWorkflowRef.current);
      }

      setNodes((currentNodes) =>
        applyNodeChanges<Node<WorkflowCanvasNodeData>>(changes, currentNodes),
      );
      setDraftWorkflow((currentWorkflow) => {
        if (!currentWorkflow) {
          return currentWorkflow;
        }

        const changedPositions = new Map<string, WorkflowNode["position"]>();
        for (const change of changes) {
          if (change.type === "position" && change.position) {
            changedPositions.set(change.id, change.position);
          }
        }

        if (changedPositions.size === 0) {
          return currentWorkflow;
        }

        return {
          ...currentWorkflow,
          nodes: currentWorkflow.nodes.map((node) =>
            changedPositions.has(node.id)
              ? { ...node, position: changedPositions.get(node.id)! }
              : node,
          ),
        };
      });
    },
    [pushToHistory],
  );

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    const hasRemoval = changes.some((c) => c.type === "remove");
    if (hasRemoval && draftWorkflowRef.current) {
      pushToHistory(draftWorkflowRef.current);
    }
    setEdges((currentEdges) => applyEdgeChanges(changes, currentEdges));
    setDraftWorkflow((currentWorkflow) => {
      if (!currentWorkflow) {
        return currentWorkflow;
      }

      const removedEdgeIds = new Set(
        changes
          .filter((change) => change.type === "remove")
          .map((change) => change.id),
      );

      if (removedEdgeIds.size === 0) {
        return currentWorkflow;
      }

      return {
        ...currentWorkflow,
        edges: currentWorkflow.edges.filter((edge) => !removedEdgeIds.has(edge.id)),
      };
    });
  }, [pushToHistory]);

  const isValidConnection = useCallback((connection: Edge | Connection): boolean => {
    const source = (connection as Connection).source ?? (connection as Edge).source;
    const target = (connection as Connection).target ?? (connection as Edge).target;
    if (!source || !target) return false;
    if (source === target) return false;
    const wf = draftWorkflowRef.current;
    if (!wf) return true;
    if (wf.edges.some(e => e.sourceNodeId === source && e.targetNodeId === target)) return false;
    const sourceNode = wf.nodes.find(n => n.id === source);
    const maxOutputs = sourceNode?.mode === "human" ? 2 : 1;
    // When reconnecting, the dragged edge is being moved (not added), so don't
    // count it against the source node's output limit.
    const reconnecting = reconnectingEdgeRef.current;
    const reconnectingFromSameSource = reconnecting?.source === source;
    const outgoing = wf.edges.filter(e => e.sourceNodeId === source).length
      - (reconnectingFromSameSource ? 1 : 0);
    if (outgoing >= maxOutputs) return false;
    return true;
  }, []);

  const onConnect = useCallback((connection: Connection) => {
    if (draftWorkflowRef.current) pushToHistory(draftWorkflowRef.current);
    setDraftWorkflow((currentWorkflow) => {
      if (!currentWorkflow || !connection.source || !connection.target) {
        return currentWorkflow;
      }

      // If source already has 1 outgoing edge, auto-mark this new one as dashed
      // (optional path). 2-output nodes always have one solid + one dashed.
      const existingFromSource = currentWorkflow.edges.filter(
        e => e.sourceNodeId === connection.source
      );
      const autoDashed = existingFromSource.length === 1;

      const nextEdge = {
        ...normalizeWorkflowEdge({
          workflowId: currentWorkflow.id,
          sourceNodeId: connection.source,
          targetNodeId: connection.target,
          dashed: autoDashed || undefined,
        }),
        createdAt: currentWorkflow.createdAt,
        updatedAt: new Date().toISOString(),
      };

      if (currentWorkflow.edges.some((edge) => edge.id === nextEdge.id)) {
        return currentWorkflow;
      }

      setEdges((currentEdges) =>
        addEdge(
          {
            id: nextEdge.id,
            source: nextEdge.sourceNodeId,
            target: nextEdge.targetNodeId,
            label: nextEdge.label || undefined,
            animated: autoDashed,
            sourceHandle: connection.sourceHandle ?? undefined,
            targetHandle: connection.targetHandle ?? undefined,
          },
          currentEdges,
        ),
      );

      return {
        ...currentWorkflow,
        edges: [...currentWorkflow.edges, nextEdge],
      };
    });
  }, [pushToHistory]);

  const onReconnectStart = useCallback((_event: React.MouseEvent | React.TouchEvent, edge: Edge) => {
    reconnectingEdgeRef.current = edge;
  }, []);

  const onReconnectEnd = useCallback(() => {
    reconnectingEdgeRef.current = null;
  }, []);

  const onReconnect = useCallback((oldEdge: Edge, newConnection: Connection) => {
    reconnectingEdgeRef.current = null;
    if (!newConnection.source || !newConnection.target) return;
    if (newConnection.source === newConnection.target) return;
    const existingEdges = draftWorkflowRef.current?.edges ?? [];
    const isDuplicate = existingEdges.some(
      e => e.id !== oldEdge.id && e.sourceNodeId === newConnection.source && e.targetNodeId === newConnection.target,
    );
    if (isDuplicate) return;
    if (draftWorkflowRef.current) pushToHistory(draftWorkflowRef.current);

    setEdges((currentEdges) => reconnectEdge(oldEdge, newConnection, currentEdges));

    setDraftWorkflow((currentWorkflow) => {
      if (!currentWorkflow) return currentWorkflow;
      return {
        ...currentWorkflow,
        edges: currentWorkflow.edges.map((edge) =>
          // Keep edge.id unchanged so canvas/workflow IDs stay in sync on delete.
          edge.id !== oldEdge.id ? edge : {
            ...edge,
            sourceNodeId: newConnection.source!,
            targetNodeId: newConnection.target!,
            updatedAt: new Date().toISOString(),
          },
        ),
      };
    });
  }, [pushToHistory]);

  const connectSelectedNode = () => {
    if (!draftWorkflow || !selectedNode || !selectedConnectTargetId) {
      return;
    }

    pushToHistory(draftWorkflow);
    const nextEdge = {
      ...normalizeWorkflowEdge({
        workflowId: draftWorkflow.id,
        sourceNodeId: selectedNode.id,
        targetNodeId: selectedConnectTargetId,
      }),
      createdAt: draftWorkflow.createdAt,
      updatedAt: new Date().toISOString(),
    };

    if (draftWorkflow.edges.some((edge) => edge.id === nextEdge.id)) {
      return;
    }

    setEdges((currentEdges) =>
      addEdge(
        {
          id: nextEdge.id,
          source: nextEdge.sourceNodeId,
          target: nextEdge.targetNodeId,
          label: nextEdge.label || undefined,
        },
        currentEdges,
      ),
    );
    setDraftWorkflow({
      ...draftWorkflow,
      edges: [...draftWorkflow.edges, nextEdge],
    });
  };

  const selectWorkflow = (workflowId: string) => {
    const workflow = workflows.find((item) => item.id === workflowId);

    if (!workflow) {
      return;
    }

    resetHistory();
    setSelectedWorkflowId(workflow.id);
    setDraftWorkflow(workflow);
    syncCanvas(workflow);
    setMessage("");
    setError("");
  };

  const startNewWorkflow = () => {
    if (!project) {
      return;
    }

    resetHistory();
    const workflow = createDraftWorkflow(project.id);
    setSelectedWorkflowId(workflow.id);
    setDraftWorkflow(workflow);
    syncCanvas(workflow);
    setMessage("");
    setError("");
  };

  const addCatalogNode = (type: WorkflowEditorNodeType) => {
    if (!draftWorkflow) {
      return;
    }

    pushToHistory(draftWorkflow);
    const timestamp = new Date().toISOString();
    const node = {
      ...createCatalogWorkflowNode({
        type,
        workflowId: draftWorkflow.id,
        index: draftWorkflow.nodes.length,
      }),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const nextWorkflow = {
      ...draftWorkflow,
      nodes: [...draftWorkflow.nodes, node],
    };

    replaceDraftWorkflow(nextWorkflow);
    setSelectedNodeId(node.id);
  };

  const applyJsonPatch = (
    field: "inputArtifacts" | "outputArtifacts" | "config" | "workflowConfig",
    value: string,
  ) => {
    setError("");

    try {
      if (field === "inputArtifacts") {
        setInputArtifactsJson(value);
        updateSelectedNode({
          inputArtifacts: parseJsonValue<WorkflowArtifact[]>(value, "Input artifacts"),
        });
      } else if (field === "outputArtifacts") {
        setOutputArtifactsJson(value);
        updateSelectedNode({
          outputArtifacts: parseJsonValue<WorkflowArtifact[]>(value, "Output artifacts"),
        });
      } else if (field === "config") {
        setConfigJson(value);
        updateSelectedNode({
          config: parseJsonValue<Record<string, unknown>>(value, "Config"),
        });
      } else if (draftWorkflow) {
        setWorkflowConfigJson(value);
        setDraftWorkflow({
          ...draftWorkflow,
          config: parseJsonValue<Record<string, unknown>>(value, "Workflow config"),
        });
      }
    } catch (jsonError) {
      if (field === "inputArtifacts") {
        setInputArtifactsJson(value);
      } else if (field === "outputArtifacts") {
        setOutputArtifactsJson(value);
      } else if (field === "config") {
        setConfigJson(value);
      } else {
        setWorkflowConfigJson(value);
      }
      setError(jsonError instanceof Error ? jsonError.message : "Invalid JSON.");
    }
  };

  const saveWorkflow = async () => {
    if (!project || !draftWorkflow) {
      return;
    }

    const issues = validateWorkflowDefinition({
      nodes: draftWorkflow.nodes,
      edges: draftWorkflow.edges,
    });

    if (hasBlockingWorkflowIssues(issues)) {
      setMessage("");
      setError("Resolve workflow validation issues before saving.");
      return;
    }

    setIsSaving(true);
    setError("");
    setMessage("");

    try {
      const payload = {
        name: draftWorkflow.name,
        description: draftWorkflow.description,
        version: draftWorkflow.version,
        nodes: draftWorkflow.nodes,
        edges: draftWorkflow.edges,
        config: draftWorkflow.config,
      };
      const savedWorkflow = workflows.some((workflow) => workflow.id === draftWorkflow.id)
        ? await updateWorkflow({ workflowId: draftWorkflow.id, input: payload })
        : await createProjectWorkflow({ projectId: project.id, input: payload });

      setWorkflows((currentWorkflows) => {
        const otherWorkflows = currentWorkflows.filter(
          (workflow) => workflow.id !== savedWorkflow.id,
        );
        return [...otherWorkflows, savedWorkflow].sort((a, b) =>
          a.name.localeCompare(b.name),
        );
      });
      setSelectedWorkflowId(savedWorkflow.id);
      setDraftWorkflow(savedWorkflow);
      syncCanvas(savedWorkflow);
      setMessage("Workflow definition saved.");
    } catch (saveError) {
      setError(
        saveError instanceof LoopBoardApiError
          ? saveError.message
          : "Loop Control Plane could not save the workflow.",
      );
    } finally {
      setIsSaving(false);
    }
  };

  const exportCurrentWorkflow = async () => {
    if (!draftWorkflow || !workflows.some((workflow) => workflow.id === draftWorkflow.id)) {
      setMessage("");
      setError("Save the workflow before exporting it.");
      return;
    }

    setIsFileBusy(true);
    setError("");
    setMessage("");
    setFileValidationErrors([]);

    try {
      const result = await exportWorkflow({
        workflowId: draftWorkflow.id,
        fileName: exportFileName || undefined,
        overwrite: true,
      });
      setExportFileName(result.fileName);
      setMessage(`Exported workflow to ${result.path}.`);
    } catch (exportError) {
      if (exportError instanceof LoopBoardApiError) {
        setFileValidationErrors(exportError.validationErrors);
        setError(exportError.message);
      } else {
        setError("Loop Control Plane could not export the workflow.");
      }
    } finally {
      setIsFileBusy(false);
    }
  };

  const applyImportedWorkflow = (result: WorkflowFileImportResult) => {
    if (!result.workflow) {
      return;
    }

    setWorkflows((currentWorkflows) => {
      const otherWorkflows = currentWorkflows.filter(
        (workflow) => workflow.id !== result.workflow!.id,
      );
      return [...otherWorkflows, result.workflow!].sort((a, b) =>
        a.name.localeCompare(b.name),
      );
    });
    setSelectedWorkflowId(result.workflow.id);
    setDraftWorkflow(result.workflow);
    syncCanvas(result.workflow);
    setImportOverwrite(null);
    setFileValidationErrors([]);
    setMessage(`Imported workflow from ${result.path}.`);
  };

  const importWorkflowFile = async (overwriteWorkflowId?: string) => {
    if (!project) {
      return;
    }

    setIsFileBusy(true);
    setError("");
    setMessage("");
    setFileValidationErrors([]);

    try {
      const result = await importProjectWorkflow({
        projectId: project.id,
        path: importPath,
        overwriteWorkflowId,
      });

      if (result.status === "needs-overwrite") {
        setImportOverwrite(result);
        setFileValidationErrors(result.validationErrors);
        setError("Review import validation errors before overwriting.");
      } else {
        applyImportedWorkflow(result);
      }
    } catch (importError) {
      setImportOverwrite(null);
      if (importError instanceof LoopBoardApiError) {
        setFileValidationErrors(importError.validationErrors);
        setError(importError.message);
      } else {
        setError("Loop Control Plane could not import the workflow file.");
      }
    } finally {
      setIsFileBusy(false);
    }
  };

  const startRun = async () => {
    if (!draftWorkflow || !workflows.some((workflow) => workflow.id === draftWorkflow.id)) {
      setMessage("");
      setError("Save the workflow before starting a run.");
      return;
    }

    setIsRunBusy(true);
    setError("");
    setMessage("");

    try {
      const run = await startWorkflowRun({
        workflowId: draftWorkflow.id,
        featureId: selectedFeature?.id,
      });
      setCurrentRun(run);
      setMessage(
        selectedFeature
          ? `Workflow run started for ${selectedFeature.name}.`
          : "Workflow run started.",
      );
    } catch (runError) {
      setError(
        runError instanceof LoopBoardApiError
          ? runError.message
          : "Loop Control Plane could not start the workflow run.",
      );
    } finally {
      setIsRunBusy(false);
    }
  };

  const runAction = async (
    action: "run-next" | "run-next-engine" | "approve" | "skip-disabled" | "fail" | "resume",
  ) => {
    if (!currentRun) {
      return;
    }

    setIsRunBusy(true);
    setError("");
    setMessage("");

    try {
      if (action === "run-next-engine") {
        const run = await applyWorkflowRunAction({
          runId: currentRun.id,
          action: "run-next",
        });
        setCurrentRun(run);
        await refreshEngineStatus();
        setMessage("Workflow step enqueued. Engine tick is running in the background.");

        void tickEngine({ mode: "manual" })
          .then(async () => {
            const [updatedRun] = await Promise.all([
              fetchWorkflowRun(run.id),
              refreshEngineStatus(),
            ]);
            setCurrentRun(updatedRun);
          })
          .catch((tickError) => {
            setError(
              tickError instanceof LoopBoardApiError
                ? tickError.message
                : "Loop Control Plane could not tick the engine.",
            );
          });

        return;
      }

      const run = await applyWorkflowRunAction({
        runId: currentRun.id,
        action,
        error: action === "fail" ? "Failed by workflow editor operator." : undefined,
      });
      setCurrentRun(run);
      await refreshEngineStatus();
      setMessage(`Workflow run ${run.status}.`);
    } catch (runError) {
      setError(
        runError instanceof LoopBoardApiError
          ? runError.message
          : "Loop Control Plane could not update the workflow run.",
      );
    } finally {
      setIsRunBusy(false);
    }
  };

  const updateSelectedNodeExecutor = (
    patch: {
      backend?: ExecutorBackend;
      argsText?: string;
      timeoutMs?: string;
      model?: string;
      fanOutMaxConcurrency?: string;
      fanOutIssueIdsText?: string;
    },
  ) => {
    if (!selectedNode) {
      return;
    }

    updateSelectedNode({
      config: applyExecutorEditorPatch(selectedNode, patch),
    });
  };

  if (!project) {
    return null;
  }

  return (
    <section className="border border-slate-200 bg-white" data-testid="workflow-editor">
      <div className="border-b border-slate-200 p-4">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase text-slate-500">
              Workflow Editor
            </p>
            <h2 className="mt-1 text-lg font-semibold text-slate-950">
              {draftWorkflow?.name ?? "Project workflows"}
            </h2>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-600">
              {project.workflowsPath || "workflows"} · {draftWorkflow?.nodes.length ?? 0} nodes ·{" "}
              {draftWorkflow?.edges.length ?? 0} edges
            </p>
          </div>
          <div className="flex flex-wrap gap-2" data-testid="workflow-editor-toolbar">
            <label className="inline-flex min-h-9 min-w-0 items-center gap-2 border border-slate-300 bg-white px-2 text-xs font-semibold text-slate-700">
              <WorkflowIcon className="h-3.5 w-3.5 shrink-0 text-slate-400" />
              <select
                aria-label="Workflow definition"
                value={selectedWorkflowId}
                onChange={(event) => selectWorkflow(event.target.value)}
                disabled={workflows.length === 0}
                className="max-w-64 bg-transparent outline-none"
              >
                {workflows.length === 0 ? (
                  <option value={selectedWorkflowId}>New Workflow</option>
                ) : null}
                {workflows.map((workflow) => (
                  <option key={workflow.id} value={workflow.id}>
                    {workflow.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={startNewWorkflow}
              data-testid="workflow-new"
              className="inline-flex min-h-9 items-center gap-2 border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-700 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-800"
            >
              <Plus className="h-4 w-4" />
              New
            </button>
            <button
              type="button"
              onClick={() => void loadWorkflows()}
              disabled={isLoading}
              className="inline-flex min-h-9 items-center gap-2 border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-700 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RefreshCw className={clsx("h-4 w-4", isLoading && "animate-spin")} />
              Reload
            </button>
            <button
              type="button"
              onClick={undo}
              disabled={!canUndo}
              title="Undo (⌘Z)"
              className="inline-flex min-h-9 items-center gap-1.5 border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-700 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Undo2 className="h-4 w-4" />
              Undo
            </button>
            <button
              type="button"
              onClick={redo}
              disabled={!canRedo}
              title="Redo (⌘⇧Z)"
              className="inline-flex min-h-9 items-center gap-1.5 border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-700 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Redo2 className="h-4 w-4" />
              Redo
            </button>
            <button
              type="button"
              onClick={() => void saveWorkflow()}
              disabled={isSaving || validationIssues.length > 0}
              data-testid="workflow-save"
              className="inline-flex min-h-9 items-center gap-2 border border-slate-900 bg-slate-900 px-3 text-xs font-semibold text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              Save
            </button>
            <button
              type="button"
              onClick={() => void startRun()}
              disabled={isRunBusy || !draftWorkflow}
              data-testid="workflow-start-run"
              className="inline-flex min-h-9 items-center gap-2 border border-emerald-700 bg-emerald-700 px-3 text-xs font-semibold text-white hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <StepForward className="h-4 w-4" />
              Start Run
            </button>
          </div>
        </div>
        {message ? (
          <div
            className="mt-3 border border-emerald-200 bg-emerald-50 p-3 text-sm leading-6 text-emerald-800"
            data-testid="workflow-message"
          >
            {message}
          </div>
        ) : null}
        {error ? (
          <div
            className="mt-3 border border-red-200 bg-red-50 p-3 text-sm leading-6 text-red-800"
            data-testid="workflow-error"
          >
            {error}
          </div>
        ) : null}
        {!isLoading && workflows.length === 0 ? (
          <div className="mt-3 border border-dashed border-slate-300 bg-slate-50 p-3 text-sm leading-6 text-slate-600">
            <p className="font-semibold text-slate-950">No workflow saved</p>
            <p className="mt-1">
              Save the draft workflow or import a repository workflow file before
              using persisted workflow automation.
            </p>
          </div>
        ) : null}
        <div className="mt-3 grid gap-2 border border-slate-200 bg-slate-50 p-3 text-sm leading-6 text-slate-700 lg:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase text-slate-500">
              Effective Policy
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
        {fileValidationErrors.length > 0 ? (
          <div className="mt-3 grid gap-2 border border-amber-200 bg-amber-50 p-3">
            {fileValidationErrors.map((validationError) => (
              <div
                key={`${validationError.code}-${validationError.message}`}
                className="flex gap-2 text-xs leading-5 text-amber-900"
              >
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{validationError.message}</span>
              </div>
            ))}
            {importOverwrite?.existingWorkflowId ? (
              <button
                type="button"
                onClick={() => void importWorkflowFile(importOverwrite.existingWorkflowId)}
                disabled={isFileBusy}
                className="mt-1 inline-flex min-h-8 w-fit items-center gap-2 border border-amber-900 bg-amber-900 px-3 text-xs font-semibold text-white hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Upload className="h-3.5 w-3.5" />
                Overwrite workflow
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="grid min-h-[42rem] lg:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="min-w-0">
          <div
            style={{ display: "flex", flexWrap: "wrap", gap: 6, borderBottom: "2px dashed #ddd9cd", background: "#f5f4f1", padding: "10px 12px" }}
            data-testid="workflow-node-catalog"
          >
            {workflowNodeCatalog.map((node) => (
              <button
                key={node.type}
                type="button"
                onClick={() => addCatalogNode(node.type)}
                data-testid={`workflow-add-node-${node.type}`}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 5,
                  border: "2px solid #23221f", borderRadius: 999,
                  background: "#fcfbf8", color: "#23221f",
                  padding: "4px 12px", fontSize: 12, fontWeight: 600,
                  fontFamily: "var(--font-hand)", cursor: "pointer",
                  textTransform: "uppercase", letterSpacing: "0.04em",
                }}
              >
                <Plus style={{ width: 12, height: 12 }} />
                {node.name}
              </button>
            ))}
          </div>
          <div className="h-[34rem]" data-testid="workflow-canvas">
            <EdgeActionsContext.Provider value={{ onToggleDashed: toggleEdgeDashed, getOutputCount }}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onReconnect={onReconnect}
              onReconnectStart={onReconnectStart}
              onReconnectEnd={onReconnectEnd}
              isValidConnection={isValidConnection}
              onNodeClick={(_event, node) => setSelectedNodeId(node.id)}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              connectionMode={ConnectionMode.Loose}
              reconnectRadius={15}
              fitView
            >
              <Background color="#c8c4ba" gap={24} size={1.5} />
              <MiniMap pannable zoomable
                style={{ border: "2px solid #b0ac9f", borderRadius: "10px 8px 11px 9px", background: "#f0ede3" }}
              />
              <Controls style={{ border: "2px solid #b0ac9f", borderRadius: 8, overflow: "hidden", background: "#fcfbf8" }} />
            </ReactFlow>
            </EdgeActionsContext.Provider>
          </div>
        </div>

        <aside style={{ borderLeft: "2px solid #ddd9cd", background: "#f5f4f1", padding: 16, overflowY: "auto" }}>
          <div className="grid gap-3">
            <label style={{ display: "grid", gap: 4, fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "#6f6d67", fontFamily: "var(--font-hand)" }}>
              Workflow name
              <input
                aria-label="Workflow name"
                value={draftWorkflow?.name ?? ""}
                onChange={(event) =>
                  draftWorkflow
                    ? setDraftWorkflow({ ...draftWorkflow, name: event.target.value })
                    : undefined
                }
                className="min-h-9 border border-slate-300 bg-white px-2 text-sm font-normal normal-case text-slate-950"
              />
            </label>
            <label className="grid gap-1 text-xs font-semibold uppercase text-slate-500">
              Description
              <textarea
                aria-label="Workflow description"
                value={draftWorkflow?.description ?? ""}
                rows={2}
                onChange={(event) =>
                  draftWorkflow
                    ? setDraftWorkflow({
                        ...draftWorkflow,
                        description: event.target.value,
                      })
                    : undefined
                }
                className="min-h-16 resize-y border border-slate-300 bg-white px-2 py-2 text-sm font-normal normal-case leading-5 text-slate-950"
              />
            </label>
            <label className="grid gap-1 text-xs font-semibold uppercase text-slate-500">
              Workflow config JSON
              <textarea
                aria-label="Workflow config JSON"
                value={workflowConfigJson}
                rows={4}
                onChange={(event) =>
                  applyJsonPatch("workflowConfig", event.target.value)
                }
                className="min-h-24 resize-y border border-slate-300 bg-white px-2 py-2 font-mono text-xs font-normal normal-case leading-5 text-slate-950"
              />
            </label>
            <div className="grid gap-2 border-t border-slate-200 pt-3">
              <label className="grid gap-1 text-xs font-semibold uppercase text-slate-500">
                Export file
                <input
                  value={exportFileName}
                  onChange={(event) => setExportFileName(event.target.value)}
                  placeholder="feature-development-loop.json"
                  className="min-h-9 border border-slate-300 bg-white px-2 font-mono text-sm font-normal normal-case text-slate-950"
                />
              </label>
              <button
                type="button"
                onClick={() => void exportCurrentWorkflow()}
                disabled={isFileBusy}
                className="inline-flex min-h-9 items-center justify-center gap-2 border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-700 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Download className="h-4 w-4" />
                Export JSON
              </button>
              <label className="grid gap-1 text-xs font-semibold uppercase text-slate-500">
                Import file
                <input
                  value={importPath}
                  onChange={(event) => {
                    setImportPath(event.target.value);
                    setImportOverwrite(null);
                  }}
                  className="min-h-9 border border-slate-300 bg-white px-2 font-mono text-sm font-normal normal-case text-slate-950"
                />
              </label>
              <button
                type="button"
                onClick={() => void importWorkflowFile()}
                disabled={isFileBusy || importPath.trim().length === 0}
                className="inline-flex min-h-9 items-center justify-center gap-2 border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-700 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Upload className="h-4 w-4" />
                Import JSON
              </button>
            </div>
            <div className="grid gap-2 border-t border-slate-200 pt-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-xs font-semibold uppercase text-slate-500">
                  Runner
                </h3>
                {currentRun ? (
                  <span className="border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold uppercase text-slate-600">
                    {currentRun.status}
                  </span>
                ) : null}
              </div>
              {currentRun ? (
                <div className="grid gap-2">
                  <p className="text-xs leading-5 text-slate-600" data-testid="workflow-current-run">
                    <span className="font-semibold text-slate-950">
                      {currentRun.currentNodeId
                        ? (draftWorkflow?.nodes.find((n) => n.id === currentRun.currentNodeId)?.name ?? "Unknown node")
                        : "Complete"}
                    </span>
                    {" · "}{currentRun.steps.length} step{currentRun.steps.length !== 1 ? "s" : ""}
                  </p>
                  {currentRun.featureId ? (
                    <p className="border border-slate-200 bg-white p-2 text-xs leading-5 text-slate-600">
                      Target feature:{" "}
                      {selectedFeature?.id === currentRun.featureId
                        ? selectedFeature.name
                        : currentRun.featureId}
                    </p>
                  ) : null}
                  {currentRun.status === "paused" || workflowPauseReason ? (
                    <p
                      className="border border-amber-200 bg-amber-50 p-2 text-xs font-semibold leading-5 text-amber-800"
                      data-testid="workflow-pause-reason"
                    >
                      {workflowPauseReason?.message ??
                        "Paused — click Approve to advance"}
                    </p>
                  ) : null}
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => void runAction("run-next")}
                      disabled={isRunBusy || currentRun.status === "paused" || currentRun.status === "completed" || currentRun.status === "failed"}
                      data-testid="workflow-run-next"
                      className="inline-flex min-h-9 items-center justify-center gap-2 border border-slate-300 bg-white px-2 text-xs font-semibold text-slate-700 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-800 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <StepForward className="h-4 w-4" />
                      Run Next
                    </button>
                    {showEngineRunNext ? (
                      <button
                        type="button"
                        onClick={() => void runAction("run-next-engine")}
                        disabled={isRunBusy || currentRun.status === "paused" || currentRun.status === "completed" || currentRun.status === "failed"}
                        data-testid="workflow-run-next-engine"
                        className="inline-flex min-h-9 items-center justify-center gap-2 border border-sky-700 bg-sky-700 px-2 text-xs font-semibold text-white hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <StepForward className="h-4 w-4" />
                        Run Next (Engine)
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => void runAction("approve")}
                      disabled={isRunBusy || currentRun.status !== "paused"}
                      data-testid="workflow-approve"
                      className="inline-flex min-h-9 items-center justify-center gap-2 border border-emerald-700 bg-emerald-700 px-2 text-xs font-semibold text-white hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Check className="h-4 w-4" />
                      Approve
                    </button>
                    <button
                      type="button"
                      onClick={() => void runAction("skip-disabled")}
                      disabled={isRunBusy || currentRun.status === "paused"}
                      className="inline-flex min-h-9 items-center justify-center gap-2 border border-slate-300 bg-white px-2 text-xs font-semibold text-slate-700 hover:border-amber-300 hover:bg-amber-50 hover:text-amber-800 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <SkipForward className="h-4 w-4" />
                      Skip Disabled
                    </button>
                    <button
                      type="button"
                      onClick={() => void runAction("resume")}
                      disabled={isRunBusy || currentRun.status !== "paused"}
                      className="inline-flex min-h-9 items-center justify-center gap-2 border border-slate-300 bg-white px-2 text-xs font-semibold text-slate-700 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-800 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <RotateCw className="h-4 w-4" />
                      Resume
                    </button>
                    <button
                      type="button"
                      onClick={() => void runAction("fail")}
                      disabled={isRunBusy || currentRun.status === "completed"}
                      className="col-span-2 inline-flex min-h-9 items-center justify-center gap-2 border border-red-300 bg-white px-2 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <XCircle className="h-4 w-4" />
                      Fail Step
                    </button>
                  </div>
                  {currentEngineJob || currentWorkflowStep?.status === "running" ? (
                    <div
                      className="grid gap-2 border border-slate-200 bg-white p-2 text-xs leading-5 text-slate-600"
                      data-testid="workflow-engine-job-status"
                    >
                      <p className="font-semibold uppercase text-slate-500">
                        Engine Job
                      </p>
                      {currentEngineJob ? (
                        <>
                          <p className="mt-1">
                            <span className="font-semibold text-slate-950">
                              {currentEngineJob.status}
                            </span>
                            {" · "}
                            {currentEngineJob.backend}
                            {" · "}
                            attempt {currentEngineJob.attempt}/{currentEngineJob.maxAttempts}
                          </p>
                          {currentEngineJob.lastLogMessage ? (
                            <p className="mt-1 text-slate-500">
                              {currentEngineJob.lastLogMessage}
                            </p>
                          ) : null}
                          {currentEngineJob.error ? (
                            <p className="mt-1 text-red-700">{currentEngineJob.error}</p>
                          ) : null}
                          {currentEngineSchedulerWarning ? (
                            <p className="mt-1 border border-amber-200 bg-amber-50 px-2 py-1 text-amber-900">
                              Scheduler last error: {currentEngineSchedulerWarning}
                            </p>
                          ) : null}
                        </>
                      ) : (
                        <p className="mt-1 text-slate-500">
                          Step is running; waiting for engine job status.
                        </p>
                      )}
                      {visibleWorkflowLogs.length > 0 || visibleEngineLogs.length > 0 ? (
                        <div
                          className="border border-slate-200 bg-slate-950 p-2 text-slate-100"
                          data-testid="workflow-live-logs"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <p className="font-semibold uppercase text-slate-300">
                              Live Logs
                            </p>
                            {currentJobDetail ? (
                              <span className="text-[10px] uppercase text-slate-400">
                                {currentJobDetail.executionLogs.length} engine entries
                              </span>
                            ) : null}
                          </div>
                          <div className="mt-2 max-h-48 overflow-y-auto font-mono text-[11px] leading-5">
                            {visibleWorkflowLogs.length > 0 ? (
                              <div className="mb-2 border-b border-slate-700 pb-2">
                                <p className="mb-1 font-sans text-[10px] font-semibold uppercase text-slate-400">
                                  Workflow Step
                                </p>
                                {visibleWorkflowLogs.map((entry) => {
                                  const metadata = formatLogMetadata(entry.metadata);

                                  return (
                                    <div key={`${entry.timestamp}-${entry.message}`} className="py-0.5">
                                      <span className="text-slate-500">
                                        {formatLogTime(entry.timestamp)}
                                      </span>{" "}
                                      <span className={logLevelClassName(entry.level)}>
                                        {entry.level}
                                      </span>{" "}
                                      <span>{entry.message}</span>
                                      {metadata ? (
                                        <span className="text-slate-500"> · {metadata}</span>
                                      ) : null}
                                    </div>
                                  );
                                })}
                              </div>
                            ) : null}
                            {visibleEngineLogs.length > 0 ? (
                              <div>
                                <p className="mb-1 font-sans text-[10px] font-semibold uppercase text-slate-400">
                                  Engine
                                </p>
                                {visibleEngineLogs.map((entry) => {
                                  const metadata = formatLogMetadata(entry.metadata);

                                  return (
                                    <div key={`${entry.timestamp}-${entry.message}`} className="py-0.5">
                                      <span className="text-slate-500">
                                        {formatLogTime(entry.timestamp)}
                                      </span>{" "}
                                      <span className={logLevelClassName(entry.level)}>
                                        {entry.level}
                                      </span>{" "}
                                      <span>{entry.message}</span>
                                      {metadata ? (
                                        <span className="text-slate-500"> · {metadata}</span>
                                      ) : null}
                                    </div>
                                  );
                                })}
                              </div>
                            ) : (
                              <p className="text-slate-400">
                                Waiting for engine log detail.
                              </p>
                            )}
                            {currentEngineSchedulerWarning ? (
                              <div className="mt-2 border-t border-slate-700 pt-2">
                                <p className="mb-1 font-sans text-[10px] font-semibold uppercase text-slate-400">
                                  Scheduler
                                </p>
                                <div className="py-0.5">
                                  <span className="text-amber-300">warn</span>{" "}
                                  <span>{currentEngineSchedulerWarning}</span>
                                </div>
                              </div>
                            ) : null}
                            {currentJobDetail?.stdoutExcerpt ? (
                              <div className="mt-2 border-t border-slate-700 pt-2 text-slate-300">
                                <p className="font-sans text-[10px] font-semibold uppercase text-slate-400">
                                  Stdout
                                </p>
                                <p className="whitespace-pre-wrap break-words">
                                  {currentJobDetail.stdoutExcerpt}
                                </p>
                              </div>
                            ) : null}
                            {currentJobDetail?.stderrExcerpt ? (
                              <div className="mt-2 border-t border-slate-700 pt-2 text-red-200">
                                <p className="font-sans text-[10px] font-semibold uppercase text-slate-400">
                                  Stderr
                                </p>
                                <p className="whitespace-pre-wrap break-words">
                                  {currentJobDetail.stderrExcerpt}
                                </p>
                              </div>
                            ) : null}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  {currentRun.steps.at(-1) ? (
                    <p
                      className="border border-slate-200 bg-white p-2 text-xs leading-5 text-slate-600"
                      data-testid="workflow-last-step"
                    >
                      Last:{" "}
                      <span className="font-semibold text-slate-950">
                        {draftWorkflow?.nodes.find(
                          (n) => n.id === currentRun.steps.at(-1)?.workflowNodeId,
                        )?.name ?? currentRun.steps.at(-1)?.workflowNodeId}
                      </span>
                      {" — "}{currentRun.steps.at(-1)?.status}
                    </p>
                  ) : null}
                </div>
              ) : (
                <p className="text-xs leading-5 text-slate-500">
                  Start a saved workflow to step through runner actions.
                </p>
              )}
            </div>
          </div>

          <div className="mt-4 border-t border-slate-200 pt-4">
            <h3 className="text-xs font-semibold uppercase text-slate-500">
              Selected node
            </h3>
            {selectedNode ? (
              <div className="mt-3 grid gap-3">
                {selectedNodeWarnings.length > 0 ? (
                  <div className="grid gap-2">
                    {selectedNodeWarnings.map((warning) => (
                      <div
                        key={warning}
                        className="flex gap-2 border border-amber-200 bg-amber-50 p-2 text-xs leading-5 text-amber-900"
                        data-testid="workflow-node-shell-warning"
                      >
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span>{warning}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
                <label className="grid gap-1 text-xs font-semibold uppercase text-slate-500">
                  Name
                  <input
                    aria-label="Workflow node name"
                    value={selectedNode.name}
                    onChange={(event) => updateSelectedNode({ name: event.target.value })}
                    className="min-h-9 border border-slate-300 bg-white px-2 text-sm font-normal normal-case text-slate-950"
                  />
                </label>
                <div className="grid gap-2 border border-slate-200 bg-white p-2">
                  <label className="grid gap-1 text-xs font-semibold uppercase text-slate-500">
                    Connect to
                    <select
                      aria-label="Connect selected node to"
                      value={selectedConnectTargetId}
                      onChange={(event) => setConnectTargetNodeId(event.target.value)}
                      disabled={connectTargetOptions.length === 0}
                      className="min-h-9 border border-slate-300 bg-white px-2 text-sm font-normal normal-case text-slate-950"
                    >
                      {connectTargetOptions.map((node) => (
                        <option key={node.id} value={node.id}>
                          {node.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    onClick={connectSelectedNode}
                    disabled={
                      !selectedConnectTargetId ||
                      draftWorkflow?.edges.some(
                        (edge) =>
                          edge.sourceNodeId === selectedNode.id &&
                          edge.targetNodeId === selectedConnectTargetId,
                      ) === true
                    }
                    data-testid="workflow-connect-selected-node"
                    className="inline-flex min-h-9 items-center justify-center gap-2 border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-700 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-800 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <GitBranch className="h-4 w-4" />
                    Connect
                  </button>
                </div>
                <label className="grid gap-1 text-xs font-semibold uppercase text-slate-500">
                  Type
                  <input
                    value={selectedNode.type}
                    onChange={(event) => updateSelectedNode({ type: event.target.value })}
                    className="min-h-9 border border-slate-300 bg-white px-2 font-mono text-sm font-normal normal-case text-slate-950"
                  />
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <label className="grid gap-1 text-xs font-semibold uppercase text-slate-500">
                    Mode
                    <select
                      value={selectedNode.mode}
                      onChange={(event) =>
                        updateSelectedNode({
                          mode: event.target.value as WorkflowNodeMode,
                        })
                      }
                      className="min-h-9 border border-slate-300 bg-white px-2 text-sm font-normal normal-case text-slate-950"
                    >
                      {workflowNodeModes.map((mode) => (
                        <option key={mode} value={mode}>
                          {compactText(mode)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="grid gap-1 text-xs font-semibold uppercase text-slate-500">
                    Risk
                    <select
                      value={selectedNode.riskPolicy}
                      onChange={(event) =>
                        updateSelectedNode({
                          riskPolicy: event.target.value as WorkflowRiskPolicy,
                        })
                      }
                      className="min-h-9 border border-slate-300 bg-white px-2 text-sm font-normal normal-case text-slate-950"
                    >
                      {workflowRiskPolicies.map((riskPolicy) => (
                        <option key={riskPolicy} value={riskPolicy}>
                          {compactText(riskPolicy)}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <label className="grid gap-1 text-xs font-semibold uppercase text-slate-500">
                    Retries
                    <input
                      type="number"
                      min={0}
                      value={selectedNode.maxRetries}
                      onChange={(event) =>
                        updateSelectedNode({
                          maxRetries: Math.max(0, Number(event.target.value) || 0),
                        })
                      }
                      className="min-h-9 border border-slate-300 bg-white px-2 text-sm font-normal normal-case text-slate-950"
                    />
                  </label>
                  <label className="flex min-h-9 items-end gap-2 text-xs font-semibold uppercase text-slate-500">
                    <input
                      type="checkbox"
                      checked={selectedNode.requireApproval}
                      onChange={(event) =>
                        updateSelectedNode({ requireApproval: event.target.checked })
                      }
                      className="mb-2 h-4 w-4"
                    />
                    Approval
                  </label>
                </div>
                {selectedNodeExecutor?.automatable ? (
                  <div
                    className="grid gap-2 border border-slate-200 bg-white p-2"
                    data-testid="workflow-node-executor-config"
                  >
                    <p className="text-xs font-semibold uppercase text-slate-500">
                      Executor
                    </p>
                    <label className="grid gap-1 text-xs font-semibold uppercase text-slate-500">
                      Backend
                      <select
                        aria-label="Executor backend"
                        value={selectedNodeExecutor.backend}
                        onChange={(event) =>
                          updateSelectedNodeExecutor({
                            backend: event.target.value as ExecutorBackend,
                          })
                        }
                        className="min-h-9 border border-slate-300 bg-white px-2 text-sm font-normal normal-case text-slate-950"
                      >
                        {workflowExecutorBackendOptions().map((backend) => (
                          <option key={backend} value={backend}>
                            {compactText(
                              workflowExecutorBackendLabel(backend, selectedNode.type),
                            )}
                          </option>
                        ))}
                      </select>
                    </label>
                    {selectedNodeExecutorHint ? (
                      <p className="border border-sky-100 bg-sky-50 px-2 py-1.5 text-xs font-medium normal-case text-sky-900">
                        {selectedNodeExecutorHint}
                      </p>
                    ) : null}
                    <label className="grid gap-1 text-xs font-semibold uppercase text-slate-500">
                      Args
                      <input
                        aria-label="Executor args"
                        value={selectedNodeExecutor.argsText}
                        onChange={(event) =>
                          updateSelectedNodeExecutor({ argsText: event.target.value })
                        }
                        placeholder="spec, plan, tasks"
                        className="min-h-9 border border-slate-300 bg-white px-2 font-mono text-sm font-normal normal-case text-slate-950"
                      />
                    </label>
                    <label className="grid gap-1 text-xs font-semibold uppercase text-slate-500">
                      Timeout (ms)
                      <input
                        aria-label="Executor timeout milliseconds"
                        type="number"
                        min={1}
                        value={selectedNodeExecutor.timeoutMs}
                        onChange={(event) =>
                          updateSelectedNodeExecutor({ timeoutMs: event.target.value })
                        }
                        placeholder={String(
                          selectedNodeExecutor.defaultBackend === selectedNodeExecutor.backend
                            ? "default"
                            : "",
                        )}
                        className="min-h-9 border border-slate-300 bg-white px-2 text-sm font-normal normal-case text-slate-950"
                      />
                    </label>
                    {executorBackendSupportsModel(selectedNodeExecutor.backend) ? (
                      <label className="grid gap-1 text-xs font-semibold uppercase text-slate-500">
                        Model (optional)
                        <input
                          aria-label="Executor model"
                          value={selectedNodeExecutor.model}
                          onChange={(event) =>
                            updateSelectedNodeExecutor({ model: event.target.value })
                          }
                          placeholder="e.g. composer-2.5-fast"
                          className="min-h-9 border border-slate-300 bg-white px-2 font-mono text-sm font-normal normal-case text-slate-950"
                        />
                      </label>
                    ) : null}
                    {executorBackendSupportsFanOut(selectedNodeExecutor.backend) ? (
                      <>
                        <label className="grid gap-1 text-xs font-semibold uppercase text-slate-500">
                          AO Fan-out Concurrency
                          <input
                            aria-label="Agent Orchestrator fan-out max concurrency"
                            type="number"
                            min={1}
                            value={selectedNodeExecutor.fanOutMaxConcurrency}
                            onChange={(event) =>
                              updateSelectedNodeExecutor({
                                fanOutMaxConcurrency: event.target.value,
                              })
                            }
                            placeholder="3"
                            className="min-h-9 border border-slate-300 bg-white px-2 text-sm font-normal normal-case text-slate-950"
                          />
                        </label>
                        <label className="grid gap-1 text-xs font-semibold uppercase text-slate-500">
                          AO Fan-out Issue IDs
                          <input
                            aria-label="Agent Orchestrator fan-out issue ids"
                            value={selectedNodeExecutor.fanOutIssueIdsText}
                            onChange={(event) =>
                              updateSelectedNodeExecutor({
                                fanOutIssueIdsText: event.target.value,
                              })
                            }
                            placeholder="101, 102, 103"
                            className="min-h-9 border border-slate-300 bg-white px-2 font-mono text-sm font-normal normal-case text-slate-950"
                          />
                        </label>
                      </>
                    ) : null}
                    <a
                      href="/docs/architecture/loop-execution-engine.md"
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-[11px] font-semibold uppercase text-sky-700 hover:text-sky-900"
                    >
                      <ExternalLink className="h-3 w-3 shrink-0" />
                      Loop execution engine docs
                    </a>
                  </div>
                ) : null}
                <label className="grid gap-1 text-xs font-semibold uppercase text-slate-500">
                  Input artifacts JSON
                  <textarea
                    value={inputArtifactsJson}
                    rows={5}
                    onChange={(event) =>
                      applyJsonPatch("inputArtifacts", event.target.value)
                    }
                    className="min-h-28 resize-y border border-slate-300 bg-white px-2 py-2 font-mono text-xs font-normal normal-case leading-5 text-slate-950"
                  />
                </label>
                <label className="grid gap-1 text-xs font-semibold uppercase text-slate-500">
                  Output artifacts JSON
                  <textarea
                    value={outputArtifactsJson}
                    rows={5}
                    onChange={(event) =>
                      applyJsonPatch("outputArtifacts", event.target.value)
                    }
                    className="min-h-28 resize-y border border-slate-300 bg-white px-2 py-2 font-mono text-xs font-normal normal-case leading-5 text-slate-950"
                  />
                </label>
                <label className="grid gap-1 text-xs font-semibold uppercase text-slate-500">
                  Config JSON
                  <textarea
                    value={configJson}
                    rows={5}
                    onChange={(event) => applyJsonPatch("config", event.target.value)}
                    className="min-h-28 resize-y border border-slate-300 bg-white px-2 py-2 font-mono text-xs font-normal normal-case leading-5 text-slate-950"
                  />
                </label>
              </div>
            ) : (
              <p className="mt-2 text-xs leading-5 text-slate-500">
                Select a workflow node to edit its execution settings.
              </p>
            )}
          </div>

          <div className="mt-4 border-t border-slate-200 pt-4">
            <div className="flex items-center gap-2">
              <GitBranch className="h-4 w-4 text-slate-400" />
              <h3 className="text-xs font-semibold uppercase text-slate-500">
                Validation
              </h3>
            </div>
            {validationIssues.length === 0 ? (
              <p className="mt-2 border border-emerald-200 bg-emerald-50 p-2 text-xs leading-5 text-emerald-800">
                Workflow graph is ready to save.
              </p>
            ) : (
              <div className="mt-2 grid gap-2">
                {validationIssues.map((issue) => (
                  <div
                    key={`${issue.code}-${issue.nodeId ?? issue.edgeId ?? issue.message}`}
                    className="flex gap-2 border border-amber-200 bg-amber-50 p-2 text-xs leading-5 text-amber-900"
                  >
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>{issue.message}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </aside>
      </div>
    </section>
  );
}
