import { expect, test, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, isRecord } from "./support/mock-state";
import { openEngineeringChannel } from "./support/test-helpers";

const proposalId = "proposal_capability_recovery";
const channelId = "channel_engineering";

function createCapabilityState() {
  const state = createBaseState({ approvalStatus: "expired" });
  state.runs = [];
  state.tasks = [];
  state.approvals = [];
  state.channelMessages = [{
    id: "message_capability_recovery", workspaceId: "workspace_default", channelId,
    kind: "message", intent: "execute", authorType: "local-user", authorId: "local-user",
    body: "Write the requested report once.", mentions: [], attachmentIds: [], linkPreviewIds: [],
    status: "ready", createdAt: "2026-10-29T00:00:00.000Z", updatedAt: "2026-10-29T00:00:00.000Z",
  }];
  state.channelExecutionProposals = [{
    id: proposalId, revision: 1, workspaceId: "workspace_default", channelId,
    sourceMessageId: "message_capability_recovery", proposedByTeammateId: "ling_agent",
    title: "Write the report", prompt: "Write report.txt with the requested content.",
    assigneeTeammateId: "ling_agent", acceptanceCriteria: ["The report contains the requested text."],
    collaborationSteps: [{ teammateId: "ling_agent", action: "coordinated", summary: "Write the report once." }],
    requiredTools: ["write"], status: "draft",
    createdAt: "2026-10-29T00:00:01.000Z", updatedAt: "2026-10-29T00:00:01.000Z",
  }];
  return state;
}

async function useEnglish(page: Page) {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
}

test("missing channel capability blocks Allow until an explicit same-channel settings edit", async ({ page }, testInfo) => {
  await useEnglish(page);
  const state = createCapabilityState();
  const patches: Array<{ channelId: string; body: unknown }> = [];
  const confirmations: string[] = [];
  const runtimeErrors: string[] = [];
  page.on("pageerror", error => runtimeErrors.push(error.message));
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    const channel = /\/channels\/([^/]+)$/.exec(path);
    if (request.method() === "PATCH" && channel) patches.push({ channelId: channel[1], body: request.postDataJSON() });
    if (request.method() === "POST" && path.endsWith(`/channel-proposals/${proposalId}/confirm-workflow`)) confirmations.push(proposalId);
  });
  await mockDaemon(page, state);
  // Keep the server boundary explicit: a client click cannot grant the missing tool.
  await page.route(`**/channel-proposals/${proposalId}/confirm-workflow?**`, async route => {
    const channel = state.channels.find(item => isRecord(item) && item.id === channelId);
    if (!isRecord(channel) || !Array.isArray(channel.allowedTools) || !channel.allowedTools.includes("write")) {
      await route.fulfill({ status: 400, json: { error: "channel_tools_missing", message: "Channel missing tools: write" } });
      return;
    }
    await route.fallback();
  });
  await page.goto("/");
  await openEngineeringChannel(page);
  const gate = page.locator(`[data-channel-execution-proposal-id="${proposalId}"][data-conversation-decision-kind="task_proposal"]`);
  const allow = gate.getByRole("button", { name: "Allow", exact: true });
  await expect(gate).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("initial-gate.png") });
  await writeFile(testInfo.outputPath("initial-gate.json"), JSON.stringify({
    proposalId, channelId, allowDisabled: await allow.isDisabled(), patches, confirmations,
  }, null, 2));
  await expect(allow).toBeDisabled();
  await expect(gate).toContainText("Missing tools");
  await expect(gate).toContainText("write");
  await expect(gate.getByRole("button", { name: "Deny", exact: true })).toBeEnabled();
  await allow.evaluate((button: HTMLButtonElement) => button.click());
  expect(confirmations).toEqual([]);
  expect(patches).toEqual([]);

  await gate.getByRole("button", { name: "Channel settings", exact: true }).click();
  const settings = page.getByRole("region", { name: "Channel settings", exact: true });
  await expect(settings).toBeVisible();
  await expect(page.locator(".channel-settings-top-back")).toBeVisible();
  const general = page.getByRole("tab", { name: "General", exact: true });
  await general.click();
  const write = settings.getByRole("switch", { name: "Use capability in channel: Write files", exact: true });
  await expect(write).toHaveAttribute("aria-checked", "false");
  // Exceed the existing 700 ms autosave debounce without editing anything.
  await page.waitForTimeout(850);
  expect(patches).toEqual([]);
  expect(confirmations).toEqual([]);

  await write.click();
  await expect.poll(() => patches.length).toBe(1);
  await expect.poll(() => {
    const channel = state.channels.find(item => isRecord(item) && item.id === channelId);
    return isRecord(channel) && Array.isArray(channel.allowedTools) && channel.allowedTools.includes("write");
  }).toBe(true);
  expect(patches[0].channelId).toBe(channelId);
  expect(patches[0].body).toMatchObject({ allowedTools: ["read", "grep", "find", "ls", "write"] });
  expect(confirmations).toEqual([]);
  await page.getByRole("button", { name: "Back to channel", exact: true }).click();
  await expect(settings).toHaveCount(0);
  await expect(gate).toBeVisible();
  await expect(allow).toBeEnabled();
  await expect(gate).not.toContainText("Missing tools");
  await expect(gate.getByRole("button", { name: "Channel settings", exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("restored-gate.png") });
  await allow.click();
  await expect.poll(() => confirmations.length).toBe(1);
  await expect.poll(() => {
    const proposal = state.channelExecutionProposals.find(item => isRecord(item) && item.id === proposalId);
    return isRecord(proposal) ? proposal.status : undefined;
  }).toBe("accepted");
  expect(state.channelExecutionProposals).toHaveLength(1);
  expect(state.channelWorkflows).toHaveLength(1);
  expect(patches).toHaveLength(1);
  expect(runtimeErrors).toEqual([]);
  await writeFile(testInfo.outputPath("recovery-evidence.json"), JSON.stringify({
    proposalId, channelId, patches, confirmations, runtimeErrors,
    proposal: state.channelExecutionProposals[0], workflowCount: state.channelWorkflows.length,
  }, null, 2));
});

test("missing channel capability leaves Deny available without modifying channel tools", async ({ page }) => {
  await useEnglish(page);
  const state = createCapabilityState();
  let channelPatches = 0;
  let confirmations = 0;
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "PATCH" && /\/channels\/[^/]+$/.test(path)) channelPatches++;
    if (request.method() === "POST" && path.endsWith("/confirm-workflow")) confirmations++;
  });
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);
  const gate = page.locator('[data-conversation-decision-kind="task_proposal"]');
  await expect(gate.getByRole("button", { name: "Allow", exact: true })).toBeDisabled();
  await gate.getByRole("button", { name: "Deny", exact: true }).click();
  await expect.poll(() => {
    const proposal = state.channelExecutionProposals[0];
    return isRecord(proposal) ? proposal.status : undefined;
  }).toBe("cancelled");
  expect(channelPatches).toBe(0);
  expect(confirmations).toBe(0);
});
