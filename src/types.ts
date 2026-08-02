export type PublicConfig = {
  workspace: string;
  permissionMode: "read-only" | "workspace-write" | "full-access" | "yolo";
  codexModel: string;
  codexReasoningEffort: string;
  realtimeModel: string;
  realtimeVoice: string;
  isYolo: boolean;
};

export type ThreadSummary = {
  id: string;
  preview?: string;
  name?: string;
  createdAt?: number;
  updatedAt?: number;
  status?: { type?: string } | string;
  turns?: unknown[];
};

export type GatewayMessage =
  | { type: "ready"; config: PublicConfig }
  | { type: "status"; appServerConnected: boolean; reason?: string }
  | { type: "notification"; method: string; params?: Record<string, unknown> }
  | { type: "serverRequest"; requestId: string | number; method: string; params?: Record<string, unknown> }
  | { type: "actionResult"; actionId: string; result: unknown }
  | { type: "actionError"; actionId?: string; message: string }
  | { type: "error" | "fatal"; message: string };

export type PendingRequest = Extract<GatewayMessage, { type: "serverRequest" }>;

export type TranscriptEntry = {
  id: string;
  role: "user" | "live" | "codex" | "system";
  text: string;
  time: number;
};

export type ActivityEntry = {
  id: string;
  kind: string;
  title: string;
  detail?: string;
  status: "running" | "done" | "failed";
  time: number;
};
