import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import type { ManagedWorktreeActionRequest, ManagedWorktreeListResponse } from "@ling-stack/contracts";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";

const evidenceDirectory = process.env.LING_WORKTREE_EVIDENCE_DIR;

function snapshot(): ManagedWorktreeListResponse {
  return {
    cwd: "/tmp/ling-stack-workspace", policy: { fetchBeforeCreate: false },
    defaultRootDir: "/tmp/ling-stack-workspace/.ling-stack/worktrees",
    effectiveRootDir: "/tmp/ling-stack-workspace/.ling-stack/worktrees", limitReached: false,
    entries: [
      { ownerKind: "channel", ownerId: "channel_engineering", ownerName: "Engineering", path: "/tmp/ling-stack-workspace/.ling-stack/worktrees/channels/channel_engineering", branchName: "ling/channel-channel_engineering", status: "ready", isDirty: false, inUse: false },
      { ownerKind: "teammate", ownerId: "private_dirty", ownerName: "Research notes", path: "/tmp/ling-stack-workspace/.ling-stack/worktrees/teammates/research/thread_with_a_long_name", branchName: "ling/teammate-research-thread", status: "ready", isDirty: true, inUse: false },
      { ownerKind: "channel", ownerId: "channel_active", ownerName: "Active project", path: "/tmp/ling-stack-workspace/.ling-stack/worktrees/channels/channel_active", status: "ready", isDirty: false, inUse: true },
    ],
  };
}

async function prepare(page: Page, locale = "en-US", theme = "light", width = 1440, height = 960) {
  await page.setViewportSize({ width, height });
  await page.addInitScript(({ locale, theme }) => {
    localStorage.setItem("ling-stack.locale", locale);
    const selection = JSON.stringify({ mode: "fixed", themeId: `ling-${theme}` });
    for (const key of ["ling-stack.themeSelection", "ling-stack.themeBootstrapSelection"]) localStorage.setItem(key, selection);
    for (const key of ["ling-stack.themePreference", "ling-stack.themeBootstrapPreference"]) localStorage.setItem(key, theme);
  }, { locale, theme });
  const runtimeErrors: string[] = [];
  page.on("pageerror", error => runtimeErrors.push(error.message));
  page.on("console", message => { if (message.type() === "error" && !message.text().includes("Failed to load resource")) runtimeErrors.push(message.text()); });
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.route(/\/notifications(?:\/stream)?(?:\?.*)?$/u, route => route.fulfill({ json: { notifications: [] } }));
  let current = snapshot();
  let loadError = false;
  let cleanupError = false;
  const actions: ManagedWorktreeActionRequest[] = [];
  await page.route(/\/worktrees(?:\?.*)?$/u, async route => {
    await route.fulfill(loadError ? { status: 503, json: { message: "Worktree list temporarily unavailable" } } : { json: current });
  });
  await page.route(/\/worktrees\/actions(?:\?.*)?$/u, async route => {
    const input = route.request().postDataJSON() as ManagedWorktreeActionRequest;
    actions.push(input);
    if (input.action === "cleanup" && cleanupError) {
      await route.fulfill({ status: 409, json: { error: "worktree_dirty", message: "Worktree has unsaved changes" } }); return;
    }
    if (input.action === "cleanup") {
      const owner = current.entries.find(entry => entry.ownerId === input.ownerId)!;
      current = { ...current, entries: current.entries.map(entry => entry.ownerId === input.ownerId ? { ...entry, status: "not_created" } : entry),
        snapshots: [...current.snapshots ?? [], { id: `snapshot_${input.ownerId}`, ownerKind: owner.ownerKind, ownerId: owner.ownerId, ownerName: owner.ownerName,
          originalPath: owner.path, snapshotPath: `/tmp/ling-recovery/${owner.ownerId}`, branchName: owner.branchName ?? "ling/test", createdAt: "2026-11-17T00:00:00Z", state: "archived" }] };
    }
    if (input.action === "restore") current = { ...current, entries: current.entries.map(entry => entry.ownerId === input.ownerId ? { ...entry, status: "ready" } : entry), snapshots: current.snapshots?.filter(item => item.id !== input.snapshotId) };
    if (input.action === "pin" || input.action === "unpin") current = { ...current, entries: current.entries.map(entry => entry.ownerId === input.ownerId ? { ...entry, pinned: input.action === "pin", kept: input.action === "pin" } : entry) };
    if (input.action === "initialize") current = { ...current, entries: current.entries.map(entry => entry.ownerId === input.ownerId ? { ...entry, status: "ready", initialization: { status: "succeeded", output: "Setup complete" } } : entry) };
    await route.fulfill({ json: current });
  });
  await page.route(/\/workspace-settings(?:\?.*)?$/u, async route => {
    const input = route.request().method() === "PATCH" ? route.request().postDataJSON() as { worktreePolicy?: ManagedWorktreeListResponse["policy"] } : undefined;
    if (!input?.worktreePolicy) { await route.fallback(); return; }
    current = { ...current, policy: input.worktreePolicy, effectiveRootDir: input.worktreePolicy.rootDir ? `${input.worktreePolicy.rootDir}/workspace_fixture` : current.defaultRootDir };
    await route.fulfill({ json: { cwd: current.cwd, settings: { ...createBaseState({ approvalStatus: "expired" }).workspaceSettings, worktreePolicy: current.policy } } });
  });
  return { actions, runtimeErrors, get current() { return current; }, set current(next) { current = next; },
    set loadError(value: boolean) { loadError = value; }, set cleanupError(value: boolean) { cleanupError = value; } };
}

async function open(page: Page, chinese = false) {
  await page.goto("/");
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: chinese ? "设置" : "Settings", exact: true }).click();
  await page.locator('[data-settings-section="worktrees"]').click();
  return page.locator("[data-worktree-settings]");
}

async function screenshot(page: Page, name: string) {
  if (!evidenceDirectory) return;
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({ path: `${evidenceDirectory}/${name}.png` });
}

async function expectNoOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await page.locator(".settings-worktrees-save-row .ling-ui-button-label").evaluate(label => label.scrollWidth <= label.clientWidth)).toBe(true);
  expect(await page.locator("[data-worktree-settings]").evaluate(panel => {
    const background = getComputedStyle(panel).backgroundColor;
    return background !== "transparent" && !background.startsWith("rgba(") && !background.includes("/");
  })).toBe(true);
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
}

test("worktree settings persist root and fetch policy, open paths, and survive navigation", async ({ page }) => {
  const harness = await prepare(page);
  const surface = await open(page);
  await expect(surface.getByRole("heading", { name: "Worktrees", exact: true })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/");
  await expect(page).toHaveTitle(/Ling/);
  const save = surface.getByRole("button", { name: "Save", exact: true });
  await expect(save).toBeDisabled();
  await surface.getByRole("textbox", { name: "Worktree root directory" }).fill("/tmp/Ling worktrees");
  await surface.getByRole("switch", { name: "Fetch upstream before creating worktrees" }).click();
  await save.click();
  await expect.poll(() => harness.current.policy).toMatchObject({ rootDir: "/tmp/Ling worktrees", fetchBeforeCreate: true });
  await expect(surface.getByText("/tmp/Ling worktrees/workspace_fixture", { exact: true })).toBeVisible();
  await expect(save).toBeDisabled();
  await surface.locator('[aria-labelledby="managed-worktrees-heading"] li').filter({ hasText: "Engineering" }).getByRole("button", { name: "Open path" }).click();
  expect(harness.actions).toEqual([{ ownerKind: "channel", ownerId: "channel_engineering", action: "open" }]);
  await page.locator('[data-settings-section="personal-profile"]').click();
  await page.locator('[data-settings-section="worktrees"]').click();
  await expect(surface.getByRole("textbox", { name: "Worktree root directory" })).toHaveValue("/tmp/Ling worktrees");
  await expect(surface.getByRole("switch", { name: "Fetch upstream before creating worktrees" })).toBeChecked();
  await expectNoOverflow(page);
  expect(harness.runtimeErrors).toEqual([]);
  await screenshot(page, "desktop-light");
  await page.locator('[data-settings-section="interface-preferences"]').click();
  await page.locator('[data-theme-option-id="ling-breeze"]').click();
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "ling-breeze");
  await page.locator('[data-settings-section="worktrees"]').click();
  await expect(surface.getByRole("textbox", { name: "Worktree root directory" })).toHaveValue("/tmp/Ling worktrees");
  await expectNoOverflow(page);
});

test("cleanup snapshots dirty worktrees, protects active worktrees and keeps confirmation errors actionable", async ({ page }) => {
  const harness = await prepare(page);
  const surface = await open(page);
  await expect(surface.locator('[aria-labelledby="managed-worktrees-heading"] li').filter({ hasText: "Research notes" }).getByRole("button", { name: "Clean up worktree" })).toBeEnabled();
  await expect(surface.locator('[aria-labelledby="managed-worktrees-heading"] li').filter({ hasText: "Active project" }).getByRole("button", { name: "Clean up worktree" })).toBeDisabled();
  const cleanup = surface.locator('[aria-labelledby="managed-worktrees-heading"] li').filter({ hasText: "Engineering" }).getByRole("button", { name: "Clean up worktree" });
  await cleanup.click();
  const dialog = page.getByRole("dialog", { name: "Clean up worktree?" });
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(cleanup).toBeFocused();
  expect(harness.actions).toEqual([]);
  harness.cleanupError = true;
  await cleanup.click();
  await dialog.getByRole("button", { name: "Clean up worktree" }).click();
  await expect(dialog).toContainText("Worktree has unsaved changes");
  await screenshot(page, "cleanup-error");
  harness.cleanupError = false;
  await dialog.getByRole("button", { name: "Clean up worktree" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(surface.locator('[aria-labelledby="managed-worktrees-heading"] li').filter({ hasText: "Engineering" })).toContainText("Not created");
  await expectNoOverflow(page);
  expect(harness.runtimeErrors).toEqual([]);
  await surface.getByRole("button", { name: "Restore worktree" }).click();
  await expect(surface.locator('[aria-labelledby="managed-worktrees-heading"] li').filter({ hasText: "Engineering" }).getByRole("button", { name: "Clean up worktree" })).toBeEnabled();
  await expect(surface.getByRole("heading", { name: "Recovery snapshots" })).toHaveCount(0);
});

test("retention, confirmation and environment settings persist and recovery actions remain usable", async ({ page }) => {
  const harness = await prepare(page);
  const surface = await open(page);
  await surface.getByRole("switch", { name: "Automatically clean up old worktrees" }).click();
  await surface.getByRole("spinbutton", { name: "Worktrees to retain" }).fill("3");
  await surface.getByRole("switch", { name: "Ask before cleaning up a worktree" }).click();
  await surface.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => harness.current.policy).toMatchObject({ autoCleanup: true, retainCount: 3, confirmBeforeDelete: false });
  await surface.getByRole("radio", { name: "Environment", exact: true }).click();
  await surface.getByRole("switch", { name: "Run setup script on new worktrees" }).click();
  await surface.getByRole("textbox", { name: "Setup script", exact: true }).fill("printf ready > setup.txt");
  await surface.getByRole("textbox", { name: "Environment variables", exact: true }).fill("LING_TEST_MODE=local\nLING_TEST_FLAG=yes");
  await surface.getByRole("spinbutton", { name: "Setup timeout (seconds)" }).fill("20");
  await screenshot(page, "environment-light");
  await surface.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => harness.current.policy.environment).toEqual({ enabled: true, setupScript: "printf ready > setup.txt", variables: { LING_TEST_MODE: "local", LING_TEST_FLAG: "yes" }, timeoutSeconds: 20 });
  await surface.getByRole("textbox", { name: "Setup script", exact: true }).fill("unsaved draft");
  await surface.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(surface.getByRole("textbox", { name: "Setup script", exact: true })).toHaveValue("unsaved draft");
  await page.locator('[data-settings-section="personal-profile"]').click();
  await page.locator('[data-settings-section="worktrees"]').click();
  await surface.getByRole("radio", { name: "Environment", exact: true }).click();
  await expect(surface.getByRole("textbox", { name: "Setup script", exact: true })).toHaveValue("printf ready > setup.txt");
  const owner = surface.locator('[aria-labelledby="managed-worktrees-heading"] li').filter({ hasText: "Engineering" });
  await owner.getByRole("button", { name: "Keep worktree" }).click();
  await expect(owner.getByRole("button", { name: "Unpin worktree" })).toBeVisible();
  await owner.getByRole("button", { name: "Clean up worktree" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(surface.getByRole("heading", { name: "Recovery snapshots" })).toBeVisible();
  await screenshot(page, "recovery-light");
  await surface.getByRole("button", { name: "Restore worktree" }).click();
  await expect(owner.getByRole("button", { name: "Open path" })).toBeEnabled();
  expect(harness.actions.find(item => item.action === "cleanup")?.confirmed).toBe(true);
  expect(harness.runtimeErrors).toEqual([]);
});

for (const viewport of [{ width: 1280, height: 800, name: "desktop-dark-zh" }, { width: 390, height: 844, name: "mobile-dark-zh" }]) {
  test(`Chinese dark worktree page handles retry and empty state at ${viewport.width}px`, async ({ page }) => {
    const harness = await prepare(page, "zh-CN", "dark", viewport.width, viewport.height);
    harness.current = { ...harness.current, entries: [] };
    harness.loadError = true;
    const surface = await open(page, true);
    await expect(surface.getByRole("button", { name: "重试" })).toBeVisible();
    harness.loadError = false;
    await surface.getByRole("button", { name: "重试" }).click();
    await expect(surface.getByText("暂无托管工作树", { exact: true })).toBeVisible();
    await expect(surface.getByRole("heading", { name: "工作树", exact: true })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expectNoOverflow(page);
    expect(harness.runtimeErrors).toEqual([]);
    await screenshot(page, viewport.name);
    harness.current = snapshot();
    await surface.getByRole("button", { name: "刷新" }).click();
    await expect(surface.getByText("Engineering", { exact: true })).toBeVisible();
    await surface.locator('[aria-labelledby="managed-worktrees-heading"] li').filter({ hasText: "Research notes" }).scrollIntoViewIfNeeded();
    await expectNoOverflow(page);
    await screenshot(page, `${viewport.name}-list`);
  });
}

for (const theme of ["breeze", "ocean", "night", "journey"]) {
  test(`worktree controls and cleanup confirmation remain readable in ${theme}`, async ({ page }) => {
    const harness = await prepare(page, "zh-CN", theme);
    const surface = await open(page, true);
    await expect(page.locator("html")).toHaveAttribute("data-ui-theme", `ling-${theme}`);
    await expect(surface.getByRole("textbox", { name: "工作树根目录" })).toBeVisible();
    await expect(surface.getByText("有待提交改动", { exact: true })).toBeVisible();
    await expectNoOverflow(page);
    await screenshot(page, `desktop-${theme}-zh`);
    await surface.locator('[aria-labelledby="managed-worktrees-heading"] li').filter({ hasText: "Engineering" }).getByRole("button", { name: "清理工作树" }).click();
    const dialog = page.getByRole("dialog", { name: "清理工作树？" });
    await expect(dialog.getByRole("button", { name: "取消" })).toBeFocused();
    await expect(dialog).toContainText("Engineering");
    await expectNoOverflow(page);
    await screenshot(page, `dialog-${theme}-zh`);
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    expect(harness.actions).toEqual([]);
    expect(harness.runtimeErrors).toEqual([]);
  });
}
