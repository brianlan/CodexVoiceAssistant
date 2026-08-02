import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { CodexClient } from "../server/codex-client.js";

describe("Codex app-server JSON-RPC client", () => {
  it("authenticates, initializes, handles responses and server requests", async () => {
    const server = new WebSocketServer({ port: 0 });
    await once(server, "listening");
    const address = server.address();
    if (typeof address === "string" || address === null) throw new Error("missing test address");

    let authorization = "";
    server.on("connection", (socket, request) => {
      authorization = request.headers.authorization ?? "";
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as { id?: number; method: string };
        if (message.method === "initialize") {
          socket.send(JSON.stringify({ id: message.id, result: { userAgent: "test" } }));
        } else if (message.method === "thread/list") {
          socket.send(JSON.stringify({ id: message.id, result: { data: [{ id: "thr_test" }] } }));
          socket.send(JSON.stringify({ id: 77, method: "item/fileChange/requestApproval", params: { itemId: "item_1" } }));
        }
      });
    });

    const client = new CodexClient(`ws://127.0.0.1:${address.port}`, "secret-token");
    await client.connect();
    expect(authorization).toBe("Bearer secret-token");

    const requestPromise = once(client, "serverRequest");
    await expect(client.request("thread/list", {})).resolves.toEqual({ data: [{ id: "thr_test" }] });
    const [request] = await requestPromise;
    expect(request).toMatchObject({ id: 77, method: "item/fileChange/requestApproval" });

    client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
