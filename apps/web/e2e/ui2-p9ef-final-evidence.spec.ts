import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  mockDaemon,
  type MockManagedPlugin,
  type MockState,
} from "./support/mock-daemon";
import {
  createBaseState,
  createChatProvider,
  createMockTeammate,
  cwd,
  isRecord,
} from "./support/mock-state";
import { openEngineeringChannel } from "./support/test-helpers";
import {
  assertUi2P9efObservation,
  captureUi2P9efScenario,
  isUi2P9efCaptureEnabled,
  observeUi2P9efScenario,
  prepareUi2P9efSurface,
  snapshotUi2P9efEvidenceDirectory,
  watchUi2P9efRuntime,
  type Ui2P9efRuntimeMonitor,
  type Ui2P9efScenarioDefinition,
} from "./support/ui2-p9ef-evidence";

const console503 = "^Failed to load resource: the server responded with a status of 503 \\(Service Unavailable\\)$";
const scenarios = {
  conversationBetaClean: scenario({
    stableId: "p9ef-conversation-beta-clean-after-late-alpha",
    label: "Beta remains clean after Alpha stream fails late",
    functionIds: ["CONV-NORMAL-COMPOSER-001", "CONV-NORMAL-FEED-001"],
    fixture: "conversation-alpha-beta-late-stream",
    trigger: {
      summary: "Start Alpha, switch to Beta, then release Alpha's failed stream",
      steps: ["Open Alpha", "Send an Alpha message", "Switch to Beta before completion", "Release the synthetic 503"],
    },
    owner: { surface: "normal-conversation", scope: "thread-stream", key: "thread_p9ef_beta" },
    assertions: {
      visible: ["Beta heading and Beta transcript"],
      absent: ["Alpha failure", "Alpha optimistic message", "Alpha busy state"],
    },
    expectedHttpFailures: [http503("POST", "^/conversations/stream(?:\\?.*)?$", 1)],
    overflowOwners: [{ label: "Conversation page", selector: "[aria-label='Conversation page']" }],
    viewport: { width: 1440, height: 960 },
    theme: "ling-light",
    locale: "en-US",
    keyboard: { exercised: true, checks: ["Beta Search accepts keyboard focus"] },
    reducedMotion: "no-preference",
  }),
  conversationAlphaRestored: scenario({
    stableId: "p9ef-conversation-alpha-failure-restored",
    label: "Alpha failure is restored only when Alpha is reopened",
    functionIds: ["CONV-NORMAL-COMPOSER-001", "FEEDBACK-ALERT-001"],
    fixture: "conversation-alpha-beta-late-stream",
    trigger: {
      summary: "Return to Alpha after its late stream failure was hidden on Beta",
      steps: ["Fail Alpha after switching to Beta", "Verify Beta is clean", "Reopen Alpha"],
    },
    owner: { surface: "normal-conversation", scope: "thread-stream", key: "thread_p9ef_alpha" },
    assertions: {
      visible: ["Alpha failure restored on its owning thread"],
      absent: ["Beta-owned failure"],
    },
    expectedHttpFailures: [http503("POST", "^/conversations/stream(?:\\?.*)?$", 1)],
    overflowOwners: [{ label: "Conversation page", selector: "[aria-label='Conversation page']" }],
    viewport: { width: 1440, height: 960 },
    theme: "ling-light",
    locale: "en-US",
    keyboard: { exercised: true, checks: ["Alpha composer accepts keyboard focus"] },
    reducedMotion: "no-preference",
  }),
  conversationDraftClean: scenario({
    stableId: "p9ef-conversation-new-draft-clean-after-stale-upload",
    label: "A new draft ignores a stale attachment upload",
    functionIds: ["CONV-NORMAL-COMPOSER-001"],
    fixture: "conversation-draft-generation-stale-upload",
    trigger: {
      summary: "Begin an upload, create another draft, then release the old upload",
      steps: ["Open a new conversation", "Start attachment upload", "Create a second new conversation", "Release old upload"],
    },
    owner: { surface: "normal-conversation", scope: "draft-attachment", key: "draft-generation-2" },
    assertions: {
      visible: ["Empty new conversation composer"],
      absent: ["Old attachment chip", "Old upload busy state", "Old upload error"],
    },
    expectedHttpFailures: [],
    overflowOwners: [{ label: "Conversation home", selector: "[aria-label='Conversation home']" }],
    viewport: { width: 1280, height: 800 },
    theme: "ling-dark",
    locale: "en-US",
    keyboard: { exercised: true, checks: ["New conversation composer accepts keyboard focus"] },
    reducedMotion: "reduce",
  }),
  teammateDesignerClean: scenario({
    stableId: "p9ef-teammate-designer-clean-after-late-engineer",
    label: "Designer ignores Engineer's late private-chat snapshot",
    functionIds: ["CONV-TEAMMATE-FEED-001", "CONV-TEAMMATE-HEADER-001"],
    fixture: "teammate-private-late-success",
    trigger: {
      summary: "Delay Engineer history, switch to Designer, then release Engineer",
      steps: ["Open Engineer chat", "Wait for Engineer request", "Switch to Designer", "Release Engineer response"],
    },
    owner: { surface: "teammate-private-chat", scope: "teammate-workspace", key: "teammate_designer" },
    assertions: {
      visible: ["Designer heading", "Designer private message"],
      absent: ["Engineer private message", "Engineer loading state", "Engineer error"],
    },
    expectedHttpFailures: [],
    overflowOwners: [{ label: "Teammate private chat", selector: ".workspace-teammate-private-surface" }],
    viewport: { width: 1280, height: 800 },
    theme: "ling-dark",
    locale: "en-US",
    keyboard: { exercised: true, checks: ["Designer Search accepts keyboard focus"] },
    reducedMotion: "reduce",
  }),
  teammateEngineerError: scenario({
    stableId: "p9ef-teammate-engineer-error-after-designer-success",
    label: "Designer success does not clear Engineer's row failure",
    functionIds: ["FEEDBACK-ALERT-001"],
    fixture: "teammate-management-row-owner",
    trigger: {
      summary: "Fail Engineer Pin, then successfully Pin Designer",
      steps: ["Open Teammate Management", "Pin Engineer and receive 503", "Pin Designer successfully"],
    },
    owner: { surface: "teammate-management", scope: "teammate-mutation", key: "teammate_engineer:pin" },
    assertions: {
      visible: ["Engineer row failure", "Designer pinned state"],
      absent: ["Engineer failure on Designer row"],
    },
    expectedHttpFailures: [http503("PATCH", "^/teammates/teammate_engineer(?:\\?.*)?$", 1)],
    overflowOwners: [{ label: "Teammate management", selector: "[aria-label='Workspace teammates']" }],
    viewport: { width: 1440, height: 960 },
    theme: "ling-light",
    locale: "en-US",
    keyboard: { exercised: true, checks: ["Engineer row actions accept keyboard focus"] },
    reducedMotion: "no-preference",
  }),
  pluginRowFailure: scenario({
    stableId: "p9ef-plugin-row-failure-after-unrelated-success",
    label: "Plugin row failure survives unrelated success and Toast dismissal",
    functionIds: ["PLUGIN-CHECK-001", "FEEDBACK-ALERT-001"],
    fixture: "plugin-owner-a-owner-b",
    trigger: {
      summary: "Fail Owner A check late while Owner B succeeds",
      steps: ["Start Owner A check", "Check Owner B", "Receive Owner A 503", "Dismiss Toast"],
    },
    owner: { surface: "plugin-manager", scope: "row-check", key: "built-in:owner-a:check:row" },
    assertions: {
      visible: ["Owner A persistent row failure", "Owner B ready row"],
      absent: ["Owner A failure on Owner B", "Dismissed error Toast"],
    },
    expectedHttpFailures: [http503("POST", "^/plugins/(?:built-in%3A|built-in:)owner-a/check(?:\\?.*)?$", 1)],
    overflowOwners: [{ label: "Plugin manager", selector: ".settings-plugin-manager" }],
    viewport: { width: 1440, height: 960 },
    theme: "ling-light",
    locale: "en-US",
    keyboard: { exercised: true, checks: ["Owner A Retry accepts keyboard focus"] },
    reducedMotion: "no-preference",
  }),
  shellSettingsRestored: scenario({
    stableId: "p9ef-shell-settings-error-restored",
    label: "Settings failure persists, hides on exit, and restores on return",
    functionIds: ["FEEDBACK-SHELL-001", "SETTINGS-AUTH-PRESET-001"],
    fixture: "workspace-settings-persistent-error",
    trigger: {
      summary: "Fail authorization save, wait six seconds, leave Settings, then return",
      steps: ["Open Default authorization", "Choose Ask first", "Wait more than six seconds", "Leave Settings", "Return to Settings"],
    },
    owner: { surface: "settings", scope: "workspace-settings", key: "defaultAuthorizationMode" },
    assertions: {
      visible: ["Restored scoped Settings Toast"],
      absent: ["Settings error outside Settings"],
    },
    expectedHttpFailures: [http503("PATCH", "^/workspace-settings(?:\\?.*)?$", 1)],
    overflowOwners: [{ label: "Settings shell", selector: ".workspace-settings-surface" }],
    viewport: { width: 1280, height: 800 },
    theme: "ling-dark",
    locale: "en-US",
    keyboard: { exercised: true, checks: ["Restored Toast dismiss action accepts keyboard focus"] },
    reducedMotion: "reduce",
  }),
  channelTeammateRestored: scenario({
    stableId: "p9ef-channel-teammate-add-failure-restored",
    label: "Channel teammate Add failure restores only on its channel",
    functionIds: ["CHANNEL-HEADER-001", "CHANNEL-SETTINGS-001", "FEEDBACK-ALERT-001"],
    fixture: "channel-teammate-engineering-research",
    trigger: {
      summary: "Fail Designer Add in Engineering, visit Research, then return",
      steps: ["Open Engineering manager", "Add Designer and receive 503", "Open Research", "Return to Engineering"],
    },
    owner: { surface: "channel-teammate-manager", scope: "channel-relation-add", key: "channel_engineering:teammate_designer" },
    assertions: {
      visible: ["Engineering Add failure after return"],
      absent: ["Engineering failure in Research", "Unhandled rejection"],
    },
    expectedHttpFailures: [http503("PUT", "^/teammates/teammate_designer/channels(?:\\?.*)?$", 1)],
    overflowOwners: [{ label: "Channel workspace", selector: ".task-workbench-window" }],
    viewport: { width: 1280, height: 800 },
    theme: "ling-light",
    locale: "en-US",
    keyboard: { exercised: true, checks: ["Channel teammate selector accepts keyboard focus"] },
    reducedMotion: "reduce",
  }),
} as const;

test.describe.configure({ mode: "serial" });
let evidenceDirectoryBefore = "";

test.beforeAll(async () => {
  if (!isUi2P9efCaptureEnabled()) evidenceDirectoryBefore = await snapshotUi2P9efEvidenceDirectory();
});

test.afterAll(async () => {
  if (!isUi2P9efCaptureEnabled()) {
    expect(await snapshotUi2P9efEvidenceDirectory()).toBe(evidenceDirectoryBefore);
  }
});

test("P9EF-EVIDENCE-01 Beta remains clean after Alpha fails late", async ({ page }) => {
  const runtime = await begin(page, scenarios.conversationBetaClean);
  const state = createConversationState();
  await mockDaemon(page, state);
  const gate = deferred();
  await installLateConversationFailure(page, gate, "Late Alpha stream failure.");
  await page.goto("/");
  const navigation = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u });
  await openConversation(page, navigation, alpha);
  await sendConversation(page, "Keep this failure with Alpha");
  await gate.started.promise;
  await openConversation(page, navigation, beta);
  const response = page.waitForResponse((item) => item.status() === 503 && item.url().includes("/conversations/stream"));
  gate.release.resolve();
  await response;
  const betaPage = page.getByLabel("Conversation page");
  await expect(betaPage.getByText("Late Alpha stream failure.", { exact: true })).toHaveCount(0);
  await expect(betaPage.getByLabel("Conversation messages", { exact: true })).not.toContainText("Keep this failure with Alpha");
  const search = page
    .locator("[data-ui2-normal-conversation-header='true']")
    .getByRole("button", { name: "Search" });
  await search.focus();
  await expect(search).toBeFocused();
  await finish(page, scenarios.conversationBetaClean, runtime);
});

test("P9EF-EVIDENCE-02 Alpha failure restores on Alpha only", async ({ page }) => {
  const runtime = await begin(page, scenarios.conversationAlphaRestored);
  const state = createConversationState();
  await mockDaemon(page, state);
  const gate = deferred();
  await installLateConversationFailure(page, gate, "Late Alpha stream failure.");
  await page.goto("/");
  const navigation = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u });
  await openConversation(page, navigation, alpha);
  await sendConversation(page, "Keep this failure with Alpha");
  await gate.started.promise;
  await openConversation(page, navigation, beta);
  const response = page.waitForResponse((item) => item.status() === 503 && item.url().includes("/conversations/stream"));
  gate.release.resolve();
  await response;
  await openConversation(page, navigation, alpha);
  const alphaPage = page.getByLabel("Conversation page");
  await expect(alphaPage.getByRole("alert")).toContainText("Late Alpha stream failure.");
  const composer = alphaPage.getByRole("textbox", { name: "Conversation message" });
  await composer.focus();
  await expect(composer).toBeFocused();
  await finish(page, scenarios.conversationAlphaRestored, runtime);
});

test("P9EF-EVIDENCE-03 new draft ignores stale upload", async ({ page }) => {
  const runtime = await begin(page, scenarios.conversationDraftClean);
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [readyProvider("provider_p9ef_draft")];
  await mockDaemon(page, state);
  const upload = deferred();
  await page.route(/\/conversations\/attachments(?:\?.*)?$/u, async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    upload.started.resolve();
    await upload.release.promise;
    await route.fallback();
  }, { times: 1 });
  await page.goto("/");
  const navigation = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u });
  await navigation.getByRole("button", { name: "New conversation" }).click();
  let home = page.getByLabel("Conversation home");
  await home.locator('input[type="file"]').setInputFiles({
    name: "stale-draft.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("stale draft upload", "utf8"),
  });
  await upload.started.promise;
  await navigation.getByRole("button", { name: "New conversation" }).click();
  home = page.getByLabel("Conversation home");
  const response = page.waitForResponse((item) => item.status() === 201 && item.url().includes("/conversations/attachments"));
  upload.release.resolve();
  await response;
  await expect(home.getByLabel("Pending message assets")).toHaveCount(0);
  await expect(home.getByText("stale-draft.txt", { exact: true })).toHaveCount(0);
  const composer = home.getByRole("textbox", { name: "Conversation message" });
  await composer.focus();
  await expect(composer).toBeFocused();
  await finish(page, scenarios.conversationDraftClean, runtime);
});

test("P9EF-EVIDENCE-04 Designer ignores late Engineer snapshot", async ({ page }) => {
  const runtime = await begin(page, scenarios.teammateDesignerClean);
  const state = createTeammateState();
  installPrivateMessage(state, "teammate_engineer", "Engineer stale private message.");
  installPrivateMessage(state, "teammate_designer", "Designer current private message.");
  await mockDaemon(page, state);
  const gate = deferred();
  await page.route(/\/teammates\/teammate_engineer\/direct-messages(?:\?.*)?$/u, async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    gate.started.resolve();
    await gate.release.promise;
    await route.fallback();
  }, { times: 1 });
  await page.goto("/");
  const panel = await openTeammateManagement(page);
  await teammateRow(panel, "Ling Engineer").getByRole("button", { name: "Open chat in app" }).click();
  await gate.started.promise;
  const navigation = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u });
  await navigation.getByRole("button").filter({ hasText: "Ling Designer" }).first().click();
  await expect(page.getByRole("heading", { name: "Ling Designer", level: 1 })).toBeVisible();
  await expect(page.getByText("Designer current private message.", { exact: true })).toBeVisible();
  const response = page.waitForResponse((item) => item.status() === 200 && item.url().includes("/teammates/teammate_engineer/direct-messages"));
  gate.release.resolve();
  await response;
  await expect(page.getByText("Engineer stale private message.", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Designer current private message.", { exact: true })).toBeVisible();
  const search = page.getByRole("toolbar", { name: "Private chat actions" }).getByRole("button", { name: "Search" });
  await search.focus();
  await expect(search).toBeFocused();
  await finish(page, scenarios.teammateDesignerClean, runtime);
});

test("P9EF-EVIDENCE-05 Engineer row error survives Designer success", async ({ page }) => {
  const runtime = await begin(page, scenarios.teammateEngineerError);
  const state = createTeammateState();
  await mockDaemon(page, state);
  await page.route(/\/teammates\/teammate_engineer(?:\?.*)?$/u, async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 503,
      json: { error: "engineer_pin_failed", message: "Engineer pin belongs to Engineer" },
    });
  }, { times: 1 });
  await page.goto("/");
  const panel = await openTeammateManagement(page);
  await runRowMenuAction(page, teammateRow(panel, "Ling Engineer"), "Pin");
  const engineerError = panel.locator('[data-teammate-action-error="teammate_engineer"]');
  await expect(engineerError).toContainText("Engineer pin belongs to Engineer");
  await runRowMenuAction(page, teammateRow(panel, "Ling Designer"), "Pin");
  await expect(engineerError).toContainText("Engineer pin belongs to Engineer");
  await expect(panel.locator('[data-teammate-action-error="teammate_designer"]')).toHaveCount(0);
  const actions = teammateRow(panel, "Ling Engineer").getByRole("button", { name: "Teammate actions" });
  await actions.focus();
  await expect(actions).toBeFocused();
  await finish(page, scenarios.teammateEngineerError, runtime);
});

test("P9EF-EVIDENCE-06 Plugin row failure survives unrelated success", async ({ page }) => {
  const runtime = await begin(page, scenarios.pluginRowFailure);
  const ownerA = readyPlugin("built-in:owner-a", "Owner A");
  const ownerB = readyPlugin("built-in:owner-b", "Owner B");
  const state = createBaseState({ approvalStatus: "expired" });
  state.managedPlugins = [ownerA, ownerB];
  await mockDaemon(page, state);
  let failOwnerACheck = true;
  await page.route("**/plugins/**", async (route) => {
    const match = /^\/plugins\/([^/]+)\/check$/u.exec(new URL(route.request().url()).pathname);
    const pluginId = match ? decodeURIComponent(match[1] ?? "") : "";
    if (route.request().method() !== "POST" || pluginId !== ownerA.id || !failOwnerACheck) {
      await route.fallback();
      return;
    }
    failOwnerACheck = false;
    await new Promise((resolve) => setTimeout(resolve, 350));
    await route.fulfill({ status: 503, json: { error: "plugin_check_failed", message: "Synthetic late Owner A failure" } });
  });
  await openPluginManager(page);
  const firstRow = pluginRow(page, ownerA.id);
  const secondRow = pluginRow(page, ownerB.id);
  await firstRow.getByRole("button", { name: "Check" }).click();
  await secondRow.getByRole("button", { name: "Check" }).click();
  await expect(secondRow.getByRole("alert")).toHaveCount(0);
  const failure = firstRow.getByRole("alert");
  await expect(failure).toHaveAttribute("title", "Plugin action failed. Try again.");
  await expect(failure).not.toContainText("Synthetic late Owner A failure");
  const toast = page.locator('[data-ling-overlay="toast"][data-tone="error"][data-scope="plugin:built-in:owner-a:check:row"]');
  await expect(toast).toContainText("Plugin action failed. Try again.");
  await expect(toast).not.toContainText("Synthetic late Owner A failure");
  await toast.locator(".ling-ui-toast-close").click({ force: true });
  await expect(failure).toBeVisible();
  const retry = firstRow.getByRole("button", { name: "Retry" });
  await retry.focus();
  await expect(retry).toBeFocused();
  await finish(page, scenarios.pluginRowFailure, runtime);
});

test("P9EF-EVIDENCE-07 Settings error restores after surface return", async ({ page }) => {
  const runtime = await begin(page, scenarios.shellSettingsRestored);
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  let failAuthorizationSave = true;
  await page.route(/\/workspace-settings(?:\?.*)?$/u, async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.fallback();
      return;
    }
    const body = await route.request().postDataJSON() as Record<string, unknown>;
    if (body.defaultAuthorizationMode === undefined || !failAuthorizationSave) {
      await route.fallback();
      return;
    }
    failAuthorizationSave = false;
    await route.fulfill({
      status: 503,
      json: { error: "workspace_settings_save_failed", message: "Workspace settings save failed." },
    });
  });
  await page.goto("/");
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "Settings" }).click();
  let settings = page.getByLabel("Settings sections");
  await settings.getByRole("button", { name: "Default authorization" }).click();
  await page.getByRole("radiogroup", { name: "Authorization mode" }).getByRole("radio", { name: "Ask first" }).click();
  const toast = page.locator('.ling-ui-toast[data-scope^="shell-error:workspace-settings:"]');
  await expect(toast).toContainText("Workspace settings save failed.");
  await page.waitForTimeout(6_250);
  await expect(toast).toBeVisible();
  await settings.getByRole("button", { name: "Back to app" }).click();
  await expect(toast).toHaveCount(0);
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "Settings" }).click();
  settings = page.getByLabel("Settings sections");
  await expect(settings).toBeVisible();
  await expect(toast).toContainText("Workspace settings save failed.");
  const dismiss = toast.getByRole("button", { name: "Dismiss notification" });
  await dismiss.focus();
  await expect(dismiss).toBeFocused();
  await finish(page, scenarios.shellSettingsRestored, runtime);
});

test("P9EF-EVIDENCE-08 channel teammate failure restores on Engineering", async ({ page }) => {
  const runtime = await begin(page, scenarios.channelTeammateRestored);
  await page.addInitScript(() => {
    const unhandledRejections: string[] = [];
    Object.defineProperty(window, "__ui2P9efUnhandledRejections", {
      configurable: true,
      value: unhandledRejections,
    });
    window.addEventListener("unhandledrejection", (event) => {
      unhandledRejections.push(event.reason instanceof Error ? event.reason.message : String(event.reason));
    });
  });
  const state = createBaseState({ approvalStatus: "expired" });
  addResearchChannel(state);
  state.aiTeammates = [
    createMockTeammate({ id: "teammate_engineer", displayName: "Ling Engineer" }),
    createMockTeammate({ id: "teammate_designer", displayName: "Ling Designer" }),
  ];
  state.teammateChannelMemberships = [channelMembership("teammate_engineer", "channel_engineering")];
  await mockDaemon(page, state);
  let failDesignerAdd = true;
  await page.route(/\/teammates\/teammate_designer\/channels(?:\?.*)?$/u, async (route) => {
    if (route.request().method() !== "PUT" || !failDesignerAdd) {
      await route.fallback();
      return;
    }
    failDesignerAdd = false;
    await route.fulfill({
      status: 503,
      json: { error: "channel_teammate_mutation_failed", message: "Designer could not be added to Engineering." },
    });
  });
  await page.goto("/");
  await openEngineeringChannel(page);
  let manager = await openChannelTeammateManager(page);
  await addTeammate(manager, "teammate_designer");
  await expect(manager.locator('[data-channel-teammate-error="add"]')).toContainText("Designer could not be added to Engineering.");
  const navigation = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u });
  await navigation.getByRole("button").filter({ hasText: "Research" }).first().click();
  await expect(page.getByRole("heading", { name: "Research", level: 1 })).toBeVisible();
  manager = await openChannelTeammateManager(page);
  await expect(manager.locator("[data-channel-teammate-error]")).toHaveCount(0);
  await navigation.getByRole("button").filter({ hasText: "Engineering" }).first().click();
  await expect(page.getByRole("heading", { name: "Engineering", level: 1 })).toBeVisible();
  manager = await openChannelTeammateManager(page);
  await expect(manager.locator('[data-channel-teammate-error="add"]')).toContainText("Designer could not be added to Engineering.");
  const selector = manager.getByLabel("Add teammate");
  await selector.focus();
  await expect(selector).toBeFocused();
  expect(await page.evaluate(() => (
    (window as Window & { __ui2P9efUnhandledRejections?: string[] }).__ui2P9efUnhandledRejections ?? []
  ))).toEqual([]);
  await finish(page, scenarios.channelTeammateRestored, runtime);
});

function scenario(definition: Ui2P9efScenarioDefinition): Ui2P9efScenarioDefinition {
  return definition;
}

function http503(method: "GET" | "PATCH" | "POST" | "PUT", urlPattern: string, count: number) {
  return { method, status: 503 as const, urlPattern, count };
}

async function begin(page: Page, definition: Ui2P9efScenarioDefinition): Promise<Ui2P9efRuntimeMonitor> {
  await prepareUi2P9efSurface(page, definition);
  return watchUi2P9efRuntime(page);
}

async function finish(page: Page, definition: Ui2P9efScenarioDefinition, runtime: Ui2P9efRuntimeMonitor): Promise<void> {
  await expect.poll(() => page.evaluate(() => document.fonts.status)).toBe("loaded");
  const observation = await observeUi2P9efScenario({ page, scenario: definition, runtime });
  assertUi2P9efObservation(definition, observation);
  expect(observation.expectedConsole503Pattern).toBe(console503);
  await captureUi2P9efScenario({ page, scenario: definition, observation });
}

const alpha = { id: "thread_p9ef_alpha", title: "P9EF Alpha" } as const;
const beta = { id: "thread_p9ef_beta", title: "P9EF Beta" } as const;

function createConversationState(): MockState {
  const state = createBaseState({ approvalStatus: "expired" });
  const providerId = "provider_p9ef_conversation";
  state.providers = [readyProvider(providerId)];
  installConversation(state, alpha, providerId, "2026-07-27T01:00:00.000Z");
  installConversation(state, beta, providerId, "2026-07-27T02:00:00.000Z");
  return state;
}

function installConversation(
  state: MockState,
  conversation: typeof alpha | typeof beta,
  providerId: string,
  timestamp: string,
): void {
  const turnId = `turn_${conversation.id}`;
  const runId = `run_${conversation.id}`;
  state.threads.push({
    id: conversation.id,
    workspaceId: "workspace_default",
    kind: "conversation",
    title: conversation.title,
    objective: `Keep ${conversation.title} isolated.`,
    status: "succeeded",
    lastRunId: runId,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  state.turns.push({
    id: turnId,
    workspaceId: "workspace_default",
    threadId: conversation.id,
    kind: "initial_request",
    status: "succeeded",
    title: conversation.title,
    userInstruction: `${conversation.title} user message`,
    lastRunId: runId,
    createdByActor: "local-user",
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: timestamp,
  });
  state.turnRunLinks.push({ turnId, runId, attemptNumber: 1, role: "primary", createdAt: timestamp });
  state.runs.unshift({
    id: runId,
    status: "succeeded",
    cwd,
    taskId: `task_${conversation.id}`,
    providerPresetId: providerId,
    providerName: "local-relay",
    providerModel: "gpt-5.5",
    taskSnapshot: { id: `task_${conversation.id}`, title: conversation.title },
    providerSnapshot: {},
    requestSnapshot: {},
    eventLogPath: `.ling-stack/sessions/${runId}.jsonl`,
    threadId: conversation.id,
    turnId,
    createdAt: timestamp,
    startedAt: timestamp,
    updatedAt: timestamp,
    endedAt: timestamp,
  });
  state.eventsByRun[runId] = [{
    id: `event_${runId}`,
    runId,
    seq: 1,
    ts: timestamp,
    type: "assistant_text_delta",
    data: { text: `${conversation.title} assistant message` },
  }];
}

async function installLateConversationFailure(page: Page, gate: DeferredGate, message: string): Promise<void> {
  await page.route(/\/conversations\/stream(?:\?.*)?$/u, async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    gate.started.resolve();
    await gate.release.promise;
    await route.fulfill({ status: 503, json: { error: "late_alpha_stream_failed", message } });
  }, { times: 1 });
}

async function openConversation(page: Page, navigation: Locator, conversation: typeof alpha | typeof beta): Promise<void> {
  await navigation.locator(".sidebar-recent-row").filter({ hasText: conversation.title }).click();
  await expect(page.getByRole("heading", { name: conversation.title, level: 1 })).toBeVisible();
}

async function sendConversation(page: Page, message: string): Promise<void> {
  const surface = page.getByLabel("Conversation page");
  await surface.getByRole("textbox", { name: "Conversation message" }).fill(message);
  await surface.getByRole("button", { name: "Send" }).click();
}

function createTeammateState(): MockState {
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [readyProvider("provider_p9ef_teammate")];
  state.aiTeammates = [
    createMockTeammate({ id: "teammate_engineer", displayName: "Ling Engineer", providerPresetId: "provider_p9ef_teammate", pinned: false }),
    createMockTeammate({ id: "teammate_designer", displayName: "Ling Designer", providerPresetId: "provider_p9ef_teammate", pinned: false }),
  ];
  return state;
}

function installPrivateMessage(state: MockState, teammateId: string, body: string): void {
  const timestamp = teammateId === "teammate_engineer" ? "2026-07-27T03:00:00.000Z" : "2026-07-27T03:01:00.000Z";
  state.teammateDirectMessages.push({
    id: `message_${teammateId}`,
    workspaceId: "workspace_default",
    threadId: `tdthread_${teammateId}`,
    teammateId,
    authorType: "ai-teammate",
    authorId: teammateId,
    body,
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
    status: "ready",
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

function readyProvider(id: string) {
  return createChatProvider({
    id,
    displayName: "P9EF Relay",
    model: "gpt-5.5",
    lastCheck: { ok: true, message: "ok", checkedAt: "2026-07-27T00:00:00.000Z" },
  });
}

async function openTeammateManagement(page: Page): Promise<Locator> {
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: "Teammate Management" }).click();
  const panel = page.getByLabel("Workspace teammates");
  await expect(panel).toBeVisible();
  return panel;
}

function teammateRow(panel: Locator, name: string): Locator {
  return panel.locator(".teammate-draft-row").filter({ hasText: name });
}

async function runRowMenuAction(page: Page, row: Locator, action: string): Promise<void> {
  await row.getByRole("button", { name: "Teammate actions" }).click();
  await page.getByRole("menuitem", { name: action }).click();
}

async function openPluginManager(page: Page): Promise<void> {
  await page.goto("/");
  const navigation = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u });
  await navigation.getByRole("button", { name: "Engineering" }).click();
  await navigation.getByRole("button", { name: "Plugin Manager" }).click();
  await expect(page.locator(".settings-plugin-manager .plugin-table-row").first()).toBeVisible();
}

function pluginRow(page: Page, pluginId: string): Locator {
  return page.locator(`.plugin-table-row[data-plugin-id="${pluginId}"]`);
}

function readyPlugin(id: string, displayName: string): MockManagedPlugin {
  return {
    id,
    displayName,
    version: "1.0.0",
    sourceKind: "built-in",
    status: "enabled",
    description: `${displayName} ownership fixture.`,
    trustSummary: "Built into Ling and governed by workspace policy.",
    contributions: [],
    linkedResources: [],
    events: [],
    health: { pluginId: id, checkedAt: "2026-07-27T00:00:00.000Z", expiresAt: "2030-07-27T00:00:00.000Z", status: "ready" },
    actions: {
      canApplyPreset: false,
      canCheck: true,
      canDisable: true,
      canEnable: false,
      canInstall: false,
      canRefreshPackage: false,
      canRuntimePreview: false,
      canUninstall: false,
    },
  };
}

async function openChannelTeammateManager(page: Page): Promise<Locator> {
  const open = page.locator(".channel-team-stack-button, .task-toolbar-teammates");
  await expect(open).toBeVisible();
  if (await open.getAttribute("aria-expanded") !== "true") await open.click();
  const manager = page.getByRole("region", { name: "Channel teammates" });
  await expect(manager).toBeVisible();
  return manager;
}

async function addTeammate(manager: Locator, teammateId: string): Promise<void> {
  await manager.getByLabel("Add teammate").selectOption(teammateId);
  await manager.getByRole("button", { name: "Add", exact: true }).click();
}

function addResearchChannel(state: MockState): void {
  const engineering = state.channels.find((channel) => isRecord(channel) && channel.id === "channel_engineering");
  if (!isRecord(engineering)) throw new Error("Engineering channel fixture is missing");
  state.channels.push({
    ...engineering,
    id: "channel_research",
    name: "Research",
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z",
  });
}

function channelMembership(teammateId: string, channelId: string): Record<string, unknown> {
  return {
    teammateId,
    channelId,
    isDefault: false,
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z",
  };
}

interface DeferredGate {
  readonly started: { readonly promise: Promise<void>; readonly resolve: () => void };
  readonly release: { readonly promise: Promise<void>; readonly resolve: () => void };
}

function deferred(): DeferredGate {
  return { started: deferredSignal(), release: deferredSignal() };
}

function deferredSignal(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((next) => { resolve = next; });
  return { promise, resolve };
}
