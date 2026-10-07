import { expect, test } from "@playwright/test";
import type { ConversationTerminalReportProjectionDto } from "@ling-stack/contracts";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";
import { openEngineeringChannel } from "./support/test-helpers";
import { attachCommittedChannelReportItem, installChannelWorkCellFixture, installNormalWorkCellFixture, installTeammateWorkCellFixture } from "./support/conversation-work-cell-fixture";

// Simulation: API fixtures exercise AppShell adapters and the real shared renderer.
// No model requests, real secrets, persisted history, or packaged acceptance claims.
for (const surface of ["normal", "private", "channel"] as const) {
  for (const restrictedOutcome of [false, true]) {
    test(`${surface} report privacy: ${restrictedOutcome ? "restricted" : "public"} outcome`, async ({ page }, testInfo) => {
      await page.addInitScript(() => {
        localStorage.setItem("ling-stack.locale", "en-US");
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
          writeText: async (text: string) => { Object.assign(globalThis, { __privacyCopy: text }); },
        } });
      });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const state = createBaseState({ approvalStatus: "expired" });
      const title = surface === "normal" ? installNormalWorkCellFixture(state) : undefined;
      const teammate = surface === "private" ? installTeammateWorkCellFixture(state) : undefined;
      if (surface === "channel") {
        const { threadId, runId } = installChannelWorkCellFixture(state, "privacy");
        const turnId = state.turnRunLinks.find((link) => link.runId === runId)!.turnId;
        state.terminalReports = [baseReport(threadId, turnId)];
      }
      const original = state.terminalReports[0] as ConversationTerminalReportProjectionDto;
      const report = withPrivacySections(original, restrictedOutcome);
      state.terminalReports = [report];
      // This matrix covers the report-only fallback. Successful narration now
      // suppresses the redundant report rather than exposing its safe sections.
      if (surface === "normal") state.eventsByRun[state.runs[0]!.id] = [];
      if (surface === "private") state.teammateDirectMessages = state.teammateDirectMessages.map((message) => message.authorType === "ai-teammate" ? { ...message, body: "" } : message);
      if (surface === "channel") attachCommittedChannelReportItem(state, report);
      const untouched = JSON.stringify(report);
      await mockDaemon(page, state);
      await page.goto("/");
      if (title) await page.getByRole("button", { name: /Open recent conversation \d+/u }).filter({ hasText: title }).click();
      if (teammate) await page.getByRole("button", { name: teammate.displayName, exact: true }).click();
      if (surface === "channel") await openEngineeringChannel(page);

      const result = page.locator(`[data-conversation-terminal-response="${report.id}"]`);
      await expect(result).toHaveCount(1);
      await expect(result).toBeVisible();
      await expect(result).not.toContainText("PRIVACY_SENTINEL");
      const toggle = result.locator(".conversation-timeline-activity-main");
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      const responseId = await result.locator("..").getAttribute("data-conversation-response-id");
      expect(responseId).toBeTruthy();
      const actions = page.locator(`.conversation-timeline-focus-block[data-conversation-response-id=${JSON.stringify(responseId)}] [data-conversation-response-footer] .message-action-bar`);
      await page.mouse.move(0, 0);
      await expect(actions).toHaveCSS("opacity", "0");
      await result.hover();
      await expect(actions).toHaveCSS("opacity", "1");
      await actions.getByRole("button", { name: "Copy message", exact: true }).click();
      const copied = await page.evaluate(() => Reflect.get(globalThis, "__privacyCopy") as string);
      expect(copied?.trim()).not.toBe("");
      expect(copied).not.toMatch(/PRIVACY_SENTINEL|hidden-private|private-proof|find content|forward-plan\.json/u);
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      if (!restrictedOutcome) await expect(result).toContainText("Public report summary");
      await expect(result).toContainText("Public check");
      await expect(result).toContainText("Public change");
      await expect(result.locator('[data-terminal-report-section="changes"] .conversation-timeline-terminal-entry')).toHaveCount(1);
      const publicFile = result.locator('[data-terminal-report-section="changes"] .conversation-timeline-file-ref');
      await expect(publicFile).toHaveCount(1);
      await expect(publicFile).toHaveAttribute("title", "docs/public.txt");
      const artifactFile = result.locator('[data-terminal-report-section="artifacts"] .conversation-timeline-file-ref');
      await expect(artifactFile).toHaveCount(1);
      await expect(artifactFile).toHaveAttribute("title", "docs/public.txt");
      expect(await page.locator("body").innerHTML()).not.toMatch(/PRIVACY_SENTINEL|hidden-private|private-proof|run_legacy\/002-find-content\.md|forward-plan\.json/u);
      await actions.getByRole("button", { name: "Copy message", exact: true }).click();
      expect(await page.evaluate(() => Reflect.get(globalThis, "__privacyCopy"))).toBe(copied);
      expect(JSON.stringify(report)).toBe(untouched);
      expect(errors).toEqual([]);
      await result.screenshot({ path: testInfo.outputPath(`simulation-${surface}-${restrictedOutcome ? "restricted" : "public"}-privacy.png`) });
    });
  }
}

test("channel report renders Markdown narration and keeps metadata lineage available on demand", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  const state = createBaseState({ approvalStatus: "expired" });
  const { threadId, runId } = installChannelWorkCellFixture(state, "privacy");
  const turnId = state.turnRunLinks.find((link) => link.runId === runId)!.turnId;
  const report = {
    ...baseReport(threadId, turnId),
    verification: [{ id: "command-check", title: "node --test", status: "passed" as const, sourceRefs: [
      { kind: "check" as const, id: "approval-1", label: "Approve shell command" },
      { kind: "operation" as const, id: "approval-1", label: "Approve shell command" },
    ] }],
    participants: [
      { agentId: "designer", displayName: "Designer", status: "completed" as const, contribution: "**Reviewed** the request.", sourceRefs: [
        { kind: "workflow_step" as const, id: "step-designer", label: "Designer: Review" },
        { kind: "run" as const, id: "run-designer", label: "Designer: Review" },
      ] },
      { agentId: "engineer", displayName: "Engineer", status: "completed" as const, contribution: "Command completed.", sourceRefs: [] },
    ],
  } satisfies ConversationTerminalReportProjectionDto;
  state.terminalReports = [report];
  attachCommittedChannelReportItem(state, report);
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);
  const result = page.locator(`[data-conversation-terminal-response="${report.id}"]`);
  await expect(result).toHaveCount(1);
  await result.locator(".conversation-timeline-activity-main").click();
  await expect(result.locator('[data-terminal-report-section="agents"] .conversation-timeline-terminal-entry-summary strong')).toHaveText("Reviewed");
  const verificationSources = result.locator('[data-terminal-report-section="verification"] .conversation-timeline-terminal-entry-sources');
  await expect(verificationSources).toHaveCount(1);
  await expect(verificationSources.locator(".conversation-timeline-ref-list")).not.toBeVisible();
  await verificationSources.locator("summary").click();
  await expect(verificationSources.locator(".conversation-timeline-terminal-lineage-ref")).toHaveCount(2);
});

for (const surface of ["normal", "private", "channel"] as const) {
  test(`${surface} mixed report refs keep lineage folded and resolve prose paths without authority`, async ({ page }, testInfo) => {
    await page.addInitScript(() => {
      localStorage.setItem("ling-stack.locale", "en-US");
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
        writeText: async (text: string) => { Object.assign(globalThis, { __reportCopy: text }); },
      } });
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const state = createBaseState({ approvalStatus: "expired" });
    const title = surface === "normal" ? installNormalWorkCellFixture(state) : undefined;
    const teammate = surface === "private" ? installTeammateWorkCellFixture(state) : undefined;
    if (surface === "channel") {
      const { threadId, runId } = installChannelWorkCellFixture(state, "mixed-refs");
      const turnId = state.turnRunLinks.find((link) => link.runId === runId)!.turnId;
      state.terminalReports = [baseReport(threadId, turnId)];
    }
    const original = state.terminalReports[0] as ConversationTerminalReportProjectionDto;
    const report: ConversationTerminalReportProjectionDto = {
      ...original,
      outcome: { ...original.outcome, status: "partially_succeeded", title: "Completed with a recovered failure", summary: "Required evidence is complete; the failed read remains audited." },
      changes: [{ id: "mixed-change", kind: "documentation", title: "Public file", summary: "Read [inside](docs/public.txt) and [outside](../outside.txt).", paths: ["docs/public.txt"], sourceRefs: [
        { kind: "file", id: "docs/public.txt", label: "public.txt", visibility: "conversation" },
        { kind: "task", id: "task-mixed", label: "task", visibility: "conversation" },
        { kind: "external", id: "call_mixed", label: "call_mixed", visibility: "conversation" },
      ] }],
      verification: [], participants: [], artifacts: [], risks: [], references: [],
    };
    state.terminalReports = [report];
    if (surface === "channel") attachCommittedChannelReportItem(state, report);
    if (surface === "private") {
      state.conversationItems = state.conversationItems?.map((item) => item.id === report.resultItemId
        ? { ...item, payload: { ...item.payload, outcomeStatus: report.outcome.status } }
        : item);
    }
    const untouched = JSON.stringify(report);
    await mockDaemon(page, state);
    await page.goto("/");
    if (title) await page.getByRole("button", { name: /Open recent conversation \d+/u }).filter({ hasText: title }).click();
    if (teammate) await page.getByRole("button", { name: teammate.displayName, exact: true }).click();
    if (surface === "channel") await openEngineeringChannel(page);

    const result = page.locator(`[data-conversation-terminal-response="${report.id}"]`);
    await expect(result).toHaveCount(1);
    // Partial reports disclose their failure detail by default.
    await expect(result.locator(".conversation-timeline-activity-main")).toHaveAttribute("aria-expanded", "true");
    const entry = result.locator('[data-terminal-report-section="changes"] .conversation-timeline-terminal-entry');
    await expect(entry.locator(".conversation-timeline-file-ref")).toHaveCount(1);
    await expect(entry.locator(".conversation-timeline-file-ref")).toHaveAttribute("title", "docs/public.txt");
    const lineage = entry.locator(".conversation-timeline-terminal-entry-sources");
    // Canonical normal/private adapters already withhold internal refs. The
    // channel projection retains visible lineage, which must stay folded.
    await expect(lineage).toHaveCount(surface === "channel" ? 1 : 0);
    if (surface === "channel") await expect(lineage.locator(".conversation-timeline-ref-list")).not.toBeVisible();
    const summary = entry.locator(".conversation-timeline-terminal-entry-summary");
    await expect(summary.locator('[title="docs/public.txt"]')).toHaveCount(1);
    await expect(summary.locator('[title="docs/public.txt"]')).not.toHaveClass(/outside-workspace/u);
    await expect(summary.locator('[title="../outside.txt (outside workspace)"]')).toHaveCount(1);
    await expect(summary.locator("button.message-local-file-link")).toHaveCount(0);
    if (surface === "channel") {
      await lineage.locator("summary").click();
      await expect(lineage.locator(".conversation-timeline-terminal-lineage-ref")).toHaveCount(2);
      await expect(lineage.locator(".conversation-timeline-file-ref")).toHaveCount(0);
      await lineage.locator("summary").click();
    } else {
      await expect(result).not.toContainText("call_mixed");
    }
    const responseId = await result.locator("..").getAttribute("data-conversation-response-id");
    expect(responseId).toBeTruthy();
    const actions = page.locator(`.conversation-timeline-focus-block[data-conversation-response-id=${JSON.stringify(responseId)}] [data-conversation-response-footer] .message-action-bar`);
    // A focused source disclosure intentionally keeps hover/focus actions visible.
    await page.getByRole("textbox").last().focus();
    await page.mouse.move(0, 0);
    await expect(actions).toHaveCSS("opacity", "0");
    await result.hover();
    await expect(actions).toHaveCSS("opacity", "1");
    await actions.getByRole("button", { name: "Copy message", exact: true }).click();
    const copied = await page.evaluate(() => Reflect.get(globalThis, "__reportCopy") as string);
    // Narration is the response copy; report-only responses use safe report text.
    const narration = page.locator(`.conversation-timeline-focus-block[data-conversation-response-id=${JSON.stringify(responseId)}] [data-conversation-timeline-kind="agentMessage"]`);
    const narrationText = (await narration.locator(".message-body-renderer").allTextContents()).join("\n\n").trim();
    if (narrationText) expect(copied).toContain(narrationText);
    else {
      expect(copied).toContain("Required evidence is complete");
      expect(copied).toContain("docs/public.txt");
    }
    expect(copied).not.toContain("call_mixed");
    expect(JSON.stringify(report)).toBe(untouched);
    expect(errors).toEqual([]);
    await result.screenshot({ path: testInfo.outputPath(`simulation-${surface}-mixed-refs.png`) });
  });
}

test("partial terminal report retains its distinct status in the shared timeline", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "zh-CN"));
  const state = createBaseState({ approvalStatus: "expired" });
  const { threadId, runId } = installChannelWorkCellFixture(state, "privacy");
  const turnId = state.turnRunLinks.find((link) => link.runId === runId)!.turnId;
  const original = baseReport(threadId, turnId);
  const report: ConversationTerminalReportProjectionDto = {
    ...original,
    outcome: { ...original.outcome, status: "partially_succeeded", title: "任务已部分完成。" },
    verification: [{ id: "partial-check", title: "One check failed", status: "failed", sourceRefs: [] }],
  };
  state.terminalReports = [report];
  attachCommittedChannelReportItem(state, report);
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const result = page.locator(`[data-conversation-terminal-response="${report.id}"]`);
  const row = result.locator("[data-conversation-timeline-item=terminalReport]");
  await expect(row).toHaveAttribute("data-conversation-timeline-status", "partially_succeeded");
  await expect(row).toContainText("部分完成");
  await expect(row).not.toContainText("已阻止");
  await expect(row.locator(".conversation-timeline-activity-main")).toHaveAttribute("aria-label", /部分完成/u);
});

function baseReport(threadId: string, turnId: string): ConversationTerminalReportProjectionDto {
  return {
    schemaVersion: 1, id: "report-channel-privacy", workspaceId: "workspace_default",
    channelId: "channel_engineering", threadId, turnId, source: { kind: "turn", id: turnId },
    generation: 1, resultItemId: "result-channel-privacy", status: "committed", language: "en-US",
    outcome: { status: "succeeded", title: "Completed", summary: "Public report summary", corrections: [], sourceRefs: [] },
    changes: [], verification: [], participants: [], artifacts: [], risks: [], references: [],
    evidenceSnapshotId: "snapshot-channel-privacy", evidenceFingerprint: "fingerprint-channel-privacy",
    synthesis: { mode: "deterministic_fallback", promptVersion: "terminal-report-v1", attemptCount: 0, validationCodes: [] },
    createdAt: "2026-07-24T02:01:00.000Z", committedAt: "2026-07-24T02:01:00.000Z",
  };
}

function withPrivacySections(report: ConversationTerminalReportProjectionDto, restrictedOutcome: boolean): ConversationTerminalReportProjectionDto {
  const privateRef = { kind: "file", id: "hidden-private.txt", label: "PRIVACY_SENTINEL label", visibility: "developer_only", sensitivity: "secret_adjacent" } as const;
  const publicAlias = { ...privateRef, visibility: "conversation", sensitivity: "normal" } as const;
  const publicRef = { kind: "file", id: "docs/public.txt", label: "public.txt", visibility: "conversation" } as const;
  const internalRef = { kind: "artifact", id: "internal-tool-content", label: "find content", visibility: "conversation" } as const;
  const internalPatchRef = { kind: "artifact", id: "internal-patch-plan", label: "Workspace forward patch plan", visibility: "conversation" } as const;
  const runRef = { kind: "run", id: "run_legacy", visibility: "conversation" } as const;
  const mixed = [publicRef, publicAlias];
  return {
    ...report,
    outcome: { ...report.outcome,
      title: restrictedOutcome ? "PRIVACY_SENTINEL outcome" : "Public result completed",
      summary: restrictedOutcome ? "PRIVACY_SENTINEL summary" : "Public report summary",
      sourceRefs: restrictedOutcome ? mixed : report.outcome.sourceRefs,
      corrections: [{ id: "private-correction", originalAssumption: "PRIVACY_SENTINEL assumption", correctedFact: "PRIVACY_SENTINEL correction", confidence: "high", sourceRefs: mixed }],
    },
    changes: [
      { id: "public-change", kind: "documentation", title: "Public change", summary: "Public details", paths: ["docs/public.txt"], sourceRefs: [publicRef] },
      { id: "private-change", kind: "code", title: "PRIVACY_SENTINEL change", summary: "PRIVACY_SENTINEL details", paths: ["hidden-private.txt"], sourceRefs: mixed },
    ],
    verification: [
      { id: "public-check", title: "Public check", status: "passed", command: "node --test public.test.mjs", sourceRefs: [publicRef] },
      { id: "private-check", title: "PRIVACY_SENTINEL check", status: "passed", command: "PRIVACY_SENTINEL command", sourceRefs: mixed },
    ],
    participants: [{ agentId: "private-agent", displayName: "PRIVACY_SENTINEL agent", status: "failed", contribution: "PRIVACY_SENTINEL contribution", sourceRefs: mixed }],
    artifacts: [
      { id: "public-proof", kind: "file", title: "Public file", path: "docs/public.txt", sourceRefs: [publicRef] },
      { id: "private-proof", kind: "file", title: "PRIVACY_SENTINEL artifact", path: "hidden-private.txt", summary: "PRIVACY_SENTINEL artifact body", sourceRefs: mixed },
      { id: "internal-tool-content", kind: "document", title: "find content", path: "run_legacy/002-find-content.md", sourceRefs: [runRef, internalRef] },
      { id: "internal-patch-plan", kind: "other", title: "Workspace forward patch plan", path: ".ling-stack/provenance/run_legacy/forward-plan.json", sourceRefs: [runRef, internalPatchRef] },
    ],
    risks: [{ id: "private-risk", severity: "warning", status: "unresolved", summary: "PRIVACY_SENTINEL risk", nextAction: "PRIVACY_SENTINEL next", sourceRefs: mixed }],
    references: [privateRef, publicAlias, publicRef, internalRef, internalPatchRef],
  };
}
