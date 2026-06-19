import { fetchAoSessions } from "@/lib/ao-bridge/ao-client";
import { aoJsonError, aoJsonOk } from "@/lib/ao-bridge/ao-http";

export const runtime = "nodejs";

export async function GET() {
  try {
    const sessions = await fetchAoSessions();
    return aoJsonOk({ orchestrators: sessions.orchestrators ?? [] });
  } catch (error) {
    return aoJsonError(error);
  }
}
