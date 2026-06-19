"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

type MuxStatus = "connecting" | "connected" | "reconnecting" | "disconnected";

type MuxContextValue = {
  status: MuxStatus;
  subscribeTerminal: (sessionId: string, callback: (data: string) => void) => () => void;
  writeTerminal: (sessionId: string, data: string) => void;
  openTerminal: (sessionId: string, projectId?: string) => void;
  closeTerminal: (sessionId: string) => void;
  resizeTerminal: (sessionId: string, cols: number, rows: number) => void;
};

const MuxContext = createContext<MuxContextValue | undefined>(undefined);

type ClientMessage =
  | { ch: "subscribe"; topics: string[] }
  | { ch: "terminal"; id: string; type: "open" | "close" | "write" | "resize"; projectId?: string; data?: string; cols?: number; rows?: number };

export function AoMuxProvider({
  children,
  muxUrl,
}: {
  children: ReactNode;
  muxUrl: string;
}) {
  const wsRef = useRef<WebSocket | null>(null);
  const subscribersRef = useRef(new Map<string, Set<(data: string) => void>>());
  const openedRef = useRef(new Set<string>());
  const [status, setStatus] = useState<MuxStatus>("connecting");

  const send = useCallback((message: ClientMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }, []);

  const connect = useCallback(() => {
    if (wsRef.current) {
      return;
    }

    setStatus("connecting");
    const ws = new WebSocket(muxUrl);
    wsRef.current = ws;

    ws.addEventListener("open", () => {
      setStatus("connected");
      send({ ch: "subscribe", topics: ["sessions", "notifications"] });
      for (const sessionId of openedRef.current) {
        send({ ch: "terminal", id: sessionId, type: "open" });
      }
    });

    ws.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(String(event.data)) as {
          ch?: string;
          id?: string;
          data?: string;
        };
        if (message.ch === "terminal" && message.id && typeof message.data === "string") {
          const callbacks = subscribersRef.current.get(message.id);
          callbacks?.forEach((callback) => callback(message.data!));
        }
      } catch {
        // Ignore malformed mux frames.
      }
    });

    ws.addEventListener("close", () => {
      wsRef.current = null;
      setStatus("reconnecting");
      window.setTimeout(connect, 1_500);
    });

    ws.addEventListener("error", () => {
      setStatus("disconnected");
    });
  }, [muxUrl, send]);

  useEffect(() => {
    connect();
    return () => {
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [connect]);

  const value = useMemo<MuxContextValue>(
    () => ({
      status,
      subscribeTerminal: (sessionId, callback) => {
        const callbacks = subscribersRef.current.get(sessionId) ?? new Set();
        callbacks.add(callback);
        subscribersRef.current.set(sessionId, callbacks);
        return () => {
          callbacks.delete(callback);
          if (callbacks.size === 0) {
            subscribersRef.current.delete(sessionId);
          }
        };
      },
      writeTerminal: (sessionId, data) => {
        send({ ch: "terminal", id: sessionId, type: "write", data });
      },
      openTerminal: (sessionId, projectId) => {
        openedRef.current.add(sessionId);
        send({
          ch: "terminal",
          id: sessionId,
          type: "open",
          ...(projectId ? { projectId } : {}),
        });
      },
      closeTerminal: (sessionId) => {
        openedRef.current.delete(sessionId);
        send({ ch: "terminal", id: sessionId, type: "close" });
      },
      resizeTerminal: (sessionId, cols, rows) => {
        send({ ch: "terminal", id: sessionId, type: "resize", cols, rows });
      },
    }),
    [send, status],
  );

  return <MuxContext.Provider value={value}>{children}</MuxContext.Provider>;
}

export const useAoMux = (): MuxContextValue => {
  const context = useContext(MuxContext);
  if (!context) {
    throw new Error("useAoMux must be used within AoMuxProvider");
  }
  return context;
};
