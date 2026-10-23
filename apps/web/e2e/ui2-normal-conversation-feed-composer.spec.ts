import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import { expectCompactMutedComposerControl } from "./support/composer-control-assertions";
import { expectMessageFrameContained } from "./support/message-frame-assertions";
import { createBaseState, createChatProvider, cwd, type MockState } from "./support/mock-state";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/conversations/normal-conversation-feed-composer/",
  import.meta.url,
));
for (const fixture of [
  { theme: "light" as const, width: 1440, height: 960 },
  { theme: "dark" as const, width: 1280, height: 800 },
]) {
  test(`normal conversation feed owns history and active states at ${fixture.width}x${fixture.height} ${fixture.theme}`, async ({ page }) => {
    await prepareSurface(page, fixture.theme, fixture.width, fixture.height);
    const runtimeErrors = collectRuntimeErrors(page);
    const state = createBaseState({ approvalStatus: "expired" });
    installProviders(state);
    const threadId = installFeedStateFixture(state);
    await mockDaemon(page, state);
    await page.goto("/");
    await openConversation(page, "UI2 feed state matrix");

    const conversation = page.getByLabel("Conversation page");
    const feedFrame = conversation.locator(".normal-conversation-feed-frame");
    const feed = conversation.getByLabel("Conversation messages", { exact: true });
    const composerStack = conversation.locator(".normal-conversation-composer-stack");
    const composer = conversation.getByLabel("New conversation composer");

    await expect(feed.locator(".normal-conversation-message-row")).toHaveCount(40);
    await expect(feed.getByText("Ling Agent is thinking...", { exact: true })).toHaveCount(2);
    const runningMessage = feed.locator(".normal-conversation-message-row.ai-teammate")
      .filter({ hasText: "Ling Agent is thinking..." })
      .last();
    await expect(runningMessage.locator(".conversation-work-cell")).toHaveCount(0);
    await expect(runningMessage).not.toContainText("Working on UI2 feed run 20");
    const failedMessage = feed
      .locator('[data-conversation-timeline-kind="agentMessage"][data-conversation-timeline-status="failed"]')
      .filter({ hasText: "Provider timed out while generating the response." });
    await expect(failedMessage).toBeVisible();
    await expect(failedMessage.locator(".normal-conversation-message-error")).toHaveCount(0);
    await expect(feed.locator(".conversation-attachment-chip")).toContainText("release-checklist.pdf");
    await expect(feed.getByRole("button", { name: "Retry response" })).toBeVisible();
    await expect(composer.getByRole("button", { name: "Stop" })).toBeVisible();

    await expectAlignedColumns(feedFrame, composerStack);
    await expect.poll(() => feed.evaluate((element) => getComputedStyle(element).overflowY)).toBe("auto");
    await expect.poll(() => feedFrame.evaluate((element) => getComputedStyle(element).overflowY)).toBe("hidden");
    await expect.poll(() => conversation.evaluate((element) => getComputedStyle(element).overflowY)).toBe("hidden");

    const composerBefore = await composer.boundingBox();
    await feed.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event("scroll"));
    });
    const latest = conversation.getByRole("button", { name: "Jump to latest message" });
    await expect(latest).toBeVisible();
    expect(Math.abs(((await composer.boundingBox())?.y ?? 0) - (composerBefore?.y ?? 0))).toBeLessThanOrEqual(1);
    await latest.click();
    await expect.poll(() => feed.evaluate((element) =>
      Math.max(0, element.scrollHeight - element.scrollTop - element.clientHeight)
    )).toBeLessThanOrEqual(2);
    await expect(latest).toHaveCount(0);

    const ownMessage = feed.locator(".normal-conversation-message-row.local-user").filter({ hasText: "UI2 history prompt 20" });
    const peerMessage = feed.locator(".normal-conversation-message-row.ai-teammate").last();
    await expect(ownMessage).toHaveClass(/message-bubble/);
    await expect(ownMessage).toHaveClass(/message-bubble-own/);
    await expect(peerMessage).toHaveClass(/message-bubble/);
    await expect(peerMessage).toHaveClass(/message-bubble-peer/);
    await expect(ownMessage).toHaveAttribute("data-has-avatar", "false");
    await expect(peerMessage).toHaveAttribute("data-has-avatar", "false");
    await expect(ownMessage.locator(":scope > :is(.user-profile-avatar, .avatar-initial, img)")).toHaveCount(0);
    await expect(peerMessage.locator(":scope > :is(.user-profile-avatar, .avatar-initial, img)")).toHaveCount(0);
    await expect(peerMessage).toHaveClass(/message-row-identity-sr-only/);
    await expect(peerMessage.locator(":scope > .message-content > header")).toHaveCSS("clip-path", "inset(50%)");
    await expectMessageFrameContained(ownMessage);
    await expectMessageFrameContained(peerMessage);
    await expectMessageWidthPolicy(ownMessage, peerMessage);

    const composerTheme = await composer.evaluate((element) => {
      const probe = document.createElement("span");
      probe.style.color = getComputedStyle(document.documentElement).getPropertyValue("--ling-bg-composer");
      document.body.append(probe);
      const expected = getComputedStyle(probe).color;
      probe.remove();
      return {
        actual: getComputedStyle(element).backgroundColor,
        expected,
        borderRadius: getComputedStyle(element).borderRadius,
      };
    });
    expect(composerTheme.actual).toBe(composerTheme.expected);
    expect(composerTheme.borderRadius).toBe("12px");
    await expectNoDocumentOverflow(page);
    await captureEvidence(page, `${fixture.width}x${fixture.height}-ling-${fixture.theme}-normal-feed-active-states.png`);
    expect(state.threads.some((thread) => thread.id === threadId)).toBe(true);
    expect(runtimeErrors).toEqual([]);
  });
}

test("normal conversation composer uses Radix menus and preserves draft, upload, and sending state", async ({ page }) => {
  await prepareSurface(page, "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.workspaceSettings.defaultReasoningSummary = "concise";
  installProviders(state);
  installStableConversationFixture(state);
  state.conversationStreamDelayMs = 650;
  await mockDaemon(page, state);
  await page.goto("/");
  await openConversation(page, "UI2 composer controls");

  const conversation = page.getByLabel("Conversation page");
  const composer = conversation.getByLabel("New conversation composer");
  const input = composer.getByRole("textbox", { name: "Conversation message" });
  const composerBeforeFocus = await composer.boundingBox();
  await input.fill("Keep this draft while menus open");
  const composerAfterFocus = await composer.boundingBox();
  expect(Math.abs((composerAfterFocus?.width ?? 0) - (composerBeforeFocus?.width ?? 0))).toBeLessThanOrEqual(1);

  const permissionTrigger = composer.getByRole("button", { name: /Selected permission preset/ });
  await permissionTrigger.click();
  const permissionMenu = page.locator('[data-ling-overlay="menu"]').filter({ has: page.getByRole("menuitemradio", { name: /Workspace write/ }) });
  await expect(permissionMenu).toBeVisible();
  await expect(permissionMenu.getByRole("group", { name: "Sandbox settings" }).getByRole("menuitemradio")).toHaveCount(3);
  await expect(permissionMenu.getByRole("group", { name: "Authorization mode" }).getByRole("menuitemradio")).toHaveCount(3);
  await permissionMenu.getByRole("menuitemradio", { name: "Request approval", exact: true }).click();
  await permissionTrigger.click();
  await expect(permissionMenu.getByRole("menuitemradio", { name: "Request approval", exact: true })).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(permissionMenu).toHaveCount(0);
  await expect(permissionTrigger).toBeFocused();

  await expect(composer.getByRole("button", { name: /Selected thinking mode|Selected reasoning summary|Selected authorization mode/ })).toHaveCount(0);
  const modelTrigger = composer.getByRole("button", { name: "Selected model gpt-5.5" });
  await expect(modelTrigger).toContainText("Off");
  await modelTrigger.click();
  const reasoningPanel = page.getByRole("dialog", { name: "Thinking mode" });
  const slider = reasoningPanel.getByRole("slider", { name: "Thinking mode" });
  await expect(reasoningPanel).toHaveAttribute("data-ling-overlay", "popover");
  await slider.focus();
  await slider.press("End");
  await expect(slider).toHaveAttribute("aria-valuetext", "XHigh");
  await slider.press("ArrowLeft");
  await expect(slider).toHaveAttribute("aria-valuetext", "High");
  await expect(modelTrigger).toContainText("High");
  await expect(modelTrigger).toHaveAccessibleName("Selected model gpt-5.5 · High");
  await expectCompactMutedComposerControl(permissionTrigger);
  await expectCompactMutedComposerControl(modelTrigger);
  await captureEvidence(page, "1440x960-ling-light-normal-composer-reasoning.png");
  await reasoningPanel.getByRole("button", { name: "Model options" }).click();
  const modelMenu = page.getByRole("dialog", { name: "Model options" });
  const modelSearch = modelMenu.getByRole("textbox", { name: "Search models" });
  await expect(modelSearch).toBeFocused();
  await expectInputContained(modelSearch, modelMenu.locator(".conversation-model-search"));
  await captureEvidence(page, "1440x960-ling-light-normal-composer-model-menu.png");
  await modelSearch.fill("nothing matches this query");
  await expect(modelMenu).toContainText("No matching models");
  await modelSearch.fill("sonnet");
  await expect(modelMenu.locator(".conversation-model-option")).toHaveCount(1);
  await modelMenu.getByRole("button", { name: /claude-sonnet-4/ }).click();
  const sonnetTrigger = composer.getByRole("button", { name: "Selected model claude-sonnet-4" });
  await expect(sonnetTrigger).toBeFocused();
  await expect(sonnetTrigger).toContainText("High");
  await sonnetTrigger.click();
  await expect(slider).toHaveAttribute("max", "2");
  await reasoningPanel.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(slider).toHaveAttribute("aria-valuetext", "Off");
  await expect(reasoningPanel.getByRole("button", { name: "Reset", exact: true })).toBeDisabled();
  await slider.focus();
  await slider.press("End");
  await expect(slider).toHaveAttribute("aria-valuetext", "High");
  await page.keyboard.press("Escape");
  await expect(sonnetTrigger).toBeFocused();

  await composer.locator('input[type="file"]').setInputFiles({
    name: "composer-evidence.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("UI 2.0 composer evidence", "utf8"),
  });
  const pendingAssets = composer.getByLabel("Pending message assets");
  await expect(pendingAssets).toContainText("composer-evidence.txt");
  await expect(input).toHaveAttribute("data-value", "Keep this draft while menus open");

  const submission = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname.endsWith("/conversations/stream"));
  await composer.getByRole("button", { name: "Send" }).click();
  expect((await submission).postDataJSON()).toMatchObject({
    providerPresetId: "provider_ui2_normal_sonnet",
    thinkingLevel: "high",
    reasoningSummary: "concise",
    authorizationMode: "ask",
    workspaceAccessMode: "workspace_write",
  });
  const send = composer.getByRole("button", { name: "Send" });
  await expect(send).toBeDisabled();
  await expect(send.locator(".ling-ui-spinner")).toHaveCount(1);
  await expect(permissionTrigger).toBeDisabled();
  await expect(conversation.getByText("Keep this draft while menus open", { exact: true })).toBeVisible({ timeout: 5_000 });
  await expect(send.locator(".ling-ui-spinner")).toHaveCount(0, { timeout: 5_000 });
  await expect(permissionTrigger).toBeEnabled();
  await expect(send).toBeDisabled();
  await expect(pendingAssets).toHaveCount(0);
  await expectNoDocumentOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("normal conversation unlocks into guidance when the reply run is linked", async ({ page }) => {
  await prepareSurface(page, "light", 1440, 960);
  await page.addInitScript(() => {
    const originalFetch = globalThis.fetch.bind(globalThis);
    let streamCalls = 0;
    (globalThis as typeof globalThis & { __normalReplyStreamCalls?: () => number }).__normalReplyStreamCalls = () => streamCalls;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (request.method !== "POST" || !url.pathname.endsWith("/conversations/stream")) {
        return originalFetch(input, init);
      }
      streamCalls += 1;
      const body = await request.clone().json() as Record<string, unknown>;
      const threadId = String(body.threadId ?? "thread_ui2_normal_composer_controls");
      const turnId = "turn_chunked_normal_reply";
      const runId = "run_chunked_normal_reply";
      const createdAt = "2026-08-05T09:00:00.000Z";
      const thread = {
        id: threadId,
        workspaceId: "workspace_default",
        kind: "conversation",
        title: "UI2 composer controls",
        status: "open",
        createdAt,
        updatedAt: createdAt,
      };
      const turn = {
        id: turnId,
        workspaceId: "workspace_default",
        threadId,
        kind: "manual_followup",
        status: "running",
        title: "Chunked normal reply",
        userInstruction: String(body.message ?? ""),
        teammateId: "ling_agent",
        activeRunId: runId,
        createdByActor: "local-user",
        createdAt,
        updatedAt: createdAt,
      };
      const userMessage = {
        id: "user_chunked_normal_reply",
        role: "user",
        content: String(body.message ?? ""),
        status: "succeeded",
        threadId,
        turnId,
        runId,
        createdAt,
        updatedAt: createdAt,
      };
      const pendingAssistant = {
        id: "assistant_chunked_normal_reply",
        role: "assistant",
        authorId: "ling_agent",
        authorLabel: "Ling Agent",
        content: "",
        status: "running",
        threadId,
        turnId,
        runId,
        createdAt,
        updatedAt: createdAt,
      };
      const doneAssistant = { ...pendingAssistant, content: "The first reply is complete.", status: "succeeded" };
      const run = {
        id: runId,
        status: "succeeded",
        cwd: String(body.projectPath ?? ""),
        taskId: `conversation:${turnId}`,
        providerPresetId: String(body.providerPresetId ?? "provider_ui2_normal_primary"),
        providerName: "local-relay",
        providerModel: "gpt-5.5",
        taskSnapshot: {},
        providerSnapshot: {},
        requestSnapshot: {},
        eventLogPath: `.ling-stack/sessions/${runId}.jsonl`,
        threadId,
        workUnitId: "wu_chunked_normal_reply",
        createdAt,
        startedAt: createdAt,
        endedAt: createdAt,
        updatedAt: createdAt,
      };
      const encoder = new TextEncoder();
      const timers: number[] = [];
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const emit = (event: string, data: unknown): void => {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          };
          emit("ready", { thread, turn, userMessage, assistantMessage: pendingAssistant });
          timers.push(globalThis.setTimeout(() => emit("ready", {
            thread,
            turn,
            userMessage,
            assistantMessage: pendingAssistant,
            runId,
            activeReply: {
              runId,
              sourceRunId: runId,
              workUnitId: "wu_chunked_normal_reply",
              threadId,
              teammateId: "ling_agent",
              status: "queued",
              createdAt,
              updatedAt: createdAt,
            },
          }), 400));
          timers.push(globalThis.setTimeout(() => emit("run_event", {
            threadId,
            turnId,
            runId,
            event: { id: "event_chunked_normal_reply", runId, seq: 1, ts: createdAt, type: "assistant_text_delta", data: { text: doneAssistant.content } },
            assistantMessage: doneAssistant,
          }), 1_400));
          timers.push(globalThis.setTimeout(() => {
            emit("done", { thread: { ...thread, status: "succeeded" }, turn: { ...turn, status: "succeeded" }, run, assistantMessage: doneAssistant });
            controller.close();
          }, 1_800));
        },
        cancel() {
          timers.forEach((timer) => globalThis.clearTimeout(timer));
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };
  });

  const state = createBaseState({ approvalStatus: "expired" });
  installProviders(state);
  installStableConversationFixture(state);
  const runSeed = state.runs[0];
  await mockDaemon(page, state);
  await page.goto("/");
  await openConversation(page, "UI2 composer controls");

  const composer = page.getByLabel("New conversation composer");
  const input = composer.getByRole("textbox", { name: "Conversation message" });
  await input.fill("Start a reply that remains active");
  await input.press("Enter");

  state.runs.push({
    ...runSeed,
    id: "run_chunked_normal_reply",
    status: "running",
    taskId: "conversation:turn_chunked_normal_reply",
    threadId: "thread_ui2_normal_composer_controls",
    workUnitId: "wu_chunked_normal_reply",
    endedAt: undefined,
    createdAt: "2026-08-05T09:00:00.000Z",
    startedAt: "2026-08-05T09:00:00.000Z",
    updatedAt: "2026-08-05T09:00:00.000Z",
  });

  await expect(composer.getByRole("button", { name: "Stop" })).toBeVisible({ timeout: 1_000 });
  await input.fill("Also cover the accepted-message failure path");
  await input.press("Enter");
  await expect.poll(() => state.runInterventions.length).toBe(1);
  expect(state.runInterventions[0]).toMatchObject({
    sourceRunId: "run_chunked_normal_reply",
    mode: "queue_followup",
    instruction: "Also cover the accepted-message failure path",
  });
  await expect.poll(() => page.evaluate(() => (
    (globalThis as typeof globalThis & { __normalReplyStreamCalls?: () => number }).__normalReplyStreamCalls?.() ?? 0
  ))).toBe(1);
});

test("normal conversation does not reset scroll for same-height stream revisions", async ({ page }) => {
  await prepareSurface(page, "light", 1440, 800);
  await page.addInitScript(() => {
    type ScrollProbe = {
      scrollToCalls: number;
      emitChunk?: (content: string, seq: number) => void;
      finish?: () => void;
    };
    const probe: ScrollProbe = { scrollToCalls: 0 };
    (globalThis as typeof globalThis & { __normalConversationScrollProbe?: ScrollProbe }).__normalConversationScrollProbe = probe;
    const originalScrollTo = HTMLElement.prototype.scrollTo;
    HTMLElement.prototype.scrollTo = function scrollTo(...args: Parameters<HTMLElement["scrollTo"]>): void {
      if (this.classList.contains("normal-conversation-feed")) probe.scrollToCalls += 1;
      originalScrollTo.apply(this, args);
    };

    const originalFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (request.method !== "POST" || !url.pathname.endsWith("/conversations/stream")) {
        return originalFetch(input, init);
      }
      const body = await request.clone().json() as Record<string, unknown>;
      const threadId = String(body.threadId ?? "thread_ui2_normal_composer_controls");
      const turnId = "turn_scroll_stability";
      const runId = "run_scroll_stability";
      const createdAt = "2026-08-29T05:00:00.000Z";
      const thread = {
        id: threadId,
        workspaceId: "workspace_default",
        kind: "conversation",
        title: "UI2 composer controls",
        status: "open",
        createdAt,
        updatedAt: createdAt,
      };
      const turn = {
        id: turnId,
        workspaceId: "workspace_default",
        threadId,
        kind: "manual_followup",
        status: "running",
        title: "Scroll stability",
        userInstruction: String(body.message ?? ""),
        teammateId: "ling_agent",
        activeRunId: runId,
        createdByActor: "local-user",
        createdAt,
        updatedAt: createdAt,
      };
      const userMessage = {
        id: "user_scroll_stability",
        role: "user",
        content: String(body.message ?? ""),
        status: "succeeded",
        threadId,
        turnId,
        runId,
        createdAt,
        updatedAt: createdAt,
      };
      const pendingAssistant = {
        id: "assistant_scroll_stability",
        role: "assistant",
        authorId: "ling_agent",
        authorLabel: "Ling Agent",
        content: "A",
        status: "running",
        threadId,
        turnId,
        runId,
        createdAt,
        updatedAt: createdAt,
      };
      const run = {
        id: runId,
        status: "succeeded",
        cwd: String(body.projectPath ?? ""),
        taskId: `conversation:${turnId}`,
        providerPresetId: String(body.providerPresetId ?? "provider_ui2_normal_primary"),
        providerName: "local-relay",
        providerModel: "gpt-5.5",
        taskSnapshot: {},
        providerSnapshot: {},
        requestSnapshot: {},
        eventLogPath: `.ling-stack/sessions/${runId}.jsonl`,
        threadId,
        workUnitId: "wu_scroll_stability",
        createdAt,
        startedAt: createdAt,
        endedAt: createdAt,
        updatedAt: createdAt,
      };
      const encoder = new TextEncoder();
      let latestAssistant = pendingAssistant;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const emit = (event: string, data: unknown): void => {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          };
          emit("ready", { thread, turn, userMessage, assistantMessage: pendingAssistant, runId });
          probe.emitChunk = (content, seq) => {
            const updatedAt = `2026-08-29T05:00:0${seq}.000Z`;
            latestAssistant = { ...pendingAssistant, content, updatedAt };
            emit("run_event", {
              threadId,
              turnId,
              runId,
              event: { id: `event_scroll_stability_${seq}`, runId, seq, ts: updatedAt, type: "assistant_text_delta", data: { text: content } },
              assistantMessage: latestAssistant,
            });
          };
          probe.finish = () => {
            emit("done", {
              thread: { ...thread, status: "succeeded" },
              turn: { ...turn, status: "succeeded" },
              run,
              assistantMessage: { ...latestAssistant, status: "succeeded" },
            });
            controller.close();
          };
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };
  });

  const state = createBaseState({ approvalStatus: "expired" });
  installProviders(state);
  const threadId = installStableConversationFixture(state);
  state.eventsByRun.run_ui2_normal_composer_controls = [{
    ...state.eventsByRun.run_ui2_normal_composer_controls[0],
    data: { text: Array.from({ length: 80 }, (_, index) => `Existing response line ${index + 1}`).join("\n") },
  }];
  await mockDaemon(page, state);
  await page.goto("/");
  await openConversation(page, "UI2 composer controls");

  const conversation = page.getByLabel("Conversation page");
  const feed = conversation.getByLabel("Conversation messages", { exact: true });
  await expect.poll(() => feed.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  const composer = conversation.getByLabel("New conversation composer");
  await composer.getByRole("textbox", { name: "Conversation message" }).fill("Keep streaming scroll stable");
  await composer.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => page.evaluate(() => Boolean(
    (globalThis as typeof globalThis & { __normalConversationScrollProbe?: { emitChunk?: unknown } })
      .__normalConversationScrollProbe?.emitChunk,
  ))).toBe(true);

  await page.evaluate(() => {
    const probe = (globalThis as typeof globalThis & {
      __normalConversationScrollProbe?: { emitChunk?: (content: string, seq: number) => void };
    }).__normalConversationScrollProbe;
    probe?.emitChunk?.("AB", 1);
  });
  await expect(conversation.getByText("AB", { exact: true })).toBeVisible();
  await page.waitForTimeout(50);
  await page.evaluate(() => {
    const probe = (globalThis as typeof globalThis & {
      __normalConversationScrollProbe?: { scrollToCalls: number };
    }).__normalConversationScrollProbe;
    if (probe) probe.scrollToCalls = 0;
  });

  for (const [content, seq] of [["ABC", 2], ["ABCD", 3], ["ABCDE", 4]] as const) {
    await page.evaluate(({ content: nextContent, seq: nextSeq }) => {
      const probe = (globalThis as typeof globalThis & {
        __normalConversationScrollProbe?: { emitChunk?: (content: string, seq: number) => void };
      }).__normalConversationScrollProbe;
      probe?.emitChunk?.(nextContent, nextSeq);
    }, { content, seq });
    await expect(conversation.getByText(content, { exact: true })).toBeVisible();
    await page.waitForTimeout(50);
  }

  expect(await page.evaluate(() => (
    (globalThis as typeof globalThis & { __normalConversationScrollProbe?: { scrollToCalls: number } })
      .__normalConversationScrollProbe?.scrollToCalls ?? -1
  ))).toBe(0);
  const beforeGrowth = await feed.evaluate((element) => element.scrollHeight);
  const growingContent = Array.from({ length: 30 }, (_, index) => `Stream line ${index + 1}`).join("\n");
  await page.evaluate((content) => {
    const probe = (globalThis as typeof globalThis & {
      __normalConversationScrollProbe?: { emitChunk?: (content: string, seq: number) => void };
    }).__normalConversationScrollProbe;
    probe?.emitChunk?.(content, 5);
  }, growingContent);
  await expect(conversation.getByText(growingContent, { exact: true })).toBeVisible();
  await expect.poll(() => feed.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await expect.poll(() => feed.evaluate((element) => Math.max(0, element.scrollHeight - element.scrollTop - element.clientHeight))).toBeLessThanOrEqual(2);
  expect(await feed.evaluate((element) => element.scrollHeight)).toBeGreaterThan(beforeGrowth);

  const latest = conversation.getByRole("button", { name: "Jump to latest message" });
  await feed.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect(latest).toBeVisible();
  const awayContent = Array.from({ length: 60 }, (_, index) => `Away stream line ${index + 1}`).join("\n");
  await page.evaluate((content) => {
    const probe = (globalThis as typeof globalThis & {
      __normalConversationScrollProbe?: { emitChunk?: (content: string, seq: number) => void };
    }).__normalConversationScrollProbe;
    probe?.emitChunk?.(content, 6);
  }, awayContent);
  await expect(conversation.getByText(awayContent, { exact: true })).toBeVisible();
  await expect.poll(() => feed.evaluate((element) => element.scrollTop)).toBeLessThanOrEqual(2);
  await expect(latest).toBeVisible();
  await expect.poll(() => feed.evaluate((element) => Math.max(0, element.scrollHeight - element.scrollTop - element.clientHeight))).toBeGreaterThan(56);
  await latest.click();
  await expect.poll(() => feed.evaluate((element) => Math.max(0, element.scrollHeight - element.scrollTop - element.clientHeight))).toBeLessThanOrEqual(2);

  await page.evaluate(() => {
    const probe = (globalThis as typeof globalThis & {
      __normalConversationScrollProbe?: { finish?: () => void };
    }).__normalConversationScrollProbe;
    probe?.finish?.();
  });
  expect(state.threads.some((thread) => thread.id === threadId)).toBe(true);
});

test("normal conversation coalesces tail reconciliation per animation frame", async ({ page }) => {
  await prepareSurface(page, "light", 1440, 800);
  await page.addInitScript(() => {
    type ScrollProbe = {
      rafCalls: number;
      triggerResize?: () => void;
    };
    const probe: ScrollProbe = { rafCalls: 0 };
    const observers: Array<{ trigger: () => void }> = [];
    (globalThis as typeof globalThis & { __normalConversationScrollProbe?: ScrollProbe }).__normalConversationScrollProbe = probe;

    const originalRequestAnimationFrame = globalThis.requestAnimationFrame.bind(globalThis);
    globalThis.requestAnimationFrame = (callback) => {
      probe.rafCalls += 1;
      return originalRequestAnimationFrame(callback);
    };

    class FakeResizeObserver {
      private readonly callback: ResizeObserverCallback;

      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
        observers.push(this);
      }

      observe(_target: Element): void {}

      unobserve(_target: Element): void {}

      disconnect(): void {
        const index = observers.indexOf(this);
        if (index >= 0) observers.splice(index, 1);
      }

      trigger(): void {
        this.callback([], this as unknown as ResizeObserver);
      }
    }
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
    probe.triggerResize = () => observers.slice().forEach((observer) => observer.trigger());
  });

  const state = createBaseState({ approvalStatus: "expired" });
  installProviders(state);
  installStableConversationFixture(state);
  await mockDaemon(page, state);
  await page.goto("/");
  await openConversation(page, "UI2 composer controls");
  await page.waitForTimeout(100);
  await page.evaluate(() => {
    const probe = (globalThis as typeof globalThis & {
      __normalConversationScrollProbe?: { rafCalls: number };
    }).__normalConversationScrollProbe;
    if (probe) probe.rafCalls = 0;
  });

  await page.evaluate(() => {
    const probe = (globalThis as typeof globalThis & {
      __normalConversationScrollProbe?: { triggerResize?: () => void };
    }).__normalConversationScrollProbe;
    probe?.triggerResize?.();
    probe?.triggerResize?.();
    probe?.triggerResize?.();
  });
  await expect.poll(() => page.evaluate(() => (
    (globalThis as typeof globalThis & { __normalConversationScrollProbe?: { rafCalls: number } })
      .__normalConversationScrollProbe?.rafCalls ?? -1
  ))).toBe(1);
});

test("normal conversation replacement retry keeps the original idempotency key", async ({ page }) => {
  await prepareSurface(page, "dark", 1280, 800);
  const state = createBaseState({ approvalStatus: "expired" });
  installProviders(state);
  installFeedStateFixture(state);
  await mockDaemon(page, state);
  await page.goto("/");
  await openConversation(page, "UI2 feed state matrix");

  const conversation = page.getByLabel("Conversation page");
  const retry = conversation.getByRole("button", { name: "Retry response" });
  await retry.click();
  await expect.poll(() => state.lastConversationMessageEditRequest?.idempotencyKey).toBe("ui2-replacement-idempotency");
  await expect(retry).toHaveCount(0);
  await expect(conversation).toContainText("Ling Agent response: UI2 history prompt 17");
});

function installProviders(state: MockState): void {
  const lastCheck = {
    ok: true,
    code: "ready",
    message: "Provider is reachable.",
    checkedAt: "2026-07-19T00:00:00.000Z",
  };
  state.providers = [
    createChatProvider({
      id: "provider_ui2_normal_primary",
      displayName: "Local Relay",
      model: "gpt-5.5",
      thinkingModes: ["minimal", "low", "medium", "high", "xhigh"],
      lastCheck,
    }),
    createChatProvider({
      id: "provider_ui2_normal_sonnet",
      displayName: "Sonnet",
      providerId: "anthropic",
      model: "claude-sonnet-4",
      thinkingModes: ["low", "high"],
      lastCheck,
    }),
  ];
  state.workspaceSettings.defaultProviderPresetId = "provider_ui2_normal_primary";
}

function installFeedStateFixture(state: MockState): string {
  const threadId = "thread_ui2_normal_feed_matrix";
  const createdAt = "2026-07-19T03:00:00.000Z";
  const turns = Array.from({ length: 20 }, (_, index) => {
    const turnNumber = index + 1;
    const turnId = `turn_ui2_normal_feed_${turnNumber}`;
    const runId = `run_ui2_normal_feed_${turnNumber}`;
    const timestamp = new Date(Date.UTC(2026, 6, 19, 3, index, 0)).toISOString();
    const status = turnNumber === 18 ? "queued" : turnNumber === 19 ? "failed" : turnNumber === 20 ? "running" : "succeeded";
    state.turnRunLinks.push({ turnId, runId, attemptNumber: 1, role: "primary", createdAt: timestamp });
    state.eventsByRun[runId] = status === "failed" ? [{
      id: `event_${runId}_failure`,
      runId,
      seq: 1,
      ts: timestamp,
      type: "assistant_text_delta",
      data: { text: "Provider timed out while generating the response." },
    }] : status === "running" ? [{
      id: `event_${runId}_stream`,
      runId,
      seq: 1,
      ts: timestamp,
      type: "assistant_text_delta",
      data: { text: "" },
    }] : status === "queued" ? [] : [{
      id: `event_${runId}_answer`,
      runId,
      seq: 1,
      ts: timestamp,
      type: "assistant_text_delta",
      data: { text: `UI2 history response ${turnNumber}` },
    }];
    state.runs.unshift({
      id: runId,
      status,
      cwd,
      taskId: `task_ui2_normal_feed_${turnNumber}`,
      providerPresetId: "provider_ui2_normal_primary",
      providerName: "local-relay",
      providerModel: "gpt-5.5",
      taskSnapshot: { id: `task_ui2_normal_feed_${turnNumber}`, title: `UI2 feed run ${turnNumber}` },
      providerSnapshot: {},
      requestSnapshot: turnNumber === 17 ? { tools: ["edit"], thinkingLevel: "high" } : {},
      eventLogPath: `.ling-stack/sessions/${runId}.jsonl`,
      threadId,
      turnId,
      createdAt: timestamp,
      startedAt: status === "queued" ? undefined : timestamp,
      updatedAt: timestamp,
      endedAt: status === "succeeded" || status === "failed" ? timestamp : undefined,
    });
    return {
      id: turnId,
      workspaceId: "workspace_default",
      threadId,
      kind: turnNumber === 1 ? "initial_request" : "manual_followup",
      status: "succeeded",
      title: `UI2 history prompt ${turnNumber}`,
      userInstruction: `UI2 history prompt ${turnNumber}`,
      sourceMessageId: `conversation-user:${turnId}`,
      revision: 1,
      ...(turnNumber === 17 ? {
        pendingReplacement: {
          supersessionId: "ui2-replacement-supersession",
          idempotencyKey: "ui2-replacement-idempotency",
          failureReason: "Replacement response was interrupted.",
        },
      } : {}),
      activeRunId: status === "queued" || status === "running" ? runId : undefined,
      lastRunId: runId,
      createdByActor: "local-user",
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: status === "succeeded" || status === "failed" ? timestamp : undefined,
    };
  });
  state.threads = [{
    id: threadId,
    workspaceId: "workspace_default",
    kind: "conversation",
    title: "UI2 feed state matrix",
    objective: "Verify all normal conversation feed states.",
    status: "running",
    activeRunId: "run_ui2_normal_feed_20",
    lastRunId: "run_ui2_normal_feed_20",
    createdAt,
    updatedAt: turns.at(-1)?.updatedAt ?? createdAt,
  }];
  state.turns = turns;
  state.conversationAttachments = [{
    id: "attachment_ui2_normal_feed",
    workspaceId: "workspace_default",
    threadId,
    turnId: "turn_ui2_normal_feed_6",
    kind: "document",
    fileName: "release-checklist.pdf",
    contentType: "application/pdf",
    sizeBytes: 2048,
    path: `conversations/${threadId}/release-checklist.pdf`,
    createdAt: "2026-07-19T03:05:00.000Z",
  }];
  return threadId;
}

function installStableConversationFixture(state: MockState): string {
  const threadId = "thread_ui2_normal_composer_controls";
  const turnId = "turn_ui2_normal_composer_controls";
  const runId = "run_ui2_normal_composer_controls";
  const timestamp = "2026-07-19T04:00:00.000Z";
  state.threads = [{
    id: threadId,
    workspaceId: "workspace_default",
    kind: "conversation",
    title: "UI2 composer controls",
    objective: "Verify normal conversation composer controls.",
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
    title: "UI2 composer controls",
    userInstruction: "Open the composer controls.",
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
    taskId: "task_ui2_normal_composer_controls",
    providerPresetId: "provider_ui2_normal_primary",
    providerName: "local-relay",
    providerModel: "gpt-5.5",
    taskSnapshot: { id: "task_ui2_normal_composer_controls", title: "UI2 composer controls" },
    providerSnapshot: {},
    requestSnapshot: {},
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
    data: { text: "Composer controls are ready." },
  }];
  return threadId;
}

async function openConversation(page: Page, title: string): Promise<void> {
  await page.getByRole("button", { name: /Open recent conversation \d+/u }).filter({ hasText: title }).click();
  await expect(page.getByLabel("Conversation page")).toBeVisible();
}

async function expectAlignedColumns(feed: Locator, composer: Locator): Promise<void> {
  await expect.poll(async () => {
    const feedBox = await feed.boundingBox();
    const composerBox = await composer.boundingBox();
    if (!feedBox || !composerBox) return false;
    return Math.abs(feedBox.x - composerBox.x) <= 1 && Math.abs(feedBox.width - composerBox.width) <= 1;
  }).toBe(true);
}

async function expectMessageWidthPolicy(ownMessage: Locator, peerMessage: Locator): Promise<void> {
  const [ownRow, ownContent, peerRow, peerContent] = await Promise.all([
    ownMessage.boundingBox(),
    ownMessage.locator(":scope > .message-content").boundingBox(),
    peerMessage.boundingBox(),
    peerMessage.locator(":scope > .message-content").boundingBox(),
  ]);
  expect(ownRow).not.toBeNull();
  expect(ownContent).not.toBeNull();
  expect(peerRow).not.toBeNull();
  expect(peerContent).not.toBeNull();
  expect(ownContent!.width).toBeLessThan(ownRow!.width);
  expect(Math.abs(peerContent!.width - peerRow!.width)).toBeLessThanOrEqual(1);
}

async function expectInputContained(input: Locator, field: Locator): Promise<void> {
  const handle = await input.elementHandle();
  // Both rectangles must come from one frame while the menu is animating.
  const { inputBox, fieldBox } = await field.evaluate((element, input) => ({
    inputBox: input?.getBoundingClientRect().toJSON(),
    fieldBox: element.getBoundingClientRect().toJSON(),
  }), handle);
  expect(inputBox).not.toBeNull();
  expect(fieldBox).not.toBeNull();
  expect(inputBox!.x).toBeGreaterThanOrEqual(fieldBox!.x - 1);
  expect(inputBox!.x + inputBox!.width).toBeLessThanOrEqual(fieldBox!.x + fieldBox!.width + 1);
  expect(inputBox!.y).toBeGreaterThanOrEqual(fieldBox!.y - 1);
  expect(inputBox!.y + inputBox!.height).toBeLessThanOrEqual(fieldBox!.y + fieldBox!.height + 1);
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
  const sessionDirectory = process.env.LING_SESSION_VALIDATION_DIR?.replace(/\/$/u, "");
  if (sessionDirectory) {
    await mkdir(sessionDirectory, { recursive: true });
    await page.screenshot({ animations: "disabled", fullPage: true, path: `${sessionDirectory}/${filename}` });
    return;
  }
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
