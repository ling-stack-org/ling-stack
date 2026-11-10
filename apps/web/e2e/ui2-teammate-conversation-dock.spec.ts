import { expect, test, type Page } from "@playwright/test";
import type { WorkspaceChangesResponse } from "@ling-stack/contracts";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import {
  createBaseState,
  createChatProvider,
  createMockTeammate,
  cwd,
  type MockState,
} from "./support/mock-state";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/conversations/teammate-conversation-dock/",
  import.meta.url,
));

test("AI teammate dock exposes real private context and tools at 1440x960 light", async ({ page }) => {
  await prepareSurface(page, "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  const teammateId = installLoadedDockFixture(state);
  await mockDaemon(page, state);
  let directWorkspaceReads = 0;
  await page.route(new RegExp(`/teammates/${teammateId}/direct-workspace(?:\\?.*)?$`, "u"), async (route) => {
    directWorkspaceReads += 1;
    if (directWorkspaceReads > 1) await new Promise((resolve) => setTimeout(resolve, 450));
    await route.fallback();
  });
  await page.route(/\/workspace\/changes(?:\?.*)?$/u, async (route) => {
    await route.fulfill({ json: workspaceChangesFixture() });
  });

  await page.goto("/");
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "UI2 Dock Engineer" }).click();
  await expect(page.getByText("Loading teammate workspace...")).toHaveCount(0);

  await page.getByRole("toolbar", { name: "Private chat actions" }).getByRole("button", { name: "Show details" }).click();
  const dock = page.getByRole("complementary", { name: "Private chat workspace dock" });
  await expectDockOpen(dock);
  await expect(dock.getByRole("button", { name: "Context" })).toBeVisible();
  await expect(dock.getByRole("button", { name: "Review", exact: true })).toBeVisible();
  await expect(dock.getByRole("button", { name: "Plans" })).toHaveCount(0);
  await expect(dock.getByRole("button", { name: "Evidence", exact: true })).toHaveCount(0);
  await expect(dock.getByRole("button", { name: "Files" })).toBeVisible();
  await expect(dock.getByRole("button", { name: "Activity" })).toBeVisible();
  await expect(dock.getByRole("button", { name: "Browser" })).toBeVisible();
  await expect(dock.getByRole("button", { name: "Terminal" })).toBeVisible();
  await expect(dock.getByRole("button", { name: /governance/iu })).toHaveCount(0);
  await expect(dock.getByRole("button", { name: "New task" })).toHaveCount(0);
  await captureEvidence(page, "1440x960-ling-light-teammate-dock-launcher.png");

  await dock.getByRole("button", { name: "Context" }).click();
  const context = dock.getByRole("region", { name: "Conversation context" });
  await expect(context).toContainText("UI2 Dock Engineer");
  await expect(context).toContainText("Private workspace context is ready.");
  await expect(context).toContainText("private-dock-notes.md");
  await expect(context).toContainText("Private Dock memory");
  await expect(context).not.toContainText("Execute private Dock checks");
  await expect(page.getByRole("toolbar", { name: "Private chat actions" }).getByRole("button", { name: "Refresh" })).toHaveCount(0);
  await expect(context).toContainText("Ready");
  await captureEvidence(page, "1440x960-ling-light-teammate-context-loaded.png");
  await dock.getByRole("button", { name: "Back" }).click();

  await dock.getByRole("button", { name: "Activity" }).click();
  const activity = dock.getByRole("region", { name: "Private conversation activity" });
  await expect(activity).toContainText("AI teammate replied");
  await expect(activity).toContainText("Execute private Dock checks");
  await expect(activity).not.toContainText("Private Dock memory");
  await captureEvidence(page, "1440x960-ling-light-teammate-activity-loaded.png");
  await dock.getByRole("button", { name: "Back" }).click();

  await dock.getByRole("button", { name: "Review", exact: true }).click();
  await expect(dock.locator(".workspace-change-file-section")).toHaveCount(1);
  await dock.getByRole("button", { name: "Back" }).click();

  await dock.getByRole("button", { name: "Files" }).click();
  await expect(dock).toContainText("private-dock-notes.md");
  await expect(dock).toContainText("private-dock-report.md");
  await dock.getByRole("button", { name: "Back" }).click();

  await dock.getByRole("button", { name: "Browser" }).click();
  const browserSource = dock.getByRole("button", { name: /Private Dock reference/iu });
  await expect(browserSource).toBeVisible();
  await browserSource.click();
  await expect(dock.locator(".right-dock-detail-list")).toContainText("https://example.com/private-dock");
  await captureEvidence(page, "1440x960-ling-light-teammate-browser-detail.png");
  await dock.getByRole("button", { name: "Back" }).click();
  await dock.getByRole("button", { name: "Back" }).click();

  await dock.getByRole("button", { name: "Terminal" }).click();
  await expect(dock.getByRole("region", { name: "Terminal session" })).toBeVisible();
  await expectNoDocumentOverflow(page);
  expect(runtimeErrors).toEqual([]);
  expect(teammateId).toBe("teammate_ui2_private_dock");
});

test("AI teammate dock contains empty, error, resize, and close states at 1280x800 dark", async ({ page }) => {
  await prepareSurface(page, "dark", 1280, 800);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  installSparseDockFixture(state);
  await mockDaemon(page, state);
  await page.route(/\/workspace\/changes(?:\?.*)?$/u, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 450));
    await route.fulfill({
      status: 503,
      json: { error: "mock_private_review_failed", message: "Private workspace review is temporarily unavailable." },
    });
  });

  await page.goto("/");
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "Sparse Dock Engineer" }).click();
  await expect(page.getByText("Loading teammate workspace...")).toHaveCount(0);
  const toolbar = page.getByRole("toolbar", { name: "Private chat actions" });
  await toolbar.getByRole("button", { name: "Show details" }).click();
  const dock = page.getByRole("complementary", { name: "Private chat workspace dock" });
  await expectDockOpen(dock);
  await expect(dock.getByRole("button", { name: "Plans" })).toHaveCount(0);
  await expect(dock.getByRole("button", { name: "Evidence", exact: true })).toHaveCount(0);

  await dock.getByRole("button", { name: "Context" }).click();
  const context = dock.getByRole("region", { name: "Conversation context" });
  await expect(context.getByRole("alert")).toContainText("Private workspace binding is unavailable.");
  await expect(context).toContainText("No AI reply summary yet.");
  await captureEvidence(page, "1280x800-ling-dark-teammate-context-error.png");
  await context.getByText("Private attachments", { exact: true }).click();
  await expect(context.locator(".ling-ui-empty-state-title").filter({ hasText: "No private attachments yet." })).toBeVisible();
  await expect(context.getByText("No used memory in this private thread yet.")).toBeVisible();
  await dock.getByRole("button", { name: "Back" }).click();

  await dock.getByRole("button", { name: "Review", exact: true }).click();
  await expect(dock.getByRole("status", { name: "Loading" })).toBeVisible();
  await expect(dock.getByText("Private workspace review is temporarily unavailable.")).toBeVisible();
  await dock.getByRole("button", { name: "Back" }).click();

  await dock.getByRole("button", { name: "Files" }).click();
  await expect(dock.locator(".ling-ui-empty-state-title").filter({ hasText: "No files" })).toBeVisible();
  await dock.getByRole("button", { name: "Back" }).click();
  await dock.getByRole("button", { name: "Browser" }).click();
  await expect(dock.locator(".ling-ui-empty-state-title").filter({ hasText: "No browser evidence" })).toBeVisible();
  await dock.getByRole("button", { name: "Back" }).click();
  await dock.getByRole("button", { name: "Activity" }).click();
  await expect(dock.locator(".ling-ui-empty-state-title").filter({ hasText: "No teammate activity yet" })).toBeVisible();
  await captureEvidence(page, "1280x800-ling-dark-teammate-activity-empty.png");
  await dock.getByRole("button", { name: "Back" }).click();
  await dock.getByRole("button", { name: "Terminal" }).click();
  await expect(dock.getByRole("region", { name: "Terminal session" })).toBeVisible();
  await dock.getByRole("button", { name: "Back" }).click();

  const resizeHandle = page.getByRole("separator", { name: "Resize workspace dock" });
  const dockFrame = page.locator(".teammate-private-right-dock-frame");
  const widthBefore = (await dockFrame.boundingBox())?.width ?? 0;
  const handleBox = await resizeHandle.boundingBox();
  expect(handleBox).not.toBeNull();
  await resizeHandle.hover({ position: { x: Math.max(1, handleBox!.width / 2), y: Math.min(90, handleBox!.height - 1) } });
  await page.mouse.down();
  await expect(page.getByLabel("Private chat", { exact: true })).toHaveClass(/is-resizing-workspace-right-dock/u);
  await page.mouse.move(Math.max(1, handleBox!.x - 120), handleBox!.y + 90, { steps: 4 });
  await expect.poll(async () => (await dockFrame.boundingBox())?.width ?? 0).toBeGreaterThan(widthBefore + 40);
  await page.mouse.up();
  await expect(page.getByLabel("Private chat", { exact: true })).not.toHaveClass(/is-resizing-workspace-right-dock/u);
  await expectNoDocumentOverflow(page);
  await captureEvidence(page, "1280x800-ling-dark-teammate-dock-empty-error-resized.png");

  await dock.getByRole("button", { name: "Close" }).click();
  await expect(dock).toHaveCount(0);
  await expect(toolbar.getByRole("button", { name: "Show details" })).toHaveAttribute("aria-expanded", "false");
  expect(runtimeErrors).toEqual([]);
});

function installLoadedDockFixture(state: MockState): string {
  const teammateId = "teammate_ui2_private_dock";
  const threadId = `tdthread_${teammateId}`;
  const runId = "run_ui2_private_dock";
  const timestamp = "2026-07-20T01:00:00.000Z";
  state.providers = [createChatProvider({
    id: "provider_ui2_private_dock",
    displayName: "Local Relay",
    model: "gpt-5.5",
  })];
  state.aiTeammates = [createMockTeammate({
    id: teammateId,
    displayName: "UI2 Dock Engineer",
    providerPresetId: "provider_ui2_private_dock",
  })];
  state.teammateDirectThreads[teammateId] = {
    id: threadId,
    workspaceId: "workspace_default",
    teammateId,
    title: "UI2 Dock Engineer",
    workspaceBinding: {
      mode: "managed_worktree",
      status: "ready",
      executionPath: `${cwd}/.ling-stack/worktrees/private-dock`,
      worktreePath: `${cwd}/.ling-stack/worktrees/private-dock`,
      branchName: "codex/ui2-private-dock",
      baseBranch: "main",
      baseCommit: "mock-base",
      createdAt: timestamp,
      checkedAt: timestamp,
      updatedAt: timestamp,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  state.teammatePrivateAttachments = [{
    id: "attachment_ui2_private_dock",
    workspaceId: "workspace_default",
    teammateId,
    threadId,
    messageId: "message_ui2_private_dock_reply",
    scope: "teammate_direct_thread",
    kind: "document",
    fileName: "private-dock-notes.md",
    contentType: "text/markdown",
    sizeBytes: 2048,
    path: `teammates/${teammateId}/direct/${threadId}/private-dock-notes.md`,
    createdAt: timestamp,
  }];
  state.memoryObjects = [{
    id: "memory_ui2_private_dock",
    workspaceId: "workspace_default",
    scopeType: "teammate",
    ownerId: teammateId,
    title: "Private Dock memory",
    body: "Keep the private context and activity surfaces independent.",
    tags: ["ui2", "dock"],
    sourceRefs: [],
    reviewState: "active",
    enabled: true,
    sensitivity: "private",
    verifyBeforeUse: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  }];
  state.usedMemoryEvents = [{
    id: "used_memory_ui2_private_dock",
    workspaceId: "workspace_default",
    memoryIds: ["memory_ui2_private_dock"],
    intent: "private-chat",
    recallQuery: "private Dock context",
    teammateId,
    responseId: "message_ui2_private_dock_reply",
    policyVersion: "ling-memory-v1",
    createdAt: timestamp,
  }];
  state.runs.unshift({
    id: runId,
    status: "succeeded",
    cwd,
    taskId: "direct:ui2-private-dock",
    teammateId,
    providerPresetId: "provider_ui2_private_dock",
    providerName: "local-relay",
    providerModel: "gpt-5.5",
    taskSnapshot: { id: "direct:ui2-private-dock", title: "Private Dock verification" },
    providerSnapshot: {},
    requestSnapshot: {},
    eventLogPath: `.ling-stack/sessions/${runId}.jsonl`,
    threadId,
    createdAt: timestamp,
    startedAt: timestamp,
    updatedAt: "2026-07-20T01:01:00.000Z",
    endedAt: "2026-07-20T01:01:00.000Z",
  });
  state.executionActions = [{
    id: "execution_ui2_private_dock",
    workspaceId: "workspace_default",
    threadId,
    runId,
    actionType: "bash",
    risk: "low",
    status: "succeeded",
    title: "Execute private Dock checks",
    summary: "Ran the private Dock focused checks.",
    targetRefs: [{ type: "command", label: "Private Dock checks" }],
    previewArtifactIds: [],
    resultArtifactIds: [],
    commandEvidence: {
      command: "pnpm test:e2e ui2-teammate-conversation-dock.spec.ts",
      cwd,
      startedAt: timestamp,
      completedAt: "2026-07-20T01:01:00.000Z",
      durationMs: 60000,
      exitCode: 0,
      latestEventSeq: 1,
      outputTail: [{
        eventSeq: 1,
        stream: "stdout",
        text: "Private Dock checks passed",
        byteCount: 26,
        redacted: false,
        ts: "2026-07-20T01:01:00.000Z",
      }],
      outputByteCount: 26,
      outputLineCount: 1,
      outputTruncated: false,
    },
    createdAt: timestamp,
    updatedAt: "2026-07-20T01:01:00.000Z",
    completedAt: "2026-07-20T01:01:00.000Z",
  }];
  state.terminalReports = [terminalReportFixture(threadId, runId)];
  state.teammateDirectMessages = [
    directMessage({
      id: "message_ui2_private_dock_user",
      teammateId,
      threadId,
      authorType: "local-user",
      body: "Verify the private Dock implementation.",
      createdAt: timestamp,
    }),
    {
      ...directMessage({
        id: "message_ui2_private_dock_reply",
        teammateId,
        threadId,
        authorType: "ai-teammate",
        body: "Private workspace context is ready.",
        createdAt: "2026-07-20T01:01:00.000Z",
      }),
      attachmentIds: ["attachment_ui2_private_dock"],
      fileRefs: [{ path: "apps/web/src/features/teammates/teammate-private-dock.ts", label: "teammate-private-dock.ts", line: 1 }],
      linkedRunId: runId,
      webEvidence: {
        status: "available",
        query: "Ling private Dock",
        provider: {
          adapterId: "openai-responses-web-search",
          providerPresetId: "provider_ui2_private_dock",
          displayName: "Private Dock evidence provider",
        },
        sources: [{
          url: "https://example.com/private-message-evidence",
          title: "Private message evidence",
          snippet: "Reachable browser evidence for the private Dock.",
        }],
        readUrls: [],
        updatedAt: "2026-07-20T01:01:00.000Z",
      },
    },
  ];
  return teammateId;
}

function installSparseDockFixture(state: MockState): string {
  const teammateId = "teammate_ui2_private_dock_sparse";
  const threadId = `tdthread_${teammateId}`;
  const timestamp = "2026-07-20T02:00:00.000Z";
  state.providers = [createChatProvider({
    id: "provider_ui2_private_dock_sparse",
    displayName: "Local Relay",
    model: "gpt-5.5",
  })];
  state.aiTeammates = [createMockTeammate({
    id: teammateId,
    displayName: "Sparse Dock Engineer",
    providerPresetId: "provider_ui2_private_dock_sparse",
  })];
  state.teammateDirectThreads[teammateId] = {
    id: threadId,
    workspaceId: "workspace_default",
    teammateId,
    title: "Sparse Dock Engineer",
    workspaceBinding: {
      mode: "managed_worktree",
      status: "blocked",
      errorMessage: "Private workspace binding is unavailable.",
      updatedAt: timestamp,
      checkedAt: timestamp,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  state.teammateDirectMessages = [];
  state.teammatePrivateAttachments = [];
  state.usedMemoryEvents = [];
  state.terminalReports = [];
  state.executionActions = [];
  return teammateId;
}

function directMessage(input: {
  readonly id: string;
  readonly teammateId: string;
  readonly threadId: string;
  readonly authorType: "local-user" | "ai-teammate";
  readonly body: string;
  readonly createdAt: string;
}): Record<string, unknown> {
  return {
    id: input.id,
    workspaceId: "workspace_default",
    teammateId: input.teammateId,
    threadId: input.threadId,
    authorType: input.authorType,
    authorId: input.authorType === "ai-teammate" ? input.teammateId : "local-user",
    body: input.body,
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
    status: "ready",
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

function terminalReportFixture(threadId: string, runId: string): Record<string, unknown> {
  const sourceRef = {
    kind: "url",
    id: "source_ui2_private_dock",
    label: "Private Dock reference",
    href: "https://example.com/private-dock",
    visibility: "conversation",
  };
  return {
    schemaVersion: 1,
    id: "terminal_report_ui2_private_dock",
    workspaceId: "workspace_default",
    threadId,
    source: { kind: "run", id: runId },
    status: "committed",
    language: "en-US",
    outcome: {
      status: "succeeded",
      title: "Private Dock verification complete",
      summary: "The private Dock deep states are available.",
      corrections: [],
      sourceRefs: [sourceRef],
    },
    changes: [{
      id: "change_ui2_private_dock",
      kind: "documentation",
      title: "Private Dock report",
      summary: "Recorded the private Dock verification.",
      paths: ["docs/private-dock-report.md"],
      sourceRefs: [],
    }],
    verification: [{
      id: "verification_ui2_private_dock",
      title: "Private Dock focused E2E",
      status: "passed",
      summary: "The focused Dock checks passed.",
      command: "pnpm test:e2e ui2-teammate-conversation-dock.spec.ts",
      durationMs: 60000,
      sourceRefs: [],
    }],
    participants: [],
    artifacts: [{
      id: "artifact_ui2_private_dock",
      kind: "document",
      title: "private-dock-report.md",
      path: "docs/private-dock-report.md",
      summary: "Private Dock evidence report.",
      sourceRefs: [],
    }],
    risks: [],
    references: [sourceRef],
    evidenceSnapshotId: "snapshot_ui2_private_dock",
    evidenceFingerprint: "fingerprint_ui2_private_dock",
    synthesis: {
      mode: "deterministic_fallback",
      promptVersion: "ui2-private-dock-v1",
      attemptCount: 1,
      validationCodes: [],
    },
    createdAt: "2026-07-20T01:01:00.000Z",
    committedAt: "2026-07-20T01:01:00.000Z",
  };
}

function workspaceChangesFixture(): WorkspaceChangesResponse {
  return {
    cwd,
    state: "dirty",
    repoRoot: cwd,
    branchName: "codex/ui2-private-dock",
    additions: 5,
    deletions: 1,
    files: [{
      path: "apps/web/src/features/teammates/teammate-private-dock.ts",
      kind: "modified",
      staged: false,
      unstaged: true,
      untracked: false,
      additions: 5,
      deletions: 1,
      diff: "@@ -1 +1 @@\n-export const oldDock = true;\n+export const ui2Dock = true;\n",
      truncated: false,
    }],
    totalFileCount: 1,
    truncated: false,
  };
}

async function expectDockOpen(dock: ReturnType<Page["getByRole"]>): Promise<void> {
  await expect(dock).toBeVisible();
  await expect(dock).toHaveAttribute("data-ui2-right-dock", "true");
  await expect.poll(async () => (await dock.boundingBox())?.width ?? 0).toBeGreaterThan(280);
}

async function prepareSurface(page: Page, theme: "light" | "dark", width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.addInitScript((themeId) => {
    const selection = { mode: "fixed", themeId: `ling-${themeId}` };
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themePreference", themeId);
    localStorage.setItem("ling-stack.themeBootstrapPreference", themeId);
  }, theme);
}

async function expectNoDocumentOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}

async function captureEvidence(page: Page, filename: string): Promise<void> {
  if (process.env.LING_CAPTURE_UI2_EVIDENCE !== "1") return;
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({ animations: "disabled", fullPage: true, path: `${evidenceDirectory}${filename}` });
}

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}
