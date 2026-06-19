import { NextResponse } from "next/server";

import { probeCliAvailabilityForBackend } from "@/lib/engine/backends/cli-availability";

export const runtime = "nodejs";

const VALID_PLUGIN_BACKENDS = new Set<string>(["claude-code", "codex", "cursor"]);

export async function GET(request: Request) {
  const url = new URL(request.url);
  const plugin = url.searchParams.get("plugin") ?? "";

  if (!VALID_PLUGIN_BACKENDS.has(plugin)) {
    return NextResponse.json(
      { available: false, message: `Unknown agent plugin: "${plugin}". Valid values: claude-code, codex, cursor.` },
      { status: 400 },
    );
  }

  const result = probeCliAvailabilityForBackend(plugin as "claude-code" | "codex" | "cursor");
  return NextResponse.json(result);
}
