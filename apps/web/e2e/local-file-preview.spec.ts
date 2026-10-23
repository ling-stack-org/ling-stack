import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createChatProvider, createMockTeammate, cwd, type MockState } from "./support/mock-state";
import { openEngineeringChannel } from "./support/test-helpers";

const directory = "/Users/test/Documents/光明乳业";
const code = `${directory}/示例 代码.py`;
const archive = `${directory}/新版 工程包.zip`;
const timestamp = "2026-10-23T08:00:00.000Z";
const body = `[查看代码](<${code}:2>) · [下载工程包](<${archive}>) · [交付目录](<${directory}/>) · [missing](${directory}/missing.txt)`;
const evidence = resolve("../../output/playwright/local-files");

async function prepare(page: Page, desktop = true): Promise<void> {
  await page.addInitScript(({ directory, code, archive, desktop }) => {
    localStorage.setItem("ling-stack.locale", "zh-CN");
    localStorage.setItem("ling-stack.themePreference", "dark");
    if (!desktop) return;
    const calls: { operation: string; path: string }[] = [];
    Object.assign(window, { localFileTestCalls: calls });
    const inspect = async (request: { path: string; line?: number }) => {
      calls.push({ operation: "inspect", path: request.path });
      const path = request.path.replace(/\/$/u, "");
      if (path === code) return { path, name: "示例 代码.py", kind: "text", sizeBytes: 32, text: "# example\nprint('你好')\n", language: "python", line: request.line, truncated: false };
      if (path === archive) return { path, name: "新版 工程包.zip", kind: "unsupported", sizeBytes: 40, truncated: false };
      if (path === directory) return { path, name: "光明乳业", kind: "directory", sizeBytes: 0, truncated: false, entries: [{ path: code, name: "示例 代码.py", directory: false }, { path: archive, name: "新版 工程包.zip", directory: false }] };
      throw new Error("ENOENT");
    };
    Object.defineProperty(window, "lingDesktop", { configurable: true, value: {
      platform: "macos", daemonBaseUrl: "http://127.0.0.1:17891",
      appearance: { reportTheme() {} },
      computerUse: { reportLocale() {}, reportSelectedDeckOwner() {}, reportSelectedConversation() {}, reportHostLayout() {}, onSummaryChanged: () => () => {}, getAutoShowEnabled: async () => true },
      localFiles: { inspect, showMenu: async (request: { path: string }) => { calls.push({ operation: "menu", path: request.path }); return undefined; } },
    } });
  }, { directory, code, archive, desktop });
}

function installChannel(state: MockState): void {
  state.channelMessages = [{ id: "local-file-message", workspaceId: "workspace_default", channelId: "channel_engineering", kind: "ai_reply", intent: "discuss", authorType: "ai-teammate", authorId: "engineer", body, status: "ready", createdAt: timestamp, updatedAt: timestamp }];
}

test("local file links preview code and ZIPs, browse directories and offer native menus", async ({ page }) => {
  await prepare(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const state = createBaseState({ approvalStatus: "expired" });
  installChannel(state);
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);
  const feed = page.getByRole("region", { name: /频道动态|Channel activity/u });
  const link = feed.getByRole("button", { name: /查看代码/u });
  await expect(link).toHaveAttribute("title", `${code}:2`);
  expect(await page.evaluate(() => (window as unknown as { localFileTestCalls: unknown[] }).localFileTestCalls.length)).toBe(0);
  await link.focus();
  await link.press("Enter");
  const preview = page.locator(".local-file-preview");
  await expect(preview).toHaveAttribute("data-local-file-kind", "text");
  await expect(preview.locator(".right-dock-code-line.focused")).toContainText("print('你好')");
  await expect(preview).toBeInViewport({ ratio: 0.5 });
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: `${evidence}/code-dark.png`, animations: "disabled" });

  await feed.getByRole("button", { name: /下载工程包/u }).click();
  await expect(preview).toHaveAttribute("data-local-file-kind", "unsupported");
  await expect(preview).toContainText("暂不支持预览此类文件");
  await preview.locator(".local-file-preview-toolbar").getByRole("button", { name: "打开方式" }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { localFileTestCalls: { operation: string; path: string }[] }).localFileTestCalls.at(-1))).toEqual({ operation: "menu", path: archive });
  await page.screenshot({ path: `${evidence}/zip-dark.png`, animations: "disabled" });

  await feed.getByRole("button", { name: /交付目录/u }).click();
  await expect(preview).toHaveAttribute("data-local-file-kind", "directory");
  await preview.getByRole("button", { name: "示例 代码.py", exact: true }).click();
  await expect(preview).toHaveAttribute("data-local-file-viewer-path", code);
  await expect(preview).toHaveAttribute("data-local-file-kind", "text");
  await feed.getByRole("button", { name: /下载工程包/u }).click({ button: "right" });
  await expect.poll(() => page.evaluate(() => (window as unknown as { localFileTestCalls: { operation: string }[] }).localFileTestCalls.at(-1)?.operation)).toBe("menu");
  await feed.getByRole("button", { name: /missing/u }).click();
  await expect(feed.getByRole("alert")).toContainText("无法预览此文件");
  expect(errors).toEqual([]);
});

test("a delayed earlier click cannot replace the latest file selection", async ({ page }) => {
  await prepare(page);
  const state = createBaseState({ approvalStatus: "expired" });
  installChannel(state);
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);
  await page.evaluate((code) => {
    const api = window.lingDesktop!.localFiles!;
    const inspect = api.inspect;
    api.inspect = ((request) => request.path === code ? new Promise((resolve) => {
      Object.assign(window, { resolveEarlierFile: async () => resolve(await inspect(request)) });
    }) : inspect(request)) as typeof inspect;
  }, code);
  await page.getByRole("button", { name: /查看代码/u }).click();
  await page.getByRole("button", { name: /下载工程包/u }).click();
  const preview = page.locator(".local-file-preview");
  await expect(preview).toHaveAttribute("data-local-file-kind", "unsupported");
  await page.evaluate(async () => (window as unknown as { resolveEarlierFile: () => Promise<void> }).resolveEarlierFile());
  await expect(preview).toHaveAttribute("data-local-file-viewer-path", archive);
});

test("ordinary browser model paths remain display-only", async ({ page }) => {
  await prepare(page, false);
  const state = createBaseState({ approvalStatus: "expired" });
  installChannel(state);
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);
  await expect(page.locator("span.message-local-file-link").filter({ hasText: "查看代码" })).toBeVisible();
  await expect(page.locator("button.message-local-file-link")).toHaveCount(0);
});

test("normal conversation file links open its own right drawer", async ({ page }) => {
  await prepare(page);
  const state = createBaseState({ approvalStatus: "expired" });
  const threadId = "thread_local_file_preview";
  const runId = "run_local_file_preview";
  const turnId = "turn_local_file_preview";
  state.providers = [createChatProvider({ id: "provider_files", displayName: "Local Files", model: "gpt-5.5" })];
  state.threads = [{ id: threadId, workspaceId: "workspace_default", kind: "conversation", title: "File preview conversation", status: "succeeded", lastRunId: runId, createdAt: timestamp, updatedAt: timestamp }];
  state.turns = [{ id: turnId, workspaceId: "workspace_default", threadId, kind: "initial_request", status: "succeeded", title: "File preview conversation", userInstruction: "Inspect these local files", lastRunId: runId, createdByActor: "local-user", createdAt: timestamp, updatedAt: timestamp, completedAt: timestamp }];
  state.turnRunLinks = [{ turnId, runId, attemptNumber: 1, role: "primary", createdAt: timestamp }];
  state.runs.unshift({ id: runId, status: "succeeded", cwd, taskId: "task_files", providerPresetId: "provider_files", providerName: "local-relay", providerModel: "gpt-5.5", taskSnapshot: { id: "task_files", title: "Files" }, providerSnapshot: {}, requestSnapshot: { cwd }, eventLogPath: `.ling-stack/sessions/${runId}.jsonl`, threadId, turnId, createdAt: timestamp, startedAt: timestamp, updatedAt: timestamp, endedAt: timestamp });
  state.eventsByRun[runId] = [{ id: "event_files", runId, seq: 1, ts: timestamp, type: "assistant_text_delta", data: { text: body } }];
  await mockDaemon(page, state);
  await page.goto("/");
  await page.locator(".sidebar-recent-row").filter({ hasText: "File preview conversation" }).click();
  await page.getByRole("button", { name: /下载工程包/u }).click();
  await expect(page.locator(".local-file-preview")).toHaveAttribute("data-local-file-kind", "unsupported");
});

test("teammate private file links open its own right drawer", async ({ page }) => {
  await prepare(page);
  const state = createBaseState({ approvalStatus: "expired" });
  const teammateId = "teammate_local_files";
  state.providers = [createChatProvider({ id: "provider_files", displayName: "Local Files", model: "gpt-5.5" })];
  state.aiTeammates = [createMockTeammate({ id: teammateId, displayName: "文件预览队友", providerPresetId: "provider_files" })];
  state.teammateDirectMessages = [{ id: "message_files", workspaceId: "workspace_default", threadId: `tdthread_${teammateId}`, teammateId, authorType: "ai-teammate", authorId: teammateId, body, attachmentIds: [], linkPreviewIds: [], fileRefs: [], status: "ready", createdAt: timestamp, updatedAt: timestamp }];
  await mockDaemon(page, state);
  await page.goto("/");
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "文件预览队友" }).click();
  await page.getByRole("button", { name: /下载工程包/u }).click();
  await expect(page.locator(".local-file-preview")).toHaveAttribute("data-local-file-kind", "unsupported");
});
