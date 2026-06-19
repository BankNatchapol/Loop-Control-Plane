"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { AgentsBoard, OrchestratorStrip } from "@/components/ao/agents-board";
import { AoMuxProvider } from "@/components/ao/mux-provider";
import { ReviewFindingsDrawer, ReviewsBoard } from "@/components/ao/reviews-board";
import { SessionDetailDrawer } from "@/components/ao/session-detail-drawer";
import {
  fetchAoBridgeHealth,
  fetchAoBridgeOrchestrators,
  fetchAoBridgeReviewFindings,
  fetchAoBridgeReviews,
  fetchAoBridgeSessions,
  fetchAoBridgeTerminalConfig,
  killAoBridgeSession,
  syncAoBridgeRuntime,
} from "@/lib/api/ao-actions";
import type { AoDashboardSession, AoReviewRun } from "@/lib/ao-bridge/types";
import type { AoWorkerPoolSnapshot } from "@/lib/engine/ao-worker-pool-types";
import type { PersistedTask } from "@/lib/db/loopboard-repository";
import type { Project } from "@/lib/loopboard";
import { summarizePoolSnapshot } from "@/lib/loopboard-pool-overlay";

export function AoAgentsTab({
  project,
  tasks,
  activeAoWorkerPool,
  onOpenBoard,
  onBoardRefresh,
}: {
  project?: Project;
  tasks: PersistedTask[];
  activeAoWorkerPool?: AoWorkerPoolSnapshot;
  onOpenBoard?: () => void;
  onBoardRefresh?: () => Promise<void>;
}) {
  const [sessions, setSessions] = useState<AoDashboardSession[]>([]);
  const [orchestrators, setOrchestrators] = useState<
    { id: string; projectId: string; projectName?: string; status?: string }[]
  >([]);
  const [selectedSession, setSelectedSession] = useState<AoDashboardSession | null>(null);
  const [muxUrl, setMuxUrl] = useState("ws://127.0.0.1:31101/mux");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const onBoardRefreshRef = useRef(onBoardRefresh);
  const hasLoadedRef = useRef(false);

  const aoProjectId = project?.engineSettings.agentOrchestrator?.projectId;
  const lcpProjectId = project?.id;

  const pickOrchestrators = useCallback(
    (
      orchestratorPayload: { id: string; projectId: string; projectName?: string; status?: string }[],
      sessionOrchestrators: { id: string; projectId: string; projectName?: string; status?: string }[],
    ) => {
      const combined =
        orchestratorPayload.length > 0 ? orchestratorPayload : sessionOrchestrators;
      return aoProjectId
        ? combined.filter((entry) => entry.projectId === aoProjectId)
        : combined;
    },
    [aoProjectId],
  );

  useEffect(() => {
    onBoardRefreshRef.current = onBoardRefresh;
  }, [onBoardRefresh]);

  const refreshSessions = useCallback(async () => {
    setRefreshing(true);
    try {
      const [sessionPayload, orchestratorPayload] = await Promise.all([
        fetchAoBridgeSessions({
          ...(aoProjectId ? { projectId: aoProjectId } : {}),
          active: true,
        }),
        fetchAoBridgeOrchestrators(),
      ]);
      setSessions(sessionPayload.sessions);
      setOrchestrators(
        pickOrchestrators(orchestratorPayload, sessionPayload.orchestrators ?? []),
      );
    } catch {
      // Keep the last good snapshot during background refresh.
    } finally {
      setRefreshing(false);
    }
  }, [aoProjectId, pickOrchestrators]);

  const load = useCallback(async (options: { silent?: boolean; syncBoard?: boolean } = {}) => {
    const silent = options.silent === true;
    const syncBoard = options.syncBoard === true;

    if (!silent) {
      setLoading(true);
      setMessage("");
    }

    try {
      const health = await fetchAoBridgeHealth();
      if (!health.available) {
        setMessage(health.message);
        setSessions([]);
        setOrchestrators([]);
        hasLoadedRef.current = false;
        return;
      }

      const [sessionPayload, orchestratorPayload, terminalConfig] = await Promise.all([
        fetchAoBridgeSessions({
          ...(aoProjectId ? { projectId: aoProjectId } : {}),
          active: true,
        }),
        fetchAoBridgeOrchestrators(),
        fetchAoBridgeTerminalConfig(),
      ]);

      setSessions(sessionPayload.sessions);
      setOrchestrators(
        pickOrchestrators(orchestratorPayload, sessionPayload.orchestrators ?? []),
      );
      setMuxUrl(terminalConfig.muxProxyUrl);
      hasLoadedRef.current = true;

      if (lcpProjectId && syncBoard) {
        void syncAoBridgeRuntime(lcpProjectId)
          .then(() => onBoardRefreshRef.current?.())
          .catch(() => undefined);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load AO sessions.");
    } finally {
      if (!silent) {
        setLoading(false);
      }
    }
  }, [aoProjectId, lcpProjectId, pickOrchestrators]);

  useEffect(() => {
    hasLoadedRef.current = false;
    void load({ syncBoard: true });
  }, [load]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void refreshSessions();
    }, 15_000);
    return () => window.clearInterval(interval);
  }, [refreshSessions]);

  const handleKill = async () => {
    if (!selectedSession) {
      return;
    }
    await killAoBridgeSession(selectedSession.id);
    setSelectedSession(null);
    await load();
  };

  return (
    <AoMuxProvider muxUrl={muxUrl}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Agent sessions</h2>
            <p className="text-sm text-slate-600">
              Live AO attention board for {project?.name ?? "all projects"}.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void load({ syncBoard: true })}
            className="border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700"
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>

        {message ? (
          <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            {message}
          </p>
        ) : null}
        {activeAoWorkerPool ? (
          <div className="flex flex-wrap items-center justify-between gap-2 border border-violet-200 bg-violet-50 px-3 py-2 text-sm text-violet-900">
            <span>
              Worker pool: {summarizePoolSnapshot(activeAoWorkerPool)}
            </span>
            {onOpenBoard ? (
              <button
                type="button"
                onClick={onOpenBoard}
                className="border border-violet-300 bg-white px-3 py-1 text-xs font-semibold text-violet-800"
              >
                Open board
              </button>
            ) : null}
          </div>
        ) : null}
        {loading ? (
          <p className="text-sm text-slate-500">Loading AO sessions…</p>
        ) : sessions.length === 0 ? (
          <p className="text-sm text-slate-500">
            No active AO worker sessions. The orchestrator may still be running — spawn work from
            the board or workflow to populate this view.
          </p>
        ) : null}

        <OrchestratorStrip orchestrators={orchestrators} />
        <AgentsBoard
          sessions={sessions}
          tasks={tasks}
          onSelectSession={setSelectedSession}
        />
      </div>

      {selectedSession ? (
        <SessionDetailDrawer
          session={selectedSession}
          projectId={project?.engineSettings.agentOrchestrator?.projectId}
          onClose={() => setSelectedSession(null)}
          onKill={() => void handleKill()}
        />
      ) : null}
    </AoMuxProvider>
  );
}

export function AoReviewsTab({ project }: { project?: Project }) {
  const [reviews, setReviews] = useState<AoReviewRun[]>([]);
  const [selectedReview, setSelectedReview] = useState<AoReviewRun | null>(null);
  const [findings, setFindings] = useState<
    { id: string; file: string; startLine: number; endLine: number; body: string }[]
  >([]);
  const [loadingFindings, setLoadingFindings] = useState(false);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    setMessage("");
    try {
      const health = await fetchAoBridgeHealth();
      if (!health.available) {
        setMessage(health.message);
        setReviews([]);
        return;
      }
      setReviews(
        await fetchAoBridgeReviews(project?.engineSettings.agentOrchestrator?.projectId),
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load AO reviews.");
    }
  }, [project?.engineSettings.agentOrchestrator?.projectId]);

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => {
      void load();
    }, 8_000);
    return () => window.clearInterval(interval);
  }, [load]);

  useEffect(() => {
    if (!selectedReview) {
      setFindings([]);
      return;
    }

    setLoadingFindings(true);
    void fetchAoBridgeReviewFindings(selectedReview.id)
      .then(setFindings)
      .catch((error) => {
        setMessage(error instanceof Error ? error.message : "Failed to load findings.");
      })
      .finally(() => setLoadingFindings(false));
  }, [selectedReview]);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-slate-900">Code reviews</h2>
        <p className="text-sm text-slate-600">AO review runs and findings for this project.</p>
      </div>
      {message ? (
        <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {message}
        </p>
      ) : null}
      <ReviewsBoard reviews={reviews} onSelectReview={setSelectedReview} />
      {selectedReview ? (
        <ReviewFindingsDrawer
          review={selectedReview}
          findings={findings}
          loading={loadingFindings}
          onClose={() => setSelectedReview(null)}
        />
      ) : null}
    </div>
  );
}
