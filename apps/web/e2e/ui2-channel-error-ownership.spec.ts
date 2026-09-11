import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, isRecord } from "./support/mock-state";
import { openEngineeringChannel } from "./support/test-helpers";

const appShellSourcePath = fileURLToPath(new URL("../src/app/AppShell.tsx", import.meta.url));
const workspaceClientSourcePath = fileURLToPath(new URL(
  "../src/features/workspace/WorkspaceClientView.tsx",
  import.meta.url,
));
const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/conversations/channel-error-ownership/",
  import.meta.url,
));
const channelOwnerSourcePaths = [
  "../src/app/use-channel-actions-controller.ts",
  "../src/app/use-channel-workflow-controller.ts",
  "../src/app/use-task-run-controller.ts",
  "../src/domains/workspace/use-workspace-domain.ts",
].map((path) => fileURLToPath(new URL(path, import.meta.url)));

test("T13-P.9D Channel removes the generic AppShell error owner", async () => {
  const [appShellSource, workspaceClientSource, ...channelOwnerSources] = await Promise.all([
    readFile(appShellSourcePath, "utf8"),
    readFile(workspaceClientSourcePath, "utf8"),
    ...channelOwnerSourcePaths.map((path) => readFile(path, "utf8")),
  ]);

  for (const source of channelOwnerSources) {
    expect(source).not.toContain("setErrorMessage");
  }

  for (const hook of [
    "useWorkspaceDomain",
    "useTaskRunController",
    "useChannelActionsController",
    "useChannelWorkflowController",
  ]) {
    expect(readHookCall(appShellSource, hook)).not.toContain("setErrorMessage");
  }

  const channelWorkspaceInvocation = readJsxInvocation(appShellSource, "WorkspaceClientView");
  expect(channelWorkspaceInvocation).not.toMatch(/\berrorMessage\s*=\s*\{errorMessage\}/u);
  expect(channelWorkspaceInvocation).not.toContain("setErrorMessage");

  const workspaceClientSignature = workspaceClientSource.slice(
    workspaceClientSource.indexOf("export function WorkspaceClientView"),
    workspaceClientSource.indexOf("): React.JSX.Element {", workspaceClientSource.indexOf("export function WorkspaceClientView")),
  );
  expect(workspaceClientSignature).not.toContain("readonly errorMessage: string;");
  expect(workspaceClientSource).not.toMatch(/\n\s*errorMessage,\n\s*onChannelCreateOpenChange/u);
  expect(workspaceClientSource).not.toMatch(
    /\{errorMessage \? \(\s*<div className="inline-error">[\s\S]*?\{errorMessage\}[\s\S]*?<\/div>\s*\) : null\}/u,
  );
});

test("T13-P.9D a late Engineering send failure cannot leak into Research", async ({ page }) => {
  const signals = collectBrowserSignals(page);
  await prepareSurface(page, { height: 960, theme: "light", width: 1440 });
  const state = createBaseState({ approvalStatus: "expired" });
  addResearchChannel(state);
  await mockDaemon(page, state);

  const requestStarted = createDeferred<void>();
  const releaseFailure = createDeferred<void>();
  const failureMessage = "Late Engineering message failed.";
  await page.route(/\/channels\/channel_engineering\/turns\/stream(?:\?.*)?$/u, async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    requestStarted.resolve();
    await releaseFailure.promise;
    await route.fulfill({
      status: 503,
      json: { error: "late_engineering_send_failed", message: failureMessage },
    });
  });

  await page.goto("/");
  await openEngineeringChannel(page);

  const draft = "Keep this failure with Engineering";
  const engineeringComposer = page.getByLabel("Channel composer");
  const engineeringInput = channelComposerTextbox(engineeringComposer);
  await engineeringInput.fill(draft);
  await engineeringComposer.getByRole("button", { name: "Send", exact: true }).click();
  await requestStarted.promise;

  const navigation = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u });
  await navigation.getByRole("button").filter({ hasText: "Research" }).first().click();
  await expect(page.getByRole("heading", { name: "Research", level: 1 })).toBeVisible();

  const failedResponse = page.waitForResponse((response) =>
    response.status() === 503 &&
    /\/channels\/channel_engineering\/turns\/stream(?:\?.*)?$/u.test(response.url())
  );
  releaseFailure.resolve();
  await failedResponse;
  await page.waitForTimeout(150);

  const researchComposer = page.getByLabel("Channel composer");
  await expect(researchComposer.locator(".composer-status-row.failed")).toHaveCount(0);
  await expect(channelComposerTextbox(researchComposer)).toHaveText("");
  await expect(page.locator(".task-workbench-window > .inline-error")).toHaveCount(0);
  await expect(page.locator('[data-ling-overlay="toast"]').filter({ hasText: failureMessage })).toHaveCount(0);
  await expect(page.getByText(failureMessage, { exact: true })).toHaveCount(0);
  await captureEvidence(page, "1440x960-ling-light-research-clean-after-late-failure.png");

  await navigation.getByRole("button").filter({ hasText: "Engineering" }).first().click();
  await expect(page.getByRole("heading", { name: "Engineering", level: 1 })).toBeVisible();

  const restoredComposer = page.getByLabel("Channel composer");
  const ownedFailure = restoredComposer.locator(".composer-status-row.failed");
  await expect(ownedFailure).toContainText(failureMessage);
  await expect(ownedFailure.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(channelComposerTextbox(restoredComposer)).toHaveText(draft);
  await expect(page.locator(".task-workbench-window > .inline-error")).toHaveCount(0);
  await expect(page.locator('[data-ling-overlay="toast"]').filter({ hasText: failureMessage })).toHaveCount(0);
  await expectNoDocumentOverflow(page);
  await captureEvidence(page, "1440x960-ling-light-engineering-composer-failure.png");
  expectBrowserSignals(signals, 503);
});

test("T13-P.9D channel rename failure remains inside its owning Dialog", async ({ page }) => {
  const signals = collectBrowserSignals(page);
  await prepareSurface(page, { height: 800, theme: "dark", width: 1280 });
  const state = createBaseState({ approvalStatus: "pending" });
  addResearchChannel(state);
  await mockDaemon(page, state);

  const failureMessage = "Channel rename belongs to this dialog.";
  await page.route(/\/channels\/channel_engineering(?:\?.*)?$/u, async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 503,
      json: { error: "channel_rename_failed", message: failureMessage },
    });
  });

  await page.goto("/");
  await openEngineeringChannel(page);
  await page.getByRole("button", { name: "More channel views" }).click();
  await page.getByRole("menuitem", { name: "Rename channel" }).click();

  const dialog = page.getByRole("dialog", { name: "Rename channel" });
  await dialog.getByLabel("Channel name").fill("Engineering renamed");
  await dialog.getByRole("button", { name: "Confirm" }).click();

  const dialogFailure = dialog.getByRole("alert");
  await expect(dialogFailure).toContainText(failureMessage);
  await expect(dialog).toBeVisible();
  await expect(page.locator(".task-workbench-window > .inline-error")).toHaveCount(0);
  await expect(page.locator('[data-ling-overlay="toast"]').filter({ hasText: failureMessage })).toHaveCount(0);
  await expectNoDocumentOverflow(page);
  await captureEvidence(page, "1280x800-ling-dark-rename-dialog-failure.png");

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  const navigation = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u });
  await navigation.getByRole("button").filter({ hasText: "Research" }).first().click();
  await expect(page.getByRole("heading", { name: "Research", level: 1 })).toBeVisible();
  await expect(page.getByText(failureMessage, { exact: true })).toHaveCount(0);
  await expectNoDocumentOverflow(page);
  expectBrowserSignals(signals, 503);
});

function readHookCall(source: string, hook: string): string {
  const start = source.indexOf(`${hook}({`);
  if (start < 0) throw new Error(`Missing ${hook} call`);
  const end = source.indexOf("\n  });", start);
  if (end < 0) throw new Error(`Missing ${hook} call boundary`);
  return source.slice(start, end);
}

function readJsxInvocation(source: string, component: string): string {
  const start = source.indexOf(`<${component}`);
  if (start < 0) throw new Error(`Missing ${component} invocation`);
  const end = source.indexOf("\n              />", start);
  if (end < 0) throw new Error(`Missing ${component} invocation boundary`);
  return source.slice(start, end);
}

function addResearchChannel(state: ReturnType<typeof createBaseState>): void {
  const engineeringChannel = state.channels.find((channel) =>
    isRecord(channel) && channel.id === "channel_engineering"
  );
  if (!isRecord(engineeringChannel)) throw new Error("Engineering channel fixture is missing");
  state.channels.push({
    ...engineeringChannel,
    id: "channel_research",
    name: "Research",
    createdAt: "2026-05-23T00:00:00.000Z",
    updatedAt: "2026-05-23T00:00:00.000Z",
  });
}

function channelComposerTextbox(scope: ReturnType<Page["getByLabel"]>) {
  return scope.getByRole("textbox", {
    name: "Message this channel or @ an AI teammate",
    exact: true,
  });
}

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function prepareSurface(
  page: Page,
  fixture: { readonly width: number; readonly height: number; readonly theme: "light" | "dark" },
): Promise<void> {
  await page.setViewportSize({ width: fixture.width, height: fixture.height });
  await page.emulateMedia({ colorScheme: fixture.theme, reducedMotion: "reduce" });
  await page.addInitScript((theme) => {
    const selection = { mode: "fixed", themeId: `ling-${theme}` };
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
  }, fixture.theme);
}

async function captureEvidence(page: Page, filename: string): Promise<void> {
  if (process.env.LING_CAPTURE_UI2_EVIDENCE !== "1") return;
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    caret: "hide",
    fullPage: false,
    path: `${evidenceDirectory}${filename}`,
  });
}

async function expectNoDocumentOverflow(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => (
    document.documentElement.scrollWidth - document.documentElement.clientWidth
  ))).toBeLessThanOrEqual(1);
}

function collectBrowserSignals(page: Page): {
  readonly consoleErrors: string[];
  readonly pageErrors: string[];
} {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  return { consoleErrors, pageErrors };
}

function expectBrowserSignals(signals: {
  readonly consoleErrors: string[];
  readonly pageErrors: string[];
}, expectedFailureStatus?: number): void {
  const expectedResourceFailure = expectedFailureStatus === undefined
    ? undefined
    : new RegExp(`Failed to load resource: .*status of ${expectedFailureStatus}`, "u");
  const unexpectedConsoleErrors = expectedResourceFailure
    ? signals.consoleErrors.filter((message) => !expectedResourceFailure.test(message))
    : signals.consoleErrors;
  expect(unexpectedConsoleErrors).toEqual([]);
  if (expectedResourceFailure) {
    expect(signals.consoleErrors).toHaveLength(1);
  }
  expect(signals.pageErrors).toEqual([]);
}
