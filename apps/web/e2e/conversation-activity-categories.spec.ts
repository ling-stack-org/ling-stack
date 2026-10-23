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
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const title = installNormalWorkCellFixture(state);
  const thread = state.threads.find(thread => thread.kind === "conversation")!;
  const runId = state.executionActions[0]!.runId!;
  const turn = state.turns.find(turn => turn.threadId === thread.id)!;
  const anchorItemId = `conversation-user:${turn.id}`;
  state.terminalReports = [];
  state.executionActions = operations({ ...state.executionActions[0]!, sourceRefs: [{ kind: "conversation_item", id: anchorItemId }] }, "search");
  state.runs = state.runs.map(run => run.id === runId ? { ...run, status: "running", createdAt: "2026-07-24T02:00:01.000Z", endedAt: undefined } : run);
  const assistantId = `conversation-assistant:${turn.id}`;
  const ownership = { workspaceId: "workspace_default", threadId: thread.id, turnId: turn.id, runId,
    attemptId: state.executionActions[0]!.attemptId!, participantId: "ling", anchorItemId: assistantId };
  const refs = [{ kind: "conversation_item", id: assistantId }, { kind: "run", id: runId },
    { kind: "attempt", id: ownership.attemptId }, { kind: "participant", id: ownership.participantId }];
  const thinking = "先核对实际操作的归属，再检查连续记录的分类。\n\n读取、编辑和命令分别保留原始详情；完成后统一整理过程，最终回复继续正常展示。";
  let compacted = false;
  await mockDaemon(page, state);
  await page.route(new RegExp(`/conversations/${thread.id}(?:\\?.*)?$`), route => route.fulfill({ json: {
    ...buildMockConversationDetail(state, cwd, thread),
    reasoningSummaries: [{ ...ownership, id: "safe-thinking", revision: 15, eventId: "safe-summary-event", eventSequence: 15,
      text: thinking, parts: [thinking], semantic: "safe_summary", source: "openai_responses", truncated: false,
      sourceRefs: [...refs, { kind: "run_event", id: "safe-summary-event" }], createdAt: "2026-07-24T02:00:05.000Z" }],
    contextCompactions: [{ ...ownership, id: "active-compaction", revision: compacted ? 32 : 30, eventId: "compaction-event", eventSequence: 30,
      status: compacted ? "succeeded" : "running", reason: "threshold", summary: "", sourceRefs: [...refs, { kind: "run_event", id: "compaction-event" }] }],
  } }));
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
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(compaction.locator(".conversation-timeline-activity-main")).toBeVisible();
  compacted = true;
  state.runs = state.runs.map(run => run.id === runId ? { ...run, status: "succeeded", endedAt: "2026-07-24T02:01:36.000Z" } : run);
  await open();
  await expect(compaction).toContainText("上下文已自动压缩");
  await expect(page.locator('[data-conversation-process-presentation="process"]').first()).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator('[data-conversation-process-group] [data-conversation-timeline-kind="contextCompaction"]')).toHaveCount(0);
  await page.screenshot({ path: `${evidence}/normal-compaction-completed-light.png` });
});
