import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import {
  createRunsThreadsFixture,
  installRunsThreadsFixture,
  openMainRunHistory,
} from "./support/runs-threads-fixture";
import {
  createBaseState,
  createChatProvider,
  createMockTeammate,
  type MockState,
} from "./support/mock-state";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/conversations/shared-conversation-evidence/",
  import.meta.url,
));
const containmentTolerance = 1;

test("Channel available web evidence uses the shared disclosure and keeps diagnostics out of the message", async ({ page }) => {
  await prepareSurface(page, { theme: "light", width: 1440, height: 960 });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "pending" });
  state.aiTeammates = [createMockTeammate({ id: "engineer", displayName: "Ling Engineer" })];
  const sourceUrl = "https://evidence-release-notes.with-a-deliberately-long-hostname.example.com/releases/ui2/conversation-evidence";
  state.channelMessages = [
    channelEvidenceMessage({
      id: "msg_ui2_evidence_available",
      body: "Available web evidence for the focused owner.",
      webEvidence: {
        status: "available",
        query: "latest Ling Stack evidence release",
        provider: {
          adapterId: "openai-responses-web-search",
          providerPresetId: "provider_openai_responses",
          displayName: "OpenAI Responses + Web Search",
        },
        sources: [{
          url: sourceUrl,
          title: `Ling release ${"evidence".repeat(28)}`,
          snippet: `Verified source summary ${"without-layout-overflow".repeat(24)}`,
        }],
        readUrls: [{
          url: sourceUrl,
          status: "available",
          finalUrl: sourceUrl,
          title: "Release source opened successfully",
        }],
        updatedAt: "2026-07-23T08:00:00.000Z",
      },
    }),
    channelEvidenceMessage({
      id: "msg_ui2_evidence_degraded",
      body: "Degraded web evidence stays diagnostic-only.",
      webEvidence: {
        status: "degraded",
        query: "degraded evidence query",
        reason: "Focused degraded diagnostic must stay outside the primary message evidence.",
        sources: [],
        readUrls: [],
        updatedAt: "2026-07-23T08:01:00.000Z",
      },
    }),
    channelEvidenceMessage({
      id: "msg_ui2_evidence_blocked",
      body: "Blocked web evidence stays diagnostic-only.",
      webEvidence: {
        status: "blocked",
        query: "blocked evidence query",
        reason: "Focused blocked diagnostic must stay outside the primary message evidence.",
        sources: [],
        readUrls: [],
        updatedAt: "2026-07-23T08:02:00.000Z",
      },
    }),
  ];
  await mockDaemon(page, state);

  await page.goto("/");
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();

  const feed = page.getByLabel("Channel message feed");
  const availableRow = feed.locator(".channel-message-row").filter({ hasText: "Available web evidence for the focused owner." });
  const evidence = availableRow.getByLabel("Message evidence", { exact: true });
  const toggle = evidence.locator(".conversation-evidence-toggle");
  const sourceStack = toggle.locator(".source-icon-stack");
  await expect(evidence).toBeVisible();
  await expect(toggle).toHaveClass(/\bling-ui-button\b/);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(sourceStack).toBeVisible();
  await expectMinimumSize(toggle, { height: 32 });
  await expectContained(toggle, evidence);
  await expectContained(sourceStack, toggle);

  await toggle.focus();
  await toggle.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");

  const sources = evidence.getByLabel("Sources", { exact: true });
  const openedUrls = evidence.getByLabel("open_url", { exact: true });
  const sourceLink = sources.getByRole("link");
  const openedLink = openedUrls.getByRole("link");
  const status = openedUrls.locator(".conversation-evidence-status.available");
  await expect(sources).toBeVisible();
  await expect(openedUrls).toBeVisible();
  await expect(sourceLink).toHaveAttribute("href", sourceUrl);
  await expect(sourceLink).toHaveAttribute("target", "_blank");
  await expect(sourceLink).toHaveAttribute("rel", "noreferrer");
  await expect(openedLink).toHaveAttribute("href", sourceUrl);
  await expect(openedLink).toHaveAttribute("target", "_blank");
  await expect(openedLink).toHaveAttribute("rel", "noreferrer");
  await expect(status).toHaveText("available");
  await expectContained(sources, evidence);
  await expectContained(openedUrls, evidence);
  await expectContained(sourceLink, sources);
  await expectContained(openedLink, openedUrls);
  await expectContained(status, openedUrls);

  const degradedRow = feed.locator(".channel-message-row").filter({ hasText: "Degraded web evidence stays diagnostic-only." });
  const blockedRow = feed.locator(".channel-message-row").filter({ hasText: "Blocked web evidence stays diagnostic-only." });
  await expect(degradedRow.getByLabel("Message evidence", { exact: true })).toHaveCount(0);
  await expect(blockedRow.getByLabel("Message evidence", { exact: true })).toHaveCount(0);
  await expect(degradedRow).not.toContainText("Focused degraded diagnostic must stay outside the primary message evidence.");
  await expect(blockedRow).not.toContainText("Focused blocked diagnostic must stay outside the primary message evidence.");

  await expectHorizontalContainment(page, [evidence, sources, openedUrls]);
  await captureEvidence(page, "1440x960-ling-light-channel-web-evidence.png");
  expect(runtimeErrors).toEqual([]);
});

test("AI teammate private memory evidence expands in dark reduced-motion without overflow", async ({ page }) => {
  await prepareSurface(page, { theme: "dark", width: 1280, height: 800, reducedMotion: true });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  installTeammateMemoryEvidence(state);
  await mockDaemon(page, state);

  await page.goto("/");
  await openTeammate(page, "UI2 Evidence Engineer");

  const chat = page.getByLabel("Private chat", { exact: true });
  const feed = chat.getByLabel("Private message feed", { exact: true });
  const message = feed.locator(".teammate-message-row.ai-teammate").filter({ hasText: "Memory-backed focused evidence response." });
  const evidence = message.getByLabel("Message evidence", { exact: true });
  const toggle = evidence.locator(".conversation-evidence-toggle");
  await expect(evidence).toBeVisible();
  await expect(toggle).toHaveClass(/\bling-ui-button\b/);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expectMinimumSize(toggle, { height: 32 });
  await expectContained(toggle, evidence);

  await toggle.focus();
  await toggle.press("Space");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");

  const memorySection = evidence.getByLabel("Memory", { exact: true });
  const memoryContent = memorySection.getByLabel("Used memory", { exact: true });
  const memoryTitle = memoryContent.getByText(/Private focused memory/);
  await expect(memorySection).toBeVisible();
  await expect(memoryContent).toBeVisible();
  await expect(memoryTitle).toBeVisible();
  await expectContained(memorySection, evidence);
  await expectContained(memoryContent, memorySection);
  await expectContained(memoryTitle, memoryContent);
  await expectHorizontalContainment(page, [chat, feed, message, evidence, memorySection, memoryContent]);
  await expect.poll(() => page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);

  await captureEvidence(page, "1280x800-ling-dark-teammate-memory-evidence.png");
  expect(runtimeErrors).toEqual([]);
});

test("Runs evidence contains long content and supports keyboard disclosure", async ({ page }) => {
  await prepareSurface(page, { theme: "light", width: 1440, height: 960 });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createRunsThreadsFixture();
  const failedRun = state.runs.find((run) => run.id === "run_ui2_failed");
  expect(failedRun).toBeDefined();
  const longCode = `evidence_${"segment_".repeat(30)}done`;
  const longLink = `https://example.com/${"deep-evidence-path/".repeat(18)}result`;
  failedRun!.errorMessage = `Focused run evidence uses \`${longCode}\` and [the retained source](${longLink}).`;
  const longMemoryTitle = `Run focused memory ${"containment".repeat(42)}`;
  state.memoryObjects = [{
    id: "memory_ui2_run_evidence",
    workspaceId: "workspace_default",
    scopeType: "workspace",
    ownerId: "workspace_default",
    title: longMemoryTitle,
    body: "Run evidence memory body.",
    tags: ["ui2", "evidence"],
    sourceRefs: [],
    reviewState: "active",
    enabled: true,
    sensitivity: "internal",
    createdAt: failedRun!.createdAt,
    updatedAt: failedRun!.updatedAt,
  }];
  state.usedMemoryEvents = [{
    id: "used_memory_ui2_run_evidence",
    workspaceId: "workspace_default",
    memoryIds: ["memory_ui2_run_evidence"],
    intent: "run",
    recallQuery: "focused run evidence",
    responseId: failedRun!.id,
    policyVersion: "ling-memory-v1-lexical",
    createdAt: failedRun!.updatedAt,
  }];
  await installRunsThreadsFixture(page, state);

  await page.goto("/");
  await openMainRunHistory(page, "Failed provider repair run");

  const detail = page.getByLabel("Run detail", { exact: true });
  const evidence = detail.locator(".conversation-evidence").first();
  const evidenceInspector = evidence.locator("xpath=ancestor::details[contains(@class, 'ling-ui-inspector-section')]").first();
  const toggle = evidence.locator(".conversation-evidence-toggle");
  const summaryRow = evidenceInspector.locator(".conversation-summary-row");
  const inlineCode = summaryRow.locator(".message-inline-code");
  const link = summaryRow.locator(".message-web-link");
  const status = summaryRow.locator(".ling-ui-status-indicator");
  await expect(evidenceInspector).toBeVisible();
  await expect(evidence).toBeVisible();
  await expect(toggle).toHaveClass(/\bling-ui-button\b/);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expectMinimumSize(toggle, { height: 32 });
  await expect(inlineCode).toContainText("evidence_segment_");
  await expect(link).toHaveAttribute("href", longLink);
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noreferrer");
  await expect(status).toBeVisible();
  await expectContained(toggle, evidence);
  await expectContained(evidence, evidenceInspector);
  await expectContained(inlineCode, summaryRow);
  await expectContained(link, summaryRow);
  await expectContained(status, summaryRow);

  await toggle.focus();
  await toggle.press("Space");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");

  const assistantSection = evidence.getByLabel("Assistant output", { exact: true });
  const memorySection = evidence.getByLabel("Memory", { exact: true });
  const memoryItem = memorySection.getByText(longMemoryTitle, { exact: true });
  await expect(assistantSection).toBeVisible();
  await expect(memorySection).toBeVisible();
  await expect(memoryItem).toBeVisible();
  await expectContained(assistantSection, evidence);
  await expectContained(memorySection, evidence);
  await expectContained(memoryItem, memorySection);
  await expectHorizontalContainment(page, [detail, evidenceInspector, summaryRow, evidence, assistantSection, memorySection]);

  await captureEvidence(page, "1440x960-ling-light-runs-evidence.png");
  expect(runtimeErrors).toEqual([]);
});

function channelEvidenceMessage(input: {
  readonly id: string;
  readonly body: string;
  readonly webEvidence: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    id: input.id,
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    kind: "ai_reply",
    intent: "discuss",
    authorType: "ai-teammate",
    authorId: "engineer",
    body: input.body,
    mentions: [],
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
    status: "ready",
    webEvidence: input.webEvidence,
    createdAt: "2026-07-23T08:00:00.000Z",
    updatedAt: "2026-07-23T08:00:00.000Z",
  };
}

function installTeammateMemoryEvidence(state: MockState): void {
  const teammateId = "teammate_ui2_evidence";
  const threadId = `tdthread_${teammateId}`;
  const messageId = "message_ui2_teammate_evidence";
  const timestamp = "2026-07-23T08:10:00.000Z";
  state.providers = [createChatProvider({
    id: "provider_ui2_evidence",
    displayName: "Local Relay",
    model: "gpt-5.5",
  })];
  state.aiTeammates = [createMockTeammate({
    id: teammateId,
    displayName: "UI2 Evidence Engineer",
    providerPresetId: "provider_ui2_evidence",
  })];
  state.memoryObjects = [{
    id: "memory_ui2_teammate_evidence",
    workspaceId: "workspace_default",
    scopeType: "teammate",
    ownerId: teammateId,
    title: `Private focused memory ${"scannable".repeat(36)}`,
    body: "Keep private evidence compact and contained.",
    tags: ["ui2", "evidence"],
    sourceRefs: [],
    reviewState: "active",
    enabled: true,
    sensitivity: "private",
    createdAt: timestamp,
    updatedAt: timestamp,
  }];
  state.usedMemoryEvents = [{
    id: "used_memory_ui2_teammate_evidence",
    workspaceId: "workspace_default",
    memoryIds: ["memory_ui2_teammate_evidence"],
    intent: "private-chat",
    recallQuery: "focused private evidence",
    teammateId,
    responseId: messageId,
    policyVersion: "ling-memory-v1-lexical",
    createdAt: timestamp,
  }];
  state.teammateDirectMessages = [directMessage({
    id: messageId,
    teammateId,
    threadId,
    body: "Memory-backed focused evidence response.",
    createdAt: timestamp,
  })];
}

function directMessage(input: {
  readonly id: string;
  readonly teammateId: string;
  readonly threadId: string;
  readonly body: string;
  readonly createdAt: string;
}): Record<string, unknown> {
  return {
    id: input.id,
    workspaceId: "workspace_default",
    threadId: input.threadId,
    teammateId: input.teammateId,
    authorType: "ai-teammate",
    authorId: input.teammateId,
    body: input.body,
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
    status: "ready",
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

async function openTeammate(page: Page, name: string): Promise<void> {
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name }).click();
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
  await expect(page.getByText("Loading teammate workspace...")).toHaveCount(0);
}

async function prepareSurface(page: Page, fixture: {
  readonly theme: "light" | "dark";
  readonly width: number;
  readonly height: number;
  readonly reducedMotion?: boolean;
}): Promise<void> {
  await page.setViewportSize({ width: fixture.width, height: fixture.height });
  await page.emulateMedia({ reducedMotion: fixture.reducedMotion ? "reduce" : "no-preference" });
  await page.addInitScript(({ theme }) => {
    const selection = { mode: "fixed", themeId: `ling-${theme}` };
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themePreference", theme);
    localStorage.setItem("ling-stack.themeBootstrapPreference", theme);
  }, { theme: fixture.theme });
}

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function expectContained(inner: Locator, outer: Locator): Promise<void> {
  await expect.poll(async () => {
    const [innerBox, outerBox] = await Promise.all([inner.boundingBox(), outer.boundingBox()]);
    if (!innerBox || !outerBox) return false;
    return innerBox.x >= outerBox.x - containmentTolerance
      && innerBox.y >= outerBox.y - containmentTolerance
      && innerBox.x + innerBox.width <= outerBox.x + outerBox.width + containmentTolerance
      && innerBox.y + innerBox.height <= outerBox.y + outerBox.height + containmentTolerance;
  }).toBe(true);
}

async function expectMinimumSize(locator: Locator, minimum: { readonly width?: number; readonly height?: number }): Promise<void> {
  await expect.poll(async () => {
    const box = await locator.boundingBox();
    if (!box) return false;
    return (minimum.width === undefined || box.width >= minimum.width)
      && (minimum.height === undefined || box.height >= minimum.height);
  }).toBe(true);
}

async function expectHorizontalContainment(page: Page, elements: readonly Locator[]): Promise<void> {
  await expect.poll(() => page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth
  )).toBeLessThanOrEqual(containmentTolerance);
  for (const element of elements) {
    await expect.poll(() => element.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(containmentTolerance);
  }
}

async function captureEvidence(page: Page, filename: string): Promise<void> {
  if (process.env.LING_CAPTURE_UI2_EVIDENCE !== "1") return;
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({ animations: "disabled", fullPage: true, path: `${evidenceDirectory}${filename}` });
}
