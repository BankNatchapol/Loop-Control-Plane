import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { afterEach, describe, it } from "node:test";

import { POST as postManagedShutdown } from "@/app/api/dev/shutdown/route";

const listen = (server: Server) =>
  new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not resolve control server port."));
        return;
      }
      resolve(address.port);
    });
  });

describe("managed runtime shutdown API", () => {
  let controlServer: Server | undefined;
  let previousManaged: string | undefined;
  let previousPort: string | undefined;

  afterEach(async () => {
    if (controlServer) {
      await new Promise<void>((resolve, reject) => {
        controlServer!.close((error) => (error ? reject(error) : resolve()));
      });
      controlServer = undefined;
    }

    if (previousManaged === undefined) {
      delete process.env.LOOPBOARD_MANAGED;
    } else {
      process.env.LOOPBOARD_MANAGED = previousManaged;
    }

    if (previousPort === undefined) {
      delete process.env.LOOPBOARD_CONTROL_PORT;
    } else {
      process.env.LOOPBOARD_CONTROL_PORT = previousPort;
    }
  });

  it("returns not available outside managed mode", async () => {
    previousManaged = process.env.LOOPBOARD_MANAGED;
    delete process.env.LOOPBOARD_MANAGED;

    const response = await postManagedShutdown();
    assert.equal(response.status, 404);
  });

  it("forwards shutdown requests to the managed control server", async () => {
    previousManaged = process.env.LOOPBOARD_MANAGED;
    previousPort = process.env.LOOPBOARD_CONTROL_PORT;

    let received = false;
    controlServer = createServer((request, response) => {
      if (request.method === "POST" && request.url === "/shutdown") {
        received = true;
        response.writeHead(202, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
        return;
      }

      response.writeHead(404);
      response.end();
    });

    const port = await listen(controlServer);
    process.env.LOOPBOARD_MANAGED = "1";
    process.env.LOOPBOARD_CONTROL_PORT = String(port);

    const response = await postManagedShutdown();
    assert.equal(response.status, 202);
    assert.equal(received, true);
    const body = (await response.json()) as { ok: boolean; data: { message: string } };
    assert.equal(body.ok, true);
    assert.match(body.data.message, /shutting down/i);
  });
});
