import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon, handleDaemonRoute, cwd } from "./support/mock-daemon";
import { createBaseState, createChatProvider, createMockTeammate } from "./support/mock-state";
import { createApproval } from "./support/approvals-fixture";
import { mergeApprovalSnapshot, mergeApprovalsForRun, upsertApproval } from "../src/lib/approvals";
import { buildInlineApprovalViews } from "../src/lib/inline-approvals";

const evidenceDir = process.env.LING_P2_APPROVAL_EVIDENCE_DIR
  ?? fileURLToPath(new URL("../../../.ling-stack/acceptance/p2-ux2-decisions-reload-20261015/", import.meta.url));

for (const transport of ["stale-snapshot", "lost-response", "empty-response"] as const) {
for (const theme of ["light", "dark"] as const) {
for (const decision of ["approve_once", "deny", "approve_command_rule"] as const) {
for (const surface of ["channel", "normal_conversation", "teammate_direct"] as const) {
test(`${transport} recovery preserves ${surface} ${decision} in ${theme}`, async ({ page }) => {
  await page.setViewportSize(theme === "light" ? { width: 1440, height: 960 } : { width: 1280, height: 800 });
  await page.addInitScript(theme => {
    localStorage.setItem("ling-stack.locale", "en-US");
    const selection = JSON.stringify({ themeId: `ling-${theme}`, mode: "fixed" });
    localStorage.setItem("ling-stack.themeSelection", selection);
    localStorage.setItem("ling-stack.themeBootstrapSelection", selection);
  }, theme);
  const state = createBaseState({ approvalStatus: "pending" });
  state.providers = [createChatProvider({ lastCheck: { ok: true, code: "ready", message: "Controlled fixture", checkedAt: "2026-10-15T00:00:00.000Z" } })];
  state.workspaceSettings.defaultProviderPresetId = state.providers[0].id;
  const targetName = installDecisionSurface(state, surface);
  const approval = createApproval({ id: "p2-late-pending", runId: state.runs[0].id,
    channelId: surface === "channel" ? state.channels[0].id : undefined, actionType: "bash", risk: "medium", title: "Controlled terminal approval",
    payload: { type: "bash", command: "whois example.com" },
    availableDecisions: ["approve_once", "approve_command_rule", "deny"],
    proposedCommandRule: { version: 1, prefix: ["whois"], display: "whois", fingerprint: "controlled-whois-prefix" } });
  state.approvals = [approval];
  state.loseNextApprovalDecisionResponse = transport === "lost-response";
  state.emptyNextApprovalDecisionResponse = transport === "empty-response";
  const stale = structuredClone(approval);
  await mockDaemon(page, state);
  let staleReads = 0;
  let receiptReads = 0;
  await page.route(url => url.pathname === `/approvals/${approval.id}`, async route => {
    receiptReads++;
    expect(new URL(route.request().url()).searchParams.get("cwd")).toBe(cwd);
    expect(route.request().method()).toBe("GET");
    await route.fallback();
  });
  await page.route(url => url.pathname === "/approvals", async route => {
    if (approval.status === "pending") return route.fallback();
    staleReads++;
    await route.fulfill({ json: { cwd, approvals: [stale] } });
  });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" && !(transport === "lost-response" && /net::ERR_CONNECTION_CLOSED/u.test(message.text()))) errors.push(message.text());
  });
  await page.goto("/");
  const navigation = page.getByRole("complementary", { name: /Sidebar display/ });
  await (surface === "normal_conversation" ? navigation.getByRole("button").filter({ hasText: targetName })
    : navigation.getByRole("button", { name: targetName, exact: true })).first().click();
  const gate = page.getByRole("region", { name: "Allow this action?", exact: true });
  await expect(gate).toHaveCount(1);
  await expect(gate).toHaveAttribute("data-surface", surface);
  await expect(page.getByRole("dialog", { name: "Allow this action?", exact: true })).toHaveCount(0);
  await mkdir(evidenceDir, { recursive: true });
  if (decision === "approve_command_rule") {
    await gate.getByRole("button", { name: "Allow options", exact: true }).focus();
    await page.keyboard.press("ArrowDown");
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem", { name: "Allow once", exact: true })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("menuitem", { name: /Allow similar commands/ })).toBeFocused();
    await page.screenshot({ path: `${evidenceDir}${surface}-${transport}-rule-menu-${theme}.png`, animations: "disabled" });
    await page.keyboard.press("Enter");
  } else {
    await page.screenshot({ path: `${evidenceDir}${surface}-${transport}-${decision}-pending-${theme}.png`, animations: "disabled" });
    await gate.getByRole("button", { name: decision === "deny" ? "Deny" : "Allow once", exact: true }).click();
  }
  await expect.poll(() => approval.status).toBe(decision === "deny" ? "denied" : "approved");
  await expect.poll(() => staleReads).toBeGreaterThan(0);
  try {
    await expect(gate).toHaveCount(0);
  } catch (error) {
    await mkdir(evidenceDir, { recursive: true });
    await page.screenshot({ path: `${evidenceDir}${surface}-${transport}-${decision}-red-${theme}.png`, animations: "disabled" });
    throw error;
  }
  await expect(page.getByLabel(surface === "channel" ? "Channel composer"
    : surface === "normal_conversation" ? "New conversation composer" : "Private chat composer", { exact: true })).toBeVisible();
  expect(state.approvalDecisionRequests).toHaveLength(1);
  expect(receiptReads).toBe(transport === "stale-snapshot" ? 0 : 1);
  expect(state.approvalDecisionRequests[0].action).toBe(decision === "deny" ? "deny" : "approve");
  if (decision !== "deny") expect(state.approvalDecisionRequests[0].body.decisionKind).toBe(decision);
  expect(state.approvalCommandRules).toHaveLength(decision === "approve_command_rule" ? 1 : 0);
  if (decision === "approve_command_rule") expect(state.approvalCommandRules[0].prefix).toEqual(["whois"]);
  await expect(page.locator("body")).toHaveCSS("background-color", theme === "dark" ? "rgb(31, 31, 31)" : "rgb(255, 255, 255)");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  await mkdir(evidenceDir, { recursive: true });
  await page.screenshot({ path: `${evidenceDir}${surface}-${transport}-${decision}-fixed-${theme}.png`, animations: "disabled" });
});
}
}
}
}

function installDecisionSurface(state: ReturnType<typeof createBaseState>, surface: "channel" | "normal_conversation" | "teammate_direct"): string {
  if (surface === "channel") return "Engineering";
  const teammateId = "p2-decision-teammate";
  const threadId = surface === "normal_conversation" ? "p2-decision-thread" : `tdthread_${teammateId}`;
  const timestamp = "2026-10-15T00:00:00.000Z";
  const run = state.runs[0];
  Object.assign(run, { channelId: undefined, workUnitId: undefined, threadId, turnId: "p2-decision-turn",
    teammateId: surface === "teammate_direct" ? teammateId : undefined, errorMessage: undefined, endedAt: undefined });
  state.tasks = [];
  if (surface === "normal_conversation") {
    state.threads = [{ id: threadId, workspaceId: "workspace_default", kind: "conversation", title: "Decision Conversation",
      objective: "Controlled approval recovery", status: "running", activeRunId: run.id, lastRunId: run.id,
      createdAt: timestamp, updatedAt: timestamp }];
    state.turns = [{ id: run.turnId!, threadId, workspaceId: "workspace_default", kind: "initial_request", status: "running",
      title: "Decision Conversation", userInstruction: "Controlled approval recovery", lastRunId: run.id,
      createdByActor: "local-user", createdAt: timestamp, updatedAt: timestamp }];
    state.turnRunLinks = [{ turnId: run.turnId!, runId: run.id, attemptNumber: 1, role: "primary", createdAt: timestamp }];
    return "Decision Conversation";
  }
  state.aiTeammates = [createMockTeammate({ id: teammateId, displayName: "Decision Teammate", providerPresetId: state.providers[0].id })];
  state.teammateDirectMessages = [{ id: "p2-decision-reply", teammateId, threadId, workspaceId: "workspace_default",
    authorType: "ai-teammate", authorId: teammateId, linkedRunId: run.id, status: "blocked",
    body: "Partial output remains while awaiting approval.", attachmentIds: [], linkPreviewIds: [], fileRefs: [],
    createdAt: timestamp, updatedAt: timestamp }];
  return "Decision Teammate";
}

for (const theme of ["light", "dark"] as const) {
for (const surface of ["channel", "normal_conversation", "teammate_direct"] as const) {
test(`reload restores the original ${surface} decision and menu keyboard focus in ${theme}`, async ({ page }) => {
  await page.setViewportSize(theme === "light" ? { width: 1440, height: 960 } : { width: 1280, height: 800 });
  await page.addInitScript(theme => {
    localStorage.setItem("ling-stack.locale", "en-US");
    const selection = JSON.stringify({ themeId: `ling-${theme}`, mode: "fixed" });
    localStorage.setItem("ling-stack.themeSelection", selection);
    localStorage.setItem("ling-stack.themeBootstrapSelection", selection);
  }, theme);
  const state = createBaseState({ approvalStatus: "pending" });
  state.providers = [createChatProvider({ lastCheck: { ok: true, code: "ready", message: "Controlled fixture", checkedAt: "2026-10-15T00:00:00.000Z" } })];
  state.workspaceSettings.defaultProviderPresetId = state.providers[0].id;
  const targetName = installDecisionSurface(state, surface);
  const approval = createApproval({ id: "p2-reload-decision", runId: state.runs[0].id,
    channelId: surface === "channel" ? state.channels[0].id : undefined, actionType: "bash", risk: "medium",
    payload: { type: "bash", command: "whois example.com" },
    availableDecisions: ["approve_once", "approve_command_rule", "deny"],
    proposedCommandRule: { version: 1, prefix: ["whois"], display: "whois", fingerprint: "controlled-whois-prefix" } });
  state.approvals = [approval];
  state.loseNextApprovalDecisionResponse = true;
  const stale = structuredClone(approval);
  await mockDaemon(page, state);
  let receiptAvailable = false;
  let receiptReads = 0;
  if (surface === "teammate_direct") {
    await page.route(url => /^\/teammates\/p2-decision-teammate\/direct-(runtime|messages|thread)$/.test(url.pathname), route =>
      handleDaemonRoute(route, receiptAvailable ? state : { ...state, approvals: [stale] }));
  } else if (surface === "normal_conversation") {
    await page.route(url => url.pathname === "/conversations/p2-decision-thread", route =>
      handleDaemonRoute(route, receiptAvailable ? state : { ...state, approvals: [stale] }));
  }
  await page.route(url => url.pathname === `/approvals/${approval.id}`, route => {
    receiptReads++;
    expect(route.request().method()).toBe("GET");
    return receiptAvailable ? route.fallback() : route.fulfill({ status: 503, json: { error: "receipt_unavailable" } });
  });
  await page.route(url => url.pathname === "/approvals", route => route.fulfill({ json: { cwd, approvals: [stale] } }));
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" && !/net::ERR_CONNECTION_CLOSED|503 \(Service Unavailable\)/u.test(message.text())) errors.push(message.text());
  });
  async function selectSurface() {
    const navigation = page.getByRole("complementary", { name: /Sidebar display/ });
    await (surface === "normal_conversation" ? navigation.getByRole("button").filter({ hasText: targetName })
      : navigation.getByRole("button", { name: targetName, exact: true })).first().click();
  }
  await page.goto("/");
  await selectSurface();
  const gate = page.getByRole("region", { name: "Allow this action?", exact: true });
  await expect(gate).toHaveCount(1);
  const trigger = gate.getByRole("button", { name: "Allow options", exact: true });
  await trigger.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "Allow once", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await gate.getByRole("button", { name: "Allow once", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => state.approvalDecisionRequests.length).toBe(1);
  await expect(gate.getByRole("alert")).not.toBeEmpty();
  await mkdir(evidenceDir, { recursive: true });
  await page.screenshot({ path: `${evidenceDir}${surface}-reload-unconfirmed-${theme}.png`, animations: "disabled" });
  await page.reload();
  await selectSurface();
  await expect(gate.getByRole("alert")).not.toBeEmpty();
  expect(state.approvalDecisionRequests).toHaveLength(1);
  await page.screenshot({ path: `${evidenceDir}${surface}-reload-still-unconfirmed-${theme}.png`, animations: "disabled" });
  receiptAvailable = true;
  await page.reload();
  await selectSurface();
  await expect(gate).toHaveCount(0);
  await expect(page.getByLabel(surface === "channel" ? "Channel composer"
    : surface === "normal_conversation" ? "New conversation composer" : "Private chat composer", { exact: true })).toBeVisible();
  expect(state.approvalDecisionRequests).toHaveLength(1);
  expect(state.approvalCommandRules).toHaveLength(0);
  expect(receiptReads).toBe(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  await page.screenshot({ path: `${evidenceDir}${surface}-reload-recovered-${theme}.png`, animations: "disabled" });
});
}
}

for (const status of ["approved", "denied", "expired", "cancelled"] as const) {
test(`observed ${status} approval cannot be reopened by a list or item update`, () => {
  const pending = createApproval({ runId: "original-run" });
  const terminal = { ...pending, status, resolvedAt: "2026-10-15T00:00:01.000Z" };
  expect(mergeApprovalSnapshot([terminal], [pending])).toEqual([terminal]);
  expect(mergeApprovalsForRun([terminal], [pending], "original-run")).toEqual([terminal]);
  expect(upsertApproval([terminal], pending)).toEqual([terminal]);
  const fresh = { ...pending, id: "next-attempt-approval" };
  expect(mergeApprovalSnapshot([terminal], [pending, fresh])).toEqual([terminal, fresh]);
  expect(mergeApprovalSnapshot([terminal], [])).toEqual([]);
});
}

for (const surface of ["channel", "normal_conversation", "teammate_direct"] as const) {
test(`${surface} inline decision deduplication preserves terminal facts in either arrival order`, () => {
  const run = { ...createBaseState({ approvalStatus: "pending" }).runs[0], id: "original-run", channelId: surface === "channel" ? "channel" : undefined,
    workUnitId: undefined, threadId: "thread", teammateId: surface === "teammate_direct" ? "teammate" : undefined };
  const pending = createApproval({ runId: run.id, actionType: "bash" });
  const terminal = { ...pending, status: "cancelled" as const };
  const context = { owner: surface === "channel" ? { kind: surface, channelId: "channel" }
    : { kind: surface, threadId: "thread", teammateId: "teammate" }, runs: [run],
    teammateDirectMessages: [{ id: "reply", linkedRunId: run.id, threadId: "thread", teammateId: "teammate" }] };
  expect(buildInlineApprovalViews([pending], context)).toHaveLength(1);
  expect(buildInlineApprovalViews([pending, terminal], context)).toEqual([]);
  expect(buildInlineApprovalViews([terminal, pending], context)).toEqual([]);
});
}

test("pending updates and resolved audit detail still refresh without retaining removed snapshot rows", () => {
  const pending = createApproval({ runId: "run-one" });
  const changed = { ...pending, description: "Current pending description" };
  expect(mergeApprovalSnapshot([pending], [changed])).toEqual([changed]);
  const approved = { ...pending, status: "approved" as const };
  const audited = { ...approved, decisionReason: "Durable decision reason" };
  expect(mergeApprovalSnapshot([approved], [audited])).toEqual([audited]);
  const unrelated = createApproval({ id: "unrelated", runId: "run-two" });
  expect(mergeApprovalsForRun([pending, unrelated], [], "run-one")).toEqual([unrelated]);
});
