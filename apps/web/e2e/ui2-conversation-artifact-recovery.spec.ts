import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import type { TurnWorkspaceChangesResponse } from "@ling-stack/contracts";
import {
  installChannelWorkCellFixture,
} from "./support/conversation-work-cell-fixture";
import { mockDaemon } from "./support/mock-daemon";
import {
  createBaseState,
  cwd,
  type MockArtifact,
  type MockState,
} from "./support/mock-state";
import { captureP6FeedbackEvidence } from "./support/p6-feedback-evidence";
import { openEngineeringChannel } from "./support/test-helpers";

test("artifact Undo and Reapply use one guarded recovery Dialog and refresh state", async ({ page }) => {
  await prepareSurface(page, { theme: "light", width: 1440, height: 960 });
  const runtimeErrors = collectRuntimeErrors(page);
  const browserDialogs: string[] = [];
  page.on("dialog", (dialog) => browserDialogs.push(dialog.type()));

  const fixture = installRecoveryFixture(createBaseState({ approvalStatus: "expired" }), "success");
  await mockDaemon(page, fixture.state);
  let state: RecoveryState = "applied";
  let mutationCalls = 0;
  let releaseMutation: (() => void) | undefined;
  const mutationGate = new Promise<void>((resolve) => {
    releaseMutation = resolve;
  });
  await installRecoveryRoute(page, fixture, async (route, action) => {
    mutationCalls += 1;
    await mutationGate;
    state = action === "undo" ? "undone" : "applied";
    await route.fulfill({ json: recoveryResponse(fixture, state) });
  }, () => state);

  await page.goto("/");
  const surface = await openRecoverySurface(page, fixture.threadId);
  const undo = surface.getByRole("button", { name: "Undo", exact: true });

  await undo.focus();
  await undo.click();
  let dialog = page.getByRole("dialog", { name: "Undo changes to 2 files?" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Workspace changes");
  await expect(dialog).not.toContainText("cannot be undone");
  await expectContained(page, dialog);
  expect(mutationCalls).toBe(0);
  await captureP6FeedbackEvidence(
    page,
    "conversations/conversation-artifact-recovery",
    "1440x960-ling-light-undo-confirm.png",
  );
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(undo).toBeFocused();
  expect(mutationCalls).toBe(0);

  await undo.click();
  dialog = page.getByRole("dialog", { name: "Undo changes to 2 files?" });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(undo).toBeFocused();
  expect(mutationCalls).toBe(0);

  await undo.click();
  dialog = page.getByRole("dialog", { name: "Undo changes to 2 files?" });
  await dialog.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(() => mutationCalls).toBe(1);
  await expect(dialog.locator("button[data-loading='true']")).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await dialog.locator("button[data-loading='true']").evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  expect(mutationCalls).toBe(1);
  releaseMutation?.();

  const reapply = surface.getByRole("button", { name: "Reapply", exact: true });
  await expect(reapply).toBeEnabled();
  await expect(reapply).toBeFocused();
  await reapply.click();
  dialog = page.getByRole("dialog", { name: "Reapply changes to 2 files?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Reapply", exact: true }).click();
  await expect(undo).toBeEnabled();
  await expect(undo).toBeFocused();
  expect(mutationCalls).toBe(2);

  await expectContained(page, surface);
  expect(browserDialogs).toEqual([]);
  expect(runtimeErrors).toEqual([]);
});

test("artifact recovery failure stays actionable in a dark reduced-motion Dialog", async ({ page }) => {
  await prepareSurface(page, { theme: "dark", width: 1280, height: 800, reducedMotion: true });
  const runtimeErrors = collectRuntimeErrors(page);
  const browserDialogs: string[] = [];
  page.on("dialog", (dialog) => browserDialogs.push(dialog.type()));

  const fixture = installRecoveryFixture(createBaseState({ approvalStatus: "expired" }), "failure");
  await mockDaemon(page, fixture.state);
  let state: RecoveryState = "applied";
  let mutationCalls = 0;
  await installRecoveryRoute(page, fixture, async (route, action) => {
    mutationCalls += 1;
    if (mutationCalls <= 2) {
      await route.fulfill({
        status: 503,
        json: { error: "focused_artifact_recovery_failed", message: "Focused artifact recovery failed." },
      });
      return;
    }
    state = action === "undo" ? "undone" : "applied";
    await route.fulfill({ json: recoveryResponse(fixture, state) });
  }, () => state);

  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "ling-dark");
  const surface = await openRecoverySurface(page, fixture.threadId);
  const undo = surface.getByRole("button", { name: "Undo", exact: true });

  await undo.focus();
  await undo.click();
  let dialog = page.getByRole("dialog", { name: "Undo changes to 2 files?" });
  await dialog.getByRole("button", { name: "Undo", exact: true }).click();
  const failure = dialog.getByRole("alert");
  await expect(failure).toContainText("Focused artifact recovery failed.");
  await page.waitForTimeout(250);
  await expect(failure).toBeVisible();
  await expectReducedMotion(page);
  await expectContained(page, dialog);
  await expect(dialog.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  await captureP6FeedbackEvidence(
    page,
    "conversations/conversation-artifact-recovery",
    "1280x800-ling-dark-persistent-failure.png",
  );
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(undo).toBeFocused();
  expect(mutationCalls).toBe(1);

  await undo.click();
  dialog = page.getByRole("dialog", { name: "Undo changes to 2 files?" });
  await dialog.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Focused artifact recovery failed.");
  await dialog.getByRole("button", { name: "Retry", exact: true }).click();

  const reapply = surface.getByRole("button", { name: "Reapply", exact: true });
  await expect(reapply).toBeEnabled();
  await expect(reapply).toBeFocused();
  expect(mutationCalls).toBe(3);
  await expectContained(page, surface);
  expect(browserDialogs).toEqual([]);
  expect(runtimeErrors).toEqual([]);
});

type RecoveryState = "applied" | "undone";

function installRecoveryFixture(state: MockState, suffix: string): {
  readonly runId: string;
  readonly state: MockState;
  readonly threadId: string;
  readonly turnId: string;
} {
  const { runId, threadId } = installChannelWorkCellFixture(state, `artifact_recovery_${suffix}`);
  const turnId = state.turnRunLinks.find((link) => link.runId === runId)?.turnId;
  if (!turnId) throw new Error(`Recovery fixture must link run ${runId} to a Turn`);
  const createdAt = "2026-07-26T02:00:00.000Z";
  const artifacts: MockArtifact[] = [
    diffArtifact(runId, `artifact_recovery_${suffix}_tsx`, "src/RecoverySurface.tsx", createdAt),
    diffArtifact(runId, `artifact_recovery_${suffix}_css`, "src/recovery-surface.css", createdAt),
  ];
  state.artifactsByRun[runId] = artifacts;
  return { runId, state, threadId, turnId };
}

function diffArtifact(runId: string, id: string, path: string, createdAt: string): MockArtifact {
  const contentText = [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1 +1 @@",
    "-export const recovery = false;",
    "+export const recovery = true;",
  ].join("\n");
  return {
    id,
    runId,
    type: "diff",
    path,
    title: path,
    contentType: "text/x-diff; charset=utf-8",
    contentText,
    sizeBytes: contentText.length,
    createdAt,
  };
}

async function installRecoveryRoute(
  page: Page,
  fixture: Pick<ReturnType<typeof installRecoveryFixture>, "runId" | "threadId" | "turnId">,
  onMutation: (route: Route, action: "undo" | "reapply") => Promise<void>,
  readState: () => RecoveryState,
): Promise<void> {
  await page.route(new RegExp(`/turns/${fixture.turnId}/workspace-changes(?:/(undo|reapply))?(?:\\?.*)?$`, "u"), async (route) => {
    const path = new URL(route.request().url()).pathname;
    const action = path.endsWith("/undo") ? "undo" : path.endsWith("/reapply") ? "reapply" : undefined;
    if (route.request().method() === "POST" && action) {
      await onMutation(route, action);
      return;
    }
    await route.fulfill({ json: recoveryResponse(fixture, readState()) });
  });
}

function recoveryResponse(
  fixture: Pick<ReturnType<typeof installRecoveryFixture>, "runId" | "threadId" | "turnId">,
  state: RecoveryState,
): TurnWorkspaceChangesResponse {
  return {
    cwd,
    threadId: fixture.threadId,
    turnId: fixture.turnId,
    runIds: [fixture.runId],
    state,
    canUndo: state === "applied",
    canReapply: state === "undone",
    provenanceComplete: true,
    files: [
      { path: "src/RecoverySurface.tsx", operationCount: 1, additions: 1, deletions: 1 },
      { path: "src/recovery-surface.css", operationCount: 1, additions: 1, deletions: 1 },
    ],
    summary: {
      fileCount: 2,
      addCount: 0,
      updateCount: 2,
      deleteCount: 0,
      moveCount: 0,
      addedLines: 2,
      removedLines: 2,
    },
    updatedAt: "2026-07-26T02:01:00.000Z",
  };
}

async function openRecoverySurface(page: Page, threadId: string): Promise<Locator> {
  await openEngineeringChannel(page);
  const workCell = page.getByLabel("Channel message feed")
    .locator(`.conversation-work-cell[data-thread-id="${threadId}"]`);
  await expect(workCell).toBeVisible();
  const shellToggle = workCell.locator(".conversation-operation-shell-head");
  if (await shellToggle.getAttribute("aria-expanded") === "false") {
    await shellToggle.click();
  }
  const surface = workCell.locator(".conversation-work-cell-change-group");
  await expect(surface).toBeVisible();
  await expect(surface).toContainText("Edited 2 files");
  return surface;
}

async function prepareSurface(page: Page, input: {
  readonly height: number;
  readonly reducedMotion?: boolean;
  readonly theme: "light" | "dark";
  readonly width: number;
}): Promise<void> {
  await page.setViewportSize({ width: input.width, height: input.height });
  await page.emulateMedia({ reducedMotion: input.reducedMotion ? "reduce" : "no-preference" });
  await page.addInitScript((theme) => {
    const selection = { mode: "fixed", themeId: `ling-${theme}` };
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themePreference", theme);
    localStorage.setItem("ling-stack.themeBootstrapPreference", theme);
  }, input.theme);
}

async function expectReducedMotion(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
  const animated = await page.locator(".ling-ui-dialog-content, .ling-ui-dialog-overlay").evaluateAll((elements) =>
    elements.map((element) => ({
      duration: getComputedStyle(element).animationDuration,
      name: getComputedStyle(element).animationName,
    })).filter((entry) => entry.name !== "none" && entry.duration !== "0s")
  );
  expect(animated).toEqual([]);
}

async function expectContained(page: Page, surface: Locator): Promise<void> {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
    .toBeLessThanOrEqual(1);
  await expect.poll(() => surface.evaluate((element) => element.scrollWidth - element.clientWidth))
    .toBeLessThanOrEqual(1);
}

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) {
      errors.push(`console:${message.text()}`);
    }
  });
  page.on("pageerror", (error) => errors.push(`pageerror:${error.message}`));
  return errors;
}
