import { fetchAoHealth } from "@/lib/ao-bridge/ao-client";
import { aoJsonError, aoJsonOk } from "@/lib/ao-bridge/ao-http";

export const runtime = "nodejs";

export async function GET() {
  try {
    const health = await fetchAoHealth();
    return aoJsonOk(health);
  } catch (error) {
    return aoJsonError(error);
  }
}
