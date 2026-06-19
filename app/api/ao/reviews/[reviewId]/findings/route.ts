import { fetchAoReviewFindings } from "@/lib/ao-bridge/ao-client";
import { aoJsonError, aoJsonOk } from "@/lib/ao-bridge/ao-http";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ reviewId: string }> },
) {
  try {
    const { reviewId } = await context.params;
    const findings = await fetchAoReviewFindings(reviewId);
    return aoJsonOk({ findings });
  } catch (error) {
    return aoJsonError(error);
  }
}
