import { NextResponse } from "next/server";

import { AoBridgeError } from "@/lib/ao-bridge/ao-client";

export const aoJsonOk = <T>(data: T, init?: ResponseInit) =>
  NextResponse.json({ ok: true as const, data }, init);

export const aoJsonError = (error: unknown) => {
  if (error instanceof AoBridgeError) {
    return NextResponse.json(
      {
        ok: false as const,
        error: {
          code: error.code,
          message: error.message,
        },
      },
      { status: error.statusCode },
    );
  }

  const message = error instanceof Error ? error.message : "AO bridge request failed.";
  return NextResponse.json(
    {
      ok: false as const,
      error: {
        code: "ao_bridge_failed",
        message,
      },
    },
    { status: 500 },
  );
};
