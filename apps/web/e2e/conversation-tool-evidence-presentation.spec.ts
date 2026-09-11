import { expect, test } from "@playwright/test";
import {
  installChannelWorkCellFixture,
  installNormalWorkCellFixture,
  installTeammateWorkCellFixture,
} from "./support/conversation-work-cell-fixture";
import { mockDaemon, type MockExecutionAction } from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";
import { openEngineeringChannel } from "./support/test-helpers";

for (const surface of ["normal", "private", "channel"] as const) {
  test(`${surface} shares compact operation rows and real tool output`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
    const state = createBaseState({ approvalStatus: "expired" });
    const title = surface === "normal" ? installNormalWorkCellFixture(state) : undefined;
    const teammate = surface === "private" ? installTeammateWorkCellFixture(state) : undefined;
    if (surface === "channel") installChannelWorkCellFixture(state, "compact-tool-evidence");
    const original = state.executionActions[0];
    if (!original?.commandEvidence) throw new Error("Fixture must contain a command with Host evidence");
    const commandText = "node --test morning-todo/todo.test.mjs";
    const path = "/workspace/morning-todo/todo.test.mjs";
    const base = { ...original, commandEvidence: undefined, revision: 50 };
    state.executionActions = [
      {
        ...original, id: "compact-command", toolCallId: "compact-command-call",
        summary: commandText,
        commandEvidence: { ...original.commandEvidence, command: commandText, durationMs: 1245, outputTail: [{ ...original.commandEvidence.outputTail[0]!, text: "1 test passed\n" }] },
      },
      {
        ...base, id: "compact-read", toolCallId: "compact-read-call", actionType: "read", title: "read",
        summary: path, status: "failed", targetRefs: [{ type: "file", id: path, path }],
        toolEvidence: { toolName: "read", inputSummary: `${path} · offset 1 · limit 400`, outputText: `ENOENT: no such file or directory\n  ${path}`, outputTruncated: false, latestEventSeq: 50 },
      },
      {
        ...base, id: "compact-ls", toolCallId: "compact-ls-call", actionType: "ls", title: "ls",
        summary: "/workspace/morning-todo", targetRefs: [{ type: "path", id: "/workspace/morning-todo", path: "/workspace/morning-todo" }],
        toolEvidence: { toolName: "ls", inputSummary: "/workspace/morning-todo", outputText: "README.md\ntodo.mjs\n`literal tool content`\n", outputTruncated: true, latestEventSeq: 51 },
      },
      {
        ...base, id: "compact-write", toolCallId: "compact-write-call", actionType: "file_write", title: "File write",
        summary: "Long paths belong in tooltips, not a repeated metadata line",
        targetRefs: ["todo.mjs", "README.md"].map((name) => ({ type: "file", id: `/workspace/morning-todo/${name}`, path: `/workspace/morning-todo/${name}` })),
      },
      {
        ...base, id: "compact-mcp", toolCallId: "compact-mcp-call", actionType: "mcp_tool_call", title: "Lookup docs",
        summary: "Lookup docs", status: "running", targetRefs: [],
        toolEvidence: { toolName: "registered_docs_lookup", inputSummary: "Lookup docs", outputText: "Found parser.ts\n`literal output`\n", outputTruncated: true, latestEventSeq: 50 },
      },
      {
        ...base, id: "compact-tool-empty", toolCallId: "compact-tool-empty-call", actionType: "dynamic_tool_call", title: "Ping service",
        summary: "Ping service", targetRefs: [], toolEvidence: undefined,
      },
      {
        ...base, id: "compact-collab", toolCallId: "compact-collab-call", actionType: "collab_agent_tool_call", title: "Contact participant",
        summary: "Contact participant", status: "failed", targetRefs: [],
        toolEvidence: { toolName: "participant_message", inputSummary: '{"participant":"engineer","body":"`literal input`"}', outputText: "Participant unavailable", outputTruncated: false, latestEventSeq: 50 },
      },
    ] satisfies MockExecutionAction[];
    await mockDaemon(page, state);
    await page.goto("/");
    if (title) await page.getByRole("button", { name: /Open recent conversation \d+/u }).filter({ hasText: title }).click();
    if (teammate) await page.getByRole("button", { name: teammate.displayName, exact: true }).click();
    if (surface === "channel") await openEngineeringChannel(page);

    const command = page.locator('[data-conversation-action-id="compact-command"][data-conversation-timeline-kind="commandExecution"]');
    const commandHead = command.locator(".conversation-timeline-activity-main");
    await expect(commandHead).toContainText(commandText);
    await expect(commandHead).toHaveAttribute("aria-expanded", "false");
    await expect(commandHead).not.toContainText(/exit 0|1\.2s|Succeeded/u);
    await expect(commandHead.locator("strong")).toHaveAttribute("title", commandText);
    await commandHead.click();
    await expect(command.locator(".conversation-timeline-output")).toHaveText("1 test passed\n");
    await expect(command.locator(".conversation-timeline-activity-detail")).not.toContainText(commandText);
    await expect(command.getByText("1.2s", { exact: true })).toHaveCount(1);
    await expect(command.locator(".conversation-timeline-activity-detail")).not.toContainText("exit 0");
    await commandHead.click();

    const read = page.locator('[data-conversation-action-id="compact-read"][data-conversation-timeline-kind="exploration"]');
    const readHead = read.locator(".conversation-timeline-activity-main");
    await expect(readHead).toContainText("Read todo.test.mjs");
    await expect(readHead).toContainText("Failed");
    await expect(readHead).toHaveAttribute("aria-expanded", "true");
    await expect(readHead.locator("strong")).toHaveAttribute("title", `${path} · offset 1 · limit 400`);
    await expect(read.locator(".conversation-timeline-output")).toHaveText(`ENOENT: no such file or directory\n  ${path}`);
    await expect(read).not.toContainText("read tool call");
    await expect(read.locator(".conversation-timeline-rich-detail")).toHaveCount(0);

    const list = page.locator('[data-conversation-action-id="compact-ls"][data-conversation-timeline-kind="exploration"]');
    const listHead = list.locator(".conversation-timeline-activity-main");
    await expect(listHead).toContainText("List morning-todo");
    await expect(listHead).toHaveAttribute("aria-expanded", "false");
    await listHead.click();
    await expect(list.locator("pre")).toHaveText("README.md\ntodo.mjs\n`literal tool content`\n");
    await expect(list.locator("pre code, pre a")).toHaveCount(0);
    await expect(list).toContainText("Output truncated");

    const write = page.locator('[data-conversation-action-id="compact-write"][data-conversation-timeline-kind="fileChange"]');
    const writeHead = write.locator(".conversation-timeline-activity-main");
    await expect(writeHead).toContainText("Edited 2 files");
    await expect(writeHead).not.toContainText("/workspace");
    await expect(writeHead.locator("strong")).toHaveAttribute("title", "/workspace/morning-todo/todo.mjs\n/workspace/morning-todo/README.md");
    await writeHead.click();
    await expect(write.getByText("todo.mjs", { exact: true })).toHaveCount(1);
    await expect(write.getByText("README.md", { exact: true })).toHaveCount(1);

    const mcp = page.locator('[data-conversation-action-id="compact-mcp"][data-conversation-timeline-kind="mcpToolCall"]');
    await expect(mcp.locator(".conversation-timeline-activity-main strong")).toHaveText("Lookup docs");
    await expect(mcp.locator(".conversation-timeline-activity-main")).toHaveAttribute("aria-expanded", "true");
    await expect(mcp.locator(".conversation-timeline-output")).toHaveText("Found parser.ts\n`literal output`\n");
    await expect(mcp.locator("pre code, pre a")).toHaveCount(0);
    await expect(mcp.locator(".conversation-timeline-activity-detail")).not.toContainText("Lookup docs");
    await expect(mcp).toContainText("Output truncated");

    const emptyTool = page.locator('[data-conversation-action-id="compact-tool-empty"][data-conversation-timeline-kind="dynamicToolCall"]');
    await expect(emptyTool.locator(".conversation-timeline-activity-main")).not.toHaveAttribute("aria-expanded");
    await expect(emptyTool.getByRole("button")).toHaveCount(0);
    await expect(emptyTool).not.toContainText("No additional detail");

    const collab = page.locator('[data-conversation-action-id="compact-collab"][data-conversation-timeline-kind="collabAgentToolCall"]');
    if (surface === "private") {
      // A shared renderer does not grant collaboration rights to a private DM.
      await expect(collab).toHaveCount(0);
      await expect(page.locator('[data-conversation-diagnostic-code="scope_mismatch"]')).toContainText("Blocked");
      await expect(page.getByText("Participant unavailable", { exact: true })).toHaveCount(0);
    } else {
      await expect(collab.locator(".conversation-timeline-activity-main")).toContainText("Failed");
      await expect(collab.locator(".conversation-timeline-tool-input")).toHaveText('{"participant":"engineer","body":"`literal input`"}');
      await expect(collab.locator(".conversation-timeline-output")).toHaveText("Participant unavailable");
      await expect(collab.locator("pre code, pre a")).toHaveCount(0);
    }
    await page.screenshot({ path: testInfo.outputPath(`${surface}-compact-tool-evidence.png`), fullPage: true });
  });
}

test("shared command rows keep timeout and cancellation explicit", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  const state = createBaseState({ approvalStatus: "expired" });
  const title = installNormalWorkCellFixture(state);
  const original = state.executionActions[0];
  if (!original?.commandEvidence) throw new Error("Fixture must include Host command evidence");
  state.executionActions = [
    { ...original, id: "timed-out-command", status: "failed", commandEvidence: { ...original.commandEvidence, exitCode: 124, timedOut: true } },
    { ...original, id: "cancelled-command", status: "cancelled", commandEvidence: { ...original.commandEvidence, exitCode: undefined, cancelled: true } },
  ];
  await mockDaemon(page, state);
  await page.goto("/");
  await page.getByRole("button", { name: /Open recent conversation \d+/u }).filter({ hasText: title }).click();
  for (const [id, label] of [["timed-out-command", "Timed out"], ["cancelled-command", "Cancelled"]]) {
    const row = page.locator(`[data-conversation-action-id="${id}"][data-conversation-timeline-kind="commandExecution"]`);
    await expect(row.locator(".conversation-timeline-activity-main")).toContainText(label!);
    await expect(row.locator(".conversation-timeline-activity-main")).toHaveAttribute("aria-expanded", "true");
  }
});

for (const surface of ["normal", "private", "channel"] as const) {
  test(`${surface} renders execution-loop evidence through the shared diagnostic renderer`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
    const state = createBaseState({ approvalStatus: "expired" });
    const title = surface === "normal" ? installNormalWorkCellFixture(state) : undefined;
    const teammate = surface === "private" ? installTeammateWorkCellFixture(state) : undefined;
    if (surface === "channel") installChannelWorkCellFixture(state, "execution-loop-diagnostic");
    const anchorAction = state.executionActions[0];
    if (!anchorAction) throw new Error("Diagnostic fixture requires an anchored execution action");
    const fingerprint = "a".repeat(64);
    state.executionActions = [{
      ...anchorAction,
      id: `runtime-loop-${surface}`,
      revision: 75,
      sourceEventSequence: 75,
      toolCallId: undefined,
      actionType: "runtime_diagnostic",
      status: "failed",
      title: "execution_loop_detected",
      summary: "Execution stopped after the same action and result repeated 3 times.",
      targetRefs: [],
      commandEvidence: undefined,
      toolEvidence: undefined,
      runtimeDiagnostic: {
        code: "execution_loop_detected",
        loopKind: "exact_repeat",
        repeatedCount: 3,
        noProgressActionCount: 12,
        cycleLength: 1,
        fingerprint,
        retryable: false,
      },
    } satisfies MockExecutionAction];
    state.terminalReports = [];
    state.conversationItems = state.conversationItems?.filter((item) => item.kind !== "terminal_report");

    await mockDaemon(page, state);
    await page.goto("/");
    if (title) await page.getByRole("button", { name: /Open recent conversation \d+/u }).filter({ hasText: title }).click();
    if (teammate) await page.getByRole("button", { name: teammate.displayName, exact: true }).click();
    if (surface === "channel") await openEngineeringChannel(page);

    const diagnostic = page.locator(`[data-conversation-action-id="runtime-loop-${surface}"][data-conversation-timeline-kind="diagnostic"]`);
    await expect(diagnostic).toHaveCount(1);
    await expect(diagnostic).toHaveAttribute("data-conversation-timeline-renderer-key", "diagnostic.blocked");
    await expect(diagnostic).toHaveAttribute("data-conversation-diagnostic-code", "execution_loop_detected");
    const disclosure = diagnostic.locator(".conversation-timeline-activity-main");
    await expect(disclosure.locator("strong")).toHaveText("Repeated execution stopped");
    await expect(disclosure).toContainText("No new evidence");
    await expect(disclosure).not.toContainText("execution_loop_detected");
    await expect(disclosure.locator("svg.lucide-circle-alert")).toBeVisible();
    await expect(disclosure).toHaveAttribute("aria-expanded", "true");
    await expect(disclosure).toHaveAttribute("aria-controls", /conversation-timeline-detail/u);
    const detail = diagnostic.locator(".conversation-timeline-diagnostic-detail");
    await expect(detail).toBeVisible();
    await expect(detail).toContainText("The run was stopped because repeated activity produced no new evidence.");
    await expect(detail).toContainText("Same action and result repeated");
    await expect(detail).toContainText("Actions without new evidence");
    await expect(detail).toContainText("12");
    await expect(detail).not.toContainText(fingerprint);
    await disclosure.click();
    await expect(disclosure).toHaveAttribute("aria-expanded", "false");
    await expect(detail).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`${surface}-execution-loop-diagnostic.png`), fullPage: true });
  });
}
