import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test, type Page, type Route } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { triggerFocusRevalidation } from "./support/focus-revalidation";
import { seedImportedQuietOcean } from "./support/media-jobs-fixtures";
import { createBaseState, createChatProvider, cwd, type MockState } from "./support/mock-state";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/features/automations/",
  import.meta.url,
));

test("AUTO-LIST/STATUS/INSPECT handles 100 rows, search, stale refresh, keyboard, and selection races", async ({ page }) => {
  test.setTimeout(60_000);
  await initializePage(page, "en-US", "light");
  const appState = createBaseState({ approvalStatus: "pending" });
  appState.providers = [createChatProvider({ id: "provider_local", displayName: "Relay", model: "gpt-test" })];
  await mockDaemon(page, appState);
  const fixture = createAutomationFixture();
  fixture.definitions = Array.from({ length: 100 }, (_, index) => createDefinition(index, {
    title: `Automation ${String(index + 1).padStart(3, "0")}`,
    trigger: index === 0 ? scheduledTrigger("09:00") : { type: "manual" },
  }));
  fixture.runs = [createRun(fixture.definitions[0], "succeeded")];
  refreshScheduler(fixture, "running");
  await mockAutomationApi(page, fixture, appState);
  const monitor = watchRuntime(page);

  await openAutomations(page);
  const surface = page.locator("[data-automation-ui2-page]");
  await expect(surface.getByRole("tab")).toHaveCount(4);
  await expect(surface.locator("[data-automation-inspector]")).toHaveCount(0);
  await expect(surface.getByRole("option", { name: "Automation 001" })).toBeVisible();
  const scrollRegion = surface.locator("[data-automation-scroll-region]");
  expect(await scrollRegion.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await assertNoHorizontalOverflow(page, surface);

  const secondRow = surface.getByRole("option", { name: "Automation 002" });
  await secondRow.focus();
  await secondRow.press("Enter");
  await expect(secondRow).toHaveAttribute("aria-selected", "true");
  await expect(surface.locator("[data-automation-inspector]")).toContainText("Automation 002");

  const search = surface.getByRole("textbox", { name: "Search" });
  await search.fill("Automation 100");
  await expect(surface.getByRole("option", { name: "Automation 100" })).toBeVisible();
  await expect(surface.getByRole("option", { name: "Automation 001" })).toHaveCount(0);
  await search.press("Escape");
  await expect(search).toHaveValue("");

  await captureEvidence(page, "1440x960-ling-light-list-inspector.png", { width: 1440, height: 960 });

  fixture.failNextList = true;
  await expect(surface.getByRole("button", { name: "Refresh" })).toHaveCount(0);
  await triggerFocusRevalidation(page);
  await expect(surface.getByText("Fixture refresh unavailable.")).toBeVisible();
  await expect(surface.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(surface.getByRole("option", { name: "Automation 001" })).toBeVisible();

  const firstRow = surface.getByRole("option", { name: "Automation 001" });
  fixture.runDelayMs = 180;
  await firstRow.getByRole("button", { name: "Run now" }).click();
  await secondRow.click();
  await expect(secondRow).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => fixture.runCalls.at(-1)).toBe(fixture.definitions[0]?.id);
  await expect(secondRow).toHaveAttribute("aria-selected", "true");

  await monitor.assertClean([503]);
});

test("AUTO-CREATE uses one keyboard-safe shared dialog and preserves failed manual input", async ({ page }) => {
  test.setTimeout(60_000);
  await initializePage(page, "en-US", "light");
  await page.emulateMedia({ reducedMotion: "reduce" });
  const appState = createBaseState({ approvalStatus: "pending" });
  appState.providers = [createChatProvider({ id: "provider_local", displayName: "gpt-test · gpt-test", model: "gpt-test" })];
  await mockDaemon(page, appState);
  const fixture = createAutomationFixture();
  await mockAutomationApi(page, fixture, appState);
  const monitor = watchRuntime(page);

  await openAutomations(page);
  const createAutomationButton = page.getByRole("button", { name: "Create automation" });
  await createAutomationButton.click();
  let dialog = page.getByRole("dialog", { name: "New automation" });
  await expect(dialog.getByRole("radio")).toHaveCount(3);
  expect(await dialog.evaluate((element) => getComputedStyle(element).animationName)).toBe("none");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  await createAutomationButton.click();
  dialog = page.getByRole("dialog", { name: "New automation" });
  await dialog.getByRole("radio", { name: "Manual setup" }).click();
  await expect(dialog.getByLabel("Model").locator('option[value="provider_local"]')).toHaveText("gpt-test · 127.0.0.1:8317");
  await expect(dialog).not.toContainText("gpt-test · gpt-test");
  await dialog.getByRole("button", { name: "Create automation" }).click();
  await expect(dialog.getByLabel("Automation name")).toBeFocused();
  await dialog.getByLabel("Automation name").fill("Daily evidence review");
  await dialog.getByLabel("Execution action").fill("Review recent runs and approvals with evidence.");
  await dialog.getByLabel("Schedule").selectOption("daily");
  fixture.failNextCreate = true;
  await dialog.getByRole("button", { name: "Create automation" }).click();
  await expect(dialog.getByText("Fixture create unavailable.")).toBeVisible();
  await expect(dialog.getByLabel("Automation name")).toHaveValue("Daily evidence review");

  await dialog.getByRole("button", { name: "Create automation" }).click();
  await expect(dialog).toHaveCount(0);
  await dismissToasts(page);
  await createAutomationButton.click();
  dialog = page.getByRole("dialog", { name: "New automation" });

  await dialog.getByRole("radio", { name: "Use template" }).click();
  await dialog.getByRole("option", { name: /Bug Scan/ }).click();
  await dialog.getByRole("button", { name: "Use this template" }).click();
  await expect(dialog.getByLabel("Automation name")).toHaveValue("Bug Scan");
  await captureEvidence(page, "1440x960-ling-light-create-review.png", { width: 1440, height: 960 });

  fixture.createDelayMs = 180;
  await dialog.getByRole("button", { name: "Create automation" }).click();
  await expect(dialog).toHaveAttribute("aria-busy", "true");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveCount(0, { timeout: 5_000 });
  await expect.poll(() => fixture.definitions.length).toBe(2);
  await monitor.assertClean([503]);
});

test("AUTO-CREATE chat draft keeps invalid input and exposes repair without pretending to enable", async ({ page }) => {
  await initializePage(page, "en-US", "dark");
  const appState = createBaseState({ approvalStatus: "pending" });
  appState.providers = [createChatProvider({ id: "provider_local", displayName: "Relay", model: "gpt-test" })];
  await mockDaemon(page, appState);
  const fixture = createAutomationFixture();
  await mockAutomationApi(page, fixture, appState);
  const monitor = watchRuntime(page);

  await openAutomations(page);
  await page.getByRole("button", { name: "Create automation" }).click();
  const dialog = page.getByRole("dialog", { name: "New automation" });
  await dialog.getByRole("radio", { name: "Create from conversation" }).click();
  await dialog.getByLabel("Request").fill("invalid draft without a target");
  await dialog.getByRole("button", { name: "Create draft" }).click();
  await expect(dialog.getByText("Setup needs attention").first()).toBeVisible();
  await expect(dialog.getByText("target", { exact: true })).toBeVisible();
  await expect(fixture.definitions).toHaveLength(0);
  await captureEvidence(page, "1280x800-ling-dark-chat-draft-invalid.png", { width: 1280, height: 800 });
  await dialog.getByRole("button", { name: "Manual setup" }).click();
  await expect(dialog.getByLabel("Automation name")).toHaveValue("Needs target review");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await monitor.assertClean();
});

test("AUTO-SCHEDULE/TARGET/RUN/INSPECT keeps scheduler, repair, raw details, and archive failures scoped", async ({ page }) => {
  test.setTimeout(60_000);
  await initializePage(page, "en-US", "dark");
  const appState = createBaseState({ approvalStatus: "pending" });
  appState.providers = [createChatProvider({ id: "provider_local", displayName: "Relay", model: "gpt-test" })];
  await mockDaemon(page, appState);
  const fixture = createAutomationFixture();
  const failed = createDefinition(1, { title: "Failed nightly review" });
  const missing = createDefinition(2, {
    target: { scope: "channel", workspaceId: "workspace_default", channelId: "channel_missing", cwd },
    title: "Missing target review",
  });
  const scheduled = createDefinition(3, { title: "Scheduled evidence review", trigger: scheduledTrigger("10:30") });
  fixture.definitions = [failed, missing, scheduled];
  fixture.runs = [createRun(failed, "failed")];
  refreshScheduler(fixture, "stopped");
  await mockAutomationApi(page, fixture, appState);
  const monitor = watchRuntime(page);

  await openAutomations(page);
  const surface = page.locator("[data-automation-ui2-page]");
  await expect(surface.getByText("Scheduler stopped")).toBeVisible();
  await expect(surface.getByRole("button", { name: "Start scheduler" })).toBeVisible();
  await surface.getByRole("tab", { name: /Needs attention/ }).click();
  const failedRow = surface.getByRole("option", { name: "Failed nightly review" });
  await failedRow.click();
  const inspector = surface.locator("[data-automation-inspector]");
  await expect(inspector.getByText("Recent run failed").first()).toBeVisible();
  await expect(inspector.getByText("Technical details")).toBeVisible();
  await expect(inspector.locator("details", { hasText: "Technical details" })).not.toHaveAttribute("open", "");
  await captureEvidence(page, "1280x800-ling-dark-failure-repair.png", { width: 1280, height: 800 });

  fixture.failNextRun = true;
  await inspector.getByRole("button", { name: "Retry" }).click();
  await expect(inspector.getByText("Fixture run unavailable.")).toBeVisible();

  const missingRow = surface.getByRole("option", { name: "Missing target review" });
  await missingRow.click();
  await expect(inspector.getByText("Unavailable").first()).toBeVisible();
  await inspector.getByRole("combobox", { name: "Target" }).selectOption("workspace");
  await inspector.getByRole("button", { name: "Target" }).click();
  await expect.poll(() => readTargetScope(fixture.definitions.find((item) => item.id === missing.id))).toBe("workspace");

  await surface.getByRole("tab", { name: /Enabled automations/ }).click();
  await scheduledRow(surface).getByRole("button", { name: "Schedule" }).click();
  const scheduleDialog = page.getByRole("dialog", { name: "Schedule" });
  await scheduleDialog.getByRole("combobox", { name: "Schedule" }).selectOption("interval");
  await scheduleDialog.getByRole("spinbutton").fill("30");
  await scheduleDialog.getByRole("button", { name: "Save" }).click();
  await expect(scheduleDialog).toHaveCount(0);
  await dismissToasts(page);

  await scheduledRow(surface).getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Archive" }).click();
  const archiveDialog = page.getByRole("dialog", { name: "Archive" });
  fixture.failNextArchive = true;
  await archiveDialog.getByRole("button", { name: "Archive" }).click();
  await expect(archiveDialog.getByText("Fixture archive unavailable.")).toBeVisible();
  await captureEvidence(page, "1280x800-ling-dark-archive-failure.png", { width: 1280, height: 800 });
  await archiveDialog.getByRole("button", { name: "Archive" }).click();
  await expect(archiveDialog).toHaveCount(0);
  await monitor.assertClean([503]);
});

test("AUTO-SCHEDULE keeps scheduler busy isolated from row actions", async ({ page }) => {
  await initializePage(page, "en-US", "light");
  const appState = createBaseState({ approvalStatus: "pending" });
  appState.providers = [createChatProvider({ id: "provider_local", displayName: "Relay", model: "gpt-test" })];
  await mockDaemon(page, appState);
  const fixture = createAutomationFixture();
  fixture.definitions = [createDefinition(1, { title: "Scheduled review", trigger: scheduledTrigger("09:00") })];
  fixture.schedulerDelayMs = 180;
  refreshScheduler(fixture, "stopped");
  await mockAutomationApi(page, fixture, appState);
  const monitor = watchRuntime(page);

  await openAutomations(page);
  const surface = page.locator("[data-automation-ui2-page]");
  await captureEvidence(page, "1440x960-ling-light-scheduler-stopped.png", { width: 1440, height: 960 });
  await surface.getByRole("button", { name: "Start scheduler" }).click();
  await expect(surface.getByRole("button", { name: "Run now" })).toBeEnabled();
  await expect(surface.getByText("Scheduler started")).toBeVisible();
  await monitor.assertClean();
});

test("AUTO-THEME keeps imported Theme Pack ownership on the list and shared create dialog", async ({ page }) => {
  test.setTimeout(60_000);
  await initializePage(page, "en-US", "light");
  const appState = createBaseState({ approvalStatus: "pending" });
  appState.providers = [createChatProvider({ id: "provider_local", displayName: "Relay", model: "gpt-test" })];
  await mockDaemon(page, appState);
  const fixture = createAutomationFixture();
  fixture.definitions = [createDefinition(1, { title: "Imported theme review", trigger: scheduledTrigger("09:00") })];
  await mockAutomationApi(page, fixture, appState);
  const monitor = watchRuntime(page);

  await page.goto("/");
  const themeId = await seedImportedQuietOcean(page);
  await page.reload();
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "Automations" }).click();

  const root = page.locator("html");
  const surface = page.locator("[data-automation-ui2-page]");
  await expect(root).toHaveAttribute("data-ui-theme", themeId);
  await expect(surface.getByRole("option", { name: "Imported theme review" })).toBeVisible();
  await expectBackgroundToMatchToken(surface, "--ling-bg-panel");
  await assertNoHorizontalOverflow(page, surface);
  await captureEvidence(page, "1440x960-quiet-ocean-list-inspector.png", { width: 1440, height: 960 });

  await page.locator("[data-desktop-window-titlebar-surface='true']")
    .getByRole("button", { name: "Create automation" })
    .click();
  const dialog = page.getByRole("dialog", { name: "New automation" });
  await expect(dialog).toBeVisible();
  await expectBackgroundToMatchToken(dialog, "--ling-bg-elevated");
  await captureEvidence(page, "1280x800-quiet-ocean-create-dialog.png", { width: 1280, height: 800 });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await monitor.assertClean();
});

function scheduledRow(surface: ReturnType<Page["locator"]>) {
  return surface.getByRole("option", { name: "Scheduled evidence review" });
}

interface AutomationFixture {
  definitions: Record<string, unknown>[];
  drafts: Record<string, unknown>[];
  runs: Record<string, unknown>[];
  schedulers: Record<string, unknown>[];
  templates: Record<string, unknown>[];
  runCalls: string[];
  createDelayMs?: number;
  runDelayMs?: number;
  schedulerDelayMs?: number;
  failNextArchive?: boolean;
  failNextCreate?: boolean;
  failNextList?: boolean;
  failNextRun?: boolean;
}

function createAutomationFixture(): AutomationFixture {
  return {
    definitions: [],
    drafts: [],
    runs: [],
    schedulers: [createScheduler([], "running")],
    templates: createTemplates(),
    runCalls: [],
  };
}

async function mockAutomationApi(page: Page, fixture: AutomationFixture, appState: MockState): Promise<void> {
  await page.route("http://127.0.0.1:17891/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (!path.startsWith("/automation")) {
      await route.fallback();
      return;
    }
    if (request.method() === "GET" && path === "/automations") {
      if (fixture.failNextList) {
        fixture.failNextList = false;
        await route.fulfill({ status: 503, json: { error: "fixture_refresh_unavailable", message: "Fixture refresh unavailable." } });
        return;
      }
      await route.fulfill({ json: { cwd, automations: fixture.definitions.filter((item) => item.status !== "archived"), templates: fixture.templates } });
      return;
    }
    if (request.method() === "POST" && path === "/automations") {
      if (fixture.createDelayMs) await delay(fixture.createDelayMs);
      if (fixture.failNextCreate) {
        fixture.failNextCreate = false;
        await route.fulfill({ status: 503, json: { error: "fixture_create_unavailable", message: "Fixture create unavailable." } });
        return;
      }
      const definition = createDefinition(fixture.definitions.length + 1, await request.postDataJSON() as Record<string, unknown>);
      fixture.definitions.unshift(definition);
      refreshScheduler(fixture, readSchedulerStatus(fixture));
      await route.fulfill({ status: 201, json: { cwd, automation: definition, thread: createAutomationThread(definition) } });
      return;
    }
    if (request.method() === "GET" && path === "/automation-drafts") {
      await route.fulfill({ json: { cwd, drafts: fixture.drafts.filter((item) => item.status !== "confirmed" && item.status !== "discarded"), templates: fixture.templates } });
      return;
    }
    if (request.method() === "POST" && path === "/automation-drafts") {
      const body = await request.postDataJSON() as Record<string, unknown>;
      const draft = createDraft(fixture, body);
      fixture.drafts.unshift(draft);
      await route.fulfill({ status: 201, json: { cwd, draft } });
      return;
    }
    if (request.method() === "GET" && path === "/automation-runs") {
      await route.fulfill({ json: { cwd, automationRuns: fixture.runs } });
      return;
    }
    if (request.method() === "GET" && path === "/automations/scheduler") {
      refreshScheduler(fixture, readSchedulerStatus(fixture));
      await route.fulfill({ json: { cwd, schedulers: fixture.schedulers } });
      return;
    }
    if (request.method() === "POST" && (path === "/automations/scheduler/start" || path === "/automations/scheduler/stop")) {
      if (fixture.schedulerDelayMs) await delay(fixture.schedulerDelayMs);
      const status = path.endsWith("/start") ? "running" : "stopped";
      refreshScheduler(fixture, status);
      await route.fulfill({ json: { cwd, scheduler: fixture.schedulers[0] } });
      return;
    }
    const draftMatch = /^\/automation-drafts\/([^/]+)(?:\/(preview|confirm))?$/.exec(path);
    if (draftMatch) {
      await handleDraftRoute(route, fixture, decodeURIComponent(draftMatch[1]), draftMatch[2]);
      return;
    }
    const definitionMatch = /^\/automations\/([^/]+)(?:\/(preview|run))?$/.exec(path);
    if (definitionMatch) {
      await handleDefinitionRoute(route, fixture, appState, decodeURIComponent(definitionMatch[1]), definitionMatch[2]);
      return;
    }
    await route.fallback();
  });
}

async function handleDraftRoute(route: Route, fixture: AutomationFixture, draftId: string, action?: string): Promise<void> {
  const request = route.request();
  const draft = fixture.drafts.find((item) => item.id === draftId);
  if (!draft) {
    await route.fulfill({ status: 404, json: { error: "automation_draft_not_found" } });
    return;
  }
  if (request.method() === "POST" && action === "preview") {
    await route.fulfill({ json: { cwd, draft, context: createContext(String(draft.title ?? "Draft")) } });
    return;
  }
  if (request.method() === "PATCH" && !action) {
    const body = await request.postDataJSON() as Record<string, unknown>;
    const partial = isRecord(body.partialAutomation) ? body.partialAutomation : {};
    const updated = {
      ...draft,
      ...partial,
      missingFields: [],
      status: "ready_for_confirmation",
      updatedAt: now(18),
    };
    fixture.drafts = fixture.drafts.map((item) => item.id === draftId ? updated : item);
    await route.fulfill({ json: { cwd, draft: updated } });
    return;
  }
  if (request.method() === "POST" && action === "confirm") {
    const definition = createDefinition(fixture.definitions.length + 1, draft);
    fixture.definitions.unshift(definition);
    fixture.drafts = fixture.drafts.map((item) => item.id === draftId ? { ...item, status: "confirmed", confirmedAutomationId: definition.id } : item);
    refreshScheduler(fixture, readSchedulerStatus(fixture));
    await route.fulfill({ status: 201, json: { cwd, automation: definition, draft: { ...draft, status: "confirmed" }, thread: createAutomationThread(definition) } });
    return;
  }
  if (request.method() === "DELETE" && !action) {
    fixture.drafts = fixture.drafts.map((item) => item.id === draftId ? { ...item, status: "discarded" } : item);
    await route.fulfill({ json: { cwd, draft: { ...draft, status: "discarded" } } });
    return;
  }
  await route.fulfill({ status: 405, json: { error: "method_not_allowed" } });
}

async function handleDefinitionRoute(
  route: Route,
  fixture: AutomationFixture,
  appState: MockState,
  automationId: string,
  action?: string,
): Promise<void> {
  const request = route.request();
  const definition = fixture.definitions.find((item) => item.id === automationId);
  if (!definition) {
    await route.fulfill({ status: 404, json: { error: "automation_not_found" } });
    return;
  }
  if (request.method() === "POST" && action === "preview") {
    await route.fulfill({ json: { cwd, automation: definition, context: createContext(String(definition.title)) } });
    return;
  }
  if (request.method() === "POST" && action === "run") {
    fixture.runCalls.push(automationId);
    if (fixture.runDelayMs) await delay(fixture.runDelayMs);
    if (fixture.failNextRun) {
      fixture.failNextRun = false;
      await route.fulfill({ status: 503, json: { error: "fixture_run_unavailable", message: "Fixture run unavailable." } });
      return;
    }
    const run = createRun(definition, "succeeded");
    fixture.runs.unshift(run);
    await route.fulfill({ json: { cwd, automation: definition, automationRun: run, context: createContext(String(definition.title)) } });
    return;
  }
  if (request.method() === "PATCH" && !action) {
    const body = await request.postDataJSON() as Record<string, unknown>;
    const updated = { ...definition, ...body, updatedAt: now(20) };
    fixture.definitions = fixture.definitions.map((item) => item.id === automationId ? updated : item);
    refreshScheduler(fixture, readSchedulerStatus(fixture));
    await route.fulfill({ json: { cwd, automation: updated, thread: createAutomationThread(updated) } });
    return;
  }
  if (request.method() === "DELETE" && !action) {
    if (fixture.failNextArchive) {
      fixture.failNextArchive = false;
      await route.fulfill({ status: 503, json: { error: "fixture_archive_unavailable", message: "Fixture archive unavailable." } });
      return;
    }
    const archived = { ...definition, status: "archived", updatedAt: now(21) };
    fixture.definitions = fixture.definitions.map((item) => item.id === automationId ? archived : item);
    appState.automationDefinitions = fixture.definitions;
    await route.fulfill({ json: { cwd, automation: archived, thread: createAutomationThread(archived) } });
    return;
  }
  await route.fulfill({ status: 405, json: { error: "method_not_allowed" } });
}

function createDefinition(index: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const target = isRecord(overrides.target) ? overrides.target : { scope: "workspace", workspaceId: "workspace_default", cwd };
  const trigger = isRecord(overrides.trigger) ? overrides.trigger : { type: "manual" };
  const id = typeof overrides.id === "string" ? overrides.id : `automation_ui2_${index}`;
  return {
    automationMode: target.scope === "thread" ? "heartbeat" : "cron",
    createdAt: now(index),
    cwds: [cwd],
    description: "UI 2.0 automation fixture.",
    executionEnvironment: "worktree",
    executionPolicy: { providerPresetId: "provider_local", allowedTools: ["read", "grep", "find", "ls"], approvalProfile: { mode: "none" } },
    id,
    kind: "custom_prompt",
    model: "gpt-test",
    outputPolicy: { destinations: [{ type: "automation_thread" }, { type: "markdown_artifact" }], artifactFormat: "markdown" },
    promptTemplate: { templateVersion: 1, systemPurpose: "Run automation.", promptMarkdown: "Review evidence.", contextSelectors: [], maxContextItems: 32 },
    reasoningEffort: "medium",
    status: "enabled",
    target,
    threadId: `thread_${id}`,
    title: `Automation ${index}`,
    trigger,
    updatedAt: now(index),
    workspaceId: "workspace_default",
    ...overrides,
  };
}

function createDraft(fixture: AutomationFixture, body: Record<string, unknown>): Record<string, unknown> {
  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  const invalid = /invalid/iu.test(prompt);
  const partial = isRecord(body.partialAutomation) ? body.partialAutomation : {};
  const id = `draft_ui2_${fixture.drafts.length + 1}`;
  return {
    channelId: "channel_engineering",
    createdAt: now(12),
    description: "Drafted from conversation.",
    executionPolicy: isRecord(partial.executionPolicy) ? partial.executionPolicy : { providerPresetId: "provider_local" },
    id,
    kind: partial.kind ?? "custom_prompt",
    missingFields: invalid ? ["target"] : [],
    outputPolicy: isRecord(partial.outputPolicy) ? partial.outputPolicy : { destinations: [{ type: "automation_thread" }], artifactFormat: "markdown" },
    promptTemplate: isRecord(partial.promptTemplate)
      ? partial.promptTemplate
      : { templateVersion: 1, promptMarkdown: prompt, contextSelectors: [], maxContextItems: 32 },
    source: body.source ?? "chat",
    status: invalid ? "needs_user_input" : "ready_for_confirmation",
    target: invalid ? undefined : { scope: "channel", workspaceId: "workspace_default", channelId: "channel_engineering", cwd },
    title: invalid ? "Needs target review" : prompt,
    trigger: invalid ? { type: "manual" } : { type: "schedule", timezone: "UTC", schedule: { cadence: "interval", everyMs: 60_000 }, missedRunPolicy: "skip" },
    updatedAt: now(12),
    warnings: invalid ? [{ code: "target_required", field: "target", message: "Choose a real target before confirming." }] : [],
    workspaceId: "workspace_default",
    ...partial,
  };
}

function createRun(definition: Record<string, unknown>, status: "failed" | "succeeded"): Record<string, unknown> {
  return {
    automationId: definition.id,
    completedAt: now(31),
    errorMessage: status === "failed" ? "Provider execution failed in fixture." : undefined,
    firedAt: now(30),
    id: `automation_run_${definition.id}_${status}`,
    idempotencyKey: `automation:${definition.id}:${status}`,
    outputArtifactIds: status === "succeeded" ? ["artifact_ui2"] : [],
    runId: `run_${definition.id}_${status}`,
    startedAt: now(30),
    status,
    threadId: definition.threadId,
    triggerType: "manual",
    workspaceId: "workspace_default",
  };
}

function createTemplates(): Record<string, unknown>[] {
  return [
    createTemplate("daily_brief", "Daily Brief", "Write today's brief."),
    createTemplate("bug_scan", "Bug Scan", "Identify likely regressions with evidence."),
  ];
}

function createTemplate(id: string, title: string, prompt: string): Record<string, unknown> {
  return {
    category: "engineering",
    defaultExecutionPolicy: { providerPresetId: "provider_local", allowedTools: ["read"], approvalProfile: { mode: "none" } },
    defaultOutputPolicy: { destinations: [{ type: "automation_thread" }], artifactFormat: "markdown" },
    defaultPromptTemplate: { templateVersion: 1, promptMarkdown: prompt, contextSelectors: [], maxContextItems: 32 },
    defaultTrigger: { type: "manual" },
    description: "Inspect recent runs and artifacts for likely regressions with evidence.",
    id,
    kind: id === "daily_brief" ? "daily_brief" : "custom_prompt",
    requirements: [],
    tags: ["ui2"],
    title,
  };
}

function scheduledTrigger(timeOfDay: string): Record<string, unknown> {
  return { type: "schedule", timezone: "UTC", schedule: { cadence: "daily", timeOfDay }, missedRunPolicy: "skip" };
}

function refreshScheduler(fixture: AutomationFixture, status: "running" | "stopped"): void {
  fixture.schedulers = [createScheduler(fixture.definitions, status)];
}

function createScheduler(definitions: readonly Record<string, unknown>[], status: "running" | "stopped"): Record<string, unknown> {
  const scheduled = definitions.filter((definition) => definition.status === "enabled" && isRecord(definition.trigger) && definition.trigger.type === "schedule");
  return {
    automationCount: scheduled.length,
    cwd,
    id: "scheduler_ui2",
    items: scheduled.map((definition) => ({ automationId: definition.id, title: definition.title, nextRunAt: now(60) })),
    nextRunAt: scheduled.length ? now(60) : undefined,
    startedAt: now(1),
    status,
    stoppedAt: status === "stopped" ? now(2) : undefined,
    tickCount: 4,
  };
}

function createAutomationThread(definition: Record<string, unknown>): Record<string, unknown> {
  return {
    createdAt: definition.createdAt,
    id: definition.threadId,
    kind: "automation",
    objective: String(definition.title),
    status: "open",
    title: definition.title,
    updatedAt: definition.updatedAt,
    workspaceId: "workspace_default",
  };
}

function createContext(title: string): Record<string, unknown> {
  return {
    contextMarkdown: `Context for ${title}`,
    renderedPrompt: `Run ${title} with verified evidence.`,
    selectedRefs: [{ kind: "recent_runs", id: "run_fixture", label: "Recent runs" }],
    warnings: [],
  };
}

function readSchedulerStatus(fixture: AutomationFixture): "running" | "stopped" {
  return fixture.schedulers[0]?.status === "stopped" ? "stopped" : "running";
}

function readTargetScope(definition: Record<string, unknown> | undefined): unknown {
  return definition && isRecord(definition.target) ? definition.target.scope : undefined;
}

async function initializePage(page: Page, locale: "en-US" | "zh-CN", theme: "dark" | "light"): Promise<void> {
  await page.addInitScript(({ locale, theme }) => {
    localStorage.setItem("ling-stack.locale", locale);
    localStorage.setItem("ling-stack.themePreference", theme);
  }, { locale, theme });
}

async function openAutomations(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "Automations" }).click();
  await expect(page.locator("[data-automation-ui2-page]")).toBeVisible();
}

function watchRuntime(page: Page): { readonly assertClean: (allowedStatuses?: readonly number[]) => Promise<void> } {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  return {
    async assertClean(allowedStatuses = []): Promise<void> {
      const unexpectedConsole = consoleErrors.filter((message) => !allowedStatuses.some((status) => message.includes(`status of ${status}`)));
      expect(pageErrors, "page errors").toEqual([]);
      expect(unexpectedConsole, "unexpected console errors").toEqual([]);
    },
  };
}

async function assertNoHorizontalOverflow(page: Page, surface: ReturnType<Page["locator"]>): Promise<void> {
  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.body.clientWidth,
  }));
  expect(overflow.document).toBeLessThanOrEqual(1);
  expect(overflow.body).toBeLessThanOrEqual(1);
  expect(await surface.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
}

async function expectBackgroundToMatchToken(
  locator: ReturnType<Page["locator"]>,
  token: string,
): Promise<void> {
  const result = await locator.evaluate((element, property) => {
    const probe = document.createElement("span");
    probe.style.backgroundColor = `var(${property})`;
    probe.style.position = "fixed";
    probe.style.pointerEvents = "none";
    document.body.append(probe);
    const expected = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return {
      actual: getComputedStyle(element).backgroundColor,
      expected,
    };
  }, token);
  expect(result.actual).toBe(result.expected);
}

async function captureEvidence(
  page: Page,
  filename: string,
  input: { readonly width: number; readonly height: number },
): Promise<void> {
  if (process.env.LING_CAPTURE_UI2_EVIDENCE !== "1") return;
  await page.setViewportSize({ width: input.width, height: input.height });
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({ animations: "disabled", fullPage: true, path: `${evidenceDirectory}${filename}` });
}

async function dismissToasts(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const button of document.querySelectorAll<HTMLButtonElement>('button[aria-label="Dismiss notification"]')) button.click();
  });
  await expect(page.getByRole("button", { name: "Dismiss notification" })).toHaveCount(0);
}

function now(offsetMinutes: number): string {
  return new Date(Date.parse("2026-07-22T01:00:00.000Z") + offsetMinutes * 60_000).toISOString();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
