import express from "express";
import { createServer } from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { LoginRateLimiter, SessionStore } from "./auth.js";
import { ensureCertificates, readTlsOptions } from "./certificates.js";
import { loadConfig } from "./config.js";
import { BrowserGateway, isAllowedOrigin, publicConfig } from "./gateway.js";

const config = loadConfig();
const certificatePaths = ensureCertificates(config.certDir, config.hostIp);
const sessions = new SessionStore(config.password, config.sessionTtlMs);
const limiter = new LoginRateLimiter();
const app = express();

app.disable("x-powered-by");
app.use((request, response, next) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "microphone=(self), camera=(), geolocation=()");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self' wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  );
  response.setHeader("Strict-Transport-Security", "max-age=31536000");
  next();
});
app.use(express.json({ limit: "64kb" }));

app.get("/healthz", (_request, response) => {
  response.json({ ok: true });
});

app.get("/api/ca.crt", (_request, response) => {
  response.download(certificatePaths.ca, "codex-voice-ca.crt");
});

app.post("/api/login", (request, response) => {
  if (!isAllowedOrigin(request, config)) {
    response.status(403).json({ error: "来源校验失败" });
    return;
  }
  const remote = request.socket.remoteAddress ?? "unknown";
  if (!limiter.check(remote)) {
    response.status(429).json({ error: "尝试次数过多，请稍后再试" });
    return;
  }
  const password = typeof request.body?.password === "string" ? request.body.password : "";
  if (!sessions.verifyPassword(password)) {
    limiter.fail(remote);
    response.status(401).json({ error: "密码不正确" });
    return;
  }
  limiter.clear(remote);
  sessions.create(response);
  response.json({ ok: true, config: publicConfig(config) });
});

app.post("/api/logout", requireAuth, (request, response) => {
  sessions.destroy(request, response);
  response.json({ ok: true });
});

app.get("/api/session", requireAuth, (_request, response) => {
  response.json({ authenticated: true, config: publicConfig(config) });
});

const clientDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  config.nodeEnv === "production" ? "../client" : "../../dist/client",
);
app.use(express.static(clientDirectory, { index: false, maxAge: config.nodeEnv === "production" ? "1h" : 0 }));
app.use((request, response, next) => {
  if (request.method !== "GET" || request.path.startsWith("/api/") || request.path === "/healthz") {
    next();
    return;
  }
  response.sendFile(path.join(clientDirectory, "index.html"));
});

const server = createServer(readTlsOptions(certificatePaths), app);
const webSockets = new WebSocketServer({ noServer: true, maxPayload: 300_000 });

server.on("upgrade", (request, socket, head) => {
  if (request.url !== "/ws" || !sessions.isAuthenticated(request) || !isAllowedOrigin(request, config)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  webSockets.handleUpgrade(request, socket, head, (webSocket) => {
    webSockets.emit("connection", webSocket, request);
  });
});

webSockets.on("connection", async (webSocket) => {
  const gateway = new BrowserGateway(webSocket, config);
  webSocket.on("message", (data) => void gateway.handle(data.toString()));
  webSocket.on("close", () => gateway.close());
  webSocket.on("error", () => gateway.close());
  try {
    await gateway.start();
  } catch (error) {
    webSocket.send(JSON.stringify({
      type: "fatal",
      message: error instanceof Error ? error.message : "无法连接 Codex app-server",
    }));
    webSocket.close(1011, "Codex app-server unavailable");
  }
});

server.listen(config.port, config.host, () => {
  console.log(`Codex Voice Assistant listening on https://${config.hostIp}:${config.port}`);
});

function requireAuth(
  request: express.Request,
  response: express.Response,
  next: express.NextFunction,
): void {
  if (!sessions.isAuthenticated(request)) {
    response.status(401).json({ error: "未登录" });
    return;
  }
  if (request.method !== "GET" && !isAllowedOrigin(request, config)) {
    response.status(403).json({ error: "来源校验失败" });
    return;
  }
  next();
}
