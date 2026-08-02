import { expect, test } from "@playwright/test";

test.beforeEach(async ({ context }) => {
  await context.grantPermissions(["microphone"], { origin: "https://127.0.0.1:3443" });
});

test("logs in, dispatches a text task, and starts a WebRTC session", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /说出来/ })).toBeVisible();
  await page.getByLabel("访问密码").fill("integration-password");
  await page.getByRole("button", { name: "进入语音工作区" }).click();

  await expect(page.getByText("App-server 已连接")).toBeVisible();
  await page.getByPlaceholder("输入任务，直接交给 Codex…").fill("运行测试并告诉我结果");
  await page.getByRole("button", { name: "发送" }).click();

  await expect(page.getByText("Codex 已完成测试任务。")).toBeVisible();
  await expect(page.getByText("npm test")).toBeVisible();
  await expect(page.getByText("3 tests passed")).toBeVisible();

  await page.getByRole("button", { name: "开始语音" }).click();
  await expect(page.getByText("正在连接 GPT-Live…")).toBeVisible({ timeout: 12_000 });
});
