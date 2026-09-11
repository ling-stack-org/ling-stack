import { expect, test, type Page, type TestInfo } from "@playwright/test";
import type { ConversationDetailResponse, TeammateDirectMessage } from "@ling-stack/contracts";
import { installTeammateWorkCellFixture } from "./support/conversation-work-cell-fixture";
import { buildMockConversationDetail, mockDaemon } from "./support/mock-daemon";
import { createBaseState, cwd } from "./support/mock-state";

function privateNarrationFixture(suffix = "") {
  const state = createBaseState({ approvalStatus: "expired" });
  const installed = installTeammateWorkCellFixture(state);
  const teammate = { teammateId: `${installed.teammateId}${suffix}`, displayName: `${installed.displayName}${suffix}` };
  const base = state.executionActions[0]!;
  const original = { ...base, runId: `${base.runId}${suffix}`, threadId: `${base.threadId}${suffix}` };
  const runId = original.runId!;
  const threadId = original.threadId!;
  const directThreadId = `tdthread_${teammate.teammateId}`;
  const turnId = `turn_private_narration${suffix}`;
  const userId = `dm_private_narration_user${suffix}`;
  const timestamp = original.updatedAt;
  state.providers = state.providers.map((provider) => ({ ...(provider as Record<string, unknown>), lastCheck: { ok: true, message: "ok", checkedAt: timestamp } }));
  state.terminalReports = [];
  state.approvals = [];
  state.turns = [{
    id: turnId, workspaceId: original.workspaceId, threadId, teammateId: teammate.teammateId,
    kind: "initial_request", status: "succeeded", sourceItemId: userId, title: "Private narration checks", userInstruction: "Read the project files then run tests.",
    lastRunId: runId, createdByActor: "local-user", createdAt: original.createdAt, updatedAt: timestamp,
  }];
  state.turnRunLinks = [{ turnId, runId, attemptNumber: 1, role: "primary", createdAt: original.createdAt }];
  state.aiTeammates = state.aiTeammates.map((entry) => ({ ...(entry as Record<string, unknown>), id: teammate.teammateId, displayName: teammate.displayName }));
  state.runs = state.runs.map((run) => run.id === base.runId ? { ...run, id: runId, threadId, turnId, teammateId: teammate.teammateId } : run);
  const thread = {
    id: threadId, workspaceId: original.workspaceId, kind: "teammate_direct" as const, teammateId: teammate.teammateId,
    title: "Private narration", objective: "Read the project files then run tests.", status: "succeeded" as const, lastRunId: runId, createdAt: original.createdAt, updatedAt: timestamp,
  };
  state.threads = [thread];
  state.conversationItems = [{
    schemaVersion: 1, id: userId, workspaceId: original.workspaceId, threadId, turnId, sequence: 1, revision: 1,
    kind: "user_message", status: "committed", actorType: "local_user", actorId: "local-user", visibility: "agent_private", visibilityOwnerId: teammate.teammateId,
    payload: { body: "Read the project files then run tests.", format: "plain_text", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] },
    domainRefs: [{ type: "message", id: userId }, { type: "turn", id: turnId }], createdAt: original.createdAt, updatedAt: timestamp,
  }];
  state.executionActions = [41, 77, 84, 91].map((seq, index) => ({
    ...original, id: `private${suffix}-narration-action-${seq}`, participantId: teammate.teammateId, sourceEventSequence: seq, revision: seq + 1,
    actionType: index === 3 ? "bash" : "read", title: index === 3 ? "Run command" : "Read file",
    summary: index === 3 ? "node --test" : `/workspace/private/file-${index}.mjs`, scopeSummary: index === 3 ? "workspace_read" : "read_only",
    toolCallId: `private${suffix}-narration-call-${seq}`, sourceRefs: [{ kind: "conversation_item", id: userId }, { kind: "run_event", id: `private${suffix}-event-${seq}` }],
    targetRefs: index === 3 ? [{ type: "command", label: "node --test" }] : [{ type: "file", id: `/workspace/private/file-${index}.mjs`, path: `/workspace/private/file-${index}.mjs` }],
    commandEvidence: index === 3 ? { ...original.commandEvidence!, command: "node --test", latestEventSeq: seq + 1 } : undefined,
    toolEvidence: index === 3 ? undefined : { toolName: "read", inputSummary: `/workspace/private/file-${index}.mjs`, outputText: `export const read${index} = true;\n`, outputTruncated: false, latestEventSeq: seq + 1 },
  }));
  const rawDetail = buildMockConversationDetail(state, cwd, thread) as unknown as ConversationDetailResponse;
  const timeline = {
    ...rawDetail, messages: [], conversationItems: [...state.conversationItems],
    runs: [...rawDetail.runs], turns: [...rawDetail.turns], runLinks: [...rawDetail.runLinks], executionActions: [...rawDetail.executionActions],
    plans: [], contextSnapshots: [], contextSummaries: [], compactionCheckpoints: [],
  } satisfies ConversationDetailResponse;
  const initial = state.teammateDirectMessages[0] as TeammateDirectMessage;
  const oldAssistant: TeammateDirectMessage = {
    ...initial, id: `${initial.id}${suffix}`, threadId: directThreadId, teammateId: teammate.teammateId,
    authorId: teammate.teammateId, linkedRunId: runId,
  };
  const user: TeammateDirectMessage = { ...oldAssistant, id: userId, authorType: "local-user", authorId: "local-user", body: "Read the project files then run tests.", linkedRunId: undefined };
  const segments = [
    { content: "Before first read.\n\nInspect `file-0.mjs`.", firstEventId: "private-5", lastEventId: "private-40", startEventSequence: 5, endEventSequence: 40, completed: true },
    { content: "Before more reads.", firstEventId: "private-50", lastEventId: "private-76", startEventSequence: 50, endEventSequence: 76, completed: true },
    { content: "Verification complete.", firstEventId: "private-96", lastEventId: "private-99", startEventSequence: 96, endEventSequence: 99, completed: true },
  ];
  const fullAssistant: TeammateDirectMessage = { ...oldAssistant, body: segments.map((segment) => segment.content).join("\n\n"), narrationSegments: segments };
  const initialAssistant = { ...oldAssistant, body: "Ready for the private test.", narrationSegments: undefined };
  state.teammateDirectMessages = [user, initialAssistant];
  const directThread = { id: directThreadId, workspaceId: original.workspaceId, teammateId: teammate.teammateId, title: teammate.displayName, createdAt: original.createdAt, updatedAt: timestamp };
  state.teammateDirectThreads[teammate.teammateId] = directThread;
  return { state, teammate, directThread, timeline, user, initialAssistant, fullAssistant };
}

/** Independently assert durable mock identities before trusting a browser result. */
function expectOwnedPrivateFixture(fixture: ReturnType<typeof privateNarrationFixture>): void {
  const { teammate, directThread, timeline, user, initialAssistant } = fixture;
  expect(directThread.id).not.toBe(timeline.thread.id);
  expect(directThread.teammateId).toBe(teammate.teammateId);
  expect(timeline.thread).toMatchObject({ kind: "teammate_direct", teammateId: teammate.teammateId, workspaceId: directThread.workspaceId });
  for (const message of [user, initialAssistant]) {
    expect(message).toMatchObject({ threadId: directThread.id, teammateId: teammate.teammateId, workspaceId: directThread.workspaceId });
  }
  expect(initialAssistant.authorId).toBe(teammate.teammateId);
  for (const run of timeline.runs) {
    expect(run).toMatchObject({ threadId: timeline.thread.id, teammateId: teammate.teammateId });
    expect(run.channelId).toBeUndefined();
    expect(run.workflowStepId).toBeUndefined();
    const links = timeline.runLinks.filter((link) => link.runId === run.id);
    expect(links).toHaveLength(1);
    expect(run).toMatchObject({ turnId: links[0]!.turnId });
    expect(timeline.turns.find((turn) => turn.id === links[0]!.turnId)).toMatchObject({
      threadId: timeline.thread.id, workspaceId: directThread.workspaceId, teammateId: teammate.teammateId,
    });
  }
  expect(timeline.conversationItems.some((item) => item.kind === "user_message" &&
    item.domainRefs.some((ref) => ref.type === "message" && ref.id === user.id))).toBe(true);
}

async function attachPrivateBrowserEvidence(page: Page, testInfo: TestInfo, fixture: ReturnType<typeof privateNarrationFixture>, extra: unknown = {}): Promise<void> {
  const feed = page.getByLabel("Private message feed", { exact: true });
  const dom = await feed.evaluate((element) => ({
    text: element.textContent,
    buttons: Array.from(element.querySelectorAll("button")).map((button) => ({ text: button.textContent, label: button.getAttribute("aria-label") })),
    facts: Array.from(element.querySelectorAll("[data-conversation-source-refs]")).map((row) => ({
      kind: row.getAttribute("data-conversation-timeline-kind"), runId: row.getAttribute("data-conversation-run-id"),
      turnId: row.getAttribute("data-conversation-turn-id"), actionId: row.getAttribute("data-conversation-action-id"),
      sourceRefs: row.getAttribute("data-conversation-source-refs"),
    })),
  }));
  await testInfo.attach("mock-private-owner-and-dom.json", { contentType: "application/json", body: JSON.stringify({
    environment: "real Chromium + AppShell + React hook; network responses are mock daemon fixtures, not live daemon",
    teammateId: fixture.teammate.teammateId, directThreadId: fixture.directThread.id,
    canonicalThread: fixture.timeline.thread, runs: fixture.timeline.runs, turnRunLinks: fixture.timeline.runLinks,
    turns: fixture.timeline.turns, canonicalItems: fixture.timeline.conversationItems, dom, extra,
  }, null, 2) });
  const screenshot = testInfo.outputPath("private-owner-browser.png");
  await page.screenshot({ path: screenshot, fullPage: true });
  await testInfo.attach("private-owner-browser", { path: screenshot, contentType: "image/png" });
}

async function expectPrivateNarration(page: Page): Promise<void> {
  const feed = page.getByLabel("Private message feed", { exact: true });
  await expect(feed.locator('[data-conversation-timeline-kind="agentMessage"]')).toHaveCount(3);
  const rows = feed.locator('[data-conversation-timeline-kind][data-conversation-timeline-depth="0"]');
  await expect.poll(() => rows.evaluateAll((elements) => elements.map((element) => element.getAttribute("data-conversation-timeline-kind") === "agentMessage"
    ? element.textContent?.includes("Before first read.") ? "before-first" : element.textContent?.includes("Before more reads.") ? "before-more" : "verified"
    : element.getAttribute("data-conversation-timeline-kind")))).toEqual([
    "userMessage", "before-first", "exploration", "before-more", "exploration", "exploration", "commandExecution", "verified",
  ]);
  await expect(feed.locator('[data-conversation-timeline-kind="explorationBatch"]')).toHaveCount(0);
  await expect(feed.locator('[data-conversation-timeline-kind="diagnostic"]')).toHaveCount(0);
  const first = feed.locator('[data-conversation-timeline-kind="agentMessage"]').first();
  await expect(first.locator(".message-body-paragraph")).toHaveCount(2);
  await expect(first.locator(".message-body-paragraph code")).toHaveText("file-0.mjs");
}

test("private segmented narration has one message resource and action owner", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async (text: string) => {
        (window as unknown as { privateCopiedText: string }).privateCopiedText = text;
      },
    } });
  });
  const fixture = privateNarrationFixture();
  const assistant = { ...fixture.fullAssistant, fileRefs: [{ path: "src/private-result.mjs", label: "private-result.mjs" }] };
  fixture.state.teammateDirectMessages = [fixture.user, assistant];
  await mockDaemon(page, fixture.state);
  await page.route(new RegExp(`/teammates/${fixture.teammate.teammateId}/direct-messages(?:\\?.*)?$`), async (route) => {
    await route.fulfill({ json: {
      cwd, teammateId: fixture.teammate.teammateId, thread: fixture.directThread, timeline: fixture.timeline,
      messages: [fixture.user, assistant], generatedMedia: [],
    } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: fixture.teammate.displayName, exact: true }).click();
  await expectPrivateNarration(page);
  const feed = page.getByLabel("Private message feed", { exact: true });
  const segments = feed.locator('[data-conversation-timeline-kind="agentMessage"]');
  await expect(segments.getByRole("button", { name: "private-result.mjs src/private-result.mjs", exact: true })).toHaveCount(1);
  await expect(segments.getByRole("button", { name: "Copy message", exact: true })).toHaveCount(1);
  await expect(segments.getByRole("button", { name: "Like response", exact: true })).toHaveCount(1);
  await expect(segments.getByRole("button", { name: "Create task", exact: true })).toHaveCount(1);
  for (const index of [0, 1]) {
    await expect(segments.nth(index).locator(".conversation-reference-strip, .teammate-message-actions")).toHaveCount(0);
  }
  await expect(segments.last().getByRole("button", { name: "private-result.mjs src/private-result.mjs", exact: true })).toBeVisible();
  const copy = segments.last().getByRole("button", { name: "Copy message", exact: true });
  await segments.last().hover();
  await copy.click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { privateCopiedText: string }).privateCopiedText)).toBe(assistant.body);
});

for (const emptyDelta of [false, true]) {
  test(`private AppShell ${emptyDelta ? "empty message-end" : "text"} SSE delta preserves narration before GET refresh`, async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
    const fixture = privateNarrationFixture();
    let streamSent = false;
    let completedRefreshes = 0;
    let releaseRefresh = (): void => {};
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    await mockDaemon(page, fixture.state);
    await page.route(new RegExp(`/teammates/${fixture.teammate.teammateId}/direct-messages(?:\\?.*)?$`), async (route) => {
      if (streamSent) await refreshGate;
      await route.fulfill({ json: {
        cwd, teammateId: fixture.teammate.teammateId, thread: fixture.directThread, timeline: fixture.timeline,
        messages: [fixture.user, streamSent ? fixture.fullAssistant : fixture.initialAssistant], generatedMedia: [],
      } });
      if (streamSent) completedRefreshes += 1;
    });
    await page.route(new RegExp(`/teammates/${fixture.teammate.teammateId}/direct-messages/stream(?:\\?.*)?$`), async (route) => {
      streamSent = true;
      const events = [
        { event: "ready", data: { message: fixture.user, aiReply: { ...fixture.initialAssistant, body: "", status: "pending" } } },
        ...(emptyDelta ? [{ event: "delta", data: { messageId: fixture.fullAssistant.id, delta: fixture.fullAssistant.body, body: fixture.fullAssistant.body } }] : []),
        { event: "delta", data: { messageId: fixture.fullAssistant.id, delta: emptyDelta ? "" : fixture.fullAssistant.body, body: fixture.fullAssistant.body, narrationSegments: fixture.fullAssistant.narrationSegments } },
      ];
      // Deliberately omit done: it must not repair the delta controller via
      // an upsert of the final assistant DTO.
      await route.fulfill({ contentType: "text/event-stream", body: events.map((event) => `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`).join("") });
    });
    try {
      await page.goto("/");
      await page.getByRole("button", { name: fixture.teammate.displayName, exact: true }).click();
      await expect(page.locator('[data-conversation-action-id="private-narration-action-91"]')).toBeVisible();
      const composer = page.locator(".teammate-private-composer-owner");
      await composer.getByRole("textbox").fill("Continue the private narration test.");
      await composer.getByRole("textbox").press("Enter");
      await expect.poll(() => streamSent).toBe(true);
      await expectPrivateNarration(page);
      expect(completedRefreshes).toBe(0);
      releaseRefresh();
      await expect.poll(() => completedRefreshes).toBeGreaterThan(0);
      await expectPrivateNarration(page);
    } finally {
      releaseRefresh();
    }
  });
}

test("private owner switch rejects a late GET without resurrecting the previous owner polling", async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  const ownerA = privateNarrationFixture("-owner-a");
  const ownerB = privateNarrationFixture("-owner-b");
  ownerA.initialAssistant = { ...ownerA.initialAssistant, status: "pending", body: "Owner A is still working." };
  ownerB.initialAssistant = { ...ownerB.initialAssistant, body: "Owner B owns this private conversation." };
  expectOwnedPrivateFixture(ownerA);
  expectOwnedPrivateFixture(ownerB);
  const state = ownerA.state;
  state.aiTeammates.push(...ownerB.state.aiTeammates);
  state.runs.push(...ownerB.state.runs.filter((run) => run.teammateId === ownerB.teammate.teammateId));
  state.threads.push(...ownerB.state.threads);
  state.turns.push(...ownerB.state.turns);
  state.turnRunLinks.push(...ownerB.state.turnRunLinks);
  state.executionActions.push(...ownerB.state.executionActions);
  state.teammateDirectThreads = { ...state.teammateDirectThreads, ...ownerB.state.teammateDirectThreads };
  state.teammateDirectMessages = [ownerA.user, ownerA.initialAssistant, ownerB.user, ownerB.initialAssistant];
  let holdA = false;
  let heldRequests = 0;
  let completedLateRequests = 0;
  let aRequests = 0;
  let releaseA = (): void => {};
  const gate = new Promise<void>((resolve) => { releaseA = resolve; });
  await mockDaemon(page, state);
  for (const fixture of [ownerA, ownerB]) {
    await page.route(new RegExp(`/teammates/${fixture.teammate.teammateId}/direct-messages(?:\\?.*)?$`), async (route) => {
      const late = fixture === ownerA && holdA;
      if (fixture === ownerA) aRequests += 1;
      if (late) { heldRequests += 1; await gate; }
      await route.fulfill({ json: {
        cwd, teammateId: fixture.teammate.teammateId, thread: fixture.directThread, timeline: fixture.timeline,
        messages: [fixture.user, late ? { ...fixture.initialAssistant, body: "LATE_OWNER_A_SECRET" } : fixture.initialAssistant], generatedMedia: [],
      } });
      if (late) completedLateRequests += 1;
    });
  }
  try {
    await page.goto("/");
    await page.getByRole("button", { name: ownerA.teammate.displayName, exact: true }).click();
    const feed = page.getByLabel("Private message feed", { exact: true });
    await expect(feed.locator('[data-conversation-action-id="private-owner-a-narration-action-91"]')).toBeVisible();
    holdA = true;
    await expect.poll(() => heldRequests).toBeGreaterThan(0);
    await page.getByRole("button", { name: ownerB.teammate.displayName, exact: true }).click();
    const bCommand = feed.locator('[data-conversation-action-id="private-owner-b-narration-action-91"]');
    await expect(bCommand).toBeVisible();
    await expect(feed).toContainText(ownerB.initialAssistant.body);
    await page.evaluate(() => {
      const audit = { leaks: [] as string[] };
      (window as unknown as { privateOwnerAudit: typeof audit }).privateOwnerAudit = audit;
      const inspect = (): void => {
        const html = document.querySelector('[aria-label="Private message feed"]')?.innerHTML ?? "";
        if (/LATE_OWNER_A_SECRET|private-owner-a|work_cell-owner-a/u.test(html)) audit.leaks.push(html);
      };
      new MutationObserver(inspect).observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
      inspect();
    });
    const requestsBeforeRelease = aRequests;
    releaseA();
    await expect.poll(() => completedLateRequests).toBe(heldRequests);
    const releasedAt = Date.now();
    // Exceed the hook's 750 ms polling period to catch a late finally/schedule resurrection.
    await expect.poll(() => Date.now() - releasedAt).toBeGreaterThan(1_050);
    expect(aRequests).toBe(requestsBeforeRelease);
    await expect(bCommand).toBeVisible();
    await expect(feed).toContainText(ownerB.initialAssistant.body);
    await expect(feed).not.toContainText("LATE_OWNER_A_SECRET");
    const leaks = await page.evaluate(() => (window as unknown as { privateOwnerAudit: { leaks: string[] } }).privateOwnerAudit.leaks);
    expect(leaks).toEqual([]);
    await attachPrivateBrowserEvidence(page, testInfo, ownerB, { aRequests, heldRequests, completedLateRequests, leaks });
  } finally {
    releaseA();
  }
});

test("private same-owner other Turn and foreign source refs stay out of DOM while ordinary tools remain usable", async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  const fixture = privateNarrationFixture();
  expectOwnedPrivateFixture(fixture);
  const original = fixture.timeline.executionActions[0]!;
  const hiddenRunId = "run_private_hidden_other_turn";
  const hiddenTurnId = "turn_private_hidden_other_turn";
  const hiddenItemId = "canonical_private_hidden_other_turn_user";
  const hiddenRun = { ...fixture.timeline.runs[0]!, id: hiddenRunId, turnId: hiddenTurnId };
  fixture.timeline.runs.push(hiddenRun);
  fixture.timeline.turns.push({ ...fixture.timeline.turns[0]!, id: hiddenTurnId, sourceItemId: hiddenItemId, lastRunId: hiddenRunId });
  fixture.timeline.runLinks.push({ ...fixture.timeline.runLinks[0]!, runId: hiddenRunId, turnId: hiddenTurnId });
  fixture.timeline.conversationItems.push({
    ...fixture.timeline.conversationItems[0]!, id: hiddenItemId, turnId: hiddenTurnId, sequence: 2,
    domainRefs: [{ type: "message", id: "dm_private_hidden_other_turn_user" }, { type: "turn", id: hiddenTurnId }],
  });
  fixture.timeline.executionActions.push(
    { ...original, id: "private-own-mcp", toolCallId: "private-own-mcp-call", actionType: "mcp_tool_call", title: "MCP data", summary: "MCP fallback summary", targetRefs: [], commandEvidence: undefined,
      toolEvidence: { toolName: "catalog.read", inputSummary: "Read private catalog", outputText: "OWN_MCP_RESULT", outputTruncated: false, latestEventSeq: 92 } },
    { ...original, id: "foreign-participant-action", toolCallId: "foreign-participant-call", participantId: "Foreign Agent", summary: "FOREIGN_PARTICIPANT_SECRET" },
    { ...original, id: "foreign-reference-action", toolCallId: "foreign-reference-call", summary: "FOREIGN_SOURCE_SECRET",
      sourceRefs: [...original.sourceRefs, { kind: "participant", id: "Foreign Agent" }, { kind: "thread", id: "foreign-thread" }] },
    // The anchor deliberately names the visible Turn; the explicit different Run must win.
    { ...original, id: "same-owner-other-turn-action", toolCallId: "other-turn-call", runId: hiddenRunId, summary: "HIDDEN_OTHER_TURN_SECRET" },
    { ...original, id: "same-owner-hidden-anchor-action", toolCallId: "hidden-anchor-call", runId: hiddenRunId, summary: "HIDDEN_OTHER_TURN_SECRET",
      sourceRefs: [{ kind: "conversation_item", id: hiddenItemId }, { kind: "run", id: hiddenRunId }] },
    // Deliberately hostile wire data, outside the allowed ExecutionAction contract.
    { ...original, id: "private-delegation-action", toolCallId: "private-delegation-call", actionType: "spawn_agent", title: "Foreign Agent", summary: "FOREIGN_DELEGATION_SECRET",
      targetRefs: [{ type: "teammate", id: "Foreign Agent", label: "Foreign Agent" }] } as unknown as ConversationDetailResponse["executionActions"][number],
  );
  expectOwnedPrivateFixture(fixture);
  const systemHistory = { ...fixture.user, id: "private-system-history", authorType: "system", authorId: "system", body: "SYSTEM_CONTINUATION_METADATA" };
  fixture.state.teammateDirectMessages = [fixture.user, fixture.fullAssistant, systemHistory];
  await mockDaemon(page, fixture.state);
  await page.route(new RegExp(`/teammates/${fixture.teammate.teammateId}/direct-messages(?:\\?.*)?$`), async (route) => {
    await route.fulfill({ json: {
      cwd, teammateId: fixture.teammate.teammateId, thread: fixture.directThread, timeline: fixture.timeline,
      messages: [fixture.user, fixture.fullAssistant, systemHistory], generatedMedia: [],
    } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: fixture.teammate.displayName, exact: true }).click();
  const feed = page.getByLabel("Private message feed", { exact: true });
  await expect(feed.getByText("Verification complete.", { exact: true })).toBeVisible();
  for (const [id, kind] of [["private-narration-action-41", "exploration"], ["private-narration-action-91", "commandExecution"], ["private-own-mcp", "mcpToolCall"]]) {
    const row = feed.locator(`[data-conversation-action-id="${id}"][data-conversation-timeline-kind="${kind}"]`);
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute("data-conversation-run-id", fixture.initialAssistant.linkedRunId!);
    await expect(row).toHaveAttribute("data-conversation-turn-id", fixture.timeline.turns[0]!.id);
    const trigger = row.locator(".conversation-timeline-activity-main");
    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    if (kind === "mcpToolCall") {
      await expect(row.getByText("Read private catalog", { exact: true })).toBeVisible();
      await expect(row.locator(".conversation-timeline-output")).toHaveText("OWN_MCP_RESULT");
    } else await expect(row.locator(".conversation-timeline-output")).toBeVisible();
  }
  const diagnostic = feed.locator('[data-conversation-diagnostic-code="scope_mismatch"]');
  await expect(diagnostic).toHaveCount(1);
  await expect(diagnostic).toHaveAttribute("data-conversation-timeline-status", "blocked");
  await expect(diagnostic).toHaveAttribute("data-conversation-source-refs", "");
  await expect(diagnostic.getByRole("button")).toHaveCount(0);
  const html = await feed.innerHTML();
  expect(html).not.toMatch(/FOREIGN_|Foreign Agent|foreign-thread|foreign-reference|foreign-participant|HIDDEN_OTHER_TURN|same-owner-other-turn-action|same-owner-hidden-anchor-action|run_private_hidden_other_turn|SYSTEM_CONTINUATION_METADATA/u);
  await expect(feed.locator('[data-conversation-timeline-kind="collabAgentToolCall"], [data-conversation-timeline-kind="subAgentActivity"]')).toHaveCount(0);
  await attachPrivateBrowserEvidence(page, testInfo, fixture);
});

test("private foreign message owners fail closed without removing valid text or its copy action", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => {
      (window as unknown as { privateCopiedText: string }).privateCopiedText = text;
    } } });
  });
  const fixture = privateNarrationFixture();
  expectOwnedPrivateFixture(fixture);
  const foreignMessages = [
    { ...fixture.initialAssistant, id: "foreign-author-message", authorId: "Foreign Agent", body: "FOREIGN_AUTHOR_BODY" },
    { ...fixture.initialAssistant, id: "foreign-thread-message", threadId: "foreign-direct-thread", body: "FOREIGN_THREAD_BODY" },
    { ...fixture.initialAssistant, id: "system-history-message", authorType: "system", authorId: "system", body: "SYSTEM_CONTINUATION_METADATA" },
  ];
  await mockDaemon(page, fixture.state);
  await page.route(new RegExp(`/teammates/${fixture.teammate.teammateId}/direct-messages(?:\\?.*)?$`), async (route) => {
    await route.fulfill({ json: {
      cwd, teammateId: fixture.teammate.teammateId, thread: fixture.directThread, timeline: fixture.timeline,
      messages: [fixture.user, fixture.initialAssistant, ...foreignMessages], generatedMedia: [],
    } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: fixture.teammate.displayName, exact: true }).click();
  const feed = page.getByLabel("Private message feed", { exact: true });
  const ownMessage = feed.locator('[data-conversation-timeline-kind="agentMessage"]');
  await expect(ownMessage).toHaveCount(1);
  await expect(ownMessage).toContainText(fixture.initialAssistant.body);
  await expect(feed).toContainText(fixture.user.body);
  await ownMessage.hover();
  await ownMessage.getByRole("button", { name: "Copy message", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { privateCopiedText: string }).privateCopiedText)).toBe(fixture.initialAssistant.body);
  await expect(ownMessage.getByRole("button", { name: "Create task", exact: true })).toHaveCount(1);
  expect(await feed.innerHTML()).not.toMatch(/FOREIGN_|Foreign Agent|foreign-direct-thread|SYSTEM_CONTINUATION_METADATA/u);
  await expect(feed.locator("[data-conversation-action-id], [data-conversation-run-id]")).toHaveCount(0);
  await attachPrivateBrowserEvidence(page, testInfo, fixture, { injectedMessageIds: foreignMessages.map((message) => message.id) });
});

test("private mixed legacy history keeps missing-anchor diagnostics beside their own source messages", async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  const fixture = privateNarrationFixture();
  const historicalMessages: TeammateDirectMessage[] = [];
  for (const [phase, count, day] of [["p01", 1, "20"], ["p02", 4, "21"]] as const) {
    const runId = `private-history-${phase}-run`;
    const turnId = `private-history-${phase}-turn`;
    const userId = `private-history-${phase}-user`;
    const createdAt = `2026-07-${day}T00:00:00.000Z`;
    const run = { ...fixture.timeline.runs[0]!, id: runId, turnId };
    fixture.timeline.runs.push(run);
    fixture.timeline.turns.push({ ...fixture.timeline.turns[0]!, id: turnId, sourceItemId: userId, lastRunId: runId });
    fixture.timeline.runLinks.push({ ...fixture.timeline.runLinks[0]!, turnId, runId });
    historicalMessages.push(
      { ...fixture.user, id: userId, body: `Historical ${phase} request.`, createdAt, updatedAt: createdAt },
      { ...fixture.initialAssistant, id: `private-history-${phase}-reply`, linkedRunId: runId, body: `Historical ${phase} reply.`, createdAt, updatedAt: createdAt,
        narrationSegments: [{ content: `Historical ${phase} reply.`, firstEventId: `${phase}-event-5`, lastEventId: `${phase}-event-10`, startEventSequence: 5, endEventSequence: 10, completed: true }] },
    );
    for (let index = 0; index < count; index += 1) {
      const id = `private-history-${phase}-action-${index}`;
      fixture.timeline.executionActions.push({ ...fixture.timeline.executionActions[0]!, id, runId, toolCallId: `${id}-call`, attemptId: `${phase}-attempt`,
        sourceRefs: [{ kind: "run", id: runId }, { kind: "execution_action", id }, { kind: "participant", id: fixture.teammate.teammateId }] });
    }
  }
  expectOwnedPrivateFixture(fixture);
  const messages = [...historicalMessages, fixture.user, fixture.fullAssistant];
  fixture.state.teammateDirectMessages = messages;
  await mockDaemon(page, fixture.state);
  await page.route(new RegExp(`/teammates/${fixture.teammate.teammateId}/direct-messages(?:\\?.*)?$`), async (route) => {
    await route.fulfill({ json: { cwd, teammateId: fixture.teammate.teammateId, thread: fixture.directThread, timeline: fixture.timeline, messages, generatedMedia: [] } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: fixture.teammate.displayName, exact: true }).click();
  const feed = page.getByLabel("Private message feed", { exact: true });
  await expect(feed.locator('[data-conversation-timeline-kind="diagnostic"]')).toHaveCount(5);
  await expect(feed.locator('[data-conversation-action-id="private-narration-action-91"]')).toBeVisible();
  const positions = await feed.locator('[data-conversation-timeline-kind][data-conversation-timeline-depth="0"]').evaluateAll((rows) => rows.map((row) => ({
    kind: row.getAttribute("data-conversation-timeline-kind"), runId: row.getAttribute("data-conversation-run-id"), text: row.textContent,
    sequence: row.getAttribute("data-conversation-timeline-thread-sequence"), refs: row.getAttribute("data-conversation-source-refs"),
  })));
  for (const [phase, next, count] of [["p01", "Historical p02 request.", 1], ["p02", fixture.user.body, 4]] as const) {
    const start = positions.findIndex((row) => row.kind === "userMessage" && row.text?.includes(`Historical ${phase} request.`));
    const end = positions.findIndex((row) => row.kind === "userMessage" && row.text?.includes(next));
    const diagnostics = positions.filter((row) => row.kind === "diagnostic" && row.runId === `private-history-${phase}-run`);
    expect(diagnostics).toHaveLength(count);
    for (const row of diagnostics) {
      expect(positions.indexOf(row)).toBeGreaterThan(start);
      expect(positions.indexOf(row)).toBeLessThan(end);
      expect(row.sequence).toBe("1");
      expect(row.refs).not.toContain("conversation_item:");
    }
  }
  await expect(feed.locator('[data-conversation-timeline-kind="diagnostic"][data-conversation-timeline-status="blocked"]')).toHaveCount(5);
  await attachPrivateBrowserEvidence(page, testInfo, fixture, { viewPositions: positions });
  await feed.getByText("Historical p01 request.", { exact: true }).scrollIntoViewIfNeeded();
  const historyScreenshot = testInfo.outputPath("private-history-source-position.png");
  await page.screenshot({ path: historyScreenshot, fullPage: true });
  await testInfo.attach("private-history-source-position", { path: historyScreenshot, contentType: "image/png" });
});
