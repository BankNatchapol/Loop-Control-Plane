import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import {
  handleApiError,
  jsonOk,
  withLoopBoardRepository,
} from "@/lib/api/loopboard-http";
import { ValidationError } from "@/lib/db/loopboard-repository";

export const runtime = "nodejs";

const isInsidePath = (child: string, parent: string): boolean =>
  child.startsWith(parent + "/") || child === parent;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  try {
    const { projectId } = await params;
    const url = new URL(request.url);
    const relativePath = url.searchParams.get("path");

    if (!relativePath || relativePath.trim().length === 0) {
      throw new ValidationError("path query parameter is required.");
    }

    return await withLoopBoardRepository((repository) => {
      const project = repository.getProject(projectId);
      const repoRoot = resolve(project.repoPath);
      const absolutePath = isAbsolute(relativePath)
        ? resolve(relativePath)
        : resolve(repoRoot, relativePath);

      if (!isInsidePath(absolutePath, repoRoot)) {
        throw new ValidationError("File path must be inside the project repository.");
      }

      if (!existsSync(absolutePath)) {
        return jsonOk({ exists: false, path: relativePath });
      }

      const stat = statSync(absolutePath);
      if (!stat.isFile()) {
        throw new ValidationError("Path is not a file.");
      }

      const MAX_BYTES = 200_000;
      const content = readFileSync(absolutePath, "utf8").slice(0, MAX_BYTES);
      const truncated = stat.size > MAX_BYTES;

      return jsonOk({ exists: true, path: relativePath, content, truncated, sizeBytes: stat.size });
    });
  } catch (error) {
    return handleApiError(error);
  }
}
