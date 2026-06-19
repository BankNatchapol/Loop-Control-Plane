import { fetchAoRuntimeTerminalConfig } from "@/lib/ao-bridge/ao-client";
import { aoJsonError, aoJsonOk } from "@/lib/ao-bridge/ao-http";

export const runtime = "nodejs";

export async function GET() {
  try {
    const runtimeConfig = await fetchAoRuntimeTerminalConfig();
    return aoJsonOk(runtimeConfig);
  } catch (error) {
    return aoJsonError(error);
  }
}
