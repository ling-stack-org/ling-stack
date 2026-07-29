import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import {
  createBaseState,
  createChatProvider,
  createMockTeammate,
} from "./support/mock-state";

const teammateDomainPath = fileURLToPath(new URL(
  "../src/domains/teammates/use-teammates-domain.ts",
  import.meta.url,
));
const teammateErrorControllerPath = fileURLToPath(new URL(
  "../src/domains/teammates/use-teammate-error-controller.ts",
  import.meta.url,
));
const teammateCreateDrawerPath = fileURLToPath(new URL(
  "../src/features/teammates/TeammateCreateDrawer.tsx",
  import.meta.url,
));
const teammateManagementListPath = fileURLToPath(new URL(
  "../src/features/teammates/TeammateManagementList.tsx",
  import.meta.url,
));
const teammateIdentityErrorPath = fileURLToPath(new URL(
  "../src/features/teammates/useTeammateIdentityError.ts",
  import.meta.url,
));
const teammateProfileControllerPath = fileURLToPath(new URL(
  "../src/features/teammates/useTeammateProfileController.ts",
  import.meta.url,
));
const appShellPath = fileURLToPath(new URL("../src/app/AppShell.tsx", import.meta.url));

test("T13-P.9EF.C releases the generic writer and freezes keyed teammate owners", async () => {
  const [domain, errors, drawer, list, identityError, profileController, appShell] = await Promise.all([
    readFile(teammateDomainPath, "utf8"),
    readFile(teammateErrorControllerPath, "utf8"),
    readFile(teammateCreateDrawerPath, "utf8"),
    readFile(teammateManagementListPath, "utf8"),
    readFile(teammateIdentityErrorPath, "utf8"),
    readFile(teammateProfileControllerPath, "utf8"),
    readFile(appShellPath, "utf8"),
  ]);

  expect(domain).not.toContain("setErrorMessage");
  expect(readHookCall(appShell, "useTeammatesDomain")).not.toContain("setErrorMessage");
  expect(errors).toContain('export type TeammateErrorSurface = "list" | "teammate" | "channel-relation";');
  expect(errors).toContain("entry.surface !== surface || entry.identity !== identity");
  expect(errors).toContain("entry.action !== action");
  expect(domain).toContain("useLatestKeyedRequestGuard");
  expect(domain).toContain("isCurrentMutationRequest");
  expect(domain).toContain("isCurrentChannelRelationRequest");
  expect(domain).toContain("activeCreateIdentityRef.current === draftIdentity");
  expect(drawer).toContain("draftId: draftIdentityRef.current");
  expect(drawer).toContain("createRequestRevisionRef.current !== requestRevision");
  expect(list).toContain("data-teammate-action-error={row.draft.id}");
  expect(identityError).toContain("errorByIdentity[identity]");
  expect(profileController).toContain('requestOwner.begin("profile")');
  expect(profileController).toContain("requestOwner.isActionCurrent(operation)");
  expect(profileController).toContain("requestOwner.reportError(operation");
  expect(appShell).toContain("actionErrorMessagesByTeammateId={teammateActionErrorMessagesById}");
});

test("T13-P.9EF.C teammate list failure stays out of Channel", async ({ page }) => {
  await prepareSurface(page);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createTeammateState();
  await mockDaemon(page, state);
  let failList = false;
  await page.route("**/teammates?**", async (route) => {
    if (route.request().method() !== "GET" || !failList) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 503,
      json: { error: "teammate_list_failed", message: "Owned teammate list failure" },
    });
  });

  await page.goto("/");
  const panel = await openTeammateManagement(page);
  await expect(panel.getByLabel("Teammate list").locator(".teammate-draft-row")).toHaveCount(2);
  failList = true;
  await panel.getByRole("button", { name: "Refresh teammates" }).click();
  await expect(panel).toContainText("Teammates could not be refreshed. The last loaded list is still shown.");

  await page.getByLabel("Settings sections").getByRole("button", { name: "Back to app" }).click();
  await page.getByLabel("Ling Stack navigation").getByRole("button").filter({ hasText: "Engineering" }).first().click();
  await expect(page.getByLabel("Channel composer")).toBeVisible();
  await expect(page.getByText("Owned teammate list failure", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Teammates could not be refreshed. The last loaded list is still shown.", { exact: true })).toHaveCount(0);
  await expect(page.locator(".task-workbench-window > .inline-error")).toHaveCount(0);
  expect(runtimeErrors).toEqual([]);
});

test("T13-P.9EF.C one teammate success cannot clear another teammate failure", async ({ page }) => {
  await prepareSurface(page);
  const runtimeErrors = collectRuntimeErrors(page);
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
  });

  await page.goto("/");
  const panel = await openTeammateManagement(page);
  await runRowMenuAction(page, teammateRow(panel, "Ling Engineer"), "Pin");
  await expect(teammateActionError(panel, "teammate_engineer")).toContainText("Engineer pin belongs to Engineer");

  await runRowMenuAction(page, teammateRow(panel, "Ling Designer"), "Pin");
  await expect(teammateActionError(panel, "teammate_designer")).toHaveCount(0);
  await expect(teammateActionError(panel, "teammate_engineer")).toContainText("Engineer pin belongs to Engineer");
  expect(runtimeErrors).toEqual([]);
});

test("T13-P.9EF.C a late Engineer failure cannot pollute the selected Designer", async ({ page }) => {
  await prepareSurface(page);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createTeammateState();
  await mockDaemon(page, state);
  const requestStarted = deferred();
  const releaseFailure = deferred();
  await page.route(/\/teammates\/teammate_engineer(?:\?.*)?$/u, async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.fallback();
      return;
    }
    requestStarted.resolve();
    await releaseFailure.promise;
    await route.fulfill({
      status: 503,
      json: { error: "late_engineer_failure", message: "Late Engineer failure" },
    });
  });

  await page.goto("/");
  let panel = await openTeammateManagement(page);
  const engineerRow = teammateRow(panel, "Ling Engineer");
  await engineerRow.getByRole("button", { name: "Teammate actions" }).click();
  await page.getByRole("menuitem", { name: "Pin" }).click();
  await requestStarted.promise;

  await teammateRow(panel, "Ling Designer").getByRole("button", { name: "Open chat in app" }).click();
  await expect(page.getByRole("heading", { name: "Ling Designer", level: 1 })).toBeVisible();
  releaseFailure.resolve();
  await page.waitForResponse((response) => response.status() === 503 && response.url().includes("/teammates/teammate_engineer"));
  await expect(page.getByText("Late Engineer failure", { exact: true })).toHaveCount(0);
  await expect(page.locator(".workspace-teammate-private-surface > .inline-error")).toHaveCount(0);

  panel = await openTeammateManagement(page);
  await expect(teammateActionError(panel, "teammate_engineer")).toContainText("Late Engineer failure");
  await expect(teammateActionError(panel, "teammate_designer")).toHaveCount(0);
  expect(runtimeErrors).toEqual([]);
});

test("T13-P.9EF.C a late private workspace load error stays with its teammate", async ({ page }) => {
  await prepareSurface(page);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createTeammateState();
  await mockDaemon(page, state);
  const requestStarted = deferred();
  const releaseFailure = deferred();
  await page.route(/\/teammates\/teammate_engineer\/direct-messages(?:\?.*)?$/u, async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    requestStarted.resolve();
    await releaseFailure.promise;
    await route.fulfill({
      status: 503,
      json: { error: "late_private_load", message: "Late Engineer private load" },
    });
  });

  await page.goto("/");
  const panel = await openTeammateManagement(page);
  await teammateRow(panel, "Ling Engineer").getByRole("button", { name: "Open chat in app" }).click();
  await requestStarted.promise;

  const navigation = page.getByLabel("Ling Stack navigation");
  await navigation.getByRole("button").filter({ hasText: "Ling Designer" }).first().click();
  await expect(page.getByRole("heading", { name: "Ling Designer", level: 1 })).toBeVisible();
  releaseFailure.resolve();
  await page.waitForResponse((response) => response.status() === 503 && response.url().includes("/teammates/teammate_engineer/direct-messages"));
  await expect(page.getByText("Late Engineer private load", { exact: true })).toHaveCount(0);
  await expect(page.locator(".workspace-teammate-private-surface > .inline-error")).toHaveCount(0);
  expect(runtimeErrors).toEqual([]);
});

test("T13-P.9EF.C create failure remains in its draft progress flow", async ({ page }) => {
  await prepareSurface(page);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createTeammateState();
  state.providers = [createChatProvider({
    id: "provider_broken",
    providerId: "broken-relay",
    displayName: "Broken Relay",
    lastCheck: { ok: true, message: "ok", checkedAt: "2026-05-22T00:00:00.000Z" },
  })];
  await mockDaemon(page, state, { providerCheckModelUnsupportedProviderIds: ["broken-relay"] });

  await page.goto("/");
  await openTeammateManagement(page);
  await page.getByLabel("Teammate templates").getByRole("button", { name: "New AI teammate" }).click();
  const dialog = page.getByRole("dialog", { name: "Create AI teammate" });
  await dialog.getByRole("button", { name: /Start from blank/u }).click();
  await dialog.getByLabel("Teammate name").fill("Scoped Draft");
  await dialog.getByLabel("Base model").selectOption("provider_broken");
  await dialog.getByRole("button", { name: "Create and verify" }).click();

  const progress = dialog.getByLabel("Teammate setup progress");
  await expect(progress).toContainText("Setup needs attention");
  await expect(progress).toContainText("Provider rejected the endpoint or model");
  await expect(page.locator("[data-teammate-action-error]")).toHaveCount(0);
  await expect(page.locator(".task-workbench-window > .inline-error")).toHaveCount(0);

  await dialog.getByRole("button", { name: "Close" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: "Back to app" }).click();
  await page.getByLabel("Ling Stack navigation").getByRole("button").filter({ hasText: "Engineering" }).first().click();
  await expect(page.getByText("Provider rejected the endpoint or model", { exact: false })).toHaveCount(0);
  expect(runtimeErrors).toEqual([]);
});

function createTeammateState(): ReturnType<typeof createBaseState> {
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({
    id: "provider_ready",
    displayName: "Local Relay",
    lastCheck: { ok: true, message: "ok", checkedAt: "2026-05-22T00:00:00.000Z" },
  })];
  state.aiTeammates = [
    createMockTeammate({
      id: "teammate_engineer",
      displayName: "Ling Engineer",
      providerPresetId: "provider_ready",
      pinned: false,
    }),
    createMockTeammate({
      id: "teammate_designer",
      templateId: "designer",
      roleKey: "designer",
      displayName: "Ling Designer",
      providerPresetId: "provider_ready",
      pinned: false,
    }),
  ];
  return state;
}

async function prepareSurface(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify({ mode: "fixed", themeId: "ling-light" }));
  });
}

async function openTeammateManagement(page: Page): Promise<Locator> {
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: "Teammate Management" }).click();
  const panel = page.getByLabel("Workspace teammates");
  await expect(panel).toBeVisible();
  return panel;
}

function teammateRow(panel: Locator, displayName: string): Locator {
  return panel.locator(".teammate-draft-row").filter({ hasText: displayName });
}

function teammateActionError(panel: Locator, teammateId: string): Locator {
  return panel.locator(`[data-teammate-action-error="${teammateId}"]`);
}

async function runRowMenuAction(page: Page, row: Locator, action: string): Promise<void> {
  await row.getByRole("button", { name: "Teammate actions" }).click();
  await page.getByRole("menuitem", { name: action }).click();
}

function readHookCall(source: string, hook: string): string {
  const start = source.indexOf(`${hook}({`);
  if (start < 0) throw new Error(`Missing ${hook} call`);
  const end = source.indexOf("\n  });", start);
  if (end < 0) throw new Error(`Missing ${hook} call boundary`);
  return source.slice(start, end);
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((next) => { resolve = next; });
  return { promise, resolve };
}

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror:${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) {
      errors.push(`console:${message.text()}`);
    }
  });
  return errors;
}
