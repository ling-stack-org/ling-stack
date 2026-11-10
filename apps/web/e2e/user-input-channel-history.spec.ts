import { expect, test } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createMockTeammate, cwd } from "./support/mock-state";

// Synthetic public Host responses; not a real SQLite receipt, runner ACK, or packaged app.
for (const surface of ["channel_root", "branch"] as const) for (const theme of ["light", "dark"] as const) {
  test(`${surface} Q/A order, copy and reload · ${theme} · synthetic Host`, async ({ page, context }, testInfo) => {
    await page.addInitScript(selected => {
      localStorage.setItem("ling-stack.locale", "en-US");
      const selection = JSON.stringify({ themeId: "ling-" + selected, mode: "fixed" });
      localStorage.setItem("ling-stack.themeSelection", selection);
      localStorage.setItem("ling-stack.themeBootstrapSelection", selection);
    }, theme);
    const state = createBaseState({ approvalStatus: "expired" });
    const workspaceId = "workspace_default", channelId = "channel_engineering", now = "2026-09-08T05:00:00.000Z";
    const threadId = surface === "branch" ? "thread_input_branch" : "thread_channel_channel_engineering";
    state.aiTeammates = [createMockTeammate({ id: "engineer", displayName: "Engineer" })];
    state.channelMessages = [];
    state.channelWorkflows = [];
    state.channelWorkflowSteps = [];
    state.runs = [];
    if (surface === "branch") state.channelBranches = [{ id: "input_branch", workspaceId, channelId,
      rootThreadId: threadId, name: "Question history branch", status: "active", createdAt: now, updatedAt: now }];
    const source = { workspaceId, threadId, turnId: "input-turn", runId: "input-run", attemptId: "input-attempt",
      participantId: "engineer", workUnitId: "input-unit", sourceItemId: "before" };
    const runEventPosition = { runId: source.runId, attemptId: source.attemptId, afterEventSequence: 0 };
    const request = { kind: "user_input_request", availability: "available", itemId: "question", requestId: "input-request", requestVersion: 1,
      source, runEventPosition, status: "answered", statusRevision: 2, waitMode: "required", createdAt: now, updatedAt: now,
      questions: [{ questionId: "q", prompt: "Synthetic question: preserve formatting?\n\n```ts\nconst retained = true;\n```",
        required: true, allowFreeText: true, options: [{ optionId: "keep", label: "Keep formatting" }] }] };
    const answerText = "Keep the formatting.\n\nPreserve this second paragraph.";
    const answer = { kind: "user_input_answer", availability: "available", itemId: "answer", requestId: request.requestId, requestVersion: 1,
      source, runEventPosition, answerId: "accepted", acceptedAt: now,
      answers: [{ questionId: "q", prompt: "Synthetic question", kind: "text", text: answerText }],
      delivery: { status: "pending", revision: 1, updatedAt: now } };
    const base = { schemaVersion: 1, workspaceId, channelId, threadId, turnId: source.turnId, status: "committed",
      actorType: "teammate", actorId: "engineer", visibility: "channel", revision: 1, domainRefs: [], createdAt: now, updatedAt: now, committedAt: now };
    const thread = { id: threadId, workspaceId, channelId, kind: "channel_discussion", title: "Question history", status: "open", surfaceKind: surface,
      relationKind: surface === "branch" ? "branch" : "root", nextItemSequence: 5, createdAt: now, updatedAt: now,
      ...(surface === "branch" ? { parentThreadId: "thread_channel_channel_engineering" } : {}) };
    // The items route and thread-list route must describe the same Host owner.
    // Register it up front; bypassing the mock items route skips its lazy creator.
    const rootThread = { ...thread, id: "thread_channel_channel_engineering", kind: "channel_discussion" as const,
      title: "Engineering conversation", objective: "Validate question history", status: "open" as const,
      surfaceKind: "channel_root" as const, relationKind: "root" as const, parentThreadId: undefined,
      conversationMode: { mode: "default" as const } };
    state.threads = [...state.threads.filter(item => item.kind !== "channel_discussion" || item.channelId !== channelId), rootThread];
    if (surface === "branch") state.threads.push({ ...rootThread, ...thread, kind: "channel_discussion", status: "open", relationKind: "branch" });
    const items = [{ ...base, id: "before", sequence: 1, kind: "assistant_message", payload: { body: "Before the question.", format: "markdown", deliveryStatus: "ready" } },
      ...[request, answer].map((record, index) => ({ ...base, id: record.itemId, sequence: 2 + index, kind: record.kind,
        actorType: index ? "local_user" : "teammate", actorId: index ? "local-user" : "engineer",
        payload: { requestId: request.requestId, requestVersion: 1, ...(index ? { answerId: answer.answerId } : {}), runEventPosition } })),
      { ...base, id: "after", sequence: 4, kind: "assistant_message", payload: { body: "Answer saved; delivery is still pending.", format: "markdown", deliveryStatus: "ready" } }];
    let questionsOnly = false;
    await mockDaemon(page, state);
    await page.route("**/channels/channel_engineering/items**", async route => {
      const selected = new URL(route.request().url()).searchParams.get("threadId") ?? "thread_channel_channel_engineering";
      if (selected !== threadId) return route.fallback();
      const waitingRequest = { ...request, itemId: "waiting-question", requestId: "waiting-request", status: "pending", statusRevision: 1 };
      const visibleItems = questionsOnly ? [{ ...items[1], id: waitingRequest.itemId, sequence: 5,
        payload: { requestId: waitingRequest.requestId, requestVersion: 1, runEventPosition } }] : items;
      await route.fulfill({ json: { cwd, channelId, thread, turns: [], items: visibleItems,
        turnContextAssignments: [],
        userInputs: questionsOnly ? [waitingRequest] : [request, answer],
        decorations: [], generatedMedia: [], hasMore: false } });
    });
    const selectLane = async (name: string) => {
      const navigation = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u });
      const showNavigation = page.getByRole("button", { name: "Show navigation", exact: true });
      const target = navigation.getByRole("button", { name, exact: true });
      await expect.poll(async () => await target.isVisible() || await showNavigation.isVisible()).toBe(true);
      if (!(await target.isVisible())) await showNavigation.click();
      await target.click();
    };
    const openLane = () => selectLane(surface === "branch" ? "Question history branch" : "Engineering");
    await page.goto("/");
    await openLane();
    const feed = page.getByLabel("Channel message feed");
    const questionRow = feed.locator('[data-conversation-timeline-kind="userInputRequest"]');
    const answerRow = feed.locator('[data-conversation-timeline-kind="userInputAnswer"]');
    await expect(questionRow).toHaveCount(1);
    await expect(answerRow).toHaveCount(1);
    await expect(questionRow.locator("pre")).toContainText("const retained = true;");
    await expect(questionRow.locator("img.teammate-avatar-image")).toHaveCount(1);
    await expect(answerRow.locator(".conversation-user-input-content p")).toHaveCount(2);
    const text = await feed.innerText();
    for (const [before, after] of [["Before the question.", "Synthetic question:"], ["Synthetic question:", "Keep the formatting."],
      ["Keep the formatting.", "Answer saved;"]]) expect(text.indexOf(before)).toBeLessThan(text.indexOf(after));
    const avatarPosition = await answerRow.evaluate(row => ({ contentRight: row.querySelector(".message-content")!.getBoundingClientRect().right,
      avatarLeft: row.querySelector(".message-content")!.nextElementSibling!.getBoundingClientRect().left }));
    expect(avatarPosition.avatarLeft).toBeGreaterThanOrEqual(avatarPosition.contentRight);
    await page.mouse.move(0, 0);
    await expect(answerRow.locator(".message-action-bar")).toHaveCSS("opacity", "0");
    await answerRow.getByRole("button", { name: "Copy message", exact: true }).focus();
    await expect(answerRow.locator(".message-action-bar")).toHaveCSS("opacity", "1");
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await answerRow.getByRole("button", { name: "Copy message", exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(answerText);
    answer.delivery = { status: "failed", revision: 2, updatedAt: "2026-09-08T05:01:00.000Z" };
    await page.reload();
    await openLane();
    await expect(answerRow).toHaveAttribute("data-user-input-status", "failed");
    for (const width of [1440, 900]) {
      await page.setViewportSize({ width, height: 960 });
      await answerRow.scrollIntoViewIfNeeded();
      const bounds = await answerRow.boundingBox();
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
      await page.screenshot({ path: testInfo.outputPath(`${surface}-${theme}-${width}-synthetic.png`), fullPage: true });
    }
    // The 900 px navigation is an icon rail; perform named lane navigation
    // at desktop width. Both transcript widths were verified above.
    await page.setViewportSize({ width: 1440, height: 960 });
    if (surface === "branch") {
      await selectLane("Engineering");
      await expect(questionRow).toHaveCount(0);
      await expect(answerRow).toHaveCount(0);
      await openLane();
      await expect(questionRow).toHaveCount(1);
      await expect(answerRow).toHaveCount(1);
    }
    // Empty message list must not suppress the only canonical question.
    questionsOnly = true;
    await page.reload();
    await openLane();
    await expect(questionRow).toHaveAttribute("data-user-input-status", "pending");
    await expect(answerRow).toHaveCount(0);
    await expect(questionRow).toBeVisible();
    await expect(feed.locator('[data-conversation-timeline-kind="commandExecution"]')).toHaveCount(0);
  });
}
