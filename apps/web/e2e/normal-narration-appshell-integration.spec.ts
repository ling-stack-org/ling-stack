import { expect, test, type Page } from "@playwright/test";
import type { ConversationDetailResponse, ConversationTranscriptMessage } from "@ling-stack/contracts";
import { installNormalWorkCellFixture } from "./support/conversation-work-cell-fixture";
import { buildMockConversationDetail, mockDaemon } from "./support/mock-daemon";
import { createBaseState, cwd } from "./support/mock-state";
import { expandTimelineProcesses } from "./support/timeline-process";
import { timelineResponseFooter } from "./support/timeline-response-footer";

function narrationFixture() {
  const state = createBaseState({ approvalStatus: "expired" });
  const title = installNormalWorkCellFixture(state);
  state.providers = state.providers.map((provider) => ({
    ...(provider as Record<string, unknown>),
    lastCheck: { ok: true, message: "ok", checkedAt: "2026-09-05T00:00:00.000Z" },
  }));
  state.terminalReports = [];
  const thread = state.threads.find((candidate) => candidate.kind === "conversation");
  const command = state.executionActions[0];
  if (!thread || !command?.commandEvidence) throw new Error("Normal fixture must have a thread and Host command evidence");
  const turn = state.turns.find((candidate) => candidate.threadId === thread.id)!;
  const userId = `conversation-user:${turn.id}`;
  const refs = [{ kind: "conversation_item", id: userId }];
  state.executionActions = [
    {
      ...command, id: "narration-read", actionType: "read", title: "read", summary: "src/todo.mjs",
      revision: 50, sourceEventSequence: 49, sourceRefs: refs, toolCallId: "narration-read-call",
      targetRefs: [{ type: "file", id: "src/todo.mjs", path: "src/todo.mjs" }], commandEvidence: undefined,
      toolEvidence: { toolName: "read", inputSummary: "src/todo.mjs", outputText: "export const done = true;\n", outputTruncated: false, latestEventSeq: 50 },
    },
    {
      ...command, id: "narration-command", title: "bash", summary: "node --test",
      revision: 100, sourceEventSequence: 99, sourceRefs: refs, toolCallId: "narration-command-call",
      targetRefs: [{ type: "command", label: "node --test" }],
      commandEvidence: { ...command.commandEvidence, command: "node --test", exitCode: 0, latestEventSeq: 100, outputTail: [{ ...command.commandEvidence.outputTail[0]!, text: "1 test passed\n" }] },
    },
  ];
  const detail = buildMockConversationDetail(state, cwd, thread) as unknown as ConversationDetailResponse;
  const assistant = detail.messages.find((message) => message.role === "assistant")!;
  const narrationSegments = [
    { content: "Before read.\n\nInspect `todo.mjs`.", firstEventId: "narration-5", lastEventId: "narration-48", startEventSequence: 5, endEventSequence: 48, completed: true },
    { content: "Before command.\n\nRun `node --test`.", firstEventId: "narration-57", lastEventId: "narration-98", startEventSequence: 57, endEventSequence: 98, completed: true },
    { content: "After verification.\n\nThe check is complete.", firstEventId: "narration-105", lastEventId: "narration-110", startEventSequence: 105, endEventSequence: 110, completed: true },
  ];
  const fullAssistant: ConversationTranscriptMessage = {
    ...assistant, content: narrationSegments.map((segment) => segment.content).join("\n\n"), narrationSegments,
  };
  // This is the packaged N02 shape: the user anchor is durable, but assistant
  // boundaries exist only in the transcript DTO derived from RunEvents.
  const historicalDetail: ConversationDetailResponse = {
    ...detail,
    conversationItems: detail.conversationItems.filter((item) => item.kind === "user_message"),
    messages: detail.messages.map((message) => message.role === "assistant" ? fullAssistant : message),
    plans: [], compactionCheckpoints: [], contextSummaries: [],
  };
  return { state, title, historicalDetail, fullAssistant };
}

async function openHistory(page: Page, title: string): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: /Open recent conversation \d+/u }).filter({ hasText: title }).click();
  await expect(page.getByLabel("Conversation page")).toBeVisible();
}

async function expectInterleavedNarration(page: Page): Promise<void> {
  const timeline = page.getByLabel("Conversation page").locator('[data-conversation-timeline="true"][data-conversation-timeline-depth="0"]').first();
  await expect(timeline.locator('[data-conversation-timeline-kind="agentMessage"]')).toHaveCount(3);
  await expandTimelineProcesses(timeline);
  const rows = timeline.locator('[data-conversation-timeline-kind][data-conversation-timeline-depth="0"]');
  await expect.poll(() => rows.evaluateAll((elements) => elements.map((element) => {
    const kind = element.getAttribute("data-conversation-timeline-kind");
    if (kind === "agentMessage") return element.textContent?.includes("Before read.") ? "before-read" : element.textContent?.includes("Before command.") ? "before-command" : "after-verification";
    return kind;
  }))).toEqual(["userMessage", "before-read", "exploration", "before-command", "commandExecution", "after-verification"]);
  const firstNarration = timeline.locator('[data-conversation-timeline-kind="agentMessage"]').first();
  await expect(firstNarration.locator(".message-body-paragraph")).toHaveCount(2);
  await expect(firstNarration.locator(".message-body-paragraph code")).toHaveText("todo.mjs");
  const read = timeline.locator('[data-conversation-action-id="narration-read"]');
  await expect(read.locator(".conversation-timeline-activity-main")).toContainText("Read todo.mjs");
  await expect(read.locator(".conversation-timeline-activity-main")).toHaveAttribute("aria-expanded", "false");
  const command = timeline.locator('[data-conversation-action-id="narration-command"]');
  await expect(command.locator(".conversation-timeline-activity-main")).toContainText("node --test");
  await expect(command.locator(".conversation-timeline-activity-main")).not.toContainText(/exit 0|Succeeded/u);
}

test("AppShell historical detail preserves narration boundaries around canonical tool facts", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  const fixture = narrationFixture();
  await mockDaemon(page, fixture.state);
  await page.route(new RegExp(`/conversations/${fixture.historicalDetail.thread.id}(?:\\?.*)?$`), (route) => route.fulfill({ json: fixture.historicalDetail }));
  await openHistory(page, fixture.title);
  await expectInterleavedNarration(page);
});

test("segmented normal narration owns message references and full-message actions only once", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async (text: string) => {
        (window as unknown as { normalCopiedText: string }).normalCopiedText = text;
      },
    } });
  });
  const fixture = narrationFixture();
  const detail = {
    ...fixture.historicalDetail,
    messages: fixture.historicalDetail.messages.map((message) => message.role === "assistant" ? {
      ...message, fileRefs: [{ path: "docs/review.md", label: "review.md" }],
    } : message),
  };
  await mockDaemon(page, fixture.state);
  await page.route(new RegExp(`/conversations/${detail.thread.id}(?:\\?.*)?$`), (route) => route.fulfill({ json: detail }));
  await openHistory(page, fixture.title);
  await expectInterleavedNarration(page);
  const rows = page.locator('[data-conversation-timeline-kind="agentMessage"]');
  const footer = await timelineResponseFooter(rows.last());
  await expect(footer.getByRole("button", { name: "Copy message", exact: true })).toHaveCount(1);
  await expect(footer.getByRole("button", { name: "Like response", exact: true })).toHaveCount(1);
  await expect(rows.locator(".conversation-reference-strip")).toHaveCount(1);
  await expect(rows.getByRole("button", { name: "Copy message", exact: true })).toHaveCount(0);
  for (const index of [0, 1]) {
    await expect(rows.nth(index).locator(".conversation-reference-strip, .normal-conversation-message-actions")).toHaveCount(0);
  }
  await footer.hover();
  await footer.getByRole("button", { name: "Copy message", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { normalCopiedText: string }).normalCopiedText))
    .toBe(fixture.fullAssistant.content);
});

test("normal narration hides assistant closing actions until pending and running become done", async ({ page }) => {
  const fixture = narrationFixture();
  const assistant: ConversationTranscriptMessage = {
    ...fixture.fullAssistant, status: "succeeded", fileRefs: [{ path: "docs/review.md", label: "review.md" }],
  };
  const detail = fixture.historicalDetail;
  await page.addInitScript(({ detail, assistant }) => {
    localStorage.setItem("ling-stack.locale", "en-US");
    const probe: { advance?: (status: "running" | "succeeded") => void; copiedText?: string } = {};
    (globalThis as typeof globalThis & { normalNarrationActionsProbe: typeof probe }).normalNarrationActionsProbe = probe;
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async (text: string) => { probe.copiedText = text; },
    } });
    const originalFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/conversations/stream")) {
        return originalFetch(input, init);
      }
      const userMessage = detail.messages.find((message) => message.role === "user")!;
      const turn = { ...detail.turns[0]!, status: "running", activeRunId: assistant.runId };
      const run = detail.runs[0]!;
      const firstSegment = assistant.narrationSegments![0]!;
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const emit = (event: string, data: unknown): void => {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          };
          emit("ready", { thread: detail.thread, turn, userMessage, runId: run.id, assistantMessage: {
            ...assistant, status: "pending", content: firstSegment.content, narrationSegments: [firstSegment],
          } });
          probe.advance = (status) => {
            if (status === "running") {
              // Even completed message_end segments are not a terminal Run.
              emit("run_event", { threadId: detail.thread.id, turnId: turn.id, runId: run.id,
                event: { id: "narration-110", runId: run.id, seq: 110, ts: run.updatedAt, type: "message_end", data: { role: "assistant" } },
                assistantMessage: { ...assistant, status },
              });
            } else {
              emit("done", { thread: detail.thread, turn: { ...turn, status, activeRunId: undefined }, run: { ...run, status }, assistantMessage: assistant });
              controller.close();
            }
          };
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };
  }, { detail, assistant });
  await mockDaemon(page, fixture.state);
  let streamStarted = false;
  let releaseRefresh = (): void => {};
  const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
  await page.route(new RegExp(`/conversations/${detail.thread.id}(?:\\?.*)?$`), async (route) => {
    if (streamStarted) await refreshGate;
    await route.fulfill({ json: { ...detail, messages: detail.messages.map((message) => message.role === "assistant"
      ? streamStarted ? assistant : { ...assistant, content: "", narrationSegments: undefined }
      : message) } });
  });
  try {
    await openHistory(page, fixture.title);
    streamStarted = true;
    await page.getByRole("textbox", { name: "Conversation message" }).fill("Continue with narration boundaries.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const rows = page.locator('[data-conversation-timeline-kind="agentMessage"]');
    const responseFooters = page.locator('[data-conversation-response-footer]');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Before read.");
    await expect.soft(rows.locator(".normal-conversation-message-actions"), "pending assistant must not expose closing actions").toHaveCount(0);
    await expect(responseFooters).toHaveCount(0);
    await expect(rows.locator(".conversation-reference-strip")).toHaveCount(1);
    const user = page.locator('[data-conversation-timeline-kind="userMessage"]').last();
    await expect(user.getByRole("button", { name: "Copy message", exact: true })).toHaveCount(1);
    await expect(user.getByRole("button", { name: "Edit message", exact: true })).toHaveCount(1);
    await page.evaluate(() => (globalThis as typeof globalThis & { normalNarrationActionsProbe: { advance: (status: "running" | "succeeded") => void } }).normalNarrationActionsProbe.advance("running"));
    await expectInterleavedNarration(page);
    await expect.soft(rows.locator(".normal-conversation-message-actions"), "running assistant must not expose closing actions").toHaveCount(0);
    await expect(responseFooters).toHaveCount(0);
    await expect(rows.locator(".conversation-reference-strip")).toHaveCount(1);
    await page.evaluate(() => (globalThis as typeof globalThis & { normalNarrationActionsProbe: { advance: (status: "running" | "succeeded") => void } }).normalNarrationActionsProbe.advance("succeeded"));
    const footer = await timelineResponseFooter(rows.last());
    await expect(responseFooters).toHaveCount(1);
    await expect(footer.getByRole("button", { name: "Copy message", exact: true })).toHaveCount(1);
    await expect(footer.getByRole("button", { name: "Like response", exact: true })).toHaveCount(1);
    await expect(footer.getByRole("button", { name: "Dislike response", exact: true })).toHaveCount(1);
    await expect(rows.locator(".normal-conversation-message-actions")).toHaveCount(0);
    await footer.hover();
    await footer.getByRole("button", { name: "Copy message", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (globalThis as typeof globalThis & { normalNarrationActionsProbe: { copiedText?: string } }).normalNarrationActionsProbe.copiedText)).toBe(assistant.content);
    releaseRefresh();
    await expectInterleavedNarration(page);
    await expect(responseFooters).toHaveCount(1);
  } finally {
    releaseRefresh();
  }
});

for (const entry of ["ready", "run_event", "done"] as const) {
  test(`AppShell SSE ${entry} preserves narration before a detail refresh can repair it`, async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
    const fixture = narrationFixture();
    const detail = fixture.historicalDetail;
    const emptyAssistant = { ...fixture.fullAssistant, content: "", narrationSegments: undefined };
    const initialDetail = { ...detail, messages: detail.messages.map((message) => message.role === "assistant" ? emptyAssistant : message) };
    let streamSent = false;
    let completedRefreshes = 0;
    let releaseRefresh = (): void => {};
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    await mockDaemon(page, fixture.state);
    await page.route(new RegExp(`/conversations/${detail.thread.id}(?:\\?.*)?$`), async (route) => {
      if (streamSent) await refreshGate;
      await route.fulfill({ json: streamSent ? detail : initialDetail });
      if (streamSent) completedRefreshes += 1;
    });
    await page.route(/\/conversations\/stream(?:\?.*)?$/u, async (route) => {
      streamSent = true;
      const userMessage = detail.messages.find((message) => message.role === "user")!;
      const turn = detail.turns[0]!;
      const run = detail.runs[0]!;
      const ready = { thread: detail.thread, turn, userMessage, assistantMessage: entry === "ready" ? fixture.fullAssistant : emptyAssistant, runId: run.id };
      const targetEvent = entry === "run_event"
        ? { threadId: detail.thread.id, turnId: turn.id, runId: run.id, event: { id: "narration-110", runId: run.id, seq: 110, ts: run.updatedAt, type: "assistant_text_delta", data: { text: "The check is complete." } }, assistantMessage: fixture.fullAssistant }
        : { thread: detail.thread, turn, run, assistantMessage: fixture.fullAssistant };
      await route.fulfill({
        contentType: "text/event-stream",
        body: [`event: ready\ndata: ${JSON.stringify(ready)}`, ...(entry === "ready" ? [] : [`event: ${entry}\ndata: ${JSON.stringify(targetEvent)}`]), ""].join("\n\n"),
      });
    });
    try {
      await openHistory(page, fixture.title);
      await expandTimelineProcesses(page.getByLabel("Conversation page"));
      await expect(page.locator('[data-conversation-action-id="narration-command"]')).toBeVisible();
      await page.getByRole("textbox", { name: "Conversation message" }).fill("Continue with narration boundaries.");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await expect.poll(() => streamSent).toBe(true);
      // GET /conversations/:id is held until this assertion completes, so only
      // the SSE entry can supply these segments to the mounted AppShell.
      await expectInterleavedNarration(page);
      expect(completedRefreshes).toBe(0);
      releaseRefresh();
      await expect.poll(() => completedRefreshes).toBeGreaterThan(0);
      await expectInterleavedNarration(page);
    } finally {
      releaseRefresh();
    }
  });
}
