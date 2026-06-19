import { fetchAoSession } from "@/lib/ao-bridge/ao-client";
import { aoJsonError, aoJsonOk } from "@/lib/ao-bridge/ao-http";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ sessionId: string }> },
) {
  try {
    const { sessionId } = await context.params;
    const session = await fetchAoSession(sessionId);
    return aoJsonOk(session);
  } catch (error) {
    return aoJsonError(error);
  }
}
