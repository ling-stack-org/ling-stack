import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createMockTeammate, cwd, isRecord, type MockState } from "./support/mock-state";

const teammateId = "teammate_memory_reviewer";
const teammateName = "Memory Systems Reviewer";
const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/features/ai-teammate-management-memory/",
  import.meta.url,
));

test("Memory separates teammate scopes from Workspace governance and folds sensitive detail", async ({ page }) => {
  await prepareSurface(page, { theme: "light", width: 1440, height: 960, locale: "en-US" });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createMemoryState();
  await mockDaemon(page, state);
  await routeHealth(page, {
    critical: 1,
    warning: 1,
    findings: [
      {
        id: "finding_secret_source",
        kind: "secret_adjacent_recallable",
        severity: "critical",
        memoryId: "memory_secret_candidate",
        title: "Secret source needs review",
        message: "A deliberately long secret-adjacent source detail must remain folded by default.",
        recommendation: "Quarantine until the source is verified.",
        scopeType: "workspace",
        ownerId: "workspace_default",
        reviewState: "candidate",
        sensitivity: "secret-adjacent",
      },
      {
        id: "finding_backlog",
        kind: "high_review_backlog",
        severity: "warning",
        title: "Review backlog needs attention",
        message: "Workspace governance has pending candidates.",
        recommendation: "Review pending candidates.",
      },
    ],
  });
  await page.goto("/");

  const memory = await openMemory(page);
  await expect(memory).toHaveAttribute("data-ui2-teammate-memory", "true");
  await expect(memory.getByText("Teammate scopes", { exact: true })).toBeVisible();
  await expect(memory.getByText("Workspace memory governance", { exact: true })).toBeVisible();
  await expect(memory).toContainText("Private chat summary");
  await expect(memory).toContainText("Channel decisions");
  await expect(memory.getByText("Memory health", { exact: true })).toBeVisible();
  await expect(memory.getByText("A deliberately long secret-adjacent source detail", { exact: false })).toBeHidden();
  await expect(memory.getByText("Secret source needs review", { exact: true })).toBeHidden();
  await expect(memory.getByText("Workspace policy", { exact: true })).toBeVisible();
  await expect(memory.locator('button[data-ling-icon-button-contract="legacy-react-node"]')).toHaveCount(0);

  const refreshAction = memory.getByRole("button", { name: "Refresh memory" });
  const scopeDetailAction = memory.getByRole("button", { name: "View memory scope details" }).first();
  const editCandidateAction = memory.getByRole("button", { name: "Edit memory candidate" }).first();
  const memoryDetailAction = memory.getByRole("button", { name: "View memory details" }).first();
  await expectTypedIconButton(refreshAction, "Refresh memory");
  await expectIconButtonTooltip(refreshAction, "Refresh memory");
  await expectTypedIconButton(scopeDetailAction, "View memory scope details");
  await expectIconButtonTooltip(scopeDetailAction, "View memory scope details");
  await expectTypedIconButton(editCandidateAction, "Edit memory candidate");
  await expectIconButtonTooltip(editCandidateAction, "Edit memory candidate");
  await expectTypedIconButton(memoryDetailAction, "View memory details");
  await expectIconButtonTooltip(memoryDetailAction, "View memory details");

  await memory.getByText("Memory health", { exact: true }).click();
  await expect(memory.getByText("Secret-adjacent recall", { exact: true })).toBeVisible();
  const healthDetailAction = memory.getByRole("button", { name: "View health finding" }).first();
  await expectTypedIconButton(healthDetailAction, "View health finding");
  await expectIconButtonTooltip(healthDetailAction, "View health finding");
  await healthDetailAction.focus();
  await expect(healthDetailAction).toBeFocused();
  await expectTypedIconButton(healthDetailAction, "View health finding");
  await healthDetailAction.click();
  const drawer = page.getByRole("dialog", { name: "Memory details" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText("Secret source needs review", { exact: true })).toBeHidden();
  await expect(drawer.getByText("A deliberately long secret-adjacent source detail", { exact: false })).toBeHidden();
  await drawer.getByText("Sensitive and raw details", { exact: true }).click();
  await expect(drawer.getByText("A deliberately long secret-adjacent source detail", { exact: false })).toBeVisible();
  await captureEvidence(page, "1440x960-ling-light-scopes-health.png");
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("Memory shows a stable initial load and retains authoritative data when refresh fails", async ({ page }) => {
  await prepareSurface(page, { theme: "dark", width: 1280, height: 800, locale: "en-US" });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createMemoryState();
  const initialGate = deferred<void>();
  const refreshGate = deferred<void>();
  let failRefresh = false;
  await mockDaemon(page, state);
  await page.route(new RegExp(`/teammates/${teammateId}/memory-scopes(?:\\?.*)?$`, "u"), async (route) => {
    if (failRefresh) {
      await refreshGate.promise;
      await route.fulfill({ status: 503, json: { error: "memory_scopes_unavailable" } });
      return;
    }
    await initialGate.promise;
    await route.fulfill({ json: { cwd, teammateId, scopes: memoryScopeFixtures(teammateId) } });
  });
  await page.goto("/");

  const memory = await openMemory(page);
  const refreshAction = memory.getByRole("button", { name: "Refresh memory" });
  await expect(memory.getByLabel("Loading memory")).toBeVisible();
  await expect(memory.getByText("Memory scopes are being prepared", { exact: true })).toHaveCount(0);
  await expect(refreshAction).toBeDisabled();
  await expectTypedIconButton(refreshAction, "Refresh memory");
  initialGate.resolve();
  await expect(memory.locator("[data-memory-scope-id]")).toHaveCount(4);

  failRefresh = true;
  await refreshAction.click();
  await expect(refreshAction).toBeDisabled();
  await expect(refreshAction).toHaveAttribute("aria-busy", "true");
  await expectTypedIconButton(refreshAction, "Refresh memory");
  refreshGate.resolve();
  await expect(memory.locator("[data-memory-scope-id]")).toHaveCount(4);
  await expect(memory.getByText("Showing retained memory data", { exact: true })).toBeVisible();
  await captureEvidence(page, "1280x800-ling-dark-workspace-governance.png");
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("Workspace policy rolls back on failure and review keeps auditable actions without Delete", async ({ page }) => {
  await prepareSurface(page, { theme: "light", width: 1280, height: 800, locale: "en-US" });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createMemoryState();
  state.memoryObjects.push(
    memoryFixture({ id: "memory_archive_candidate", title: "Archive candidate", body: "Archive after review." }),
    memoryFixture({ id: "memory_reject_candidate", title: "Reject candidate", body: "Reject with audit history." }),
  );
  let policyMode = "balanced";
  let failPolicySave = false;
  let failedReviewId = "";
  await mockDaemon(page, state);
  await routePolicy(page, () => policyMode, async (route, mode) => {
    if (failPolicySave) {
      await route.fulfill({ status: 503, json: { error: "policy_unavailable" } });
      return;
    }
    policyMode = mode;
    await route.fulfill({ json: { cwd, policy: memoryPolicyFixture(policyMode) } });
  });
  await routeReview(page, state, () => failedReviewId);
  await page.goto("/");

  const memory = await openMemory(page);
  const policy = memory.getByRole("combobox", { name: "Memory review mode" });
  await policy.selectOption("conservative");
  await expect(policy).toHaveValue("conservative");
  await expect(page.getByText("Memory review mode updated", { exact: true })).toBeVisible();
  failPolicySave = true;
  await policy.selectOption("fast");
  await expect(policy).toHaveValue("conservative");
  await expect(memory.getByText("Memory review mode could not be saved. Try again.", { exact: true })).toBeVisible();

  const releaseRow = memory.locator('[data-memory-id="memory_release_candidate"]');
  await releaseRow.getByRole("button", { name: "Edit memory candidate" }).click();
  const drawer = page.getByRole("dialog", { name: "Memory details" });
  await expect(drawer).toBeVisible();
  await drawer.getByLabel("Title").fill("Edited release preference");
  await drawer.getByRole("button", { name: "Save and approve" }).click();
  await expect(drawer).toHaveCount(0);
  await expect(memory.locator('[data-memory-id="memory_release_candidate"]')).toHaveCount(0);

  await memory.locator('[data-memory-id="memory_archive_candidate"]').getByRole("button", { name: "View memory details" }).click();
  await page.getByRole("dialog", { name: "Memory details" }).getByRole("button", { name: "Archive" }).click();
  const archiveDialog = page.getByRole("dialog", { name: "Archive this memory?" });
  await expect(archiveDialog).toContainText("does not permanently delete");
  await expect(archiveDialog.getByRole("button", { name: /delete/iu })).toHaveCount(0);
  await archiveDialog.getByRole("button", { name: "Archive" }).click();
  await expect(memory.locator('[data-memory-id="memory_archive_candidate"]')).toHaveCount(0);

  const secretRow = memory.locator('[data-memory-id="memory_secret_candidate"]');
  await secretRow.getByRole("button", { name: "Quarantine" }).click();
  await page.getByRole("dialog", { name: "Quarantine this memory?" }).getByRole("button", { name: "Quarantine" }).click();
  await expect(secretRow).toHaveCount(0);
  await page.getByRole("button", { name: "Dismiss notification" }).click();

  await memory.locator('[data-memory-id="memory_reject_candidate"]').getByRole("button", { name: "View memory details" }).click();
  const reviewDrawer = page.getByRole("dialog", { name: "Memory details" });
  await expect(reviewDrawer).toBeVisible();
  await expect.poll(async () => (await reviewDrawer.boundingBox())?.x ?? 1280).toBeLessThan(1000);
  await expect.poll(async () => reviewDrawer.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
  await captureEvidence(page, "1280x800-ling-light-review-inspector.png");
  await reviewDrawer.getByRole("button", { name: "Reject" }).click();
  const rejectDialog = page.getByRole("dialog", { name: "Reject this memory?" });
  failedReviewId = "memory_reject_candidate";
  await rejectDialog.getByRole("button", { name: "Reject" }).click();
  await expect(rejectDialog.getByText("Memory review action failed. Try again.", { exact: true })).toBeVisible();
  await expect(memory.locator('[data-memory-id="memory_reject_candidate"]')).toBeVisible();
  failedReviewId = "";
  await rejectDialog.getByRole("button", { name: "Reject" }).click();
  await expect(memory.locator('[data-memory-id="memory_reject_candidate"]')).toHaveCount(0);
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("Import requires preview, folds warnings, preserves failed input, and keeps secret candidates disabled", async ({ page }) => {
  await prepareSurface(page, { theme: "dark", width: 1440, height: 960, locale: "en-US" });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createMemoryState();
  let failImport = false;
  await mockDaemon(page, state);
  await routeImport(page, async (route, body) => {
    if (failImport) {
      await route.fulfill({ status: 503, json: { error: "import_unavailable" } });
      return;
    }
    const plan = importPlanFixture();
    await route.fulfill({ json: { cwd, dryRun: body.dryRun === true, importedCount: body.dryRun === true ? 0 : 1, plan, memories: [] } });
  });
  await page.goto("/");

  const memory = await openMemory(page);
  const importAction = memory.getByRole("button", { name: "Import" });
  await expect(importAction).not.toHaveAttribute("data-ling-icon-button-contract");
  await importAction.click();
  let dialog = page.getByRole("dialog", { name: "Import memory" });
  const source = "# Ling Memory Export\nsecret-adjacent candidate";
  await dialog.getByRole("textbox", { name: "Markdown" }).fill(source);
  await expect(dialog.getByRole("button", { name: "Import candidates" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Preview import" }).click();
  await expect(dialog.getByText("Secret-adjacent candidates stay disabled", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Parser warning: verify source", { exact: true })).toBeHidden();
  await dialog.getByText("Import warnings and skipped items", { exact: true }).click();
  await expect(dialog.getByText("Parser warning: verify source", { exact: true })).toBeVisible();
  await captureEvidence(page, "1440x960-ling-dark-import-warning.png");
  await dialog.getByRole("button", { name: "Import candidates" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Imported 1 candidates", { exact: true })).toBeVisible();

  failImport = true;
  await memory.getByRole("button", { name: "Import" }).click();
  dialog = page.getByRole("dialog", { name: "Import memory" });
  await dialog.getByRole("textbox", { name: "Markdown" }).fill(source);
  await dialog.getByRole("button", { name: "Preview import" }).click();
  await expect(dialog.getByText("Memory import failed. Check the Markdown and try again.", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "Markdown" })).toHaveValue(source);
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("Protected Chinese Memory resets overlays and ignores a delayed old-teammate refresh", async ({ page }) => {
  await prepareSurface(page, { theme: "dark", width: 1280, height: 800, locale: "zh-CN", reducedMotion: "reduce" });
  const runtimeErrors = collectRuntimeErrors(page);
  const secondId = "teammate_memory_current";
  const secondName = "当前记忆审阅员";
  const state = createMemoryState("Ling Agent", "ling_agent");
  state.aiTeammates = [
    createMockTeammate({ id: "ling_agent", displayName: "Ling Agent", kind: "system_teammate", systemRole: "ling_agent" }),
    createMockTeammate({ id: secondId, displayName: secondName }),
  ];
  const oldRefreshGate = deferred<void>();
  let blockOldRefresh = false;
  await mockDaemon(page, state);
  await page.route(/\/teammates\/([^/]+)\/memory-scopes(?:\?.*)?$/u, async (route) => {
    const match = /\/teammates\/([^/]+)\/memory-scopes$/u.exec(new URL(route.request().url()).pathname);
    const requestedId = match ? decodeURIComponent(match[1]) : "";
    if (requestedId === "ling_agent" && blockOldRefresh) await oldRefreshGate.promise;
    await route.fulfill({ json: { cwd, teammateId: requestedId, scopes: memoryScopeFixtures(requestedId) } });
  });
  await page.goto("/");

  const protectedMemory = await openMemory(page, "Ling Agent", true);
  await expect(protectedMemory.getByText("受保护的协调器记忆", { exact: true })).toBeVisible();
  await protectedMemory.getByRole("button", { name: "导入" }).click();
  const importDialog = page.getByRole("dialog", { name: "导入记忆" });
  await importDialog.getByRole("textbox", { name: "Markdown" }).fill("old teammate draft");
  await importDialog.getByRole("button", { name: "取消" }).click();
  await captureEvidence(page, "1280x800-ling-dark-protected-secret-reduced-motion.png");
  blockOldRefresh = true;
  await protectedMemory.getByRole("button", { name: "刷新记忆" }).click();

  const currentMemory = await openMemory(page, secondName, true);
  await expect(page.getByRole("dialog", { name: "导入记忆" })).toHaveCount(0);
  await expect(currentMemory.getByText("受保护的协调器记忆", { exact: true })).toHaveCount(0);
  oldRefreshGate.resolve();
  await expect(currentMemory.locator('[data-memory-scope-id^="scope_teammate_memory_current"]')).toHaveCount(4);
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

function memoryScopeFixtures(id: string): Record<string, unknown>[] {
  return [
    ["private-chat-summary", undefined],
    ["private-notes", undefined],
    ["channel-brief", "channel_engineering"],
    ["channel-decisions", "channel_engineering"],
  ].map(([kind, channelId]) => ({
    id: `scope_${id}_${kind}`,
    teammateId: id,
    kind,
    channelId,
    enabled: true,
    createdAt: "2026-07-21T00:00:00.000Z",
    updatedAt: "2026-07-21T00:00:00.000Z",
  }));
}

function memoryPolicyFixture(mode: string): Record<string, unknown> {
  return {
    workspaceId: "workspace_default",
    mode,
    autoActiveSameScope: mode !== "conservative",
    autoActiveUserExplicit: true,
    requireManualForWorkspace: true,
    requireManualForPersona: true,
    requireManualForCrossScope: true,
    quarantineSecretAdjacent: true,
    updatedAt: "2026-07-21T00:00:00.000Z",
  };
}

function importPlanFixture(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "ling-memory-markdown-import",
    source: { id: "memory_import_source", label: "reviewed.md", importedAt: "2026-07-21T00:00:00.000Z" },
    candidateCount: 1,
    skippedCount: 1,
    candidates: [{
      index: 0,
      originalId: "memory_external_secret",
      title: "Imported restricted note",
      createInput: {
        scopeType: "workspace",
        ownerId: "workspace_default",
        title: "Imported restricted note",
        body: "Restricted source body",
        tags: [],
        sourceRefs: [{ type: "import", id: "memory_import_source", label: "reviewed.md" }],
        reviewState: "candidate",
        enabled: false,
        sensitivity: "secret-adjacent",
        verifyBeforeUse: true,
      },
      warnings: ["Parser warning: verify source"],
    }],
    skipped: [{ index: 1, title: "Unsupported record", reason: "Unsupported schema entry" }],
  };
}

async function routePolicy(
  page: Page,
  getMode: () => string,
  update: (route: Route, mode: string) => Promise<void>,
): Promise<void> {
  await page.route(/\/memory\/review-policy(?:\?.*)?$/u, async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: { cwd, policy: memoryPolicyFixture(getMode()) } });
      return;
    }
    if (route.request().method() === "PATCH") {
      const body = await route.request().postDataJSON() as Record<string, unknown>;
      await update(route, String(body.mode ?? getMode()));
      return;
    }
    await route.fallback();
  });
}

async function routeReview(page: Page, state: MockState, failedReviewId: () => string = () => ""): Promise<void> {
  await page.route(/\/memory\/([^/]+)\/review(?:\?.*)?$/u, async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    const match = /\/memory\/([^/]+)\/review$/u.exec(new URL(route.request().url()).pathname);
    const memoryId = match ? decodeURIComponent(match[1]) : "";
    if (memoryId === failedReviewId()) {
      await route.fulfill({ status: 503, json: { error: "review_unavailable" } });
      return;
    }
    const body = await route.request().postDataJSON() as Record<string, unknown>;
    const action = String(body.action ?? "keep_candidate");
    const index = state.memoryObjects.findIndex((item) => isRecord(item) && item.id === memoryId);
    const current = index >= 0 && isRecord(state.memoryObjects[index]) ? state.memoryObjects[index] as Record<string, unknown> : memoryFixture({ id: memoryId });
    const edited = isRecord(body.editedMemory) ? body.editedMemory : {};
    const nextReviewState = action === "approve" || action === "edit_and_approve"
      ? "active"
      : action === "reject"
        ? "rejected"
        : action === "archive"
          ? "archived"
          : action === "quarantine"
            ? "disabled"
            : "candidate";
    const memory = {
      ...current,
      ...edited,
      reviewState: nextReviewState,
      enabled: action === "quarantine" ? false : current.enabled,
      updatedAt: "2026-07-21T00:20:00.000Z",
    };
    if (index >= 0) state.memoryObjects[index] = memory;
    await route.fulfill({
      json: {
        memory,
        action: {
          id: `memory_action_${memoryId}_${action}`,
          workspaceId: "workspace_default",
          memoryId,
          action,
          previousReviewState: String(current.reviewState ?? "candidate"),
          nextReviewState,
          sourceRefs: Array.isArray(current.sourceRefs) ? current.sourceRefs : [],
          editedMemory: edited,
          reason: String(body.reason ?? ""),
          actor: "local-user",
          createdAt: "2026-07-21T00:20:00.000Z",
        },
      },
    });
  });
}

async function routeImport(
  page: Page,
  handler: (route: Route, body: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  await page.route(/\/memory\/import(?:\?.*)?$/u, async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    await handler(route, await route.request().postDataJSON() as Record<string, unknown>);
  });
}

function createMemoryState(displayName: string = teammateName, id: string = teammateId): MockState {
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [createMockTeammate({ id, displayName })];
  state.teammateChannelMemberships = [{
    teammateId: id,
    channelId: "channel_engineering",
    role: "member",
    isDefault: true,
    enabled: true,
    createdAt: "2026-07-21T00:00:00.000Z",
    updatedAt: "2026-07-21T00:00:00.000Z",
  }];
  state.memoryObjects = [
    memoryFixture({
      id: "memory_secret_candidate",
      title: "Credential rotation note",
      body: "Do not expose this secret-adjacent source body in the default list.",
      sensitivity: "secret-adjacent",
      verifyBeforeUse: true,
      sourceRefs: [{ type: "doc", id: "source_secret_rotation", label: "Restricted rotation notes" }],
    }),
    memoryFixture({
      id: "memory_release_candidate",
      title: "Release review preference",
      body: "Prefer a concise release checklist before deployment.",
      ownerId: id,
      scopeType: "teammate",
      sourceRefs: [{ type: "message", id: "message_release", label: "Private release conversation" }],
    }),
  ];
  state.usedMemoryEvents = [{
    id: "used_memory_release",
    workspaceId: "workspace_default",
    memoryIds: ["memory_release_candidate"],
    intent: "private-chat",
    recallQuery: "release checklist",
    teammateId: id,
    responseId: "response_release",
    policyVersion: "memory-policy-v1",
    createdAt: "2026-07-21T00:05:00.000Z",
  }];
  return state;
}

function memoryFixture(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "memory_candidate",
    workspaceId: "workspace_default",
    scopeType: "workspace",
    ownerId: "workspace_default",
    title: "Candidate memory",
    body: "Candidate body",
    tags: [],
    sourceRefs: [],
    reviewState: "candidate",
    enabled: true,
    sensitivity: "normal",
    verifyBeforeUse: false,
    createdAt: "2026-07-21T00:00:00.000Z",
    updatedAt: "2026-07-21T00:00:00.000Z",
    ...overrides,
  };
}

async function routeHealth(
  page: Page,
  input: { readonly critical: number; readonly warning: number; readonly findings: readonly Record<string, unknown>[] },
): Promise<void> {
  await page.route(/\/memory\/health(?:\?.*)?$/u, async (route) => {
    await route.fulfill({
      json: {
        cwd,
        report: {
          generatedAt: "2026-07-21T00:10:00.000Z",
          staleCandidateDays: 30,
          summary: {
            total: 2,
            active: 0,
            candidate: 2,
            disabled: 1,
            archived: 0,
            rejected: 0,
            enabled: 1,
            reviewBacklog: 2,
            staleCandidates: 0,
            verifyBeforeUse: 1,
            findings: { critical: input.critical, warning: input.warning, info: 0 },
          },
          findings: input.findings,
        },
      },
    });
  });
}

async function openMemory(page: Page, targetTeammateName: string = teammateName, chinese = false): Promise<Locator> {
  const navigation = page.getByLabel("Ling Stack navigation");
  await navigation.getByRole("button", { name: targetTeammateName }).click();
  const header = page.locator("[data-ui2-teammate-chat-header]");
  await expect(header).toBeVisible();
  const dockLabel = chinese ? "私聊工作区面板" : "Private chat workspace dock";
  if (await page.getByLabel(dockLabel).count() === 0) {
    await header.getByRole("button", { name: chinese ? "显示详情" : "Show details" }).click();
  }
  await page.getByLabel(dockLabel).getByRole("button", { name: chinese ? "设置" : "Settings" }).click();
  const settings = page.getByLabel(chinese ? "设置分组" : "Settings sections");
  await settings.getByRole("button", { name: chinese ? /^记忆(?:\s|$)/u : /^Memory(?:\s|$)/u }).click();
  const memory = page.locator("[data-ui2-teammate-memory]");
  await expect(memory).toBeVisible();
  return memory;
}

async function prepareSurface(
  page: Page,
  options: {
    readonly theme: "dark" | "light";
    readonly width: number;
    readonly height: number;
    readonly locale: "en-US" | "zh-CN";
    readonly reducedMotion?: "no-preference" | "reduce";
  },
): Promise<void> {
  await page.setViewportSize({ width: options.width, height: options.height });
  await page.emulateMedia({ colorScheme: options.theme, reducedMotion: options.reducedMotion ?? "no-preference" });
  await page.addInitScript(({ locale, theme }) => {
    const themeId = `ling-${theme}`;
    const selection = { mode: "fixed", themeId };
    localStorage.setItem("ling-stack.locale", locale);
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapPreference", theme);
  }, { locale: options.locale, theme: options.theme });
}

async function captureEvidence(page: Page, fileName: string): Promise<void> {
  if (process.env.LING_CAPTURE_UI2_EVIDENCE !== "1") return;
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({ path: `${evidenceDirectory}${fileName}`, fullPage: true });
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    clientHeight: document.documentElement.clientHeight,
    clientWidth: document.documentElement.clientWidth,
    scrollHeight: document.documentElement.scrollHeight,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
  expect(overflow.scrollHeight).toBeLessThanOrEqual(overflow.clientHeight + 1);
}

async function expectTypedIconButton(button: Locator, label: string): Promise<void> {
  await expect(button).toHaveAttribute("data-ling-icon-button-contract", "typed-lucide");
  await expect(button).toHaveAttribute("data-icon-only", "true");
  await expect(button).toHaveAttribute("aria-label", label);
  await expect(button).toHaveAttribute("title", label);
  const box = await button.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(32);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(32);
}

async function expectIconButtonTooltip(button: Locator, label: string): Promise<void> {
  const page = button.page();
  await button.hover();
  await expect(page.getByRole("tooltip", { name: label, exact: true })).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(page.getByRole("tooltip", { name: label, exact: true })).toHaveCount(0);
}

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) errors.push(message.text());
  });
  return errors;
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((currentResolve) => { resolve = currentResolve; });
  return { promise, resolve };
}
