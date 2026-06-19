import { fetchAoReviews } from "@/lib/ao-bridge/ao-client";
import { aoJsonError, aoJsonOk } from "@/lib/ao-bridge/ao-http";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const projectId = url.searchParams.get("projectId") ?? url.searchParams.get("project") ?? undefined;
    const reviews = await fetchAoReviews(projectId);
    return aoJsonOk({ reviews });
  } catch (error) {
    return aoJsonError(error);
  }
}
