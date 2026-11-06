import { expect, test, type Locator, type Page } from "@playwright/test";
import { installChannelWorkCellScenario } from "./support/conversation-work-cell-scenario";
import { cwd, mockDaemon } from "./support/mock-daemon";
import { createBaseState, createMockTeammate } from "./support/mock-state";
import { openEngineeringChannel, readScrollState } from "./support/test-helpers";
import { timelineBatchGroup } from "./support/timeline-batch-group";

function channelRootTimeline(page: Page): Locator {
  return page.locator(".message-feed")
    .locator('[data-conversation-timeline][data-conversation-timeline-scope="channel_root"]');
}

async function expandTimelineItem(item: Locator): Promise<void> {
  const toggle = item.locator('.conversation-timeline-activity-main[aria-expanded="false"]');
  if (await toggle.count() > 0) {
    await toggle.click();
  }
}

test("work-cell Markdown artifacts return preview content matching the artifact body", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "expired" });
  installChannelWorkCellScenario(state);
  await mockDaemon(page, state);
  await page.goto("/");

  const artifactId = "demo_work_cell_channel_engineering_artifact_doc";
  const result = await page.evaluate(async ({ artifactId, cwd }) => {
    const base = `http://127.0.0.1:17891/artifacts/${encodeURIComponent(artifactId)}`;
    const preview = await fetch(`${base}/preview?cwd=${encodeURIComponent(cwd)}`);
    const content = await fetch(`${base}/content?cwd=${encodeURIComponent(cwd)}`);
    return {
      previewStatus: preview.status,
      contentStatus: content.status,
      preview: await preview.json(),
      content: await content.text(),
    };
  }, { artifactId, cwd });

  expect(result).toMatchObject({
    previewStatus: 200,
    contentStatus: 200,
    preview: {
      ref: { id: artifactId, source: "artifact", scope: "run", previewable: true },
      kind: "markdown_text",
      truncated: false,
    },
  });
  expect(result.preview.text).toBe(result.content);
  expect(result.preview.text).toContain("# Conversation Work Cell Operation Records");
});

test("channel work-cell mock renders a realistic multi-agent operation record", async ({ page }) => {
  const runtimeErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(`${message.text()} @ ${message.location().url || "unknown"}`);
  });
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "zh-CN");
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
      readyState = TestEventSource.OPEN;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;

      constructor(url: string | URL) {
        super();
        this.url = String(url);
        subscribers.add(this);
      }

      close(): void {
        this.readyState = TestEventSource.CLOSED;
        subscribers.delete(this);
      }
    }
    const emit = (name: string, data: unknown): void => {
      const event = new MessageEvent(name, { data: JSON.stringify(data) });
      subscribers.forEach((subscriber) => subscriber.dispatchEvent(event));
    };
    Object.defineProperty(globalThis, "EventSource", { configurable: true, value: TestEventSource });
    Object.defineProperty(globalThis, "__workCellControlPlane", {
      configurable: true,
      value: {
        subscriberCount: () => subscribers.size,
        ready: () => emit("control_plane_replay_ready", {
          disposition: "complete",
          requestedAfterSeq: 0,
          replayFloorSeq: 0,
          upperBoundSeq: 0,
          nextAfterSeq: 0,
        }),
        refresh: () => emit("control_plane_event", {
          seq: 1,
          workspaceId: "workspace_default",
          cwd: "/workspace",
          ts: "2026-08-10T00:01:00.000Z",
          domain: "runs",
          entityType: "run",
          entityId: "run_work_cell_demo_refresh",
          action: "run.updated",
          data: {},
        }),
      },
    });
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.channelMessages = [{
    id: "message_after_work_cell_demo",
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    kind: "message",
    intent: "discuss",
    authorType: "local-user",
    authorId: "local-user",
    body: [
      "继续检查历史会话里的文件操作。",
      "这一条测试消息让上面的产物记录成为历史内容。",
      "菜单向下展开时仍然必须覆盖后续会话行。",
      "Visual Studio Code、TextEdit 和下载入口都应该可以点击。",
      "虚拟列表不能拦截弹层的指针事件。",
      "滚动后菜单也不能改变消息流高度。",
      "完成验证后继续保留简约的会话布局。",
    ].join("\n"),
    mentions: [],
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
    status: "ready",
    createdAt: "2026-07-10T09:15:00.000Z",
    updatedAt: "2026-07-10T09:15:00.000Z",
  }];
  state.tasks = [];
  state.runs = [];
  state.approvals = [];
  state.channelExecutionProposals = [];
  state.channelWorkflows = [];
  state.channelWorkflowSteps = [];
  state.executionActions = [];
  state.artifactsByRun = {};
  state.aiTeammates = [
    createMockTeammate({ id: "ling_agent", templateId: "ling_agent", kind: "system_teammate", systemRole: "ling_agent", roleKey: "custom", displayName: "Ling Agent", avatarTone: "violet" }),
    createMockTeammate({ id: "teammate_builtin_architect", templateId: "architect", roleKey: "architect", displayName: "Ling Architect" }),
    createMockTeammate({ id: "teammate_builtin_designer", templateId: "designer", roleKey: "designer", displayName: "Ling Designer" }),
    createMockTeammate({ id: "teammate_builtin_engineer", templateId: "engineer", roleKey: "engineer", displayName: "Ling Engineer" }),
    createMockTeammate({ id: "teammate_builtin_qa", templateId: "qa", roleKey: "qa", displayName: "Ling QA" }),
  ];

  installChannelWorkCellScenario(state);
  await mockDaemon(page, state);
  await page.route(/\/workspace\/changes(?:\?.*)?$/, async (route) => {
    await route.fulfill({ status: 304, body: "" });
  });
  let demoRecoveryState: "applied" | "undone" = "applied";
  await page.route(/\/turns\/turn_demo_work_cell_[^/]+\/workspace-changes(?:\/(?:undo|reapply))?(?:\?.*)?$/u, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/undo")) {
      demoRecoveryState = "undone";
    } else if (url.pathname.endsWith("/reapply")) {
      demoRecoveryState = "applied";
    }
    const encodedTurnId = url.pathname.split("/")[2] ?? "";
    const turnId = decodeURIComponent(encodedTurnId);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        cwd: url.searchParams.get("cwd") ?? "/repo",
        threadId: "thread_channel_channel_engineering",
        turnId,
        runIds: [
          "demo_work_cell_channel_engineering_run_architect",
          "demo_work_cell_channel_engineering_run_designer",
          "demo_work_cell_channel_engineering_run_engineer",
          "demo_work_cell_channel_engineering_run_qa",
          "demo_work_cell_channel_engineering_run_engineer_followup",
        ],
        state: demoRecoveryState,
        canUndo: demoRecoveryState === "applied",
        canReapply: demoRecoveryState === "undone",
        provenanceComplete: true,
        files: [],
        summary: {
          fileCount: 5,
          addCount: 0,
          updateCount: 5,
          deleteCount: 0,
          moveCount: 0,
          addedLines: 15,
          removedLines: 4,
        },
        updatedAt: "2026-07-13T00:00:00.000Z",
      }),
    });
  });
  await page.route(/\/(?:runs|workflows)\/demo_work_cell_[^/]+\/workspace-changes(?:\/(?:undo|reapply))?(?:\?.*)?$/, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/undo")) {
      demoRecoveryState = "undone";
    } else if (url.pathname.endsWith("/reapply")) {
      demoRecoveryState = "applied";
    }
    const recoveryId = url.pathname.split("/")[2] ?? "demo_work_cell_recovery";
    const workflowRecovery = url.pathname.startsWith("/workflows/");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        cwd: url.searchParams.get("cwd") ?? "/repo",
        ...(workflowRecovery ? { workflowId: recoveryId, runIds: ["demo_work_cell_run_engineer", "demo_work_cell_run_qa"] } : { runId: recoveryId }),
        state: demoRecoveryState,
        canUndo: demoRecoveryState === "applied",
        canReapply: demoRecoveryState === "undone",
        files: [],
        summary: {
          fileCount: 5,
          addCount: 0,
          updateCount: 5,
          deleteCount: 0,
          moveCount: 0,
          addedLines: 15,
          removedLines: 4,
        },
        updatedAt: "2026-07-13T00:00:00.000Z",
      }),
    });
  });
  page.on("dialog", (dialog) => void dialog.accept());
  await page.route(/\/channels\/channel_engineering\/protocol(?:\?.*)?$/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 350));
    await route.fallback();
  });
  await page.goto("/");
  await expect.poll(() => page.evaluate(() => (
    globalThis as typeof globalThis & {
      __workCellControlPlane: { subscriberCount: () => number };
    }
  ).__workCellControlPlane.subscriberCount())).toBe(1);
  await page.evaluate(() => (
    globalThis as typeof globalThis & {
      __workCellControlPlane: { ready: () => void };
    }
  ).__workCellControlPlane.ready());
  await openEngineeringChannel(page);

  await expect.poll(() => readScrollState(page, ".activity-shell .message-feed")).toMatchObject({ atBottom: true });
  await expect(page.getByRole("button", { name: "Jump to latest message" })).toHaveCount(0);

  const feed = page.locator(".message-feed");
  await expect(feed).toContainText("讨论一下：多 Agent 讨论问题时");
  const discussionReplies = feed.locator(".channel-message-row.ai-teammate").filter({ hasText: /讨论阶段应该保留|普通会话行最清晰|不创建 workflow|限制可见参与人数/u });
  await expect(discussionReplies).toHaveCount(4);
  for (const name of ["Ling Architect", "Ling Designer", "Ling Engineer", "Ling QA"]) {
    const reply = discussionReplies.filter({ has: page.locator("strong", { hasText: name }) });
    await expect(reply).toHaveCount(1);
    await expect(reply.locator(".teammate-avatar-image.compact")).toHaveCount(1);
    await expect(reply).not.toContainText("已处理");
  }
  await expect(discussionReplies.locator(".conversation-work-cell")).toHaveCount(0);
  await expect(discussionReplies.locator(".terminal-report-block")).toHaveCount(0);
  const timeline = channelRootTimeline(page);
  await expect(timeline).toHaveCount(1);
  await expect(timeline).toHaveAttribute("data-conversation-timeline-scope", "channel_root");
  await expect(feed.locator(".conversation-turn, .conversation-work-cell")).toHaveCount(0);

  const sourceItem = timeline.locator('[data-conversation-timeline-kind="userMessage"]')
    .filter({ hasText: "把频道里的多 agent 操作记录按我们讨论的最终效果接进去" });
  await expect(sourceItem).toHaveCount(1);
  const sourceMessage = sourceItem.locator(".channel-message-row.local-user");
  await expect(sourceMessage).toHaveCount(1);
  const sourceMessageSpacing = await sourceMessage.evaluate((element) => {
    const paragraph = element.querySelector<HTMLElement>(".message-body-paragraph");
    const avatar = element.querySelector<HTMLElement>(":scope > .user-profile-avatar, :scope > .avatar-initial");
    const shell = element.querySelector<HTMLElement>(".message-body-shell");
    if (!paragraph || !avatar || !shell) return null;
    return {
      textToAvatar: Math.round(avatar.getBoundingClientRect().left - paragraph.getBoundingClientRect().right),
      paragraphPaddingRight: getComputedStyle(paragraph).paddingRight,
      shellPaddingRight: getComputedStyle(shell).paddingRight,
    };
  });
  expect(sourceMessageSpacing).not.toBeNull();
  expect(sourceMessageSpacing?.textToAvatar).toBeLessThanOrEqual(24);
  expect(sourceMessageSpacing?.paragraphPaddingRight).toBe("0px");
  expect(sourceMessageSpacing?.shellPaddingRight).toBe("0px");

  const subAgents = timeline.locator('[data-conversation-timeline-kind="subAgentActivity"]');
  await expect(subAgents).toHaveCount(4);
  for (const participantId of ["architect", "designer", "engineer", "qa"]) {
    const subAgent = timeline.locator(`[data-conversation-timeline-kind="subAgentActivity"][data-conversation-participant-id="${participantId}"]`);
    await expect(subAgent).toHaveCount(1);
    await expect(subAgent).toHaveAttribute("data-conversation-timeline-renderer-key", "agent.nested");
    await expect(subAgent.locator(".conversation-timeline-sub-agent-head")).toHaveAttribute("aria-expanded", "false");
    await expect(subAgent.locator('[data-conversation-timeline-scope="child"]')).toHaveCount(0);
  }

  const terminalReportItem = timeline.locator('[data-conversation-timeline-kind="terminalReport"]');
  await expect(terminalReportItem).toHaveCount(1);
  await expandTimelineItem(terminalReportItem);
  const terminalReport = terminalReportItem.locator(".conversation-timeline-terminal-report");
  await expect(terminalReport).toBeVisible();
  await expect.poll(() => terminalReport.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  await expect(terminalReportItem).toHaveAttribute("data-conversation-timeline-status", "succeeded");
  await expect(terminalReportItem).toContainText("任务已完成。");
  await expect(terminalReportItem).not.toContainText("频道现在会保留 Architect、Designer、Engineer 和 QA 的真实操作过程");
  await expect(terminalReport.locator('[data-terminal-report-section="agents"], [data-terminal-report-section="verification"]')).toHaveCount(0);
  await expect(terminalReport).not.toContainText("重构操作记录展示");
  await expect(terminalReport).not.toContainText("Web typecheck");
  const reportRef = terminalReport.locator(".conversation-timeline-file-ref")
    .filter({ hasText: "conversation-work-cell-operation-records.md" });
  await expect(reportRef).toHaveCount(1);
  await expect(reportRef).toBeVisible();
  await expect(reportRef).toHaveAttribute("title", "docs/design/conversation-work-cell-operation-records.md");
  await expect(reportRef.locator(".conversation-timeline-file-ref-icon")).toBeVisible();
  await expect(terminalReport.getByRole("button", { name: "conversation-work-cell-operation-records.md", exact: true })).toHaveCount(0);
  await expect(timeline.locator('[data-conversation-timeline-kind="agentMessage"]').filter({ hasText: "完成：「频道 work-cell 操作记录样例」" })).toHaveCount(0);

  const topLevelKinds = await timeline.locator(":scope > .conversation-timeline-focus-block")
    .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-feed-item-kind")));
  const sourceIndex = topLevelKinds.indexOf("userMessage");
  const firstSubAgentIndex = topLevelKinds.indexOf("subAgentActivity");
  const reportIndex = topLevelKinds.indexOf("terminalReport");
  expect(sourceIndex).toBeGreaterThanOrEqual(0);
  expect(firstSubAgentIndex).toBeGreaterThan(sourceIndex);
  expect(reportIndex).toBeGreaterThan(firstSubAgentIndex);

  const engineerSpan = timeline.locator('[data-conversation-timeline-kind="subAgentActivity"][data-conversation-participant-id="engineer"]');
  const engineerDisclosure = engineerSpan.locator(".conversation-timeline-sub-agent-head");
  await engineerDisclosure.focus();
  await engineerDisclosure.press("Enter");
  await expect(engineerDisclosure).toHaveAttribute("aria-expanded", "true");
  const engineerGroupId = await engineerDisclosure.getAttribute("aria-controls");
  expect(engineerGroupId).toBeTruthy();
  const engineerDetail = timeline.locator(`[id="${engineerGroupId}"]`);
  await expect(engineerDetail).toHaveCount(1);
  await expect(engineerDetail).toHaveAttribute("data-conversation-timeline-scope", "child");
  await expect(engineerDetail).not.toContainText("完成频道 work-cell 操作记录投影");
  await expect(engineerDetail).not.toContainText("主要任务已完成");
  await expect(engineerDetail).toContainText("先把 agent 内部工作流拆成可扫描的步骤");
  await expect(engineerDetail).toContainText("然后收紧视觉噪音");
  await expect(engineerDetail).toContainText("改完后先跑类型检查");
  await expect(engineerDetail).toContainText("ConversationWorkCell.tsx");
  await expect(engineerDetail).toContainText("conversation-work-cell-operation-records.md");
  await expect(engineerDetail).toContainText("已运行命令 corepack pnpm");

  const editActionRow = engineerDetail.locator('[data-conversation-timeline-kind="fileChange"]')
    .filter({ hasText: "ConversationWorkCell.tsx" }).first();
  await expandTimelineItem(editActionRow);
  const editFileRefs = editActionRow.locator("button.conversation-timeline-file-ref");
  await expect(editFileRefs).toHaveCount(2);
  await expect(editFileRefs.nth(0)).toHaveAttribute("title", "apps/web/src/shared/conversation/blocks/ConversationWorkCell.tsx");
  await expect(editFileRefs.nth(0).locator(".conversation-timeline-file-ref-icon")).toHaveText("▧");
  await expect(editFileRefs.nth(1)).toHaveAttribute("title", "apps/web/src/shared/conversation/blocks/ConversationWorkCell.tsx");
  await expect(editFileRefs.nth(1).locator(".conversation-timeline-file-ref-icon")).toHaveText("±");
  await expect(editActionRow.locator(".conversation-timeline-change-preview")).toHaveCount(0);

  const styleActionRow = engineerDetail.locator('[data-conversation-timeline-kind="fileChange"]')
    .filter({ hasText: "components.css" }).first();
  await expandTimelineItem(styleActionRow);
  const styleRef = styleActionRow.locator(".conversation-timeline-file-ref").first();
  await expect(styleRef).toBeVisible();
  await expect(styleRef).toHaveAttribute("title", "apps/web/src/styles/components.css");
  await expect(styleRef.locator(".conversation-timeline-file-ref-icon")).toBeVisible();

  const commandBatch = engineerDetail.locator(".conversation-command-batch");
  await expect(commandBatch).toHaveCount(1);
  await expect(commandBatch.locator(".conversation-command-batch-header")).toContainText("已运行 3 个命令");
  await expect(commandBatch).toHaveClass(/collapsed/u);
  await commandBatch.locator(".conversation-command-batch-header").click();
  await expect(commandBatch).toHaveClass(/expanded/u);
  const commandRows = (await timelineBatchGroup(commandBatch)).locator('[data-conversation-timeline-kind="commandExecution"]');
  await expect(commandRows).toHaveCount(3);
  for (const [index, command] of [
    "corepack pnpm --filter @ling-stack/web typecheck",
    "corepack pnpm --filter @ling-stack/web check:i18n",
    "git diff --check",
  ].entries()) {
    const commandRow = commandRows.nth(index);
    await expandTimelineItem(commandRow);
    await expect(commandRow.locator(".conversation-timeline-activity-main strong")).toHaveAttribute("title", command);
  }

  const refreshMessage = "触发一次 SSE feed revision，已展开的批次和命令详情必须保持。";
  state.channelMessages.push({
    id: "message_work_cell_demo_refresh",
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    kind: "message",
    intent: "discuss",
    authorType: "local-user",
    authorId: "local-user",
    body: refreshMessage,
    mentions: [],
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
    status: "ready",
    createdAt: "2026-08-10T00:01:00.000Z",
    updatedAt: "2026-08-10T00:01:00.000Z",
  });
  await page.evaluate(() => (
    globalThis as typeof globalThis & {
      __workCellControlPlane: { refresh: () => void };
    }
  ).__workCellControlPlane.refresh());
  await expect(page.getByText(refreshMessage)).toBeVisible();
  await expect(engineerDisclosure).toHaveAttribute("aria-expanded", "true");
  await expect(engineerDetail).toHaveCount(1);
  await expect(commandBatch).toHaveClass(/expanded/u);
  await expect(commandRows).toHaveCount(3);
  for (const commandRow of await commandRows.all()) {
    await expect(commandRow.locator(".conversation-timeline-activity-main")).toHaveAttribute("aria-expanded", "true");
  }

  const qaSpan = timeline.locator('[data-conversation-timeline-kind="subAgentActivity"][data-conversation-participant-id="qa"]');
  const qaDisclosure = qaSpan.locator(".conversation-timeline-sub-agent-head");
  await qaDisclosure.click();
  await expect(qaDisclosure).toHaveAttribute("aria-expanded", "true");
  const qaGroupId = await qaDisclosure.getAttribute("aria-controls");
  expect(qaGroupId).toBeTruthy();
  const qaDetail = timeline.locator(`[id="${qaGroupId}"]`);
  await expect(qaDetail).toHaveCount(1);
  await expect(qaDetail).toHaveAttribute("data-conversation-timeline-scope", "child");
  await expect(qaDetail).toContainText("QA 按频道真实路径回归，重点看折叠摘要");
  await expect(qaDetail).not.toContainText("通过频道工作记录样例回归");
  const qaCommandRow = qaDetail.locator('[data-conversation-timeline-kind="commandExecution"]');
  await expandTimelineItem(qaCommandRow);
  const qaCommand = qaCommandRow.locator(".conversation-timeline-activity-main strong");
  await expect(qaCommand).toHaveAttribute("title", 'corepack pnpm --filter @ling-stack/web exec playwright test apps/web/e2e/channel.spec.ts -g "work cell"');
  await expect(qaCommand).toHaveCSS("white-space", "nowrap");
  expect(runtimeErrors).toEqual([]);
});
