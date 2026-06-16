import type { LoopBoardRepository } from "@/lib/db/loopboard-repository";
import { ValidationError } from "@/lib/db/loopboard-repository";
import {
  getBackendAvailabilityReport,
  type BackendAvailabilityReport,
} from "@/lib/engine/backend-availability-service";

export type BackendAvailabilityResponse = BackendAvailabilityReport;

export const getBackendAvailability = (
  repository: LoopBoardRepository,
  input: { projectId?: string } = {},
): BackendAvailabilityResponse => {
  if (input.projectId) {
    const project = repository.getProject(input.projectId);
    if (!project) {
      throw new ValidationError(`Project not found: ${input.projectId}`);
    }

    return getBackendAvailabilityReport(project);
  }

  return getBackendAvailabilityReport();
};
