import { jsonError, jsonOk } from "@/lib/api/loopboard-http";

export const runtime = "nodejs";

export async function POST() {
  if (process.env.LOOPBOARD_MANAGED !== "1") {
    return jsonError("Managed shutdown is only available in dev:managed mode.", 404, "not_available");
  }

  const controlPort = process.env.LOOPBOARD_CONTROL_PORT ?? "31999";

  try {
    const response = await fetch(`http://127.0.0.1:${controlPort}/shutdown`, {
      method: "POST",
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) {
      return jsonError("Managed shutdown request failed.", 502, "shutdown_failed");
    }

    return jsonOk({ message: "Shutting down managed runtime." }, { status: 202 });
  } catch {
    return jsonError("Managed shutdown control server is unavailable.", 503, "shutdown_unavailable");
  }
}
