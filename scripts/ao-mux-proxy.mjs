import { createServer } from "node:http";
import { connect as netConnect } from "node:net";

import { WebSocket, WebSocketServer } from "ws";

const muxHost = process.env.LOOPBOARD_AO_MUX_HOST ?? "127.0.0.1";
const muxPort = Number.parseInt(process.env.LOOPBOARD_AO_MUX_PORT ?? "14801", 10);
const listenPort = Number.parseInt(process.env.LOOPBOARD_AO_MUX_PROXY_PORT ?? "31101", 10);
const upstreamUrl = `ws://${muxHost}:${muxPort}/mux`;

const server = createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/plain" });
  response.end("Loop Control Plane AO mux proxy\n");
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const pathname = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`)
    .pathname;

  if (pathname !== "/mux") {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (clientSocket) => {
    const upstream = new WebSocket(upstreamUrl);
    let closing = false;

    const normalizeCloseCode = (code) =>
      typeof code === "number" && code >= 1000 && code <= 4999 ? code : 1000;

    const normalizeCloseReason = (reason) => {
      if (typeof reason === "string") return reason;
      if (Buffer.isBuffer(reason)) return reason;
      return undefined;
    };

    const closeSocket = (target, code, reason) => {
      if (
        target.readyState !== WebSocket.OPEN &&
        target.readyState !== WebSocket.CONNECTING
      ) {
        return;
      }

      try {
        target.close(normalizeCloseCode(code), normalizeCloseReason(reason));
      } catch {
        try {
          target.terminate();
        } catch {
          // Socket may already be gone.
        }
      }
    };

    const closeBoth = (code, reason) => {
      if (closing) return;
      closing = true;
      closeSocket(clientSocket, code, reason);
      closeSocket(upstream, code, reason);
    };

    upstream.on("open", () => {
      clientSocket.on("message", (data, isBinary) => {
        if (upstream.readyState === WebSocket.OPEN) {
          upstream.send(data, { binary: isBinary });
        }
      });
      upstream.on("message", (data, isBinary) => {
        if (clientSocket.readyState === WebSocket.OPEN) {
          clientSocket.send(data, { binary: isBinary });
        }
      });
    });

    upstream.on("error", () => closeBoth());
    clientSocket.on("error", () => closeBoth());
    upstream.on("close", (code, reason) => closeBoth(code, reason));
    clientSocket.on("close", (code, reason) => closeBoth(code, reason));
  });
});

const waitForUpstream = async (attempts = 30) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const reachable = await new Promise((resolveReachable) => {
      const socket = netConnect({ host: muxHost, port: muxPort });
      socket.once("connect", () => {
        socket.destroy();
        resolveReachable(true);
      });
      socket.once("error", () => {
        socket.destroy();
        resolveReachable(false);
      });
      socket.setTimeout(500, () => {
        socket.destroy();
        resolveReachable(false);
      });
    });

    if (reachable) {
      return true;
    }

    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }

  return false;
};

const start = async () => {
  const ready = await waitForUpstream();
  if (!ready) {
    console.warn(
      `[ao-mux-proxy] AO mux upstream ${upstreamUrl} is not reachable yet; proxy will still start.`,
    );
  }

  server.listen(listenPort, "127.0.0.1", () => {
    console.log(`[ao-mux-proxy] Listening on ws://127.0.0.1:${listenPort}/mux -> ${upstreamUrl}`);
  });
};

const shutdown = () => {
  wss.close();
  server.close(() => process.exit(0));
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

void start();
