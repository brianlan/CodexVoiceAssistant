import { EventEmitter } from "node:events";
import WebSocket from "ws";

export type JsonObject = Record<string, unknown>;

type RpcResponse = {
  id: number | string;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

export interface CodexClientEvents {
  notification: [message: { method: string; params?: JsonObject }];
  serverRequest: [message: { id: number | string; method: string; params?: JsonObject }];
  close: [reason: string];
}

export class CodexClient extends EventEmitter<CodexClientEvents> {
  private socket?: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number | string, Pending>();

  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {
    super();
  }

  async connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    this.socket = new WebSocket(this.url, {
      headers: { Authorization: `Bearer ${this.token}` },
      handshakeTimeout: 10_000,
    });

    await new Promise<void>((resolve, reject) => {
      const socket = this.socket!;
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        socket.off("open", onOpen);
        socket.off("error", onError);
      };
      socket.once("open", onOpen);
      socket.once("error", onError);
    });

    this.socket.on("message", (data) => this.handleMessage(data.toString()));
    this.socket.on("close", (_code, reason) => this.handleClose(reason.toString() || "app-server disconnected"));
    this.socket.on("error", (error) => this.emit("close", error.message));

    await this.request("initialize", {
      clientInfo: {
        name: "codex_voice_assistant",
        title: "Codex Voice Assistant",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
        mcpServerOpenaiFormElicitation: false,
      },
    });
    this.notify("initialized");
  }

  request(method: string, params: JsonObject = {}, timeoutMs = 30_000): Promise<unknown> {
    const id = this.nextId++;
    this.send({ id, method, params });
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
    });
  }

  notify(method: string, params?: JsonObject): void {
    this.send(params ? { method, params } : { method });
  }

  respond(id: number | string, result: unknown): void {
    this.send({ id, result });
  }

  respondError(id: number | string, code: number, message: string): void {
    this.send({ id, error: { code, message } });
  }

  close(): void {
    this.socket?.close(1000, "browser disconnected");
  }

  private send(payload: unknown): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Codex app-server is not connected");
    }
    this.socket.send(JSON.stringify(payload));
  }

  private handleMessage(raw: string): void {
    let message: RpcResponse & { method?: string; params?: JsonObject };
    try {
      message = JSON.parse(raw) as typeof message;
    } catch {
      return;
    }

    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? "Codex app-server request failed"));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method && message.id !== undefined) {
      this.emit("serverRequest", {
        id: message.id,
        method: message.method,
        params: message.params,
      });
      return;
    }

    if (message.method) {
      this.emit("notification", { method: message.method, params: message.params });
    }
  }

  private handleClose(reason: string): void {
    for (const { reject, timeout } of this.pending.values()) {
      clearTimeout(timeout);
      reject(new Error(reason));
    }
    this.pending.clear();
    this.emit("close", reason);
  }
}
