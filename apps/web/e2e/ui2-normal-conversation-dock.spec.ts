import { expect, test, type Page } from "@playwright/test";
import type { ProposedPlanArtifact, WorkspaceChangesResponse } from "@ling-stack/contracts";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createChatProvider, cwd, type MockState } from "./support/mock-state";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/conversations/normal-conversation-dock/",
  import.meta.url,
));

test("normal conversation dock reaches every real deep state at 1440x960 light", async ({ page }) => {
  await prepareSurface(page, "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  installDockFixture(state);
  await mockDaemon(page, state);
  await page.route(/\/workspace\/changes(?:\?.*)?$/u, async (route) => {
    await route.fulfill({ json: workspaceChangesFixture() });
  });
  await page.goto("/");
  await openConversation(page, "UI2 dock deep states");

  const conversation = page.getByLabel("Conversation page");
  const detailsTrigger = conversation.getByRole("button", { name: "Show details" });
  await detailsTrigger.click();
  const dock = page.getByRole("complementary", { name: "Conversation workspace dock" });
  await expectDockOpen(dock);
  await expect(dock.getByRole("button", { name: "Context" })).toBeVisible();
  await expect(dock.getByRole("button", { name: "Review", exact: true })).toBeVisible();
  await expect(dock.getByRole("button", { name: "Plans" })).toBeVisible();
  await expect(dock.getByRole("button", { name: "Files" })).toBeVisible();
  await expect(dock.getByRole("button", { name: "Activity" })).toBeVisible();
  await expect(dock.getByRole("button", { name: "Browser" })).toBeVisible();
  await expect(dock.getByRole("button", { name: "Terminal" })).toBeVisible();
  await expect(dock.getByRole("button", { name: "New task" })).toHaveCount(0);
  await expect(dock.getByRole("button", { name: /governance/iu })).toHaveCount(0);
  await captureEvidence(page, "1440x960-ling-light-normal-dock-launcher.png");

  await dock.getByRole("button", { name: "Context" }).click();
  const context = dock.getByRole("region", { name: "Conversation context" });
  await expect(context).toContainText("UI2 dock deep states");
  await expect(context).toContainText("2 messages");
  await expect(context).toContainText("Run Dock verification");
  await expect(context).toContainText("succeeded");
  await dock.getByRole("button", { name: "Back" }).click();

  await dock.getByRole("button", { name: "Review", exact: true }).click();
  await expect(dock.locator(".workspace-change-file-section")).toHaveCount(2);
  await captureEvidence(page, "1440x960-ling-light-normal-dock-review.png");
  await dock.getByRole("button", { name: "Back" }).click();

  await dock.getByRole("button", { name: "Plans" }).click();
  await expect(dock.getByRole("radiogroup", { name: "Plan scope" })).toHaveCount(0);
  const plan = dock.getByRole("button", { name: "Open plan detail Normal conversation dock plan" });
  await expect(plan).toBeVisible();
  await plan.click();
  await expect(dock.locator(".right-dock-plan-detail")).toContainText("Verify every normal conversation Dock page.");
  await dock.getByRole("button", { name: "Back" }).click();
  await dock.getByRole("button", { name: "Back" }).click();

  await dock.getByRole("button", { name: "Files" }).click();
  const attachment = dock.getByRole("button", { name: /^dock-evidence\.md conversations/iu });
  await expect(attachment).toBeVisible();
  await attachment.click();
  await expect(dock.locator(".right-dock-detail-list")).toContainText("dock-evidence.md");
  await dock.getByRole("button", { name: "Back" }).click();
  await dock.getByRole("button", { name: "Back" }).click();

  await dock.getByRole("button", { name: "Browser" }).click();
  const browserSource = dock.getByRole("button", { name: /Ling UI 2\.0 Dock reference/iu });
  await expect(browserSource).toBeVisible();
  await browserSource.click();
  await expect(dock.locator(".right-dock-detail-list")).toContainText("https://example.com/ling-ui2-dock");
  await dock.getByRole("button", { name: "Back" }).click();
  await dock.getByRole("button", { name: "Back" }).click();

  await dock.getByRole("button", { name: "Activity" }).click();
  const activity = dock.getByRole("region", { name: "Conversation activity" });
  await expect(activity).toContainText("Inspect the normal conversation Dock");
  await expect(activity).toContainText("Run Dock verification");
  await captureEvidence(page, "1440x960-ling-light-normal-dock-deep-states.png");
  await dock.getByRole("button", { name: "Back" }).click();

  await dock.getByRole("button", { name: "Terminal" }).click();
  await expect(dock.getByRole("region", { name: "Terminal session" })).toBeVisible();
  await expectNoDocumentOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("normal conversation dock contains empty, failure, resize, and close states at 1280x800 dark", async ({ page }) => {
  await prepareSurface(page, "dark", 1280, 800);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  installDockFixture(state, { sparse: true });
  await mockDaemon(page, state);
  await page.route(/\/workspace\/changes(?:\?.*)?$/u, async (route) => {
    await route.fulfill({
      status: 503,
      json: { error: "mock_workspace_changes_failed", message: "Workspace review is temporarily unavailable." },
    });
  });
  await page.goto("/");
  await openConversation(page, "UI2 dock sparse states");

  const conversation = page.getByLabel("Conversation page");
  const detailsTrigger = conversation.getByRole("button", { name: "Show details" });
  await detailsTrigger.click();
  const dock = page.getByRole("complementary", { name: "Conversation workspace dock" });
  await expectDockOpen(dock);

  await dock.getByRole("button", { name: "Review", exact: true }).click();
  await expect(dock.getByText("Workspace review is temporarily unavailable.")).toBeVisible();
  await dock.getByRole("button", { name: "Back" }).click();
  await dock.getByRole("button", { name: "Plans" }).click();
  await expect(dock.locator(".ling-ui-empty-state-title").filter({ hasText: "No plans" })).toBeVisible();
  await dock.getByRole("button", { name: "Back" }).click();
  await dock.getByRole("button", { name: "Files" }).click();
  await expect(dock.locator(".ling-ui-empty-state-title").filter({ hasText: "No files" })).toBeVisible();
  await dock.getByRole("button", { name: "Back" }).click();
  await dock.getByRole("button", { name: "Browser" }).click();
  await expect(dock.locator(".ling-ui-empty-state-title").filter({ hasText: "No browser evidence" })).toBeVisible();
  await dock.getByRole("button", { name: "Back" }).click();
  await dock.getByRole("button", { name: "Activity" }).click();
  await expect(dock.getByRole("region", { name: "Conversation activity" })).toContainText("Open the sparse Dock states.");
  await dock.getByRole("button", { name: "Back" }).click();

  const resizeHandle = conversation.getByRole("separator", { name: "Resize workspace dock" });
  const dockFrame = page.locator(".normal-conversation-right-dock-frame");
  const widthBefore = (await dockFrame.boundingBox())?.width ?? 0;
  const handleBox = await resizeHandle.boundingBox();
  expect(handleBox).not.toBeNull();
  await resizeHandle.hover({ position: { x: Math.max(1, handleBox!.width / 2), y: Math.min(90, handleBox!.height - 1) } });
  await page.mouse.down();
  await expect(conversation).toHaveClass(/is-resizing-workspace-right-dock/u);
  await page.mouse.move(Math.max(1, handleBox!.x - 130), handleBox!.y + 90, { steps: 4 });
  await expect.poll(async () => (await dockFrame.boundingBox())?.width ?? 0).toBeGreaterThan(widthBefore + 70);
  await page.mouse.up();
  await expect(conversation).not.toHaveClass(/is-resizing-workspace-right-dock/u);
  await expectNoDocumentOverflow(page);
  await captureEvidence(page, "1280x800-ling-dark-normal-dock-empty-error-resized.png");

  const close = dock.getByRole("button", { name: "Close" });
  await close.click();
  await expect(dock).toHaveCount(0);
  await expect(detailsTrigger).toHaveAttribute("aria-expanded", "false");
  expect(runtimeErrors).toEqual([]);
});

test("normal conversation plan loading and failure stay inside the Dock", async ({ page }) => {
  await prepareSurface(page, "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  installDockFixture(state, { sparse: true });
  await mockDaemon(page, state);
  await page.route(/\/threads\/[^/]+\/proposed-plans(?:\?.*)?$/u, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    await route.fulfill({
      status: 503,
      json: { error: "mock_plan_history_failed", message: "Plan history is temporarily unavailable." },
    });
  });
  await page.goto("/");
  await openConversation(page, "UI2 dock sparse states");
  const conversation = page.getByLabel("Conversation page");
  await conversation.getByRole("button", { name: "Show details" }).click();
  const dock = page.getByRole("complementary", { name: "Conversation workspace dock" });
  await expectDockOpen(dock);
  const plansLauncher = dock.locator('[data-ui2-dock-launcher-action="plans"]');
  await expect(plansLauncher).toContainText("Loading");
  await plansLauncher.click();
  await expect(dock.locator(".ling-ui-empty-state-title").filter({ hasText: "Loading plans" })).toBeVisible();
  await expect(dock.locator(".ling-ui-empty-state-title").filter({ hasText: "Plan history unavailable" })).toBeVisible();
  await expect(dock).toContainText("Plan history is temporarily unavailable.");
  await dock.getByRole("button", { name: "Back" }).click();
  await expect(dock.getByRole("button", { name: "Context" })).toBeVisible();
  await expectNoDocumentOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

function installDockFixture(state: MockState, options: { readonly sparse?: boolean } = {}): string {
  const sparse = options.sparse ?? false;
  const threadId = sparse ? "thread_ui2_normal_dock_sparse" : "thread_ui2_normal_dock";
  const turnId = sparse ? "turn_ui2_normal_dock_sparse" : "turn_ui2_normal_dock";
  const runId = sparse ? "run_ui2_normal_dock_sparse" : "run_ui2_normal_dock";
  const title = sparse ? "UI2 dock sparse states" : "UI2 dock deep states";
  const timestamp = "2026-07-19T06:00:00.000Z";
  state.providers = [createChatProvider({ id: "provider_ui2_normal_dock", displayName: "Local Relay", model: "gpt-5.5" })];
  state.threads = [{
    id: threadId,
    workspaceId: "workspace_default",
    kind: "conversation",
    title,
    objective: "Verify normal conversation Dock states.",
    status: "succeeded",
    lastRunId: runId,
    createdAt: timestamp,
    updatedAt: timestamp,
  }];
  state.turns = [{
    id: turnId,
    workspaceId: "workspace_default",
    threadId,
    kind: "initial_request",
    status: "succeeded",
    title,
    userInstruction: sparse ? "Open the sparse Dock states." : "Inspect the normal conversation Dock.",
    lastRunId: runId,
    createdByActor: "local-user",
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: timestamp,
  }];
  state.turnRunLinks = [{ turnId, runId, attemptNumber: 1, role: "primary", createdAt: timestamp }];
  state.runs.unshift({
    id: runId,
    status: "succeeded",
    cwd,
    taskId: `task_${runId}`,
    providerPresetId: "provider_ui2_normal_dock",
    providerName: "local-relay",
    providerModel: "gpt-5.5",
    taskSnapshot: { id: `task_${runId}`, title: sparse ? "Sparse Dock verification" : "Run Dock verification" },
    providerSnapshot: {},
    requestSnapshot: { projectPath: cwd },
    eventLogPath: `.ling-stack/sessions/${runId}.jsonl`,
    threadId,
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
    data: { text: sparse ? "Sparse Dock state is ready." : "Dock evidence is ready in `docs/dock-evidence.md`." },
  }];
  if (sparse) return threadId;

  state.conversationAttachments = [{
    id: "attachment_ui2_normal_dock",
    workspaceId: "workspace_default",
    threadId,
    turnId,
    kind: "document",
    fileName: "dock-evidence.md",
    contentType: "text/markdown",
    sizeBytes: 1024,
    path: `conversations/${threadId}/dock-evidence.md`,
    createdAt: timestamp,
  }];
  state.executionActions = [{
    id: "execution_action_ui2_normal_dock",
    workspaceId: "workspace_default",
    threadId,
    runId,
    actionType: "bash",
    risk: "low",
    status: "succeeded",
    title: "Run Dock verification",
    summary: "Executed the focused Dock verification command.",
    targetRefs: [{ type: "command", label: "Dock verification" }],
    previewArtifactIds: [],
    resultArtifactIds: [],
    commandEvidence: {
      command: "pnpm test:e2e ui2-normal-conversation-dock.spec.ts",
      cwd,
      startedAt: timestamp,
      completedAt: "2026-07-19T06:00:02.000Z",
      durationMs: 2000,
      exitCode: 0,
      latestEventSeq: 1,
      outputTail: [{
        eventSeq: 1,
        stream: "stdout",
        text: "2 tests passed",
        byteCount: 14,
        redacted: false,
        ts: "2026-07-19T06:00:02.000Z",
      }],
      outputByteCount: 14,
      outputLineCount: 1,
      outputTruncated: false,
    },
    createdAt: timestamp,
    updatedAt: "2026-07-19T06:00:02.000Z",
    completedAt: "2026-07-19T06:00:02.000Z",
  }];
  state.terminalReports = [terminalReportFixture(threadId, turnId, runId)];
  state.proposedPlans = [planFixture(threadId, turnId, runId)];
  return threadId;
}

function planFixture(threadId: string, turnId: string, runId: string): ProposedPlanArtifact {
  return {
    id: "plan_ui2_normal_dock",
    workspaceId: "workspace_default",
    threadId,
    sourceTurnId: turnId,
    sourceRunId: runId,
    planGroupId: "plan_group_ui2_normal_dock",
    version: 1,
    title: "Normal conversation dock plan",
    bodyMarkdown: "## Dock plan\n\nVerify every normal conversation Dock page.",
    status: "draft",
    createdAt: "2026-07-19T06:00:00.000Z",
    updatedAt: "2026-07-19T06:01:00.000Z",
  };
}

function terminalReportFixture(threadId: string, turnId: string, runId: string): Record<string, unknown> {
  const sourceRef = {
    kind: "url",
    id: "source_ui2_normal_dock",
    label: "Ling UI 2.0 Dock reference",
    href: "https://example.com/ling-ui2-dock",
    visibility: "conversation",
  };
  return {
    schemaVersion: 1,
    id: "terminal_report_ui2_normal_dock",
    workspaceId: "workspace_default",
    threadId,
    turnId,
    source: { kind: "run", id: runId },
    status: "committed",
    language: "en-US",
    outcome: {
      status: "succeeded",
      title: "Dock verification complete",
      summary: "All normal conversation Dock evidence is available.",
      corrections: [],
      sourceRefs: [sourceRef],
    },
    changes: [{
      id: "change_ui2_normal_dock",
      kind: "code",
      title: "Dock evidence file",
      summary: "Added Dock evidence.",
      paths: ["docs/dock-evidence.md"],
      sourceRefs: [],
    }],
    verification: [{
      id: "verification_ui2_normal_dock",
      title: "Dock focused E2E",
      status: "passed",
      summary: "Focused Dock checks passed.",
      command: "pnpm test:e2e ui2-normal-conversation-dock.spec.ts",
      durationMs: 2000,
      sourceRefs: [],
    }],
    participants: [],
    artifacts: [{
      id: "artifact_ui2_normal_dock",
      kind: "document",
      title: "Dock evidence report",
      path: "docs/dock-evidence.md",
      summary: "Normal conversation Dock evidence.",
      sourceRefs: [],
    }],
    risks: [],
    references: [sourceRef],
    evidenceSnapshotId: "snapshot_ui2_normal_dock",
    evidenceFingerprint: "fingerprint_ui2_normal_dock",
    synthesis: {
      mode: "deterministic_fallback",
      promptVersion: "ui2-normal-dock-v1",
      attemptCount: 1,
      validationCodes: [],
    },
    createdAt: "2026-07-19T06:00:02.000Z",
    committedAt: "2026-07-19T06:00:02.000Z",
  };
}

function workspaceChangesFixture(): WorkspaceChangesResponse {
  return {
    cwd,
    state: "dirty",
    repoRoot: cwd,
    branchName: "codex/ui2-normal-dock",
    additions: 7,
    deletions: 2,
    files: [
      {
        path: "apps/web/src/features/workspace/NormalConversationWorkspacePanels.tsx",
        kind: "added",
        staged: false,
        unstaged: true,
        untracked: true,
        additions: 4,
        deletions: 0,
        diff: "@@ -0,0 +1,4 @@\n+export function NormalConversationWorkspacePanels() {\n+  return null;\n+}\n",
        truncated: false,
      },
      {
        path: "apps/web/src/features/workspace/normal-conversation-dock-projections.ts",
        kind: "modified",
        staged: false,
        unstaged: true,
        untracked: false,
        additions: 3,
        deletions: 2,
        diff: "@@ -1,3 +1,4 @@\n-old projection\n+new projection\n",
        truncated: false,
      },
    ],
    totalFileCount: 2,
    truncated: false,
    checkedAt: "2026-07-19T06:02:00.000Z",
  };
}

async function openConversation(page: Page, title: string): Promise<void> {
  await page.getByLabel("Ling Stack navigation").locator(".sidebar-recent-row").filter({ hasText: title }).click();
  await expect(page.getByLabel("Conversation page")).toBeVisible();
}

async function expectDockOpen(dock: ReturnType<Page["getByRole"]>): Promise<void> {
  await expect(dock).toBeVisible();
  await expect.poll(async () => (await dock.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(300);
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
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
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
