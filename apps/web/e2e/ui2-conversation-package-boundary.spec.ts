import { access, mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  ComposerPermissionMenu,
  ConversationComposerShell,
  ConversationFeed,
  ConversationShell,
  MessageActionBar,
  RightDockShell,
  TeammateAvatarStack,
  TokenizedComposerInput,
} from "@ling-stack/conversation-ui-react";
import {
  filterSlashCommandPickerOptions,
  parseComposerInputParts,
} from "@ling-stack/conversation-ui-core";
import { seedImportedQuietOcean } from "./support/media-jobs-fixtures";
import { mockDaemon } from "./support/mock-daemon";
import {
  createBaseState,
  createMockTeammate,
  type MockState,
} from "./support/mock-state";
import {
  openChannelChatTools,
  openEngineeringChannel,
} from "./support/test-helpers";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/conversations/conversation-package-boundary/",
  import.meta.url,
));
const webConversationDirectory = fileURLToPath(new URL(
  "../src/shared/conversation/",
  import.meta.url,
));

const removedWebDuplicates = [
  "blocks/ConversationFeed.tsx",
  "blocks/ConversationShell.tsx",
  "blocks/MessageFooterActions.tsx",
  "blocks/RightDrawer.tsx",
  "composer/ComposerPermissionMenu.tsx",
  "composer/ConversationComposerShell.tsx",
  "composer/TokenizedComposerInput.tsx",
  "composer/composer-input-parts.ts",
  "composer/slash-command-picker.ts",
  "feedback/MessageActionBar.tsx",
  "identity/TeammateAvatarStack.tsx",
] as const;

test("T13-O.30 removes Web duplicates while shared package exports remain usable", async () => {
  for (const relativePath of removedWebDuplicates) {
    await expectPathToBeAbsent(`${webConversationDirectory}${relativePath}`);
  }

  const webBarrel = await readFile(`${webConversationDirectory}index.ts`, "utf8");
  for (const relativePath of removedWebDuplicates) {
    const localModule = `./${relativePath.replace(/\.tsx?$/u, ".js")}`;
    expect(webBarrel, `stale local export ${localModule}`).not.toContain(localModule);
  }
  expect(webBarrel).not.toContain("MessageFooterActions");
  expect(webBarrel).not.toContain("RightDrawer");

  for (const packageExport of [
    ComposerPermissionMenu,
    ConversationComposerShell,
    ConversationFeed,
    ConversationShell,
    MessageActionBar,
    RightDockShell,
    TeammateAvatarStack,
    TokenizedComposerInput,
    filterSlashCommandPickerOptions,
    parseComposerInputParts,
  ]) {
    expect(packageExport).toBeTruthy();
  }
});

test("1440x960 Ling Light keeps Channel message roots and Reply on the package boundary", async ({ page }) => {
  await prepareSurface(page, { height: 960, theme: "light", width: 1440 });
  const runtime = watchRuntime(page);
  const state = createBaseState({ approvalStatus: "expired" });
  installPlainChatFixture(state);
  await mockDaemon(page, state);

  await page.goto("/");
  await openEngineeringChannel(page);

  const feed = page.getByLabel("Channel message feed");
  const messageRoots = feed.locator(".message-bubble");
  await expect(messageRoots).toHaveCount(2);
  await expectMessageRootAttributes(messageRoots);

  const aiMessage = messageRoots.filter({ hasText: "Plain chat package reply" });
  await aiMessage.hover();
  const reply = aiMessage.getByRole("button", { name: "Reply in topic" });
  await expect(reply).toBeVisible();
  await expect(reply).not.toHaveAttribute("data-tooltip", /.+/u);
  await expectUniqueTooltipOnHoverAndFocus(page, reply, "Reply in topic");
  await expect(feed.locator('[aria-label="Reply in topic"][data-tooltip]')).toHaveCount(0);
  await expectNoHorizontalOverflow(page, [feed, messageRoots]);
  await captureEvidence(page, "1440x960-ling-light-channel-message-boundary.png");
  runtime.expectClean();
});

test("1280x800 Ling Dark gives Code and Mermaid CopyAction one Radix Tooltip and copied state", async ({ page }) => {
  await prepareSurface(page, { height: 800, theme: "dark", width: 1280 });
  const runtime = watchRuntime(page);
  const state = createBaseState({ approvalStatus: "expired" });
  installRichCopyFixture(state);
  await mockDaemon(page, state);

  await page.goto("/");
  await openEngineeringChannel(page);

  const feed = page.getByLabel("Channel message feed");
  const message = feed.locator(".message-bubble").filter({ hasText: "Package copy boundary" });
  await expect(message).toBeVisible();
  const code = message.locator(".message-code-block");
  const mermaid = message.locator(".message-mermaid-block");
  await expect(code).toBeVisible();
  await mermaid.scrollIntoViewIfNeeded();
  await expect(mermaid.locator(".message-mermaid-canvas svg")).toBeVisible({ timeout: 10_000 });

  await test.step("Mermaid CopyAction uses the package Radix Tooltip", async () => {
    const mermaidCopy = mermaid.locator("button.message-code-copy");
    await expect(mermaidCopy).toHaveAccessibleName("Copy Mermaid source");
    await mermaid.hover();
    await exerciseCopyAction(page, mermaidCopy, "Copy Mermaid source");
    await expect.poll(() => copiedText(page)).toContain("Package --> Boundary");
    await expect(mermaid.getByRole("button", { name: "Copy Mermaid source" })).toBeVisible({ timeout: 3_000 });
  });

  await test.step("Code CopyAction uses the package Radix Tooltip", async () => {
    const codeCopy = code.locator("button.message-code-copy");
    await expect(codeCopy).toHaveAccessibleName("Copy code");
    await exerciseCopyAction(page, codeCopy, "Copy code");
    await expect.poll(() => copiedText(page)).toContain("const packageBoundary = true");
  });
  await expectNoHorizontalOverflow(page, [feed, message, code, mermaid]);
  await captureEvidence(page, "1280x800-ling-dark-code-mermaid-copy.png");
  runtime.expectClean();
});

test("1440x960 Quiet Ocean keeps structured protocol and runtime MessageBubble semantics", async ({ page }) => {
  await prepareSurface(page, { height: 960, theme: "light", width: 1440 });
  const runtime = watchRuntime(page);
  const state = createBaseState({ approvalStatus: "expired" });
  installStructuredActivityFixture(state);
  await mockDaemon(page, state);

  await page.goto("/");
  const themeId = await seedImportedQuietOcean(page);
  await page.reload();
  await openChannelChatTools(page);
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", themeId);

  const feed = page.getByLabel("Channel message feed");
  const structured = feed.locator(".message-bubble-system").filter({ hasText: "Structured package boundary" });
  const protocol = feed.locator(".message-bubble-protocol").filter({ hasText: "Protocol package boundary" });
  const runtimeMessage = feed.locator(".message-bubble-runtime").filter({ hasText: "Runtime package boundary" });
  await expect(structured).toBeVisible();
  await expect(protocol).toBeVisible();
  await expect(runtimeMessage).toBeVisible();
  await expectMessageRootAttributes(feed.locator(".message-bubble"));
  await expectSemanticMessageColor(structured, "--ling-status-neutral", "--ling-bg-subtle");
  await expectSemanticMessageColor(protocol, "--ling-status-info", "--ling-status-info-bg");
  await expectSemanticMessageColor(runtimeMessage, "--ling-status-info", "--ling-status-info-bg");
  await expectNoHorizontalOverflow(page, [feed, structured, protocol, runtimeMessage]);
  await runtimeMessage.scrollIntoViewIfNeeded();
  await captureEvidence(page, "1440x960-quiet-ocean-structured-message-boundary.png");
  runtime.expectClean();
});

function installPlainChatFixture(state: MockState): void {
  state.aiTeammates = [createMockTeammate({ id: "engineer", displayName: "Engineer" })];
  state.channelMessages = [
    channelMessage({
      authorId: "local-user",
      authorType: "local-user",
      body: "Plain chat package prompt",
      createdAt: "2026-07-24T04:00:00.000Z",
      id: "message_ui2_package_prompt",
      kind: "message",
    }),
    channelMessage({
      authorId: "engineer",
      authorType: "ai-teammate",
      body: "Plain chat package reply",
      createdAt: "2026-07-24T04:01:00.000Z",
      id: "message_ui2_package_reply",
      kind: "ai_reply",
    }),
  ];
  clearDefaultActivity(state);
}

function installRichCopyFixture(state: MockState): void {
  state.aiTeammates = [createMockTeammate({ id: "engineer", displayName: "Engineer" })];
  state.channelMessages = [channelMessage({
    authorId: "engineer",
    authorType: "ai-teammate",
    body: [
      "Package copy boundary",
      "",
      "```ts",
      "const packageBoundary = true;",
      "```",
      "",
      "```mermaid",
      "flowchart LR",
      "  Package --> Boundary",
      "```",
    ].join("\n"),
    createdAt: "2026-07-24T04:10:00.000Z",
    id: "message_ui2_package_copy",
    kind: "ai_reply",
  })];
  clearDefaultActivity(state);
}

function installStructuredActivityFixture(state: MockState): void {
  state.channelMessages = [];
  state.channelConversationItemExtras = [{
    schemaVersion: 1,
    id: "item_ui2_package_structured",
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    threadId: "thread_channel_channel_engineering",
    sequence: 1,
    kind: "system_event",
    status: "committed",
    actorType: "system",
    visibility: "channel",
    payload: { eventType: "task_link", summary: "Structured package boundary" },
    domainRefs: [],
    revision: 1,
    createdAt: "2026-07-24T04:20:00.000Z",
    updatedAt: "2026-07-24T04:20:00.000Z",
    committedAt: "2026-07-24T04:20:00.000Z",
  }];
  state.channelDecisions = [{
    id: "decision_ui2_package_boundary",
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    title: "Protocol package boundary",
    decision: "Keep protocol messages on shared MessageBubble chrome.",
    rationale: "One semantic owner keeps imported themes predictable.",
    alternatives: [],
    status: "active",
    createdBy: "system",
    createdAt: "2026-07-24T04:21:00.000Z",
    updatedAt: "2026-07-24T04:21:00.000Z",
  }];
  state.channelWorkflows = [{
    id: "workflow_ui2_package_boundary",
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    title: "Runtime package boundary",
    objective: "Keep runtime messages on shared MessageBubble chrome.",
    status: "ready",
    createdBy: "system",
    createdAt: "2026-07-24T04:22:00.000Z",
    updatedAt: "2026-07-24T04:22:00.000Z",
  }];
  clearDefaultActivity(state);
}

function channelMessage(input: {
  readonly authorId: string;
  readonly authorType: "local-user" | "ai-teammate" | "system";
  readonly body: string;
  readonly createdAt: string;
  readonly id: string;
  readonly kind: "message" | "ai_reply" | "task_link";
}): Record<string, unknown> {
  return {
    id: input.id,
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    kind: input.kind,
    intent: input.kind === "task_link" ? "execute" : "discuss",
    authorType: input.authorType,
    authorId: input.authorId,
    body: input.body,
    mentions: [],
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
    status: "ready",
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

function clearDefaultActivity(state: MockState): void {
  state.tasks = [];
  state.runs = [];
  state.approvals = [];
}

async function prepareSurface(page: Page, options: {
  readonly height: number;
  readonly theme: "light" | "dark";
  readonly width: number;
}): Promise<void> {
  await page.setViewportSize({ height: options.height, width: options.width });
  await page.emulateMedia({ colorScheme: options.theme });
  await page.addInitScript((theme) => {
    const override = sessionStorage.getItem("ling-stack.e2eThemeSelection");
    const selection = override
      ? JSON.parse(override) as { readonly mode: "fixed"; readonly themeId: string }
      : { mode: "fixed" as const, themeId: `ling-${theme}` };
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themePreference", theme);
    localStorage.setItem("ling-stack.themeBootstrapPreference", theme);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          (window as unknown as { __lingCopiedText?: string }).__lingCopiedText = text;
        },
      },
    });
  }, options.theme);
}

async function exerciseCopyAction(page: Page, action: Locator, idleLabel: string): Promise<void> {
  await action.scrollIntoViewIfNeeded();
  await expectUniqueTooltipOnHoverAndFocus(page, action, idleLabel);
  await action.click();
  await expect(action).toHaveAttribute("aria-label", "Copied");
  await action.blur();
  await action.focus();
  await expectUniqueRadixTooltip(page, "Copied");
}

async function expectUniqueTooltipOnHoverAndFocus(page: Page, action: Locator, label: string): Promise<void> {
  await action.hover();
  await expectUniqueRadixTooltip(page, label);
  await page.mouse.move(2, 2);
  await expect(page.locator('[data-ling-overlay="tooltip"]:visible')).toHaveCount(0);
  await action.focus();
  await expect(action).toBeFocused();
  await expectUniqueRadixTooltip(page, label);
}

async function expectUniqueRadixTooltip(page: Page, label: string): Promise<void> {
  const visibleTooltips = page.locator('[data-ling-overlay="tooltip"]:visible');
  await expect(visibleTooltips).toHaveCount(1, { timeout: 2_500 });
  await expect(visibleTooltips).toContainText(label);
}

async function expectMessageRootAttributes(roots: Locator): Promise<void> {
  expect(await roots.count()).toBeGreaterThan(0);
  const attributes = await roots.evaluateAll((elements) => elements.map((element) => ({
    messageRow: element.getAttribute("data-conversation-message-row"),
    hasAvatar: element.getAttribute("data-has-avatar"),
  })));
  for (const attribute of attributes) {
    expect(attribute.messageRow).toBe("true");
    expect(["true", "false"]).toContain(attribute.hasAvatar);
  }
}

async function expectSemanticMessageColor(
  root: Locator,
  borderToken: string,
  backgroundToken: string,
): Promise<void> {
  const colors = await root.locator(":scope > .message-content").evaluate((element, tokens) => {
    const resolveColor = (property: "backgroundColor" | "color", token: string): string => {
      const probe = document.createElement("span");
      probe.style[property] = `var(${token})`;
      document.body.append(probe);
      const value = getComputedStyle(probe)[property];
      probe.remove();
      return value;
    };
    const style = getComputedStyle(element);
    return {
      background: style.backgroundColor,
      expectedBackground: resolveColor("backgroundColor", tokens.backgroundToken),
      border: style.borderInlineStartColor,
      borderWidth: Number.parseFloat(style.borderInlineStartWidth),
      expectedBorder: resolveColor("color", tokens.borderToken),
    };
  }, { backgroundToken, borderToken });
  expect(colors.borderWidth).toBe(3);
  expect(colors.border).toBe(colors.expectedBorder);
  expect(colors.background).toBe(colors.expectedBackground);
}

async function expectNoHorizontalOverflow(page: Page, regions: readonly Locator[]): Promise<void> {
  const documentOverflow = await page.evaluate(() => ({
    body: document.body.scrollWidth - document.body.clientWidth,
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }));
  expect(documentOverflow.body).toBeLessThanOrEqual(1);
  expect(documentOverflow.document).toBeLessThanOrEqual(1);
  for (const region of regions) {
    const overflows = await region.evaluateAll((elements) => elements.map((element) => ({
      name: element.className,
      overflow: element.scrollWidth - element.clientWidth,
    })));
    for (const entry of overflows) {
      expect(entry.overflow, String(entry.name)).toBeLessThanOrEqual(1);
    }
  }
}

async function copiedText(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as { __lingCopiedText?: string }).__lingCopiedText ?? "");
}

async function expectPathToBeAbsent(path: string): Promise<void> {
  await expect(access(path).then(() => true, () => false), path).resolves.toBe(false);
}

async function captureEvidence(page: Page, filename: string): Promise<void> {
  if (process.env.LING_CAPTURE_UI2_EVIDENCE !== "1") return;
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: `${evidenceDirectory}${filename}`,
  });
}

function watchRuntime(page: Page): { readonly expectClean: () => void } {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) {
      consoleErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  return {
    expectClean: () => {
      expect(consoleErrors).toEqual([]);
      expect(pageErrors).toEqual([]);
    },
  };
}
