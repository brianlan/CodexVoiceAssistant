import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { WebSocketServer } from "ws";

const mock = new WebSocketServer({ port: 43222 });
let threadCounter = 1;

mock.on("connection", (socket) => {
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.method === "initialize") {
      respond(socket, message.id, { userAgent: "e2e", codexHome: "/tmp" });
      return;
    }
    if (message.method === "thread/list") {
      respond(socket, message.id, { data: [] });
      return;
    }
    if (message.method === "thread/start") {
      const thread = { id: `thr_e2e_${threadCounter++}`, preview: "端到端语音任务", createdAt: Math.floor(Date.now() / 1000), turns: [] };
      respond(socket, message.id, { thread });
      notify(socket, "thread/started", { thread });
      return;
    }
    if (message.method === "thread/resume") {
      respond(socket, message.id, { thread: { id: message.params.threadId, preview: "恢复的任务", turns: [] } });
      return;
    }
    if (message.method === "turn/start") {
      const threadId = message.params.threadId;
      const turn = { id: "turn_e2e", status: "inProgress" };
      respond(socket, message.id, { turn });
      notify(socket, "turn/started", { threadId, turn });
      notify(socket, "item/started", { threadId, turnId: turn.id, item: { id: "cmd_e2e", type: "commandExecution", command: "npm test", status: "inProgress" } });
      notify(socket, "item/commandExecution/outputDelta", { threadId, turnId: turn.id, itemId: "cmd_e2e", delta: "3 tests passed\n" });
      notify(socket, "item/completed", { threadId, turnId: turn.id, item: { id: "cmd_e2e", type: "commandExecution", command: "npm test", aggregatedOutput: "3 tests passed\n", status: "completed" } });
      notify(socket, "item/agentMessage/delta", { threadId, turnId: turn.id, itemId: "msg_e2e", delta: "Codex 已完成测试任务。" });
      notify(socket, "turn/completed", { threadId, turn: { id: turn.id, status: "completed" } });
      return;
    }
    if (message.method === "thread/realtime/start") {
      respond(socket, message.id, {});
      notify(socket, "thread/realtime/started", { threadId: message.params.threadId, realtimeSessionId: "rt_e2e", version: "v3" });
      return;
    }
    if (message.method === "thread/realtime/stop") {
      respond(socket, message.id, {});
      notify(socket, "thread/realtime/closed", { threadId: message.params.threadId, reason: "stopped" });
      return;
    }
    if (message.id !== undefined) respond(socket, message.id, {});
  });
});

rmSync(".test-certs", { recursive: true, force: true });
const gateway = spawn(process.execPath, ["dist/server/index.js"], {
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_ENV: "production",
    APP_HOST: "127.0.0.1",
    APP_HOST_IP: "127.0.0.1",
    APP_PORT: "3443",
    APP_PASSWORD: "integration-password",
    APP_SERVER_TOKEN: "integration-app-server-token-long-enough",
    CODEX_APP_SERVER_URL: "ws://127.0.0.1:43222",
    CODEX_WORKSPACE: "/workspace",
    CODEX_PERMISSION_MODE: "workspace-write",
    CERT_DIR: ".test-certs",
  },
});

function shutdown() {
  gateway.kill("SIGTERM");
  mock.close();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
gateway.on("exit", (code) => {
  if (code && code !== 0) process.exit(code);
});

function respond(socket, id, result) { socket.send(JSON.stringify({ id, result })); }
function notify(socket, method, params) { socket.send(JSON.stringify({ method, params })); }
