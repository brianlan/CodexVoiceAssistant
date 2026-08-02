import { describe, expect, it } from "vitest";
import { loadConfig, threadConfigOverrides, threadPermissionParams } from "../server/config.js";

const baseEnv = {
  APP_PASSWORD: "a-strong-test-password",
  APP_SERVER_TOKEN: "a-very-long-test-app-server-token",
};

describe("configuration", () => {
  it("defaults to workspace-write and the V3 GPT-Live model", () => {
    const config = loadConfig(baseEnv);
    expect(config.permissionMode).toBe("workspace-write");
    expect(config.realtimeModel).toBe("gpt-live-1-boulder-alpha");
  });

  it("maps the explicit YOLO mode to danger-full-access without approvals", () => {
    expect(threadPermissionParams("yolo")).toEqual({
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    });
  });

  it("keeps approvals enabled in full-access mode", () => {
    expect(threadPermissionParams("full-access")).toEqual({
      sandbox: "danger-full-access",
      approvalPolicy: "on-request",
    });
  });

  it("treats blank optional model, effort, and voice variables as unset", () => {
    const config = loadConfig({
      ...baseEnv,
      CODEX_MODEL: "",
      CODEX_REASONING_EFFORT: "",
      REALTIME_VOICE: "",
    });
    expect(config.codexModel).toBeUndefined();
    expect(config.codexReasoningEffort).toBeUndefined();
    expect(config.realtimeVoice).toBeUndefined();
  });

  it("maps xhigh to the app-server thread config override", () => {
    const config = loadConfig({ ...baseEnv, CODEX_REASONING_EFFORT: "xhigh" });
    expect(config.codexReasoningEffort).toBe("xhigh");
    expect(threadConfigOverrides(config.codexReasoningEffort)).toEqual({
      model_reasoning_effort: "xhigh",
    });
  });
});
