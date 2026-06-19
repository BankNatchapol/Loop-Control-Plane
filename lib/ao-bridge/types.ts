export type AoAttentionLevel =
  | "merge"
  | "action"
  | "respond"
  | "review"
  | "pending"
  | "working"
  | "done";

export type AoSessionActivity =
  | "active"
  | "ready"
  | "idle"
  | "waiting_input"
  | "blocked"
  | "exited";

export type AoDashboardSession = {
  id: string;
  projectId: string;
  status: string;
  activity: AoSessionActivity | null;
  attentionLevel: AoAttentionLevel;
  branch: string | null;
  issueId: string | null;
  issueUrl: string | null;
  issueTitle: string | null;
  displayName: string | null;
  summary: string | null;
  createdAt: string;
  lastActivityAt: string;
  pr: AoDashboardPr | null;
  runtimeHandle?: {
    tmuxName?: string | null;
  } | null;
  isOrchestrator?: boolean;
};

export type AoDashboardPr = {
  number: number | null;
  url: string | null;
  state: string | null;
  reviewDecision: string | null;
  mergeability: string | null;
  ciStatus: string | null;
};

export type AoOrchestratorLink = {
  id: string;
  projectId: string;
  projectName?: string;
  status?: string;
  activity?: AoSessionActivity | null;
};

export type AoReviewRun = {
  id: string;
  projectId: string;
  status: string;
  workerSessionId?: string | null;
  workerIssueId?: string | null;
  branch?: string | null;
  prNumber?: number | null;
  prUrl?: string | null;
  createdAt: string;
  updatedAt: string;
  findingCount?: number;
};

export type AoReviewFinding = {
  id: string;
  file: string;
  startLine: number;
  endLine: number;
  body: string;
};

export type AoRuntimeTerminalConfig = {
  directTerminalPort: number;
  muxProxyUrl: string;
  apiAvailable: boolean;
};

export type AoBridgeHealth = {
  available: boolean;
  apiBaseUrl: string;
  message: string;
  version?: string;
};

export type AoSessionsResponse = {
  sessions: AoDashboardSession[];
  orchestrators: AoOrchestratorLink[];
  stats?: Record<string, number>;
};

export type LinkedAoTaskRuntime = {
  taskId: string;
  issueNumber: number;
  aoSessionId?: string;
  aoSessionStatus?: string;
  aoAttentionLevel?: AoAttentionLevel;
  aoActivity?: AoSessionActivity | null;
  aoLastSyncedAt?: string;
  aoPrUrl?: string;
};
