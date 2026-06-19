"use client";

import { useEffect, useRef } from "react";

import { useAoMux } from "@/components/ao/mux-provider";

import "@xterm/xterm/css/xterm.css";

export function AgentTerminal({
  sessionId,
  projectId,
  className = "",
}: {
  sessionId: string;
  projectId?: string;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const { openTerminal, closeTerminal, subscribeTerminal, writeTerminal, resizeTerminal, status } =
    useAoMux();

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    let disposed = false;
    let cleanup: (() => void) | undefined;

    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);

      if (disposed || !containerRef.current) {
        return;
      }

      const terminal = new Terminal({
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        fontSize: 13,
        theme: {
          background: "#0f172a",
          foreground: "#e2e8f0",
          cursor: "#38bdf8",
        },
        convertEol: true,
      });
      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(containerRef.current);
      fitAddon.fit();
      openTerminal(sessionId, projectId);

      const unsubscribe = subscribeTerminal(sessionId, (data) => {
        terminal.write(data);
      });

      const dataDisposable = terminal.onData((data) => {
        writeTerminal(sessionId, data);
      });

      const resizeObserver = new ResizeObserver(() => {
        fitAddon.fit();
        resizeTerminal(sessionId, terminal.cols, terminal.rows);
      });
      resizeObserver.observe(containerRef.current);

      cleanup = () => {
        resizeObserver.disconnect();
        dataDisposable.dispose();
        unsubscribe();
        closeTerminal(sessionId);
        terminal.dispose();
      };
    })();

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [
    closeTerminal,
    openTerminal,
    projectId,
    resizeTerminal,
    sessionId,
    subscribeTerminal,
    writeTerminal,
  ]);

  return (
    <div className={className}>
      <div className="mb-2 text-xs text-slate-500">
        Terminal {status === "connected" ? "connected" : status}
      </div>
      <div
        ref={containerRef}
        className="h-[min(480px,60vh)] overflow-hidden rounded border border-slate-800 bg-slate-950"
      />
    </div>
  );
}
