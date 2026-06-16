"use client";

import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from "@xyflow/react";
import clsx from "clsx";
import {
  AlertTriangle,
  Check,
  Download,
  ExternalLink,
  GitBranch,
  Plus,
  RefreshCw,
  RotateCw,
  Save,
  SkipForward,
  StepForward,
  Upload,
  Workflow as WorkflowIcon,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  createProjectWorkflow,
  exportWorkflow,
  applyWorkflowRunAction,
  fetchEngineStatus,
  fetchProjectWorkflows,
  importProjectWorkflow,
  startWorkflowRun,
  updateWorkflow,
  LoopBoardApiError,
} from "@/lib/api/loopboard-client";
import type { EngineStatusResponse } from "@/lib/api/engine-actions";
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
  workflowExecutorBackendOptions,
  workflowNodeExecutorPolicyWarnings,
} from "@/lib/workflows/workflow-executor-editor";

type WorkflowCanvasNodeData = {
  label: string;
  mode: WorkflowNodeMode;
  type: string;
};

const compactText = (value: string) => value.replaceAll("-", " ");

const nodeToCanvasNode = (
  node: WorkflowNode,
  activeNodeId?: string | null,
): Node<WorkflowCanvasNodeData> => ({
  id: node.id,
  position: node.position,
  data: {
    label: node.name,
    mode: node.mode,
    type: node.type,
  },
  className: clsx(
    "!rounded-none !border-2 !px-3 !py-2 !text-xs !font-semibold !shadow-sm",
    node.mode === "auto" && "!border-sky-300 !bg-sky-50 !text-sky-900",
    node.mode === "human" && "!border-amber-300 !bg-amber-50 !text-amber-900",
    node.mode === "semi" && "!border-violet-300 !bg-violet-50 !text-violet-900",
    node.mode === "disabled" && "!border-slate-300 !bg-slate-100 !text-slate-500",
  ),
  style: node.id === activeNodeId
    ? { outline: "3px solid #10b981", outlineOffset: "2px" }
    : undefined,
});

const edgeToCanvasEdge = (edge: WorkflowEdge): Edge => ({
  id: edge.id,
  source: edge.sourceNodeId,
  target: edge.targetNodeId,
  label: edge.label || undefined,
  animated: edge.label === "retry",
});

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

export function WorkflowEditor({
  project,
  selectedFeature,
  automationSettings = defaultAutomationSettings,
}: {
  project?: Project;
  selectedFeature?: Feature;
  automationSettings?: AutomationSettings;
}) {
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
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isFileBusy, setIsFileBusy] = useState(false);
  const [isRunBusy, setIsRunBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

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

  const syncCanvas = useCallback((workflow: Workflow) => {
    setNodes(workflow.nodes.map((node) => nodeToCanvasNode(node)));
    setEdges(workflow.edges.map(edgeToCanvasEdge));
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
        style: n.id === activeNodeId
          ? { outline: "3px solid #10b981", outlineOffset: "2px" }
          : undefined,
      }))
    );
  }, [currentRun?.currentNodeId]);

  const replaceDraftWorkflow = useCallback(
    (nextWorkflow: Workflow) => {
      setDraftWorkflow(nextWorkflow);
      setNodes(nextWorkflow.nodes.map((node) => nodeToCanvasNode(node)));
      setEdges(nextWorkflow.edges.map(edgeToCanvasEdge));
    },
    [],
  );

  const updateSelectedNode = useCallback(
    (patch: Partial<WorkflowNode>) => {
      if (!draftWorkflow || !selectedNode) {
        return;
      }

      const nextWorkflow = {
        ...draftWorkflow,
        nodes: draftWorkflow.nodes.map((node) =>
          node.id === selectedNode.id ? { ...node, ...patch } : node,
        ),
      };
      replaceDraftWorkflow(nextWorkflow);
    },
    [draftWorkflow, replaceDraftWorkflow, selectedNode],
  );

  const onNodesChange = useCallback(
    (changes: Array<NodeChange<Node<WorkflowCanvasNodeData>>>) => {
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
    [],
  );

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
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
  }, []);

  const onConnect = useCallback((connection: Connection) => {
    setDraftWorkflow((currentWorkflow) => {
      if (!currentWorkflow || !connection.source || !connection.target) {
        return currentWorkflow;
      }

      const nextEdge = {
        ...normalizeWorkflowEdge({
          workflowId: currentWorkflow.id,
          sourceNodeId: connection.source,
          targetNodeId: connection.target,
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
          },
          currentEdges,
        ),
      );

      return {
        ...currentWorkflow,
        edges: [...currentWorkflow.edges, nextEdge],
      };
    });
  }, []);

  const connectSelectedNode = () => {
    if (!draftWorkflow || !selectedNode || !selectedConnectTargetId) {
      return;
    }

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
            className="flex flex-wrap gap-2 border-b border-slate-200 bg-slate-50 p-3"
            data-testid="workflow-node-catalog"
          >
            {workflowNodeCatalog.map((node) => (
              <button
                key={node.type}
                type="button"
                onClick={() => addCatalogNode(node.type)}
                data-testid={`workflow-add-node-${node.type}`}
                className="inline-flex min-h-8 items-center gap-1.5 border border-slate-300 bg-white px-2 text-[11px] font-semibold uppercase text-slate-700 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-800"
              >
                <Plus className="h-3.5 w-3.5" />
                {node.name}
              </button>
            ))}
          </div>
          <div className="h-[34rem]" data-testid="workflow-canvas">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodeClick={(_event, node) => setSelectedNodeId(node.id)}
              fitView
            >
              <Background />
              <MiniMap pannable zoomable />
              <Controls />
            </ReactFlow>
          </div>
        </div>

        <aside className="border-t border-slate-200 bg-slate-50 p-4 lg:border-l lg:border-t-0">
          <div className="grid gap-3">
            <label className="grid gap-1 text-xs font-semibold uppercase text-slate-500">
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
                      className="border border-slate-200 bg-white p-2 text-xs leading-5 text-slate-600"
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
                        </>
                      ) : (
                        <p className="mt-1 text-slate-500">
                          Step is running; waiting for engine job status.
                        </p>
                      )}
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
                            {compactText(backend)}
                          </option>
                        ))}
                      </select>
                    </label>
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
