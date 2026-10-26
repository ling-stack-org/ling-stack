import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, isRecord } from "./support/mock-state";
import { openEngineeringChannel } from "./support/test-helpers";
import { mockUnknownSubmissionReceipt } from "./support/unknown-submission-receipt";

const appShellSourcePath = fileURLToPath(new URL("../src/app/AppShell.tsx", import.meta.url));
const workspaceClientSourcePath = fileURLToPath(new URL(
  "../src/features/workspace/WorkspaceClientView.tsx",
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
  expect(channelOwnerSources[0]).toContain("shouldReportConversationStreamError");
  expect(channelOwnerSources[0]).toContain("hasAssistantReply: receivedAiReply");
});

test("T13-P.9D a provider failure stays on its channel reply", async ({ page }) => {
  const signals = collectBrowserSignals(page);
  await prepareSurface(page, { height: 960, theme: "light", width: 1440 });
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state);

  const failureMessage = "Provider message ended with an error.";
  await page.route(/\/channels\/channel_engineering\/turns\/stream(?:\?.*)?$/u, async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    const requestBody = await route.request().postDataJSON() as Record<string, unknown>;
    const channelId = "channel_engineering";
    const threadId = "thread_channel_channel_engineering";
    const turnId = "turn_channel_provider_failure";
    const createdAt = "2026-10-26T00:20:00.000Z";
    const userItemId = "message_channel_provider_failure";
    const replyItemId = "reply_channel_provider_failure";
    const body = typeof requestBody.body === "string" ? requestBody.body : "";
    const thread = {
      id: threadId,
      workspaceId: "workspace_default",
      kind: "channel_discussion",
      channelId,
      title: "Engineering conversation",
      objective: "Root conversation for Engineering.",
      status: "open",
      conversationMode: { mode: "default" },
      surfaceKind: "channel_root",
      relationKind: "root",
      nextItemSequence: 3,
      createdAt,
      updatedAt: createdAt,
    };
    const turn = {
      id: turnId,
      workspaceId: "workspace_default",
      threadId,
      kind: "manual_followup",
      status: "failed",
      title: body,
      userInstruction: body,
      channelId,
      sourceItemId: userItemId,
      createdByActor: "local-user",
      createdAt,
      updatedAt: createdAt,
      completedAt: createdAt,
    };
    const userItem = {
      schemaVersion: 1,
      id: userItemId,
      workspaceId: "workspace_default",
      channelId,
      threadId,
      turnId,
      sequence: 1,
      kind: "user_message",
      status: "committed",
      actorType: "local_user",
      actorId: "local-user",
      visibility: "channel",
      payload: {
        body,
        format: "plain_text",
        mentions: [],
        attachmentIds: [],
        linkPreviewIds: [],
        fileRefs: [],
      },
      domainRefs: [],
      revision: 1,
      createdAt,
      updatedAt: createdAt,
      committedAt: createdAt,
    };
    const failedReply = {
      schemaVersion: 1,
      id: replyItemId,
      workspaceId: "workspace_default",
      channelId,
      threadId,
      turnId,
      sequence: 2,
      kind: "assistant_message",
      status: "failed",
      actorType: "teammate",
      actorId: "ling_agent",
      visibility: "channel",
      payload: {
        body: `AI teammate is blocked: ${failureMessage}`,
        format: "markdown",
        streaming: false,
        deliveryStatus: "failed",
        errorMessage: failureMessage,
      },
      domainRefs: [{ type: "conversation_item", id: userItemId }],
      revision: 1,
      createdAt,
      updatedAt: createdAt,
      committedAt: createdAt,
    };
    state.channelMessages.push(
      {
        id: userItemId,
        workspaceId: "workspace_default",
        channelId,
        threadId,
        kind: "message",
        intent: "discuss",
        authorType: "local-user",
        authorId: "local-user",
        body,
        mentions: [],
        attachmentIds: [],
        linkPreviewIds: [],
        fileRefs: [],
        status: "ready",
        createdAt,
        updatedAt: createdAt,
      },
      {
        id: replyItemId,
        workspaceId: "workspace_default",
        channelId,
        threadId,
        sourceItemId: userItemId,
        kind: "ai_reply",
        intent: "discuss",
        authorType: "ai-teammate",
        authorId: "ling_agent",
        body: `AI teammate is blocked: ${failureMessage}`,
        mentions: [],
        attachmentIds: [],
        linkPreviewIds: [],
        fileRefs: [],
        status: "failed",
        errorMessage: failureMessage,
        createdAt,
        updatedAt: createdAt,
      },
    );
    const events = [
      { event: "ready", data: { thread, turn: { ...turn, status: "running" }, userItem, decorations: [] } },
      {
        event: "error",
        data: {
          thread,
          turn,
          userItem,
          assistantItems: [failedReply],
          decorations: [],
          error: failureMessage,
        },
      },
    ];
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: events.map((event) => `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`).join(""),
    });
  });

  await page.goto("/");
  await openEngineeringChannel(page);
  const composer = page.getByLabel("Channel composer");
  await channelComposerTextbox(composer).fill("Trigger provider failure");
  await composer.getByRole("button", { name: "Send", exact: true }).click();

  const feed = page.getByLabel("Channel message feed");
  await expect(feed.getByText("AI teammate is blocked: Provider message ended with an error.", { exact: true })).toBeVisible();
  // The typed error is already narrated by the failed reply body, so the
  // shared message projector suppresses a second inline copy as well.
  await expect(feed.locator(".channel-message-error")).toHaveCount(0);
  await expect(feed.getByText(failureMessage, { exact: true })).toHaveCount(0);
  await expect(composer.locator(".channel-composer-feedback-stack")).toHaveCount(0);
  await expect(page.locator(".task-workbench-window > .inline-error")).toHaveCount(0);
  await expect(page.locator('[data-ling-overlay="toast"][data-tone="error"]')).toHaveCount(0);
  expectBrowserSignals(signals);
});

test("T13-P.9D a late Engineering send failure cannot leak into Research", async ({ page }) => {
  const signals = collectBrowserSignals(page);
  await prepareSurface(page, { height: 960, theme: "light", width: 1440 });
  const state = createBaseState({ approvalStatus: "expired" });
  addResearchChannel(state);
  await mockDaemon(page, state);
  await mockUnknownSubmissionReceipt(page);

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
      // This case requires proven rejection; 5xx plus an unknown receipt is query-only recovery.
      status: 400,
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
    response.status() === 400 &&
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
  expectBrowserSignals(signals, 400);
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
  await page.screenshot({
    animations: "disabled",
    caret: "hide",
    fullPage: false,
    path: test.info().outputPath(filename),
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
