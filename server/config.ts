import { z } from "zod";

export const permissionModes = [
  "read-only",
  "workspace-write",
  "full-access",
  "yolo",
] as const;

export type PermissionMode = (typeof permissionModes)[number];

export const reasoningEfforts = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export type CodexReasoningEffort = (typeof reasoningEfforts)[number];

const envSchema = z.object({
  APP_HOST: z.string().default("0.0.0.0"),
  APP_PORT: z.coerce.number().int().positive().max(65535).default(3000),
  APP_HOST_IP: z.string().min(1).default("127.0.0.1"),
  APP_PASSWORD: z.string().min(12, "APP_PASSWORD must contain at least 12 characters"),
  SESSION_TTL_HOURS: z.coerce.number().positive().max(168).default(12),
  CERT_DIR: z.string().default("/app/certs"),
  CODEX_APP_SERVER_URL: z.string().url().default("ws://codex-app-server:4222"),
  APP_SERVER_TOKEN: z.string().min(24, "APP_SERVER_TOKEN must contain at least 24 characters"),
  CODEX_WORKSPACE: z.string().default("/workspace"),
  CODEX_PERMISSION_MODE: z.enum(permissionModes).default("workspace-write"),
  CODEX_MODEL: optionalString(),
  CODEX_REASONING_EFFORT: optionalReasoningEffort(),
  REALTIME_MODEL: z.string().default("gpt-live-1-boulder-alpha"),
  REALTIME_VOICE: optionalString(),
  REALTIME_PROMPT: optionalString(),
  ALLOWED_ORIGINS: optionalString(),
  NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
});

function optionalString() {
  return z.preprocess(
    (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
    z.string().optional(),
  );
}

function optionalReasoningEffort() {
  return z.preprocess(
    (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
    z.enum(reasoningEfforts).optional(),
  );
}

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.parse(env);
  const allowedOrigins = new Set(
    (parsed.ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );

  return {
    host: parsed.APP_HOST,
    port: parsed.APP_PORT,
    hostIp: parsed.APP_HOST_IP,
    password: parsed.APP_PASSWORD,
    sessionTtlMs: parsed.SESSION_TTL_HOURS * 60 * 60 * 1000,
    certDir: parsed.CERT_DIR,
    appServerUrl: parsed.CODEX_APP_SERVER_URL,
    appServerToken: parsed.APP_SERVER_TOKEN,
    workspace: parsed.CODEX_WORKSPACE,
    permissionMode: parsed.CODEX_PERMISSION_MODE,
    codexModel: parsed.CODEX_MODEL,
    codexReasoningEffort: parsed.CODEX_REASONING_EFFORT,
    realtimeModel: parsed.REALTIME_MODEL,
    realtimeVoice: parsed.REALTIME_VOICE,
    realtimePrompt: parsed.REALTIME_PROMPT,
    allowedOrigins,
    nodeEnv: parsed.NODE_ENV,
  };
}

export function threadConfigOverrides(reasoningEffort?: CodexReasoningEffort) {
  return reasoningEffort
    ? { model_reasoning_effort: reasoningEffort }
    : undefined;
}

export function threadPermissionParams(mode: PermissionMode) {
  switch (mode) {
    case "read-only":
      return { sandbox: "read-only", approvalPolicy: "on-request" } as const;
    case "workspace-write":
      return { sandbox: "workspace-write", approvalPolicy: "on-request" } as const;
    case "full-access":
      return { sandbox: "danger-full-access", approvalPolicy: "on-request" } as const;
    case "yolo":
      return { sandbox: "danger-full-access", approvalPolicy: "never" } as const;
  }
}
