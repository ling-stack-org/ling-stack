import { expect, test } from "@playwright/test";
import { buildMockConversationDetail, mockDaemon } from "./support/mock-daemon";
import { createBaseState, cwd, isRecord } from "./support/mock-state";
import { installNormalWorkCellFixture } from "./support/conversation-work-cell-fixture";

// Production adapters and renderer with API fixtures, not packaged/native proof.
for (const source of ["host_status", "run_narration"] as const) {
  test(`normal interruption preserves facts and only replaces ${source} when the canonical report arrives`, async ({ page }, testInfo) => {
    await page.addInitScript(() => {
      localStorage.setItem("ling-stack.locale", "en-US");
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async (text: string) => { Reflect.set(globalThis, "__interruptionCopy", text); } },
      });
    });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const state = createBaseState({ approvalStatus: "expired" });
    const title = installNormalWorkCellFixture(state);
    const original = state.terminalReports[0]!;
    if (!isRecord(original) || !isRecord(original.outcome)) throw new Error("Interruption fixture requires a terminal report");
    const runId = state.turnRunLinks[0]!.runId;
    const turnId = state.turnRunLinks[0]!.turnId;
    const thread = state.threads.find(item => item.id === original.threadId)!;
    const warning = "Tool completion was not received; process termination and actual effects remain unconfirmed.";
    const reason = "The runtime restarted without a safe checkpoint. The task was interrupted and was not retried.";
    state.runs = state.runs.map(run => run.id === runId ? { ...run, status: "failed", errorMessage: "runtime_interrupted_no_checkpoint" } : run);
    state.turns = state.turns.map(turn => isRecord(turn) && turn.id === turnId ? { ...turn, status: "failed" } : turn);
    state.terminalReports = [{ ...original, outcome: { ...original.outcome, status: "failed", summary: "The task failed." },
      risks: [
        { id: `execution-unconfirmed:${runId}:tool`, summary: warning, severity: "critical", status: "unverified", sourceRefs: [{ kind: "run", id: runId, visibility: "conversation" }] },
        { id: `run-failure:${runId}`, summary: reason, severity: "critical", status: "unresolved", sourceRefs: [{ kind: "run", id: runId, visibility: "conversation" }] },
      ],
    }];
    await mockDaemon(page, state);
    await page.route(`**/conversations/${thread.id}?*`, async route => {
      const detail = buildMockConversationDetail(state, cwd, thread);
      detail.messages = (detail.messages as Array<Record<string, unknown>>).map(message => message.role === "assistant"
        ? { ...message, content: "STATUS_PLACEHOLDER_SENTINEL", contentSource: source, narrationSegments: [], errorMessage: "runtime_interrupted_no_checkpoint" }
        : message);
      detail.conversationItems = (detail.conversationItems as Array<Record<string, unknown>>).flatMap(item => item.kind !== "assistant_message" ? [item]
        : source === "host_status" ? [] : [{ ...item, payload: { ...(item.payload as object), body: "STATUS_PLACEHOLDER_SENTINEL", phase: "commentary" } }]);
      await route.fulfill({ json: detail });
    });
    await page.goto("/");
    await page.getByRole("button", { name: /Open recent conversation \d+/u }).filter({ hasText: title }).click();
    const feed = page.locator('[data-conversation-surface-timeline="normal"]');
    const result = feed.locator("[data-conversation-terminal-response]");
    await expect(result).toHaveCount(1);
    const risks = result.locator('[data-terminal-report-section="risks"]');
    for (const fact of [reason, warning]) {
      await expect(risks.locator(".conversation-timeline-terminal-entry").filter({ hasText: fact })).toHaveCount(1);
      await expect(result.locator(".conversation-timeline-result-summary")).not.toContainText(fact);
    }
    if (source === "host_status") {
      await expect(feed).not.toContainText("STATUS_PLACEHOLDER_SENTINEL");
      await expect(feed).not.toContainText("runtime_interrupted_no_checkpoint");
    } else {
      await expect(feed.locator('[data-conversation-timeline-kind="agentMessage"]')).toContainText("STATUS_PLACEHOLDER_SENTINEL");
    }
    const detail = result.locator("button.conversation-timeline-activity-main");
    await expect(detail.locator("strong")).toHaveText("The task failed.");
    await expect(detail).toHaveAccessibleName("The task failed.. Collapse details");
    await expect(detail).toHaveAttribute("aria-expanded", "true");
    await expect(risks).toBeVisible();
    const footer = feed.locator("[data-conversation-response-footer]");
    await expect(footer).toHaveCount(1);
    await detail.click();
    await expect(detail).toHaveAttribute("aria-expanded", "false");
    await expect(risks).toBeHidden();
    const copy = footer.getByRole("button", { name: "Copy message", exact: true });
    await copy.focus();
    await copy.click();
    const collapsedCopy = await page.evaluate(() => Reflect.get(globalThis, "__interruptionCopy") as string);
    for (const fact of [reason, warning]) expect(collapsedCopy.split(fact)).toHaveLength(2);
    expect(collapsedCopy.includes("STATUS_PLACEHOLDER_SENTINEL")).toBe(source === "run_narration");
    await detail.click();
    await expect(detail).toHaveAttribute("aria-expanded", "true");
    await expect(risks).toBeVisible();
    await copy.click();
    expect(await page.evaluate(() => Reflect.get(globalThis, "__interruptionCopy"))).toBe(collapsedCopy);
    expect(errors).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`${source}-failure-result.png`) });
  });
}
