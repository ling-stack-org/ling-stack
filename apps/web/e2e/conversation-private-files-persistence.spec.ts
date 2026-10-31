import { expect, test, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { buildMockConversationDetail, mockDaemon } from "./support/mock-daemon";
import { createBaseState, createChatProvider, createMockTeammate, cwd } from "./support/mock-state";
import { triggerFocusRevalidation } from "./support/focus-revalidation";

const teammateId = "teammate_files_reader";
const directThreadId = "dm_files_reader";
const canonicalThreadId = "thread_files_reader";
const turnId = "turn_files_reader";
const runId = "run_files_reader";
const now = "2026-10-29T00:00:00.000Z";
const paths = ["a.txt", "b.txt", "c.txt", "d.txt"];

/** Real AppShell/private feed, projector, view store, retention and review dock. */
async function installPrivateFilesFixture(page: Page, initiallyEmpty = false) {
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({ id: "provider_files", model: "fixture-model",
    lastCheck: { ok: true, code: "ready", message: "Fixture provider ready", checkedAt: now } })];
  state.aiTeammates = [createMockTeammate({ id: teammateId, displayName: "Files Reader", providerPresetId: "provider_files" })];
  const directThread = { id: directThreadId, workspaceId: "workspace_default", teammateId,
    title: "Files Reader", createdAt: now, updatedAt: now };
  state.teammateDirectThreads[teammateId] = directThread;
  const thread = { id: canonicalThreadId, workspaceId: "workspace_default", teammateId,
    kind: "teammate_direct", title: "Files Reader canonical", objective: "Write four files", status: "open",
    createdAt: now, updatedAt: now };
  state.threads.push(thread);
  state.threads.push({ id: "thread_files_other", workspaceId: "workspace_default", kind: "conversation",
    title: "Ordinary reading", objective: "Read an ordinary conversation", status: "succeeded",
    lastRunId: "run_files_other", createdAt: now, updatedAt: now });
  state.turns.push({ id: "turn_files_other", workspaceId: "workspace_default", threadId: "thread_files_other",
    kind: "initial_request", status: "succeeded", title: "Ordinary reading", userInstruction: "Ordinary request",
    lastRunId: "run_files_other", createdByActor: "local-user", createdAt: now, updatedAt: now });
  state.turnRunLinks.push({ turnId: "turn_files_other", runId: "run_files_other", attemptNumber: 1, role: "primary", createdAt: now });
  state.runs.push({ id: "run_files_other", status: "succeeded", cwd, threadId: "thread_files_other", turnId: "turn_files_other",
    taskId: "task_files_other", providerPresetId: "provider_files", providerName: "fixture", providerModel: "fixture-model",
    taskSnapshot: { title: "Ordinary reading" }, providerSnapshot: {}, requestSnapshot: {}, eventLogPath: "fixture/other.jsonl",
    createdAt: now, startedAt: now, updatedAt: now, endedAt: now });
  state.eventsByRun.run_files_other = [{ id: "event_files_other", runId: "run_files_other", seq: 1, ts: now,
    type: "assistant_text_delta", data: { text: "Ordinary response." } }];
  state.turns.push({ id: turnId, workspaceId: "workspace_default", threadId: canonicalThreadId,
    teammateId, kind: "teammate_direct_reply", status: "running", title: "Write four files",
    userInstruction: "Write four files", sourceMessageId: "files-user", sourceItemId: "files-user-item",
    createdByActor: "local-user", createdAt: now, updatedAt: now });
  state.turnRunLinks.push({ runId, turnId, attemptNumber: 1, role: "primary", createdAt: now });
  state.runs.push({ id: runId, threadId: canonicalThreadId, teammateId, status: "running", cwd,
    taskId: "direct:files", taskSnapshot: { title: "Write four files" }, providerSnapshot: {}, requestSnapshot: {},
    providerName: "fixture", providerModel: "fixture-model", workUnitId: "wu_files",
    eventLogPath: "fixture/files.jsonl", createdAt: now, updatedAt: now, startedAt: now });
  const messageBase = { workspaceId: "workspace_default", threadId: directThreadId, teammateId,
    attachmentIds: [], linkPreviewIds: [], fileRefs: [], createdAt: now, updatedAt: now, revision: 1 };
  const user = { ...messageBase, id: "files-user", authorType: "local-user", authorId: "local-user",
    body: "Write four files", status: "ready" };
  let reply = { ...messageBase, id: "files-reply", authorType: "ai-teammate", authorId: teammateId,
    body: "Writing the four files.", status: "pending", linkedRunId: runId,
    narrationSegments: [{ content: "Writing the four files.", firstEventId: "files-evt-1", lastEventId: "files-evt-1",
      startEventSequence: 1, endEventSequence: 1, completed: true }] };
  let published = !initiallyEmpty;
  state.teammateDirectMessages = published ? [user, reply] : [];
  const item = (id: string, sequence: number, kind: string, payload: Record<string, unknown>, domainRefs: unknown[]) => ({
    schemaVersion: 1, id, workspaceId: "workspace_default", threadId: canonicalThreadId, turnId,
    sequence, kind, actorType: kind === "user_message" ? "user" : "host", actorId: "local-user",
    visibility: "thread_participants", status: "committed", revision: 1,
    domainRefs, payload, createdAt: now, updatedAt: now, committedAt: now,
  });
  const userItem = item("files-user-item", 1, "user_message", { body: user.body, format: "markdown" }, [{ type: "message", id: user.id }]);
  let settled = false;
  let holdCanonical = false;
  const canonicalWaiters = new Set<() => void>();
  let canonicalBlocked = false;
  let holdWorkspace = initiallyEmpty;
  let workspaceBlocked = false;
  const workspaceWaiters = new Set<() => void>();
  const initialMessageWaiters = new Set<() => void>();
  let sendCount = 0;
  await mockDaemon(page, state);
  await page.route(`**/teammates/${teammateId}/direct-messages?**`, async route => {
    if (route.request().method() !== "GET") return route.fallback();
    // An initial metadata request can reach the handler after the first send.
    // The independent canonical reader may finish before workspace metadata.
    if (initiallyEmpty && !published) await new Promise<void>(resolve => initialMessageWaiters.add(resolve));
    if (holdCanonical) {
      canonicalBlocked = true;
      await new Promise<void>(resolve => { canonicalWaiters.add(resolve); });
    }
    const detail = buildMockConversationDetail(state, cwd, thread);
    await route.fulfill({ json: { cwd, teammateId, thread: directThread,
      messages: published ? [user, reply] : [], generatedMedia: [], hasMore: false,
      timeline: published ? { ...detail, messages: [], conversationItems: [userItem,
        ...(settled ? paths.map((path, index) => item(`files-tool-${index}`, index + 2, "tool_call",
          { toolCallId: `files-call-${index}`, toolName: "write" }, [{ type: "run", id: runId }])) : [])] } : undefined,
    } });
  });
  await page.route(`**/teammates/${teammateId}/direct-workspace?**`, async route => {
    if (holdWorkspace) {
      workspaceBlocked = true;
      await new Promise<void>(resolve => workspaceWaiters.add(resolve));
    }
    await route.fallback();
  });
  const review = { scope: { kind: "turn", id: turnId }, workspaceId: "workspace_default", threadId: canonicalThreadId,
    runIds: [runId], revision: "files-review-v1", state: "exact", coveredPaths: paths, additions: 4, deletions: 0,
    files: paths.map(path => ({ id: `review:${path}`, path, kind: "added", state: "exact", additions: 1, deletions: 0,
      diff: `diff --git a/${path} b/${path}\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+content for ${path}\n` })) };
  await page.route(`**/turns/${turnId}/workspace-changes?**`, async route => route.fulfill({ json: {
    cwd, turnId, state: "applied", canUndo: false, canReapply: false, updatedAt: now,
    files: paths.map(path => ({ path, operationCount: 1, additions: 1, deletions: 0 })),
    summary: { fileCount: 4, addCount: 4, updateCount: 0, deleteCount: 0, moveCount: 0, addedLines: 4, removedLines: 0 },
    review,
  } }));
  function settle() {
      settled = true;
      reply = { ...reply, status: "ready", body: "Created all four files.", revision: 2,
        narrationSegments: [...reply.narrationSegments, { content: "Created all four files.", firstEventId: "files-evt-10", lastEventId: "files-evt-10",
          startEventSequence: 10, endEventSequence: 10, completed: true }] };
      state.teammateDirectMessages = [user, reply];
      const run = state.runs.find(run => run.id === runId)!;
      run.status = "succeeded";
      state.turns.find(turn => turn.id === turnId)!.status = "succeeded";
      state.executionActions.push(...paths.map((path, index) => ({
        id: `files-action-${index}`, workspaceId: "workspace_default", threadId: canonicalThreadId, runId,
        attemptId: "attempt_files", workUnitId: "wu_files", participantId: teammateId, workflowStepId: undefined,
        toolCallId: `files-call-${index}`, sourceEventSequence: index + 2, revision: 1,
        actionType: "file_write", risk: "low", status: "succeeded", title: `Write ${path}`, summary: `Created ${path}`,
        sourceRefs: [{ kind: "conversation_item", id: `files-tool-${index}` }],
        targetRefs: [{ type: "file", id: path, path }], previewArtifactIds: [], resultArtifactIds: [],
        createdAt: now, updatedAt: now, completedAt: now,
      })));
  }
  await page.route(`**/teammates/${teammateId}/direct-messages/stream?**`, async route => {
    sendCount++;
    published = true;
    const pending = { ...reply, body: "", status: "pending", narrationSegments: [] };
    settle();
    initialMessageWaiters.forEach(release => release());
    initialMessageWaiters.clear();
    const events = [
      { event: "ready", data: { message: user, aiReply: pending } },
      { event: "run_linked", data: { messageId: reply.id, linkedRunId: runId } },
      { event: "delta", data: { messageId: reply.id, body: "Writing the four files.", delta: "Writing the four files.", narrationSegments: reply.narrationSegments.slice(0, 1) } },
      { event: "done", data: { message: user, aiReply: reply } },
    ];
    await route.fulfill({ status: 200, contentType: "text/event-stream",
      body: events.map(event => `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`).join("") });
  });
  return {
    state,
    settle,
    sendCount: () => sendCount,
    workspaceBlocked: () => workspaceBlocked,
    releaseWorkspace() { holdWorkspace = false; workspaceWaiters.forEach(release => release()); workspaceWaiters.clear(); },
    hold() { holdCanonical = true; canonicalBlocked = false; },
    blocked() { return canonicalBlocked; },
    release() { holdCanonical = false; canonicalWaiters.forEach(release => release()); canonicalWaiters.clear(); },
  };
}

async function readFileView(page: Page) {
  return page.locator("[data-conversation-response-files]").evaluate(element => ({
    responseId: element.getAttribute("data-conversation-response-id"),
    fileCount: element.querySelectorAll(".conversation-response-file").length,
    snapshots: JSON.parse(localStorage.getItem("ling-stack.conversation-reading.v1") ?? "null"),
  }));
}

for (const initiallyEmpty of [false, true]) {
test(`first private live file expansion survives Diff and a delayed canonical remount${initiallyEmpty ? " before workspace identity arrives" : ""}`, async ({ page }, testInfo) => {
  test.setTimeout(45_000);
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  const fixture = await installPrivateFilesFixture(page, initiallyEmpty);
  await page.goto("/");
  const sidebar = page.getByRole("complementary", { name: /Sidebar display/ });
  const openPrivate = () => sidebar.getByRole("button", { name: "Files Reader", exact: true }).click();
  await openPrivate();
  const feed = page.getByLabel("Private message feed", { exact: true });
  if (initiallyEmpty) {
    await expect.poll(() => fixture.workspaceBlocked()).toBe(true);
    const composer = page.getByLabel("Private chat composer", { exact: true });
    await composer.getByRole("textbox").fill("Write four files");
    await composer.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => fixture.sendCount()).toBe(1);
  } else {
    await expect(feed).toContainText("Writing the four files.");
    fixture.settle();
    await triggerFocusRevalidation(page);
  }
  const files = feed.locator("[data-conversation-response-files]");
  await expect(files.locator(".conversation-response-file")).toHaveCount(3);
  await files.locator(".conversation-response-files-more").click();
  await expect(files.locator(".conversation-response-file")).toHaveCount(4);
  const before = await readFileView(page);
  await files.getByRole("button", { name: "d.txt", exact: true }).click();
  const dock = page.getByLabel("Private chat workspace dock");
  await expect(dock).toContainText("content for d.txt");
  await dock.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dock).toHaveCount(0);
  fixture.hold();
  await sidebar.getByRole("button", { name: /Open recent conversation \d+/ }).filter({ hasText: "Ordinary reading" }).click();
  await expect(page.getByLabel("Conversation page")).toBeVisible();
  fixture.releaseWorkspace();
  await openPrivate();
  await expect.poll(() => fixture.blocked()).toBe(true);
  fixture.release();
  await expect(files).toBeVisible();
  const after = await readFileView(page);
  const evidence = testInfo.outputPath("first-live-and-canonical-return.json");
  await mkdir(dirname(evidence), { recursive: true });
  await writeFile(evidence, JSON.stringify({ initiallyEmpty, before, after }, null, 2));
  await testInfo.attach("first-live-and-canonical-return.json", { path: evidence, contentType: "application/json" });
  expect(after.responseId).toBe(before.responseId);
  await expect(files.locator(".conversation-response-file")).toHaveCount(4);
  await expect(files.locator(".conversation-response-files-more")).toHaveAttribute("aria-expanded", "true");
  const expectedScope = JSON.stringify(["http://127.0.0.1:17891/", cwd, `teammate:${teammateId}`, directThreadId]);
  for (const view of [before, after]) {
    const entries = view.snapshots?.entries as Array<[string, { disclosures: unknown[] }]> | undefined;
    expect(entries?.find(([scope]) => scope === expectedScope)?.[1].disclosures)
      .toContainEqual(["block", `response-files:${before.responseId}`, true]);
  }
  // The early fallback must not overwrite a later explicit user preference.
  await files.locator(".conversation-response-files-more").click();
  await expect(files.locator(".conversation-response-file")).toHaveCount(3);
  await sidebar.getByRole("button", { name: /Open recent conversation \d+/ }).filter({ hasText: "Ordinary reading" }).click();
  await expect(page.getByLabel("Conversation page")).toBeVisible();
  await openPrivate();
  await expect(files.locator(".conversation-response-file")).toHaveCount(3);
  await expect(files.locator(".conversation-response-files-more")).toHaveAttribute("aria-expanded", "false");
  await files.locator(".conversation-response-files-more").click();
  await page.reload();
  await openPrivate();
  await expect(files.locator(".conversation-response-file")).toHaveCount(4);
  expect((await readFileView(page)).responseId).toBe(before.responseId);
});
}
