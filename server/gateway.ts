import type { IncomingMessage } from "node:http";
import type { AppConfig } from "./config.js";
import { threadConfigOverrides, threadPermissionParams } from "./config.js";
import { CodexClient, type JsonObject } from "./codex-client.js";
import { z } from "zod";
import type WebSocket from "ws";

const baseAction = z.object({ actionId: z.string().min(1).max(100) });

const actionSchema = z.discriminatedUnion("type", [
  baseAction.extend({ type: z.literal("listThreads") }),
  baseAction.extend({ type: z.literal("createThread") }),
  baseAction.extend({ type: z.literal("resumeThread"), threadId: z.string().min(1).max(200) }),
  baseAction.extend({
    type: z.literal("startRealtime"),
    threadId: z.string().min(1).max(200),
    sdp: z.string().min(1).max(250_000),
  }),
  baseAction.extend({ type: z.literal("stopRealtime"), threadId: z.string().min(1).max(200) }),
  baseAction.extend({
    type: z.literal("sendText"),
    threadId: z.string().min(1).max(200),
    text: z.string().trim().min(1).max(32_000),
    throughRealtime: z.boolean().default(false),
  }),
  baseAction.extend({
    type: z.literal("interrupt"),
    threadId: z.string().min(1).max(200),
    turnId: z.string().min(1).max(200),
  }),
  baseAction.extend({ type: z.literal("listVoices") }),
  baseAction.extend({
    type: z.literal("resolveRequest"),
    requestId: z.union([z.string(), z.number()]),
    resolution: z.enum(["accept", "acceptForSession", "decline", "cancel", "grant", "deny"]),
    answers: z.record(z.string(), z.array(z.string().max(4_000)).max(5)).optional(),
  }),
]);

type Action = z.infer<typeof actionSchema>;
type ServerRequest = { id: number | string; method: string; params?: JsonObject };

export class BrowserGateway {
  private readonly codex: CodexClient;
  private readonly pendingServerRequests = new Map<number | string, ServerRequest>();

  constructor(
    private readonly browser: WebSocket,
    private readonly config: AppConfig,
  ) {
    this.codex = new CodexClient(config.appServerUrl, config.appServerToken);
  }

  async start(): Promise<void> {
    this.codex.on("notification", (message) => {
      if (message.method === "thread/realtime/outputAudio/delta") return;
      if (message.method === "serverRequest/resolved") {
        const requestId = message.params?.requestId;
        if (typeof requestId === "string" || typeof requestId === "number") {
          this.pendingServerRequests.delete(requestId);
        }
      }
      this.send({ type: "notification", ...message });
    });
    this.codex.on("serverRequest", (message) => {
      this.pendingServerRequests.set(message.id, message);
      this.send({ type: "serverRequest", requestId: message.id, method: message.method, params: message.params });
    });
    this.codex.on("close", (reason) => {
      this.send({ type: "status", appServerConnected: false, reason });
    });

    await this.codex.connect();
    this.send({
      type: "ready",
      config: publicConfig(this.config),
    });
  }

  async handle(raw: string): Promise<void> {
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      this.send({ type: "error", message: "消息不是有效的 JSON" });
      return;
    }

    const parsed = actionSchema.safeParse(decoded);
    if (!parsed.success) {
      const actionId = isRecord(decoded) && typeof decoded.actionId === "string" ? decoded.actionId : undefined;
      this.send({ type: "actionError", actionId, message: "无效的操作参数" });
      return;
    }

    try {
      const result = await this.dispatch(parsed.data);
      this.send({ type: "actionResult", actionId: parsed.data.actionId, result });
    } catch (error) {
      this.send({
        type: "actionError",
        actionId: parsed.data.actionId,
        message: error instanceof Error ? error.message : "操作失败",
      });
    }
  }

  close(): void {
    for (const request of this.pendingServerRequests.values()) {
      try {
        this.codex.respondError(request.id, -32800, "Voice client disconnected");
      } catch {
        // The app-server socket may already be gone.
      }
    }
    this.pendingServerRequests.clear();
    this.codex.close();
  }

  private async dispatch(action: Action): Promise<unknown> {
    switch (action.type) {
      case "listThreads":
        return this.codex.request("thread/list", {
          limit: 50,
          cwd: this.config.workspace,
        });
      case "createThread":
        return this.codex.request("thread/start", this.threadParams());
      case "resumeThread":
        return this.codex.request("thread/resume", {
          threadId: action.threadId,
          ...this.threadParams(),
        });
      case "startRealtime":
        return this.codex.request(
          "thread/realtime/start",
          compact({
            threadId: action.threadId,
            version: "v3",
            model: this.config.realtimeModel,
            voice: this.config.realtimeVoice,
            outputModality: "audio",
            prompt: this.config.realtimePrompt,
            includeStartupContext: true,
            clientManagedHandoffs: false,
            delegationAckFiller: false,
            codexResponseHandoffMode: "bemTags",
            transport: { type: "webrtc", sdp: action.sdp },
          }),
          45_000,
        );
      case "stopRealtime":
        return this.codex.request("thread/realtime/stop", { threadId: action.threadId });
      case "sendText":
        if (action.throughRealtime) {
          return this.codex.request("thread/realtime/appendText", {
            threadId: action.threadId,
            text: action.text,
            role: "user",
          });
        }
        return this.codex.request("turn/start", {
          threadId: action.threadId,
          input: [{ type: "text", text: action.text }],
        });
      case "interrupt":
        return this.codex.request("turn/interrupt", {
          threadId: action.threadId,
          turnId: action.turnId,
        });
      case "listVoices":
        return this.codex.request("thread/realtime/listVoices", {});
      case "resolveRequest":
        return this.resolveServerRequest(action);
    }
  }

  private threadParams(): JsonObject {
    return compact({
      cwd: this.config.workspace,
      model: this.config.codexModel,
      config: threadConfigOverrides(this.config.codexReasoningEffort),
      ...threadPermissionParams(this.config.permissionMode),
      approvalsReviewer: "user",
      personality: "friendly",
      serviceName: "codex_voice_assistant",
    });
  }

  private resolveServerRequest(action: Extract<Action, { type: "resolveRequest" }>): JsonObject {
    const pending = this.pendingServerRequests.get(action.requestId);
    if (!pending) throw new Error("该请求已经失效或已被处理");

    let result: JsonObject;
    switch (pending.method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval": {
        if (!["accept", "acceptForSession", "decline", "cancel"].includes(action.resolution)) {
          throw new Error("此审批不支持该操作");
        }
        result = { decision: action.resolution };
        break;
      }
      case "item/permissions/requestApproval":
        result = action.resolution === "grant"
          ? { permissions: pending.params?.permissions ?? {}, scope: "turn" }
          : { permissions: {} };
        break;
      case "item/tool/requestUserInput":
      case "tool/requestUserInput":
        if (!action.answers) {
          if (action.resolution === "cancel") {
            this.codex.respondError(pending.id, -32800, "Canceled by user");
            this.pendingServerRequests.delete(pending.id);
            return {};
          }
          throw new Error("请回答所有问题");
        }
        result = {
          answers: Object.fromEntries(
            Object.entries(action.answers).map(([id, answers]) => [id, { answers }]),
          ),
        };
        break;
      case "mcpServer/elicitation/request":
        if (!["decline", "cancel"].includes(action.resolution)) {
          throw new Error("当前界面不支持填写 MCP 表单，只能拒绝或取消");
        }
        result = { action: action.resolution, content: null, _meta: null };
        break;
      default:
        if (!["decline", "cancel", "deny"].includes(action.resolution)) {
          throw new Error(`未知请求 ${pending.method} 只能拒绝`);
        }
        this.codex.respondError(pending.id, -32800, "Declined by voice client");
        this.pendingServerRequests.delete(pending.id);
        return {};
    }

    this.codex.respond(pending.id, result);
    this.pendingServerRequests.delete(pending.id);
    return {};
  }

  private send(payload: unknown): void {
    if (this.browser.readyState === this.browser.OPEN) {
      this.browser.send(JSON.stringify(payload));
    }
  }
}

export function isAllowedOrigin(request: IncomingMessage, config: AppConfig): boolean {
  const origin = request.headers.origin;
  if (!origin) return false;
  if (config.allowedOrigins.has(origin)) return true;
  return origin === `https://${request.headers.host}`;
}

export function publicConfig(config: AppConfig) {
  return {
    workspace: config.workspace,
    permissionMode: config.permissionMode,
    codexModel: config.codexModel ?? "Codex 默认模型",
    codexReasoningEffort: config.codexReasoningEffort ?? "模型默认值",
    realtimeModel: config.realtimeModel,
    realtimeVoice: config.realtimeVoice ?? "自动",
    isYolo: config.permissionMode === "yolo",
  };
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
