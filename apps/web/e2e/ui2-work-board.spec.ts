import { expect, test, type Locator, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon, type MockWorkItem } from "./support/mock-daemon";
import { createBaseState, createChatProvider, cwd } from "./support/mock-state";
import { openWorkBoardFromInbox } from "./support/open-work-board";
import { openChannelChatTools } from "./support/test-helpers";

const evidenceDirectory = fileURLToPath(new URL("../../../docs/design/ui2.0升级/evidence/features/work-board/", import.meta.url));

test.describe("UI2 Work Board", () => {
  test.beforeEach(async ({ page }) => {
    await prepareSurface(page, "light", 1440, 960);
  });

  test("keeps focused styles as the Light and Dark Work Board owners", async ({ page }) => {
    const errors = collectRuntimeErrors(page);
    const state = createBaseState({ approvalStatus: "expired" });
    state.tasks = [];
    state.runs = [];
    state.approvals = [];
    state.workItems = [
      workItemFixture("wb_theme_owner_waiting", "Waiting theme owner audit", { status: "waiting", waitingReason: "user" }),
      workItemFixture("wb_theme_owner_ready", "Ready theme owner audit"),
      workItemFixture("wb_theme_owner_blocked", "Blocked theme owner audit", { status: "blocked" }),
      workItemFixture("wb_theme_owner_running", "Running theme owner audit", { status: "running" }),
    ];
    await mockDaemon(page, state);

    for (const theme of ["light", "dark"] as const) {
      await prepareSurface(page, theme, theme === "dark" ? 1280 : 1440, theme === "dark" ? 800 : 960);
      await page.goto("/");
      await openWorkBoard(page);
      const board = page.locator(".work-board-page");
      await board.getByRole("button", { name: "All active" }).click();
      await expect(board.locator(".work-item-row")).toHaveCount(4);
      await board.locator(".work-item-row").filter({ hasText: "Waiting theme owner audit" }).click();
      const audit = await readWorkBoardStyleAudit(page);

      expect(audit.theme).toBe(theme);
      expect(audit.loadedFocusedStyleSheets).toEqual([
        "channel.css",
        "inspector.css",
        "list.css",
        "page.css",
        "toolbar.css",
      ]);
      expect(audit.strictConsoleMatches).toEqual([]);
      expect(audit.computed.page.backgroundColor).toBe(audit.tokens.panelBackground);
      expect(audit.computed.page.color).toBe(audit.tokens.defaultText);
      expect(audit.computed.heading.color).toBe(audit.tokens.strongText);
      expect(audit.computed.inspector.backgroundColor).toBe(audit.tokens.panelBackground);
      expect(audit.computed.inspector.borderLeftColor).toBe(audit.tokens.defaultBorder);
      expect(audit.computed.detailField.backgroundColor).toBe(audit.tokens.subtleBackground);
      expect(audit.computed.detailField.borderColor).toBe(audit.tokens.defaultBorder);
      expect(audit.focusedMatches.some((rule) => rule.source === "page.css" && rule.selector.includes(".work-board-page"))).toBe(true);
      expect(audit.focusedMatches.some((rule) => rule.source === "inspector.css" && rule.selector.includes(".work-board-detail-field"))).toBe(true);
      await expectNoDocumentOverflow(page);
    }

    await openChannelChatTools(page);
    const channelAudit = await readWorkBoardStyleAudit(page);
    expect(channelAudit.strictConsoleMatches).toEqual([]);
    expect(channelAudit.focusedMatches.some((rule) => rule.source === "channel.css" && rule.selector.includes(".channel-work-board"))).toBe(true);
    await expectNoDocumentOverflow(page);
    expect(errors).toEqual([]);
  });

  test("filters, sorts, selects by keyboard, and only opens from an explicit action", async ({ page }) => {
    const errors = collectRuntimeErrors(page);
    const state = createBaseState({ approvalStatus: "expired" });
    state.tasks = [taskFixture("wb_open_task", "Open-intent task")];
    state.workItems = [
      workItemFixture("wb_ready_high", "Ready high priority", { priority: "high" }),
      workItemFixture("wb_waiting", "Waiting for user", { status: "waiting", waitingReason: "user", priority: "low" }),
      workItemFixture("wb_done", "Completed record", { status: "done" }),
    ];
    await mockDaemon(page, state);
    await page.goto("/");
    await openWorkBoard(page);

    const board = page.locator(".work-board-page");
    await expect(board.getByRole("heading", { name: "Needs action" })).toBeVisible();
    const waitingRow = board.locator(".work-item-row").filter({ hasText: "Waiting for user" });
    await waitingRow.focus();
    await waitingRow.press("Enter");
    await expect(waitingRow).toHaveAttribute("aria-selected", "true");
    await expect(board).toBeVisible();
    await expect(board.getByLabel("Work details")).toContainText("Waiting for user");
    await captureEvidence(page, "1440x960-ling-light-actionable-mixed.png", "actionable mixed groups with keyboard-selected Inspector", errors);

    await board.getByRole("button", { name: "All active" }).click();
    await expect(board.getByRole("heading", { name: "All active work" })).toBeVisible();

    await board.getByRole("combobox", { name: "Sort work" }).selectOption("priority");
    const filter = board.getByRole("button", { name: "Filter work" });
    await expectTypedIconAction(page, filter, "Filter work");
    await expect(filter).toHaveAttribute("aria-pressed", "false");
    await filter.focus();
    await expect(filter).toBeFocused();
    await filter.click();
    await expect(filter).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("combobox", { name: "Status" }).selectOption("waiting");
    await page.keyboard.press("Escape");
    await expect(filter).toHaveAttribute("aria-pressed", "false");
    await expect(filter).toBeFocused();
    await expect(board.locator(".work-item-row")).toHaveCount(1);

    const search = board.getByRole("searchbox", { name: "Search work" });
    await search.fill("no-such-work-item");
    await expect(board.getByText("No work matches these filters")).toBeVisible();
    await board.locator(".work-board-empty").getByRole("button", { name: "Clear filters" }).click();
    await expect(search).toHaveValue("");

    await board.getByRole("button", { name: "All active" }).click();
    const taskRow = board.locator(".work-item-row").filter({ hasText: "Open-intent task" });
    await taskRow.press("Space");
    await expect(board).toBeVisible();
    await taskRow.getByRole("button", { name: "Open task" }).click();
    await expect(page.locator(".workspace-client-surface")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("scopes mutation busy to one row and keeps a failed Fail dialog intact", async ({ page }) => {
    const errors = collectRuntimeErrors(page);
    const state = createBaseState({ approvalStatus: "expired" });
    state.tasks = [];
    state.workItems = [
      workItemFixture("wb_busy_a", "Busy row A"),
      workItemFixture("wb_busy_b", "Independent row B"),
      workItemFixture("wb_claimed", "Claimed failure target", {
        status: "running",
        claim: { ownerId: "web-user", token: "fake-claim-token-never-render", claimedAt: "2026-07-22T00:00:00.000Z", heartbeatAt: "2026-07-22T00:00:00.000Z", expiresAt: "2026-07-22T00:05:00.000Z" },
      }),
    ];
    const claimGate = deferred<void>();
    const failGate = deferred<void>();
    let rejectFail = true;
    let workspaceWorkItemReads = 0;
    await mockDaemon(page, state);
    await page.route(/\/work-items(?:\?.*)?$/u, async (route) => {
      if (route.request().method() === "GET" && new URL(route.request().url()).searchParams.get("limit") === "500") workspaceWorkItemReads += 1;
      await route.fallback();
    });
    await page.route(/\/work-items\/wb_busy_a\/claim(?:\?.*)?$/u, async (route) => { await claimGate.promise; await route.fallback(); });
    await page.route(/\/work-items\/wb_claimed\/fail(?:\?.*)?$/u, async (route) => {
      if (!rejectFail) { await route.fallback(); return; }
      await failGate.promise;
      const item = state.workItems.find((candidate) => candidate.id === "wb_claimed");
      await route.fulfill({ json: { cwd, workItem: { ...item, id: "wb_unexpected_identity" } } });
    });
    await page.goto("/");
    await openWorkBoard(page);

    const board = page.locator(".work-board-page");
    await expect(board).toHaveAttribute("data-source-freshness", "fresh");
    const initialWorkItemReads = workspaceWorkItemReads;
    const rowA = board.locator(".work-item-row").filter({ hasText: "Busy row A" });
    const rowB = board.locator(".work-item-row").filter({ hasText: "Independent row B" });
    await rowA.getByRole("button", { name: "Claim" }).click();
    await expect(rowA.getByRole("button", { name: "Claim" })).toHaveAttribute("aria-busy", "true");
    await expect(board.getByLabel("Work details").getByRole("button", { name: "Claim" })).toBeDisabled();
    await expect(rowB.getByRole("button", { name: "Claim" })).toBeEnabled();
    claimGate.resolve();
    await expect.poll(() => state.workItems.find((item) => item.id === "wb_busy_a")?.claim?.ownerId).toBe("web-user");
    await expect.poll(() => workspaceWorkItemReads).toBe(initialWorkItemReads + 1);

    const claimedRow = board.locator(".work-item-row").filter({ hasText: "Claimed failure target" });
    await claimedRow.click();
    const failTrigger = board.getByLabel("Work details").getByRole("button", { name: "Mark failed" });
    await failTrigger.click();
    const dialog = page.getByRole("dialog", { name: "Mark work as failed" });
    const reason = dialog.getByRole("textbox", { name: "Reason" });
    await expect(reason).toHaveValue("");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect(failTrigger).toBeFocused();
    await failTrigger.click();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(failTrigger).toBeFocused();
    await failTrigger.click();
    await reason.fill("");
    await dialog.getByRole("button", { name: "Mark failed" }).click();
    await expect(dialog).toContainText("A failure reason is required.");

    await reason.fill("Focused failure reason remains after rejection");
    await dialog.getByRole("button", { name: "Mark failed" }).click();
    await expect(dialog.getByRole("button", { name: "Mark failed" })).toHaveAttribute("aria-busy", "true");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
    failGate.resolve();
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeEnabled();
    await expect(reason).toHaveValue("Focused failure reason remains after rejection");
    await expect(dialog).toBeVisible();
    expect(workspaceWorkItemReads).toBe(initialWorkItemReads + 1);
    const technicalDetails = dialog.locator("details").filter({ hasText: "Technical details" });
    await expect(technicalDetails).not.toHaveAttribute("open", "");
    await expect(dialog.locator("[data-work-board-failure-technical]")).not.toBeVisible();
    await technicalDetails.getByText("Technical details", { exact: true }).click();
    await expect(dialog.locator("[data-work-board-failure-technical]")).toBeVisible();
    await technicalDetails.getByText("Technical details", { exact: true }).click();
    await expect(page.locator("body")).not.toContainText("fake-claim-token-never-render");
    await captureEvidence(page, "1440x960-ling-light-durable-fail-dialog.png", "claimed durable Fail dialog retaining input after scoped failure", errors);
    rejectFail = false;
    await dialog.getByRole("button", { name: "Mark failed" }).click();
    await expect.poll(() => state.workItems.find((item) => item.id === "wb_claimed")?.status).toBe("blocked");
    await expect.poll(() => workspaceWorkItemReads).toBe(initialWorkItemReads + 2);
    await expect(dialog).toBeHidden();
    await expect(claimedRow).toBeFocused();
    await expect(page.locator(".ling-ui-toast-description").getByText("Work marked failed", { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("retains rows after a source failure and discloses capped workspace data", async ({ page }) => {
    test.setTimeout(60_000);
    await prepareSurface(page, "dark", 1280, 800);
    const errors = collectRuntimeErrors(page);
    const state = createBaseState({ approvalStatus: "expired" });
    state.tasks = [];
    state.workItems = Array.from({ length: 500 }, (_, index) => workItemFixture(`wb_cap_${index}`, `Capped record ${index}`));
    let failRuns = false;
    await mockDaemon(page, state);
    await page.route(/\/runs(?:\?.*)?$/u, async (route) => {
      if (failRuns) await route.fulfill({ status: 200, contentType: "application/json", body: "{" });
      else await route.fallback();
    });
    await page.goto("/");
    await openWorkBoard(page);

    const board = page.locator(".work-board-page");
    await expect(board).toHaveAttribute("data-source-active", "true");
    await expect(board.getByText("Showing the latest available records")).toBeVisible();
    await expect(board.getByTitle("Capped record 0")).toBeVisible();
    await expect(board.getByRole("button", { name: /Load more/i })).toHaveCount(0);
    failRuns = true;
    await board.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(board.getByText("Showing retained data")).toBeVisible();
    await expect(board.getByTitle("Capped record 0")).toBeVisible();
    await captureEvidence(page, "1280x800-ling-dark-retained-stale.png", "retained capped rows after the runs source refresh fails", errors);
    expect(errors).toEqual([]);
  });

  test("captures a dark active-filter no-result state", async ({ page }) => {
    await prepareSurface(page, "dark", 1280, 800);
    const errors = collectRuntimeErrors(page);
    const state = createBaseState({ approvalStatus: "expired" });
    state.tasks = [];
    state.runs = [];
    state.approvals = [];
    state.workItems = [workItemFixture("wb_filter_ready", "Ready item excluded by waiting filter")];
    await mockDaemon(page, state);
    await page.goto("/");
    await openWorkBoard(page);

    const board = page.locator(".work-board-page");
    await board.getByRole("button", { name: "Filter work" }).click();
    await page.getByRole("combobox", { name: "Status" }).selectOption("waiting");
    await page.keyboard.press("Escape");
    await expect(board.getByText("No work matches these filters")).toBeVisible();
    await expect(board.getByLabel("1 active filters")).toBeVisible();
    await expectNoDocumentOverflow(page);
    await captureEvidence(page, "1280x800-ling-dark-filter-no-result.png", "dark no-result state with one active status filter", errors);
    expect(errors).toEqual([]);
  });

  test("captures a pending approval Inspector without inline decision controls", async ({ page }) => {
    const errors = collectRuntimeErrors(page);
    const state = createBaseState({ approvalStatus: "pending" });
    state.workItems = [];
    await mockDaemon(page, state);
    await page.goto("/");
    await openWorkBoard(page);

    const board = page.locator(".work-board-page");
    const approvalRow = board.locator(".work-item-row").filter({ hasText: "Inspect workspace" });
    await approvalRow.click();
    const inspector = board.getByLabel("Work details");
    await expect(inspector.getByRole("button", { name: "Handle approval" })).toBeVisible();
    await expect(inspector.getByRole("button", { name: /Approve|Deny/ })).toHaveCount(0);
    await expect(inspector.locator("details").filter({ hasText: "Technical details" })).not.toHaveAttribute("open", "");
    await captureEvidence(page, "1440x960-ling-light-approval-inspector.png", "pending approval Inspector with exact Inbox action and folded raw details", errors);
    expect(errors).toEqual([]);
  });

  test("captures a long reduced-motion list with independent scroll owners", async ({ page }) => {
    await prepareSurface(page, "dark", 1280, 800);
    const errors = collectRuntimeErrors(page);
    const state = createBaseState({ approvalStatus: "expired" });
    const artifactIds = Array.from({ length: 64 }, (_, index) => `artifact-long-evidence-${String(index).padStart(2, "0")}`);
    state.tasks = [];
    state.runs = [];
    state.approvals = [];
    state.workItems = [
      workItemFixture("wb_long_primary", "A deliberately long work item title that proves row ellipsis never resizes the action column or the board grid", {
        artifactIds,
        labels: Array.from({ length: 12 }, (_, index) => `long-label-${index}`),
        priority: "urgent",
      }),
      ...Array.from({ length: 119 }, (_, index) => workItemFixture(`wb_long_${String(index).padStart(3, "0")}`, `Long list record ${String(index).padStart(3, "0")} with stable action geometry`)),
    ];
    await mockDaemon(page, state);
    await page.goto("/");
    await openWorkBoard(page);

    const board = page.locator(".work-board-page");
    const longRow = board.locator(".work-item-row").filter({ hasText: "A deliberately long work item title" });
    await longRow.click();
    await board.getByLabel("Work details").locator("details").filter({ hasText: "Evidence" }).locator("summary").click();
    await expect.poll(() => hasVerticalOverflow(board.locator(".work-board-list-scroll"))).toBe(true);
    await expect.poll(() => hasVerticalOverflow(board.locator(".work-board-detail"))).toBe(true);
    await expectNoDocumentOverflow(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await captureEvidence(page, "1280x800-ling-dark-long-list-reduced-motion.png", "120-row long-text list with expanded evidence and independent reduced-motion scroll owners", errors);
    expect(errors).toEqual([]);
  });

  test("captures selected-missing recovery after an authoritative refresh", async ({ page }) => {
    const errors = collectRuntimeErrors(page);
    const state = createBaseState({ approvalStatus: "expired" });
    state.tasks = [];
    state.runs = [];
    state.approvals = [];
    state.workItems = [workItemFixture("wb_selected_removed", "Selected work removed by refresh")];
    await mockDaemon(page, state);
    await page.goto("/");
    await openWorkBoard(page);

    const board = page.locator(".work-board-page");
    const selectedRow = board.locator(".work-item-row").filter({ hasText: "Selected work removed by refresh" });
    await selectedRow.click();
    await expect(selectedRow).toHaveAttribute("aria-selected", "true");
    state.workItems = [];
    await board.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(board.getByText("Selected work is no longer available")).toBeVisible();
    await expect(board.getByRole("button", { name: "Clear selection" })).toBeVisible();
    await captureEvidence(page, "1440x960-ling-light-selected-missing.png", "selected work removed by authoritative refresh with explicit recovery actions", errors);
    expect(errors).toEqual([]);
  });

  test("captures the bounded dark Channel Work Board projection", async ({ page }) => {
    await prepareSurface(page, "dark", 1280, 800);
    const errors = collectRuntimeErrors(page);
    const state = createBaseState({ approvalStatus: "expired" });
    state.providers = [createChatProvider()];
    state.workspaceSettings = { ...state.workspaceSettings, defaultProviderPresetId: "provider_local" };
    state.channels = state.channels.map((channel) => ({ ...(channel as Record<string, unknown>), defaultProviderPresetId: "provider_local" }));
    state.tasks = [];
    state.runs = [];
    state.approvals = [];
    state.workItems = [
      workItemFixture("wb_channel_visible", "Engineering active projection"),
      workItemFixture("wb_channel_terminal", "Engineering terminal projection", { status: "done" }),
      workItemFixture("wb_channel_other", "Other channel projection", { channelId: "channel_other" }),
    ];
    await mockDaemon(page, state);
    await page.goto("/");
    await openChannelChatTools(page);

    const channelBoard = page.getByLabel("Channel Work Board");
    await expect(channelBoard.getByText("Engineering active projection")).toBeVisible();
    await expect(channelBoard.getByText("Engineering terminal projection")).toHaveCount(0);
    await expect(channelBoard.getByText("Other channel projection")).toHaveCount(0);
    await expectNoDocumentOverflow(page);
    await captureEvidence(page, "1280x800-ling-dark-channel-projection.png", "bounded Engineering-only non-terminal Channel Work Board projection", errors);
    expect(errors).toEqual([]);
  });

  test("shows a source skeleton without flashing empty", async ({ page }) => {
    const state = createBaseState({ approvalStatus: "expired" });
    const tasksGate = deferred<void>();
    const sourceRequestUrls: string[] = [];
    await mockDaemon(page, state);
    await page.route(/\/tasks(?:\?.*)?$/u, async (route) => {
      if (new URL(route.request().url()).searchParams.get("limit") === "500") sourceRequestUrls.push(route.request().url());
      if (new URL(route.request().url()).searchParams.get("limit") === "500") await tasksGate.promise;
      await route.fallback();
    });
    await page.goto("/");
    await openWorkBoard(page);
    const board = page.locator(".work-board-page");
    await expect(board).toHaveAttribute("data-source-active", "true");
    await expect(board.getByLabel("Loading work board...")).toBeVisible();
    await expect(board.getByText("No work yet")).toHaveCount(0);
    tasksGate.resolve();
    await expect(board.getByLabel("Loading work board...")).toHaveCount(0);
    expect(sourceRequestUrls).toHaveLength(1);
  });

  test("shows a true empty state and stays overflow-safe in dark mode", async ({ page }) => {
    await prepareSurface(page, "dark", 1280, 800);
    const errors = collectRuntimeErrors(page);
    const state = createBaseState({ approvalStatus: "expired" });
    state.tasks = [];
    state.runs = [];
    state.approvals = [];
    state.workItems = [];
    state.externalWorkActions = [];
    state.externalWorkCiTriage = [];
    state.channelWorkflows = [];
    state.channelWorkflowSteps = [];
    await mockDaemon(page, state);
    await page.goto("/");
    await openWorkBoard(page);
    const board = page.locator(".work-board-page");
    await expect(board.getByText("No work yet")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    const overflow = await page.evaluate(() => ({ width: document.documentElement.scrollWidth - document.documentElement.clientWidth, height: document.documentElement.scrollHeight - document.documentElement.clientHeight }));
    expect(overflow.width).toBeLessThanOrEqual(1);
    expect(overflow.height).toBeLessThanOrEqual(1);
    await captureEvidence(page, "1280x800-ling-dark-true-empty.png", "true empty list with collapsed guide", errors);
    expect(errors).toEqual([]);
  });
});

async function openWorkBoard(page: Page): Promise<void> {
  await openWorkBoardFromInbox(page);
  await expect(page.locator(".work-board-page")).toBeVisible();
}

async function expectTypedIconAction(page: Page, action: Locator, label: string): Promise<void> {
  await expect(action).toHaveAttribute("data-icon-only", "true");
  await expect(action).toHaveAttribute("data-ling-icon-button-contract", "typed-lucide");
  await expect(action).toHaveAttribute("aria-label", label);
  await expect(action).toHaveAttribute("title", label);
  const bounds = await action.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds?.width ?? 0).toBeGreaterThanOrEqual(32);
  expect(bounds?.height ?? 0).toBeGreaterThanOrEqual(32);
  await action.hover();
  await expect(page.getByRole("tooltip", { name: label })).toBeVisible();
  await page.mouse.move(0, 0);
}

async function prepareSurface(page: Page, theme: "light" | "dark", width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.emulateMedia({ colorScheme: theme, reducedMotion: theme === "dark" ? "reduce" : "no-preference" });
  await page.addInitScript(({ cwdValue, selectedTheme }) => {
    const themeId = `ling-${selectedTheme}`;
    const selection = { mode: "fixed", themeId };
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.workspaceCwd", cwdValue);
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themePreference", selectedTheme);
    localStorage.setItem("ling-stack.themeBootstrapPreference", selectedTheme);
  }, { cwdValue: cwd, selectedTheme: theme });
}

function workItemFixture(id: string, title: string, overrides: Partial<MockWorkItem> = {}): MockWorkItem {
  return {
    id, workspaceId: "workspace_default", channelId: "channel_engineering", sourceType: "manual", sourceId: id,
    title, status: "ready", priority: "normal", labels: [], artifactIds: [], proofArtifactIds: [], dependencyIds: [],
    attemptCount: 0, retryBudget: 2, createdAt: "2026-07-22T00:00:00.000Z", updatedAt: "2026-07-22T00:10:00.000Z",
    ...overrides,
  };
}

function taskFixture(id: string, title: string): Record<string, unknown> {
  return { id, workspaceId: "workspace_default", channelId: "channel_engineering", title, prompt: `Prompt for ${id}`, status: "todo", attachmentIds: [], createdAt: "2026-07-22T00:00:00.000Z", updatedAt: "2026-07-22T00:10:00.000Z" };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  return errors;
}

async function captureEvidence(page: Page, filename: string, fixture: string, consoleErrors: readonly string[]): Promise<void> {
  if (process.env.LING_CAPTURE_UI2_EVIDENCE !== "1") return;
  await mkdir(evidenceDirectory, { recursive: true });
  const screenshotPath = `${evidenceDirectory}${filename}`;
  await page.screenshot({ animations: "disabled", path: screenshotPath });
  const selectorOwnership = await readWorkBoardStyleAudit(page);
  const metrics = await page.evaluate(() => {
    const readScroll = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      return element ? { clientHeight: element.clientHeight, clientWidth: element.clientWidth, scrollHeight: element.scrollHeight, scrollWidth: element.scrollWidth } : null;
    };
    const readThemeId = (raw: string | null): string | null => {
      try {
        const parsed = JSON.parse(raw ?? "null") as { themeId?: unknown } | null;
        return typeof parsed?.themeId === "string" ? parsed.themeId : null;
      } catch {
        return null;
      }
    };
    return {
      document: { clientHeight: document.documentElement.clientHeight, clientWidth: document.documentElement.clientWidth, scrollHeight: document.documentElement.scrollHeight, scrollWidth: document.documentElement.scrollWidth },
      documentOverflow: { horizontal: document.documentElement.scrollWidth - document.documentElement.clientWidth, vertical: document.documentElement.scrollHeight - document.documentElement.clientHeight },
      inspector: readScroll(".work-board-detail"), list: readScroll(".work-board-list-scroll"), channelProjection: readScroll(".channel-work-board-groups"),
      locale: localStorage.getItem("ling-stack.locale") ?? "en-US", reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
      sourceActive: document.querySelector(".work-board-page")?.getAttribute("data-source-active"),
      sourceFreshness: document.querySelector(".work-board-page")?.getAttribute("data-source-freshness"),
      theme: document.documentElement.dataset.theme,
      themeId: readThemeId(localStorage.getItem("ling-stack.themeSelection")),
      visibleWorkItemRows: document.querySelectorAll(".work-board-page .work-item-row").length,
      visibleChannelRows: document.querySelectorAll(".channel-work-board .work-item-row").length,
      selectedWorkItem: document.querySelector('.work-item-row[aria-selected="true"]')?.getAttribute("aria-label") ?? null,
      emptyState: document.querySelector(".work-board-empty")?.textContent?.trim() ?? null,
      dialog: document.querySelector('[role="dialog"]')?.getAttribute("aria-label") ?? null,
    };
  });
  if (metrics.documentOverflow.horizontal > 1 || metrics.documentOverflow.vertical > 1) throw new Error(`Evidence viewport overflowed: ${JSON.stringify(metrics.documentOverflow)}`);
  const viewport = page.viewportSize();
  const sha256 = createHash("sha256").update(await readFile(screenshotPath)).digest("hex");
  await writeFile(screenshotPath.replace(/\.png$/u, ".metadata.json"), `${JSON.stringify({
    file: filename, fixture, verification: "verified", matrix: "P11.1 / WB-08", capturedOn: "2026-07-23",
    url: page.url(), servedArtifact: "Vite source via Playwright webServer", viewport, image: { width: viewport?.width, height: viewport?.height, format: "PNG, 8-bit/color RGB" },
    console: consoleErrors.length === 0 ? "pass" : consoleErrors, sha256, selectorOwnership, ...metrics,
  }, null, 2)}\n`, "utf8");
}

async function readWorkBoardStyleAudit(page: Page) {
  const focusedStyleSources = Object.fromEntries(await Promise.all(
    ["page.css", "toolbar.css", "list.css", "inspector.css", "channel.css"].map(async (filename) => [
      filename,
      await readFile(fileURLToPath(new URL(`../src/styles/work-board/${filename}`, import.meta.url)), "utf8"),
    ]),
  ));
  const strictConsoleSource = await readFile(fileURLToPath(new URL("../src/styles/strict-console.css", import.meta.url)), "utf8");

  return page.evaluate(({ focusedStyleSources, strictConsoleSource }) => {
    const roots = Array.from(document.querySelectorAll<HTMLElement>(".work-board-page, .channel-work-board"));
    const elements = roots.flatMap((root) => [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))]);
    const focusedMatches: Array<{ source: string; selector: string; properties: string[] }> = [];
    const strictConsoleMatches: Array<{ source: string; selector: string; properties: string[] }> = [];

    const visitRules = (rules: CSSRuleList, source: string) => {
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSMediaRule && !matchMedia(rule.conditionText).matches) continue;
        if (rule instanceof CSSStyleRule) {
          const matching = elements.some((element) => {
            try { return element.matches(rule.selectorText); } catch { return false; }
          });
          if (!matching) continue;
          const record = { source, selector: rule.selectorText, properties: Array.from(rule.style).sort() };
          if (source === "strict-console.css") strictConsoleMatches.push(record);
          if (["page.css", "toolbar.css", "list.css", "inspector.css", "channel.css"].includes(source)) focusedMatches.push(record);
          continue;
        }
        if ("cssRules" in rule) visitRules((rule as CSSGroupingRule).cssRules, source);
      }
    };
    for (const [source, css] of Object.entries(focusedStyleSources)) {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      visitRules(sheet.cssRules, source);
    }
    const strictConsoleSheet = new CSSStyleSheet();
    strictConsoleSheet.replaceSync(strictConsoleSource);
    visitRules(strictConsoleSheet.cssRules, "strict-console.css");

    const resolveToken = (token: string, property: "backgroundColor" | "borderColor" | "color") => {
      const probe = document.createElement("span");
      probe.style.position = "fixed";
      probe.style.pointerEvents = "none";
      probe.style.opacity = "0";
      probe.style[property] = `var(${token})`;
      document.body.append(probe);
      const value = getComputedStyle(probe)[property];
      probe.remove();
      return value;
    };
    const computed = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) return { backgroundColor: "", borderColor: "", borderLeftColor: "", color: "" };
      const style = getComputedStyle(element);
      return { backgroundColor: style.backgroundColor, borderColor: style.borderColor, borderLeftColor: style.borderLeftColor, color: style.color };
    };

    return {
      theme: document.documentElement.dataset.theme,
      loadedFocusedStyleSheets: Object.keys(focusedStyleSources).sort(),
      focusedMatches,
      strictConsoleMatches,
      tokens: {
        panelBackground: resolveToken("--ling-bg-panel", "backgroundColor"),
        subtleBackground: resolveToken("--ling-bg-subtle", "backgroundColor"),
        defaultBorder: resolveToken("--ling-border-default", "borderColor"),
        defaultText: resolveToken("--ling-text-default", "color"),
        strongText: resolveToken("--ling-text-strong", "color"),
      },
      computed: {
        page: computed(".work-board-page"),
        heading: computed(".work-board-header h1"),
        inspector: computed(".work-board-detail"),
        detailField: computed(".work-board-detail-field"),
      },
    };
  }, { focusedStyleSources, strictConsoleSource });
}

async function expectNoDocumentOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    horizontal: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    vertical: document.documentElement.scrollHeight - document.documentElement.clientHeight,
  }));
  expect(overflow.horizontal).toBeLessThanOrEqual(1);
  expect(overflow.vertical).toBeLessThanOrEqual(1);
}

async function hasVerticalOverflow(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) => element.scrollHeight > element.clientHeight + 1);
}
