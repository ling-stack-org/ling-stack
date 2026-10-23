import { expect, test, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { buildMockConversationDetail, mockDaemon, type MockExecutionAction } from "./support/mock-daemon";
import { createBaseState, cwd } from "./support/mock-state";
import { installChannelWorkCellFixture, installNormalWorkCellFixture, installTeammateWorkCellFixture } from "./support/conversation-work-cell-fixture";
import { openEngineeringChannel } from "./support/test-helpers";

const evidence = fileURLToPath(new URL("../../../output/playwright/", import.meta.url));

function operations(base: MockExecutionAction, category: "search" | "edit" | "tool" | "web"): MockExecutionAction[] {
  const kinds = category === "web" ? ["web_search", "web_search"]
    : [...(category === "tool" ? ["load_tools"] : []), ...(category === "edit" || category === "tool" ? ["edit"] : []), "read", "bash"];
  return kinds.map((kind, index) => {
    const file = { kind: "file", id: "src/example.ts", path: "src/example.ts" };
    return {
      ...base, id: `category-${category}-${index}`, revision: index * 2 + 22, sourceEventSequence: index * 2 + 21,
      toolCallId: `category-call-${index}`, actionType: kind === "load_tools" || kind === "web_search" ? "mcp_tool_call" : kind,
      title: kind, summary: kind, status: "succeeded", risk: "low",
      sourceRefs: [...(base.sourceRefs ?? []), ...(kind === "read" || kind === "edit" ? [file] : [])],
      targetRefs: kind === "read" || kind === "edit" ? [{ type: "file", id: file.id, path: file.path }] : [],
      commandEvidence: kind === "bash" ? { ...base.commandEvidence!, command: "node --test", exitCode: 0 } : undefined,
      toolEvidence: kind !== "bash" ? {
        toolName: kind, inputSummary: kind === "read" || kind === "edit" ? file.path : "example",
        outputText: "Completed", outputTruncated: false, latestEventSeq: index * 2 + 2,
      } : undefined,
    };
  });
}

for (const surface of ["normal", "private", "channel"] as const) {
  test(`${surface} classifies settled operations while live and preserves disclosures after completion`, async ({ page }) => {
    test.slow();
    await mkdir(evidence, { recursive: true });
    await page.addInitScript(() => {
      localStorage.setItem("ling-stack.locale", "zh-CN");
      localStorage.setItem("ling-stack.themePreference", "dark");
    });
    const state = createBaseState({ approvalStatus: "expired" });
    const title = surface === "normal" ? installNormalWorkCellFixture(state) : undefined;
    const teammate = surface === "private" ? installTeammateWorkCellFixture(state) : undefined;
    if (surface === "channel") installChannelWorkCellFixture(state, "activity-categories");
    const base = state.executionActions[0]!;
    if (surface === "normal") {
      const turn = state.turns.find(turn => turn.threadId === base.threadId)!;
      base.sourceRefs = [{ kind: "conversation_item", id: `conversation-user:${turn.id}` }];
      state.runs = state.runs.map(run => run.id === base.runId ? { ...run, createdAt: "2026-07-24T02:00:01.000Z" } : run);
    }
    const runId = base.runId!;
    state.terminalReports = [];
    if (surface === "channel") {
      const anchor = base.sourceRefs!.find(ref => ref.kind === "conversation_item")!.id;
      const turnId = `turn_${anchor}`;
      state.channelTurnContexts[turnId] = { assignment: {
        turnId, segmentId: "segment-category", status: "committed", revision: 1,
      } };
    }
    state.runs = state.runs.map(run => run.id === runId ? { ...run, status: "running", endedAt: undefined } : run);
    await mockDaemon(page, state);
    const open = async (target: Page) => {
      await target.goto("/");
      if (title) await target.getByRole("button", { name: /Open recent conversation \d+|打开最近对话 \d+/u }).filter({ hasText: title }).click();
      if (teammate) await target.getByRole("button", { name: teammate.displayName, exact: true }).click();
      if (surface === "channel") await openEngineeringChannel(target);
    };
    for (const category of ["search", "edit", "tool", "web"] as const) {
      state.executionActions = operations(base, category);
      await open(page);
      const header = page.locator(`[data-conversation-activity-category="${category}"]`);
      await expect(header).toHaveCount(1).catch(async error => {
        await writeFile(`${evidence}/${surface}-category-diagnostic.json`, JSON.stringify(await page.locator('[data-conversation-timeline-id]').evaluateAll(nodes => nodes.map(node => ({...((node as HTMLElement).dataset)}))), null, 2));
        throw error;
      });
      await expect(header).toHaveAttribute("aria-expanded", "false");
      await expect(page.locator('[data-conversation-process-presentation="process"]')).toHaveCount(0);
      const labels = category === "web" ? ["已搜索网页"]
        : [...(category === "tool" ? ["加载了工具"] : []), ...(category === "edit" || category === "tool" ? ["编辑了文件"] : []), "读取文件", "运行了命令"];
      for (const label of labels) await expect(header).toContainText(label);
      if (category !== "tool") await expect(header).not.toContainText("加载了工具");
      if (category !== "web") await expect(header).not.toContainText("已搜索网页");
      await page.screenshot({ path: `${evidence}/${surface}-category-${category}.png` });
      if (surface === "normal" && category === "tool") {
        await page.setViewportSize({ width: 390, height: 844 });
        const hideNavigation = page.getByRole("button", { name: "收起左侧栏", exact: true });
        if (await hideNavigation.isVisible()) await hideNavigation.click();
        await expect(header).toBeInViewport();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await page.screenshot({ path: `${evidence}/normal-category-tool-mobile.png` });
        await page.setViewportSize({ width: 1440, height: 960 });
      }
      await header.focus();
      await page.keyboard.press("Enter");
      await expect(header).toHaveAttribute("aria-expanded", "true");
      const groupId = await header.getAttribute("aria-controls");
      expect(groupId).toBeTruthy();
      await expect(page.locator(`[id="${groupId}"] [data-conversation-timeline-id]`)).toHaveCount(state.executionActions.length);
    }
    state.runs = state.runs.map(run => run.id === runId ? { ...run, status: "succeeded", endedAt: "2026-07-24T02:01:36.000Z" } : run);
    await open(page);
    const process = page.locator('[data-conversation-process-presentation="process"]').first();
    await expect(process).toHaveAttribute("aria-expanded", "false");
    await expect(process).toContainText("1分钟36秒");
    await page.screenshot({ path: `${evidence}/${surface}-category-completed.png` });
    await process.click();
    await expect(page.locator('[data-conversation-activity-category="web"]')).toBeVisible();
    await page.screenshot({ path: `${evidence}/${surface}-category-completed-expanded.png` });
  });
}

test("normal conversation keeps safe thinking visible and compaction independent through completion", async ({ page }) => {
  await mkdir(evidence, { recursive: true });
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "zh-CN");
    localStorage.setItem("ling-stack.themePreference", "light");
    const subscribers = new Set<EventTarget>();
    class TestEventSource extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 2;
      readonly CONNECTING = 0;
      readonly OPEN = 1;
      readonly CLOSED = 2;
      readonly url: string;
      readonly withCredentials = false;
      readyState = 1;
      onopen = null;
      onmessage = null;
      onerror = null;
      constructor(url: string | URL) { super(); this.url = String(url); subscribers.add(this); }
      close() { this.readyState = 2; subscribers.delete(this); }
    }
    const emit = (name: string, data: unknown) => subscribers.forEach(source =>
      source.dispatchEvent(new MessageEvent(name, { data: JSON.stringify(data) })));
    let seq = 0;
    Object.defineProperty(globalThis, "EventSource", { configurable: true, value: TestEventSource });
    Object.defineProperty(globalThis, "__activityStream", { value: {
      count: () => subscribers.size,
      ready: () => emit("control_plane_replay_ready", { disposition: "complete", requestedAfterSeq: 0,
        replayFloorSeq: 0, upperBoundSeq: 0, nextAfterSeq: 0 }),
      refresh: (runId: string) => emit("control_plane_event", { seq: ++seq, workspaceId: "workspace_default",
        cwd: "/workspace", ts: "2026-07-24T02:00:06.000Z", domain: "runs", entityType: "context_compaction",
        entityId: runId, action: "context_compaction.revised", data: { runId } }),
    } });
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const title = installNormalWorkCellFixture(state);
  const thread = state.threads.find(thread => thread.kind === "conversation")!;
  const runId = state.executionActions[0]!.runId!;
  const turn = state.turns.find(turn => turn.threadId === thread.id)!;
  const anchorItemId = `conversation-user:${turn.id}`;
  state.terminalReports = [];
  state.executionActions = operations({ ...state.executionActions[0]!, sourceRefs: [{ kind: "conversation_item", id: anchorItemId }] }, "search");
  state.runs = state.runs.map(run => run.id === runId ? { ...run, status: "running", createdAt: "2026-07-24T02:00:01.000Z",
    updatedAt: "2026-07-24T02:00:01.000Z", endedAt: undefined } : run);
  const assistantId = `conversation-assistant:${turn.id}`;
  const ownership = { workspaceId: "workspace_default", threadId: thread.id, turnId: turn.id, runId,
    attemptId: state.executionActions[0]!.attemptId!, participantId: "ling", anchorItemId: assistantId };
  const refs = [{ kind: "conversation_item", id: assistantId }, { kind: "run", id: runId },
    { kind: "attempt", id: ownership.attemptId }, { kind: "participant", id: ownership.participantId }];
  const thinking = "先核对实际操作的归属，再检查连续记录的分类。\n\n读取、编辑和命令分别保留原始详情；完成后统一整理过程，最终回复继续正常展示。";
  let compactionStatus = "running";
  let compactionRevision = 30;
  await mockDaemon(page, state);
  await page.route(new RegExp(`/conversations/${thread.id}(?:\\?.*)?$`), route => {
    const detail = buildMockConversationDetail(state, cwd, thread);
    return route.fulfill({ json: {
    ...detail,
    // The mock Host advances item revisions when pending delivery becomes committed.
    conversationItems: (detail.conversationItems as Record<string, unknown>[]).map(item => ({ ...item, revision: compactionRevision })),
    reasoningSummaries: [{ ...ownership, id: "safe-thinking", revision: 15, eventId: "safe-summary-event", eventSequence: 15,
      text: thinking, parts: [thinking], semantic: "safe_summary", source: "openai_responses", truncated: false,
      sourceRefs: [...refs, { kind: "run_event", id: "safe-summary-event" }], createdAt: "2026-07-24T02:00:05.000Z" }],
    contextCompactions: [{ ...ownership, id: "active-compaction", revision: compactionRevision, eventId: "compaction-event", eventSequence: 30,
      status: compactionStatus, reason: "threshold", summary: "", sourceRefs: [...refs, { kind: "run_event", id: "compaction-event" }] }],
  } });
  });
  const open = async () => {
    await page.goto("/");
    await page.getByRole("button", { name: /打开最近对话 \d+/u }).filter({ hasText: title }).click();
  };
  await open();
  const compaction = page.locator('[data-conversation-timeline-kind="contextCompaction"]');
  const reasoning = page.locator('[data-conversation-timeline-kind="reasoning"]');
  await expect(reasoning).toContainText(thinking.split("\n\n")[1]!);
  await expect(reasoning.getByRole("button")).toHaveCount(0);
  await expect(compaction).toContainText("正在压缩上下文…");
  await expect(compaction.locator("[data-conversation-process-header]")).toHaveCount(0);
  await page.screenshot({ path: `${evidence}/normal-thinking-compaction-light.png` });
  const motion = compaction.locator(".conversation-activity-label");
  await expect(motion).toHaveAttribute("data-activity-motion", "running");
  await expect(compaction.locator(".conversation-timeline-activity-status")).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await motion.evaluate(node => getComputedStyle(node).animationName)).toBe("none");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect.poll(() => motion.evaluate(node => getComputedStyle(node).animationName)).toBe("conversation-activity-light");
  // IntersectionObserver must pause work when the label leaves the viewport.
  await compaction.evaluate(node => { (node as HTMLElement).style.transform = "translateY(-10000px)"; });
  await expect(motion).toHaveAttribute("data-activity-motion", "paused");
  await compaction.evaluate(node => { (node as HTMLElement).style.transform = ""; });
  await expect(motion).toHaveAttribute("data-activity-motion", "running");
  const originalRow = await compaction.getAttribute("data-conversation-timeline-id");
  const activity = page.locator('[data-conversation-activity-category="search"]');
  await activity.click();
  await expect(activity).toHaveAttribute("aria-expanded", "true");
  await expect.poll(() => page.evaluate(() => (globalThis as any).__activityStream.count())).toBeGreaterThan(0);
  await page.evaluate(() => (globalThis as any).__activityStream.ready());
  const refresh = async () => {
    compactionRevision += 1;
    await page.evaluate(id => (globalThis as any).__activityStream.refresh(id), runId);
  };
  for (const [status, label] of [["failed", "上下文压缩失败"], ["blocked", "上下文压缩结果待确认"],
    ["cancelled", "已取消上下文压缩"], ["running", "正在压缩上下文…"]]) {
    compactionStatus = status!;
    await refresh();
    await expect(compaction).toContainText(label!);
    await expect(compaction).toHaveAttribute("data-conversation-timeline-id", originalRow!);
    await expect(activity).toHaveAttribute("aria-expanded", "true");
  }
  compactionStatus = "succeeded";
  state.runs = state.runs.map(run => run.id === runId ? { ...run, status: "succeeded",
    updatedAt: "2026-07-24T02:01:36.000Z", endedAt: "2026-07-24T02:01:36.000Z" } : run);
  await refresh();
  await expect(compaction).toContainText("上下文已自动压缩");
  await expect(page.locator('[data-conversation-process-presentation="process"]').first()).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator('[data-conversation-process-group] [data-conversation-timeline-kind="contextCompaction"]')).toHaveCount(0);
  await page.screenshot({ path: `${evidence}/normal-compaction-completed-light.png` });
});
