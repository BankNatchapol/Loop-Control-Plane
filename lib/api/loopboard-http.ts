import { NextResponse } from "next/server";

import { applyMigrations, openLoopBoardDatabase } from "@/db/migrate";
import {
  LoopBoardRepository,
  LoopBoardRepositoryError,
  ResumableWorkflowRunError,
} from "@/lib/db/loopboard-repository";
import { TaskContextActionError } from "@/lib/api/task-context-actions";
import { FeatureArtifactDocumentError } from "@/lib/features/feature-artifact-documents";
import { ProjectOpenActionError } from "@/lib/projects/project-open-actions";
import { TaskOpenActionError } from "@/lib/tasks/task-open-actions";
import { LoopSchedulerError } from "@/lib/engine/loop-scheduler";
import { EngineJobRecoveryError } from "@/lib/engine/engine-job-recovery";
import { EnginePolicyError } from "@/lib/policies/automation-policy";
import { WorkflowFileError } from "@/lib/workflows/workflow-files";

export type ApiSuccess<T> = {
  ok: true;
  data: T;
};

export type ApiFailure = {
  ok: false;
  error: {
    code: string;
    message: string;
  };
};

const startupRecoveryState = globalThis as typeof globalThis & {
  __loopboardStartupRecoveryApplied?: boolean;
};

export const jsonOk = <T>(data: T, init?: ResponseInit) =>
  NextResponse.json<ApiSuccess<T>>({ ok: true, data }, init);

export const jsonError = (
  message: string,
  status = 500,
  code = "internal_error",
) =>
  NextResponse.json<ApiFailure>(
    { ok: false, error: { code, message } },
    { status },
  );

export const handleApiError = (error: unknown) => {
  if (error instanceof ResumableWorkflowRunError) {
    return NextResponse.json(
      {
        ok: false,
        error: { code: error.code, message: error.message },
        existingRunId: error.existingRunId,
      },
      { status: error.statusCode },
    );
  }
  if (error instanceof LoopBoardRepositoryError) {
    return jsonError(error.message, error.statusCode, error.code);
  }

  if (error instanceof TaskContextActionError) {
    return jsonError(error.message, error.statusCode, error.code);
  }

  if (error instanceof ProjectOpenActionError) {
    return jsonError(error.message, error.statusCode, error.code);
  }

  if (error instanceof TaskOpenActionError) {
    return jsonError(error.message, error.statusCode, error.code);
  }

  if (error instanceof FeatureArtifactDocumentError) {
    return jsonError(error.message, error.statusCode, error.code);
  }

  if (error instanceof WorkflowFileError) {
    return NextResponse.json<ApiFailure & { validationErrors?: unknown }>(
      {
        ok: false,
        error: { code: error.code, message: error.message },
        validationErrors: error.validationErrors,
      },
      { status: error.statusCode },
    );
  }

  if (error instanceof LoopSchedulerError) {
    return jsonError(error.message, error.statusCode, error.code);
  }

  if (error instanceof EngineJobRecoveryError) {
    return jsonError(error.message, error.statusCode, error.code);
  }

  if (error instanceof EnginePolicyError) {
    return jsonError(error.message, error.statusCode, error.code);
  }

  console.error(error);
  return jsonError("LoopBoard could not complete the request.");
};

export const withLoopBoardRepository = async <T>(
  operation: (repository: LoopBoardRepository) => T | Promise<T>,
): Promise<T> => {
  const database = openLoopBoardDatabase();
  applyMigrations(database);
  const repository = new LoopBoardRepository(database);
  if (!startupRecoveryState.__loopboardStartupRecoveryApplied) {
    repository.interruptOrphanedExecutions();
    startupRecoveryState.__loopboardStartupRecoveryApplied = true;
  }

  try {
    return await operation(repository);
  } finally {
    database.close();
  }
};

export const readJsonBody = async (request: Request): Promise<unknown> => {
  try {
    return await request.json();
  } catch {
    return {};
  }
};
