import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createMockTeammate, isRecord, type MockState } from "./support/mock-state";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/settings/archived-items/",
  import.meta.url,
));

test("Archived Items keeps initial loading and refresh failure scoped while preserving authoritative rows", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "light", "en-US", 1440, 960);
  const state = createBaseState({ approvalStatus: "pending" });
  state.threads = Array.from({ length: 55 }, (_, index) => createArchivedConversation(index));
  state.aiTeammates = [];
  await mockDaemon(page, state);

  const listGate = deferred();
  let listMode: "hold" | "ok" | "fail" = "hold";
  await page.route("**/threads?**", async (route) => {
    if (listMode === "hold") {
      await listGate.promise;
      await route.fallback();
      return;
    }
    if (listMode === "fail") {
      await route.fulfill({ status: 503, json: { message: "Synthetic archived list failure" } });
      return;
    }
    await route.fallback();
  });

  await page.goto("/");
  const panel = await openArchivedItems(page);
  await expect(panel.locator(".archived-item-skeleton")).toHaveCount(4);
  await expect(panel.locator(".archived-items-search-input")).toHaveClass(/ling-ui-input/);

  listMode = "ok";
  listGate.resolve();
  await expect(panel.locator(".archived-item-row")).toHaveCount(55);
  await expect(panel.locator(".archived-item-row").first()).toHaveClass(/ling-ui-data-row/);
  await expect(panel.getByRole("button", { name: "Restore", exact: true }).first()).toHaveAttribute("data-variant", "secondary");
  await expect(panel.getByRole("button", { name: "Delete conversation" }).first()).toHaveAttribute("data-variant", "danger");
  await expect(panel.locator(".secondary-button, .ghost-icon-button, .compact-button, .inline-error")).toHaveCount(0);
  const metrics = await listMetrics(panel);
  expect(metrics.overflowY).toBe("auto");
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight + 2);
  await expectNoHorizontalOverflow(panel);
  await expectNoPageOverflow(page);
  await captureEvidence(page, "1440x960-ling-light-conversations-loaded.png");

  listMode = "fail";
  await page.getByLabel("Settings sections").getByRole("button", { name: /User profile/ }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: /Archived items/ }).click();
  await expect(panel.getByText("Archived items could not be loaded. Review details and try again.")).toBeVisible();
  await expect(panel.locator(".archived-item-row")).toHaveCount(55);
  await panel.getByText("Error details", { exact: true }).click();
  await expect(panel.getByText("Synthetic archived list failure", { exact: true })).toBeVisible();
  expect(runtimeErrors).toEqual([]);
});

test("Archived Items keeps dense scrolling, scoped search, keyboard tabs, and category memory in dark mode", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "dark", "en-US", 1280, 800, "reduce");
  const state = createBaseState({ approvalStatus: "pending" });
  state.threads = Array.from({ length: 55 }, (_, index) => createArchivedConversation(index));
  state.aiTeammates = [createMockTeammate({ id: "archived_teammate", displayName: "Archived teammate", hidden: true })];
  state.channels.push(createArchivedChannel("archived_channel", "Archived channel"));
  state.channelBranches = [createArchivedBranch("archived_branch", "archived_channel", "Archived branch")];
  await mockDaemon(page, state);
  await page.goto("/");
  const panel = await openArchivedItems(page);

  await expect(panel.locator(".archived-item-row")).toHaveCount(55);
  await captureEvidence(page, "1280x800-ling-dark-dense-scroll.png");
  const search = panel.getByRole("searchbox", { name: "Search archived items" });
  await search.fill("not present anywhere");
  await expect(panel.getByText("No matching archived items", { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Clear search" })).toHaveJSProperty("offsetWidth", 32);
  await captureEvidence(page, "1280x800-ling-dark-no-result.png");
  await search.press("Escape");
  await expect(search).toHaveValue("");

  const conversationsTab = panel.getByRole("tab", { name: /Conversations 55/ });
  await conversationsTab.focus();
  await page.keyboard.press("ArrowRight");
  await expect(panel.getByRole("tab", { name: /AI Teammates 1/ })).toHaveAttribute("aria-selected", "true");
  await search.fill("Archived");
  await panel.getByRole("tab", { name: /Branches 1/ }).click();
  await expect(search).toHaveValue("");
  await page.reload();
  const reloadedPanel = await openArchivedItems(page);
  await expect(reloadedPanel.getByRole("tab", { name: /Branches 1/ })).toHaveAttribute("aria-selected", "true");
  await expectNoHorizontalOverflow(reloadedPanel);
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("conversation delete Dialog owns cancel, busy, Escape, success, and fallback focus", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "light", "en-US", 1440, 960);
  const state = createBaseState({ approvalStatus: "pending" });
  const conversation = createArchivedConversation(0);
  state.threads = [conversation];
  state.aiTeammates = [];
  state.threadHardDeleteDelayMs = 400;
  await mockDaemon(page, state);
  await page.goto("/");
  const panel = await openArchivedItems(page);

  const row = archivedRow(panel, conversation.title);
  const trigger = row.getByRole("button", { name: "Delete conversation" });
  const stableTrigger = row.locator(".archived-delete-action");
  await trigger.click();
  let dialog = page.getByRole("dialog", { name: `Delete conversation ${conversation.title}?` });
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await expect(dialog).toContainText("Historical runs remain but will no longer be linked");
  await captureEvidence(page, "1440x960-ling-light-conversation-delete.png");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.click();
  dialog = page.getByRole("dialog", { name: `Delete conversation ${conversation.title}?` });
  const confirm = dialog.getByRole("button", { name: "Delete conversation", exact: true });
  await confirm.click();
  await expect(dialog.locator('button[data-variant="danger"]')).toHaveAttribute("aria-busy", "true");
  await expect(stableTrigger).toHaveAttribute("data-loading", "true");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveCount(0, { timeout: 5_000 });
  await expect(row).toHaveCount(0);
  await expect(panel.getByRole("searchbox", { name: "Search archived items" })).toBeFocused();
  expect(runtimeErrors).toEqual([]);
});

test("teammate delete failure stays in the Chinese dark Dialog with folded raw details", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "dark", "zh-CN", 1280, 800, "reduce");
  const state = createBaseState({ approvalStatus: "pending" });
  state.threads = [];
  state.aiTeammates = [createMockTeammate({
    id: "archived_teammate_failure",
    displayName: "归档队友",
    hidden: true,
    status: "active",
  })];
  await mockDaemon(page, state);
  await page.route("**/teammates/archived_teammate_failure/hard-delete?**", async (route) => {
    await route.fulfill({ status: 503, json: { message: "模拟删除失败，请重试。" } });
  });
  await page.goto("/");
  const panel = await openArchivedItems(page);
  await panel.getByRole("tab", { name: /AI 队友 1/ }).click();

  const row = archivedRow(panel, "归档队友");
  const trigger = row.getByRole("button", { name: "删除 AI 队友" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "永久删除 AI 队友“归档队友”？" });
  await dialog.getByRole("button", { name: "删除 AI 队友", exact: true }).click();
  await expect(dialog.getByText("无法删除该归档项目。请查看详情后重试。", { exact: true })).toBeVisible();
  await expect(dialog.getByText("模拟删除失败，请重试。", { exact: true })).toBeHidden();
  await captureEvidence(page, "1280x800-ling-dark-teammate-delete-failure-zh-CN.png");
  await dialog.getByText("错误详情", { exact: true }).click();
  await expect(dialog.getByText("模拟删除失败，请重试。", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(row).toBeVisible();
  expect(runtimeErrors).toEqual([]);
});

test("Branch Restore both and channel permanent delete retain their existing business effects", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "dark", "en-US", 1280, 800);
  const state = createBaseState({ approvalStatus: "pending" });
  state.threads = [];
  state.aiTeammates = [];
  state.channels = [
    createArchivedChannel("archived_parent", "Archived parent"),
    createArchivedChannel("channel_delete", "Delete-ready channel"),
  ];
  state.channelBranches = [createArchivedBranch("branch_restore_both", "archived_parent", "Restore both branch")];
  await mockDaemon(page, state);
  await page.goto("/");
  const panel = await openArchivedItems(page);

  await panel.getByRole("tab", { name: /Branches 1/ }).click();
  const branchRow = archivedRow(panel, "Archived parent / Restore both branch");
  await expect(branchRow.getByRole("button", { name: "Restore both" })).toBeVisible();
  await captureEvidence(page, "1280x800-ling-dark-branch-restore-both.png");
  await branchRow.getByRole("button", { name: "Restore both" }).click();
  await expect.poll(() => recordStatus(state.channels, "archived_parent")).toBe("active");
  await expect.poll(() => recordStatus(state.channelBranches, "branch_restore_both")).toBe("active");
  await expect(branchRow).toHaveCount(0);

  await panel.getByRole("tab", { name: /Channels 1/ }).click();
  const channelRow = archivedRow(panel, "Delete-ready channel");
  await channelRow.getByRole("button", { name: "Delete channel" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete channel Delete-ready channel?" });
  await expect(dialog).toContainText("This cannot be undone");
  await dialog.getByRole("button", { name: "Delete channel", exact: true }).click();
  await expect.poll(() => recordExists(state.channels, "channel_delete")).toBe(false);
  await expect(channelRow).toHaveCount(0);
  await expectNoHorizontalOverflow(panel);
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

async function prepareSurface(
  page: Page,
  theme: "dark" | "light",
  locale: "en-US" | "zh-CN",
  width: number,
  height: number,
  reducedMotion: "no-preference" | "reduce" = "no-preference",
): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.emulateMedia({ colorScheme: theme, reducedMotion });
  await page.addInitScript(({ initialLocale, initialTheme }) => {
    const themeId = initialTheme === "dark" ? "ling-dark" : "ling-light";
    const selection = { mode: "fixed", themeId };
    localStorage.setItem("ling-stack.locale", initialLocale);
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapPreference", initialTheme);
  }, { initialLocale: locale, initialTheme: theme });
}

async function openArchivedItems(page: Page): Promise<Locator> {
  await page.getByLabel(/Ling Stack navigation/).getByRole("button", { name: /Settings|设置/ }).click();
  await page.getByLabel(/Settings sections|设置分组/).getByRole("button", { name: /Archived items|已归档项目/ }).click();
  const panel = page.locator("[data-ui2-archived-items]");
  await expect(panel).toBeVisible();
  return panel;
}

function archivedRow(panel: Locator, name: string): Locator {
  return panel.locator(".archived-item-row").filter({ hasText: name });
}

function createArchivedConversation(index: number): MockState["threads"][number] {
  const timestamp = new Date(Date.UTC(2026, 4, 26 + index, 8, 0, 0)).toISOString();
  const title = index === 0 ? "Archived conversation" : `Archived conversation ${index + 1}`;
  return {
    id: `archived_conversation_${index}`,
    workspaceId: "workspace_default",
    kind: "conversation",
    teammateId: "ling_agent",
    title,
    objective: title,
    status: "archived",
    conversationMode: { mode: "default" },
    createdAt: timestamp,
    updatedAt: timestamp,
    archivedAt: timestamp,
  };
}

function createArchivedChannel(id: string, name: string): Record<string, unknown> {
  return {
    id,
    workspaceId: "workspace_default",
    name,
    status: "archived",
    boundPath: "/tmp/ling-archived",
    autoReplyMode: "mentions_only",
    allowedTools: ["read"],
    runtimePolicy: {},
    createdAt: "2026-07-01T08:00:00.000Z",
    updatedAt: "2026-07-01T08:00:00.000Z",
  };
}

function createArchivedBranch(id: string, channelId: string, name: string): Record<string, unknown> {
  return {
    id,
    workspaceId: "workspace_default",
    channelId,
    name,
    status: "archived",
    createdAt: "2026-07-01T08:00:00.000Z",
    updatedAt: "2026-07-01T08:00:00.000Z",
    archivedAt: "2026-07-01T08:00:00.000Z",
  };
}

function recordStatus(records: readonly unknown[], id: string): unknown {
  const record = records.find((item) => isRecord(item) && item.id === id);
  return isRecord(record) ? record.status : undefined;
}

function recordExists(records: readonly unknown[], id: string): boolean {
  return records.some((item) => isRecord(item) && item.id === id);
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((next) => { resolve = next; });
  return { promise, resolve };
}

async function listMetrics(panel: Locator): Promise<{ clientHeight: number; overflowY: string; scrollHeight: number }> {
  return await panel.locator(".archived-item-list").evaluate((element) => ({
    clientHeight: element.clientHeight,
    overflowY: getComputedStyle(element).overflowY,
    scrollHeight: element.scrollHeight,
  }));
}

async function expectNoHorizontalOverflow(locator: Locator): Promise<void> {
  const metrics = await locator.evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
}

async function captureEvidence(page: Page, filename: string): Promise<void> {
  if (process.env.LING_CAPTURE_UI2_EVIDENCE !== "1") return;
  await mkdir(evidenceDirectory, { recursive: true });
  await page.locator(".settings-layout").screenshot({ animations: "disabled", path: `${evidenceDirectory}${filename}` });
}

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}
