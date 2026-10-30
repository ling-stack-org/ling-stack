import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createMockTeammate, isRecord } from "./support/mock-state";
import { openEngineeringChannel } from "./support/test-helpers";

const appShellPath = sourcePath("../src/app/AppShell.tsx");
const teammateDomainPath = sourcePath("../src/domains/teammates/use-teammates-domain.ts");
const teammateErrorControllerPath = sourcePath("../src/domains/teammates/use-teammate-error-controller.ts");
const workspacePath = sourcePath("../src/features/workspace/WorkspaceClientView.tsx");
const managerPanelPath = sourcePath("../src/features/workspace/ChannelTeammateManagerPanel.tsx");

test("T13-P.9EF review 2 freezes visible channel relation ownership and rejection handling", async () => {
  const [appShell, domain, errorController, workspace, managerPanel] = await Promise.all([
    readFile(appShellPath, "utf8"),
    readFile(teammateDomainPath, "utf8"),
    readFile(teammateErrorControllerPath, "utf8"),
    readFile(workspacePath, "utf8"),
    readFile(managerPanelPath, "utf8"),
  ]);

  expect(errorController).toContain("latestTeammateChannelRelationErrorByChannelId");
  expect(errorController).toContain("teammateChannelRelationIdentity(channelId: string, teammateId: string)");
  expect(errorController).toContain("entry.identity === identity && entry.action === action");
  expect(errorController).toContain("isTeammateChannelRelationAction(entry.action)");
  expect(domain).toContain("teammateChannelRelationIdentity(channelId, teammateId)");
  expect(domain).toContain("[cwd, relationshipIdentity, action]");
  expect(domain).toContain('errorController.clear("channel-relation", relationshipIdentity, action)');
  expect(workspace).toContain("onAddChannelTeammate(teammateId).catch(() => undefined)");
  expect(managerPanel).toContain("onRemoveChannelTeammate(teammate.id).catch(() => undefined)");
  expect(managerPanel).toContain('data-channel-teammate-error={channelTeammateError.action}');
  expect(managerPanel).toContain('<InlineFeedback');
  expect(workspace).not.toContain("onSetDefaultChannelTeammate");
  expect(appShell).not.toContain("onSetDefaultChannelTeammate");
});

test("T13-P.9EF review 2 channel teammate failures persist and only same channel action success clears them", async ({ page }) => {
  await preparePage(page);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const state = createBaseState({ approvalStatus: "expired" });
  addResearchChannel(state);
  state.aiTeammates = [
    createMockTeammate({ id: "teammate_engineer", displayName: "Ling Engineer" }),
    createMockTeammate({ id: "teammate_designer", displayName: "Ling Designer" }),
    createMockTeammate({ id: "teammate_qa", displayName: "Ling QA" }),
  ];
  state.teammateChannelMemberships = [channelMembership("teammate_engineer", "channel_engineering")];
  await mockDaemon(page, state);

  let designerMutationCount = 0;
  const addFailure = "Designer could not be added to Engineering.";
  const removeFailure = "Designer could not be removed from Engineering.";
  await page.route(/\/teammates\/teammate_designer\/channels(?:\?.*)?$/u, async (route) => {
    if (route.request().method() !== "PUT") {
      await route.fallback();
      return;
    }
    designerMutationCount += 1;
    const failure = designerMutationCount === 1
      ? addFailure
      : designerMutationCount === 3
        ? removeFailure
        : "";
    if (!failure) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 503,
      json: { error: "channel_teammate_mutation_failed", message: failure },
    });
  });

  await page.goto("/");
  await openEngineeringChannel(page);
  let manager = await openChannelTeammateManager(page);

  await addTeammate(manager, "teammate_designer");
  const addError = relationError(manager, "add");
  await expect(addError).toContainText(addFailure);
  await expect(manager.getByRole("alert")).toHaveCount(1);
  await expect(page.locator('[data-ling-overlay="toast"]').filter({ hasText: addFailure })).toHaveCount(0);
  await expect(page.locator(".task-workbench-window > .inline-error")).toHaveCount(0);

  await page.waitForTimeout(6_200);
  await expect(addError).toContainText(addFailure);

  const navigation = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u });
  await navigation.getByRole("button", { name: "Research", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Research / Research conversation", level: 1, exact: true })).toBeVisible();
  manager = await openChannelTeammateManager(page);
  await expect(manager.locator("[data-channel-teammate-error]")).toHaveCount(0);

  await navigation.getByRole("button", { name: "Engineering", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Engineering / Engineering conversation", level: 1, exact: true })).toBeVisible();
  await page.getByRole("button", { name: "More channel views" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await page.getByLabel("Channel settings navigation").getByRole("tab", { name: "Members" }).click();
  manager = page.getByLabel("Channel teammates");
  await expect(manager).toBeVisible();
  await expect(relationError(manager, "add")).toContainText(addFailure);
  await expect(manager.getByRole("alert")).toHaveCount(1);

  await page.getByRole("button", { name: "Back to channel" }).click();
  manager = await openChannelTeammateManager(page);

  await addTeammate(manager, "teammate_qa");
  await expect(relationError(manager, "add")).toContainText(addFailure);
  await expect(teammateRow(manager, "Ling QA")).toBeVisible();

  await addTeammate(manager, "teammate_designer");
  await expect(relationError(manager, "add")).toHaveCount(0);
  await expect(teammateRow(manager, "Ling Designer")).toBeVisible();

  await removeTeammate(manager, "Ling Designer");
  await expect(relationError(manager, "remove")).toContainText(removeFailure);
  await expect(teammateRow(manager, "Ling Designer")).toBeVisible();

  await removeTeammate(manager, "Ling QA");
  await expect(relationError(manager, "remove")).toContainText(removeFailure);
  await expect(teammateRow(manager, "Ling QA")).toHaveCount(0);

  await removeTeammate(manager, "Ling Designer");
  await expect(relationError(manager, "remove")).toHaveCount(0);
  await expect(teammateRow(manager, "Ling Designer")).toHaveCount(0);
  await expectUnhandledRejections(page, []);
  expect(pageErrors).toEqual([]);
});

function sourcePath(relativePath: string): string {
  return fileURLToPath(new URL(relativePath, import.meta.url));
}

async function preparePage(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
    const selection = { mode: "fixed", themeId: "ling-light" };
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    const unhandledRejections: string[] = [];
    Object.defineProperty(window, "__ui2UnhandledRejections", {
      configurable: true,
      value: unhandledRejections,
    });
    window.addEventListener("unhandledrejection", (event) => {
      unhandledRejections.push(event.reason instanceof Error ? event.reason.message : String(event.reason));
    });
  });
}

async function openChannelTeammateManager(page: Page) {
  const openButton = page.locator(".channel-team-stack-button, .task-toolbar-teammates");
  await expect(openButton).toBeVisible();
  if (await openButton.getAttribute("aria-expanded") !== "true") {
    await openButton.click();
  }
  const manager = page.getByRole("region", { name: "Channel teammates" });
  await expect(manager).toBeVisible();
  return manager;
}

async function addTeammate(manager: Locator, teammateId: string): Promise<void> {
  await manager.getByLabel("Add teammate").selectOption(teammateId);
  await manager.getByRole("button", { name: "Add", exact: true }).click();
}

async function removeTeammate(manager: Locator, displayName: string): Promise<void> {
  await teammateRow(manager, displayName).getByRole("button", { name: "Remove from channel" }).click();
}

function teammateRow(manager: Locator, displayName: string) {
  return manager.locator(".channel-teammate-chip").filter({ hasText: displayName });
}

function relationError(manager: Locator, action: "add" | "remove" | "set-default") {
  return manager.locator(`[data-channel-teammate-error="${action}"]`);
}

function addResearchChannel(state: ReturnType<typeof createBaseState>): void {
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

async function expectUnhandledRejections(page: Page, expected: readonly string[]): Promise<void> {
  await expect.poll(() => page.evaluate(() => (
    (window as Window & { readonly __ui2UnhandledRejections?: readonly string[] }).__ui2UnhandledRejections ?? []
  ))).toEqual(expected);
}
