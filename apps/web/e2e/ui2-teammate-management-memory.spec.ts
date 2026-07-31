import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon, type MockState } from "./support/mock-daemon";
import { createBaseState, createMockTeammate } from "./support/mock-state";

const teammateId = "teammate_memory_projection";
const teammateName = "Memory Projection Reviewer";
const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/features/ai-teammate-management-memory/",
  import.meta.url,
));

test("memory leaves teammate Settings while the current private-conversation projection remains available", async ({ page }) => {
  await prepareSurface(page, { theme: "light", width: 1440, height: 960, locale: "en-US" });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createMemoryState();
  await mockDaemon(page, state);
  await page.goto("/");

  const dock = await openPrivateDock(page, teammateName, englishLabels);
  const context = page.getByLabel("Conversation context");
  await expect(context).toBeVisible();
  await expect(context.getByText("Release review preference", { exact: true })).toBeVisible();
  await expect(context).toContainText("Prefer a concise release checklist before deployment.");

  await dock.getByRole("button", { name: "Settings" }).click();
  const settings = page.getByLabel("Settings sections");
  await expect(settings).toBeVisible();
  await expect(settings.getByRole("button", { name: /^Memory/u })).toHaveCount(0);
  await expect(page.locator("[data-ui2-teammate-memory]")).toHaveCount(0);
  await expect(settings.getByRole("button", { name: "Tools and permissions", exact: true })).toBeVisible();
  await captureEvidence(page, "1440x960-ling-light-memory-settings-removed.png");
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("Chinese dark protected teammate also keeps memory out of Settings without creating an empty page", async ({ page }) => {
  await prepareSurface(page, { theme: "dark", width: 1280, height: 800, locale: "zh-CN", reducedMotion: "reduce" });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createMemoryState("Ling Agent", "ling_agent", true);
  await mockDaemon(page, state);
  await page.goto("/");

  const dock = await openPrivateDock(page, "Ling Agent", chineseLabels);
  await expect(page.getByLabel("对话上下文")).toContainText("Release review preference");
  await dock.getByRole("button", { name: "设置" }).click();
  const settings = page.getByLabel("设置分组");
  await expect(settings.getByRole("button", { name: /^记忆/u })).toHaveCount(0);
  await expect(settings.getByRole("button")).toHaveCount(3);
  await expect(page.locator("[data-ui2-teammate-memory]")).toHaveCount(0);
  await captureEvidence(page, "1280x800-ling-dark-protected-memory-settings-removed-zh-CN.png");
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

function createMemoryState(
  displayName: string = teammateName,
  id: string = teammateId,
  protectedProfile = false,
): MockState {
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [createMockTeammate({
    id,
    displayName,
    kind: protectedProfile ? "system_teammate" : "ai_teammate",
    systemRole: protectedProfile ? "ling_agent" : undefined,
    protectedProfile,
  })];
  state.memoryObjects = [{
    id: "memory_release_preference",
    workspaceId: "workspace_default",
    scopeType: "teammate",
    ownerId: id,
    title: "Release review preference",
    body: "Prefer a concise release checklist before deployment.",
    tags: ["release"],
    sourceRefs: [{ type: "message", id: "message_release", label: "Private release conversation" }],
    reviewState: "active",
    enabled: true,
    sensitivity: "normal",
    verifyBeforeUse: false,
    createdAt: "2026-07-21T00:00:00.000Z",
    updatedAt: "2026-07-21T00:00:00.000Z",
  }];
  state.usedMemoryEvents = [{
    id: "used_memory_release",
    workspaceId: "workspace_default",
    memoryIds: ["memory_release_preference"],
    intent: "private-chat",
    recallQuery: "release checklist",
    teammateId: id,
    responseId: "response_release",
    policyVersion: "memory-policy-v1",
    createdAt: "2026-07-21T00:05:00.000Z",
  }];
  return state;
}

const englishLabels = {
  context: "Context",
  details: "Show details",
  dock: "Private chat workspace dock",
} as const;

const chineseLabels = {
  context: "上下文",
  details: "显示详情",
  dock: "私聊工作区面板",
} as const;

async function openPrivateDock(
  page: Page,
  targetTeammateName: string,
  labels: typeof englishLabels | typeof chineseLabels,
): Promise<Locator> {
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: targetTeammateName }).click();
  const header = page.locator("[data-ui2-teammate-chat-header]");
  await expect(header).toBeVisible();
  await header.getByRole("button", { name: labels.details }).click();
  const dock = page.getByLabel(labels.dock);
  await expect(dock).toBeVisible();
  await dock.getByRole("button", { name: labels.context, exact: true }).click();
  return dock;
}

async function prepareSurface(
  page: Page,
  options: {
    readonly theme: "dark" | "light";
    readonly width: number;
    readonly height: number;
    readonly locale: "en-US" | "zh-CN";
    readonly reducedMotion?: "no-preference" | "reduce";
  },
): Promise<void> {
  await page.setViewportSize({ width: options.width, height: options.height });
  await page.emulateMedia({ colorScheme: options.theme, reducedMotion: options.reducedMotion ?? "no-preference" });
  await page.addInitScript(({ locale, theme }) => {
    const themeId = `ling-${theme}`;
    const selection = { mode: "fixed", themeId };
    localStorage.setItem("ling-stack.locale", locale);
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapPreference", theme);
  }, { locale: options.locale, theme: options.theme });
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    clientHeight: document.documentElement.clientHeight,
    scrollHeight: document.documentElement.scrollHeight,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
  expect(overflow.scrollHeight).toBeLessThanOrEqual(overflow.clientHeight + 1);
}

async function captureEvidence(page: Page, fileName: string): Promise<void> {
  if (process.env.LING_CAPTURE_UI2_EVIDENCE !== "1") return;
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({ animations: "disabled", path: `${evidenceDirectory}${fileName}` });
}

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}
