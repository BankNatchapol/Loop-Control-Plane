import { postAoSessionAction } from "@/lib/ao-bridge/ao-client";
import { aoJsonError, aoJsonOk } from "@/lib/ao-bridge/ao-http";

export const runtime = "nodejs";

export async function POST(
  _request: Request,
  context: { params: Promise<{ sessionId: string }> },
) {
  try {
    const { sessionId } = await context.params;
    await postAoSessionAction(sessionId, "kill");
    return aoJsonOk({ sessionId, killed: true });
  } catch (error) {
    return aoJsonError(error);
  }
}
