import { syncAoRuntimeForRepository } from "@/lib/ao-bridge/ao-session-sync-service";
import { aoJsonError, aoJsonOk } from "@/lib/ao-bridge/ao-http";
import { withLoopBoardRepository } from "@/lib/api/loopboard-http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { projectId?: string };
    const result = await withLoopBoardRepository((repository) =>
      syncAoRuntimeForRepository(repository, body.projectId),
    );
    return aoJsonOk(result);
  } catch (error) {
    return aoJsonError(error);
  }
}
