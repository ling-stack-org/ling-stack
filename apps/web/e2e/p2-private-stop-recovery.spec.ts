import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { cwd, mockDaemon } from "./support/mock-daemon";
import { createBaseState, createChatProvider, createMockTeammate } from "./support/mock-state";
import { triggerFocusRevalidation } from "./support/focus-revalidation";

const evidenceDir = process.env.LING_P2_EVIDENCE_DIR ?? fileURLToPath(new URL("../../../.ling-stack/acceptance/p2-ux2-private-stop-20261015/", import.meta.url));
const teammateId = "stop-teammate";
const workUnitId = "private-stop-work";
const now = "2026-10-15T00:00:00.000Z";

async function openPrivateReply(page: Page, loseResponse = false) {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  if (loseResponse) {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.addInitScript(() => {
      const selection = JSON.stringify({ themeId: "ling-dark", mode: "fixed" });
      localStorage.setItem("ling-stack.themeSelection", selection);
      localStorage.setItem("ling-stack.themeBootstrapSelection", selection);
      localStorage.setItem("ling-stack.themePreference", "dark");
      localStorage.setItem("ling-stack.themeBootstrapPreference", "dark");
    });
  }
  if (loseResponse) await page.addInitScript(() => {
    const fetch = window.fetch;
    window.fetch = async (...args) => {
      const response = await fetch(...args);
      if (response.ok && args[1]?.method === "POST" && /\/teammate-direct-replies\/[^/]+\/cancel$/.test(new URL(String(args[0]), location.href).pathname)) {
        await response.text();
        throw new TypeError("Controlled private stop response loss");
      }
      return response;
    };
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({ id: "stop-provider", lastCheck: { ok: true, code: "ready", message: "Controlled stop fixture", checkedAt: now } })];
  state.workspaceSettings.defaultProviderPresetId = state.providers[0].id;
  state.aiTeammates = [createMockTeammate({ id: teammateId, displayName: "Stop Teammate", providerPresetId: state.providers[0].id }),
    createMockTeammate({ id: "other-stop-teammate", displayName: "Other Teammate", providerPresetId: state.providers[0].id })];
  state.runs = []; state.tasks = []; state.approvals = []; state.threads = []; state.turns = [];
  state.channelMessages = []; state.teammateDirectInterventions = [];
  state.teammateDirectMessages = [{ id: "private-stop-reply", teammateId, threadId: `tdthread_${teammateId}`,
    workspaceId: "workspace_default", authorType: "ai-teammate", authorId: teammateId,
    attachmentIds: [], linkPreviewIds: [], fileRefs: [],
    body: "Keep this private partial output.", status: "pending", createdAt: now, updatedAt: now }];
  state.workUnits = [{ id: workUnitId, workspaceId: "workspace_default", kind: "teammate_direct_reply",
    ownerType: "teammate", ownerId: teammateId, teammateId, idempotencyKey: workUnitId,
    status: "running", priority: 50, attemptCount: 1, activeAttemptId: "private-stop-attempt", createdByActor: "user",
    request: { sourceMessageId: "private-stop-source" }, timeoutPolicy: { staleAfterMs: 120000, timeoutAfterMs: 300000 },
    linkedMessageId: "private-stop-reply", createdAt: now, updatedAt: now, startedAt: now }];
  await mockDaemon(page, state);
  let posts = 0, reads = 0;
  await page.route(url => url.pathname === `/work-units/${workUnitId}`, async route => { reads++; await route.fallback(); });
  await page.route(url => url.pathname === `/teammate-direct-replies/${workUnitId}/cancel`, route => {
    posts++;
    expect(route.request().postDataJSON()).toEqual({ reason: "user_requested",
      expectedAttemptId: state.workUnits[0].activeAttemptId ?? null, expectedRunId: state.workUnits[0].linkedRunId ?? null });
    state.workUnits = state.workUnits.map(unit => ({ ...unit, status: "cancelling" }));
    return route.fulfill({ json: { cwd, workUnit: state.workUnits[0] } });
  });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" && !/^Failed to load resource: the server responded with a status of (403|503)\b/.test(message.text())) errors.push(message.text());
  });
  await page.goto("/");
  await page.getByRole("complementary", { name: /Sidebar display/ }).getByRole("button", { name: "Stop Teammate", exact: true }).click();
  const composer = page.getByLabel("Private chat composer", { exact: true });
  await expect(composer.getByRole("button", { name: "Stop reply", exact: true })).toBeVisible();
  await expect(page.getByText("Keep this private partial output.", { exact: true })).toBeVisible();
  await expect(page.locator("body")).toHaveCSS("background-color", loseResponse ? "rgb(31, 31, 31)" : "rgb(255, 255, 255)");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  return { state, composer, errors, counts: () => ({ posts, reads }) };
}

test("private stop keeps partial output and uncertainty until captured Host evidence agrees", async ({ page }) => {
  const f = await openPrivateReply(page, true);
  const attempt = f.state.workUnitAttemptsByWorkUnit[workUnitId][0];
  attempt.fencingToken = "9";
  const proof = { attemptId: attempt.id, runtimeInstanceId: attempt.runtimeInstanceId, fencingToken: "9",
    localExecution: "draining" as const, effects: "settled" as const };
  f.state.workUnitStopEvidenceByWorkUnit = { [workUnitId]: { schemaVersion: 1, workUnitId, attempts: [proof] } };
  await f.composer.getByRole("button", { name: "Stop reply", exact: true }).click();
  await expect.poll(() => f.counts().posts).toBe(1);
  f.state.workUnits = f.state.workUnits.map(unit => ({ ...unit, status: "cancelled" }));
  f.state.workUnitAttemptsByWorkUnit[workUnitId] = [{ ...attempt, status: "cancelled" }];
  f.state.teammateDirectMessages = f.state.teammateDirectMessages.map(message => ({ ...message, status: "cancelled" }));
  let reads = f.counts().reads;
  await expect.poll(() => f.counts().reads).toBeGreaterThan(reads);
  await expect(f.composer.getByRole("button", { name: "Stopping", exact: true })).toBeDisabled();
  f.state.workUnitStopEvidenceByWorkUnit[workUnitId] = { schemaVersion: 1, workUnitId,
    attempts: [{ ...proof, localExecution: "drained", effects: "unknown" }] };
  reads = f.counts().reads;
  await expect.poll(() => f.counts().reads).toBeGreaterThan(reads);
  await expect(f.composer.getByRole("button", { name: "Stopping", exact: true })).toBeDisabled();
  await expect(page.getByText("Keep this private partial output.", { exact: true })).toBeVisible();
  await mkdir(evidenceDir, { recursive: true });
  await page.screenshot({ path: `${evidenceDir}private-logical-cancel-host-unknown-dark.png`, animations: "disabled" });
  f.state.workUnitStopEvidenceByWorkUnit[workUnitId] = { schemaVersion: 1, workUnitId,
    attempts: [{ ...proof, localExecution: "drained" }] };
  await expect(f.composer.getByRole("button", { name: "Stopping", exact: true })).toHaveCount(0);
  await expect(f.composer.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  expect(f.counts().posts).toBe(1);
  expect(f.errors).toEqual([]);
});

for (const loseResponse of [false, true]) test(`private stop ${loseResponse ? "lost receipt" : "accepted request"} waits for terminal execution and owned-resource release`, async ({ page }) => {
  const f = await openPrivateReply(page, loseResponse);
  await f.composer.getByRole("button", { name: "Stop reply", exact: true }).click();
  await expect.poll(() => f.counts().posts).toBe(1);
  await expect(f.composer.getByRole("button", { name: "Stopping", exact: true })).toBeDisabled();
  await expect(page.getByText("Keep this private partial output.", { exact: true })).toBeVisible();
  await mkdir(evidenceDir, { recursive: true });
  await page.screenshot({ path: `${evidenceDir}private-stop-${loseResponse ? "lost-response" : "pending"}.png`, animations: "disabled" });
  f.state.workUnits = f.state.workUnits.map(unit => ({ ...unit, status: "cancelled" }));
  f.state.workUnitAttemptsByWorkUnit[workUnitId] = f.state.workUnitAttemptsByWorkUnit[workUnitId].map(attempt => ({ ...attempt, status: "cancelled" }));
  f.state.resourceLeases = [{ id: "private-owned-stop-lease", workspaceId: "workspace_default", resourceType: "workspace",
    resourceKey: cwd, ownerType: "work_unit_attempt", ownerId: "private-stop-attempt", workUnitId,
    status: "active", acquiredAt: now, expiresAt: "2099-01-01T00:00:00.000Z" }];
  const previousReads = f.counts().reads;
  await expect.poll(() => f.counts().reads).toBeGreaterThan(previousReads);
  await expect(f.composer.getByRole("button", { name: "Stopping", exact: true })).toBeDisabled();
  f.state.resourceLeases = [];
  f.state.teammateDirectMessages = f.state.teammateDirectMessages.map(message => ({ ...message, status: "cancelled" }));
  await expect(f.composer.getByRole("button", { name: "Stopping", exact: true })).toHaveCount(0);
  await expect(f.composer.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  await expect(page.getByText("Keep this private partial output.", { exact: true })).toBeVisible();
  expect(f.counts().posts).toBe(1);
  await page.screenshot({ path: `${evidenceDir}private-stop-confirmed-${loseResponse ? "lost-response" : "acknowledged"}.png`, animations: "disabled" });
  expect(f.errors).toEqual([]);
});

test("a rejected stale private stop leaves its successor running and removes only the old stopping state", async ({ page }) => {
  const f = await openPrivateReply(page);
  let posts = 0;
  await page.route(url => url.pathname === `/teammate-direct-replies/${workUnitId}/cancel`, route => {
    posts++;
    expect(route.request().postDataJSON()).toEqual({ reason: "user_requested",
      expectedAttemptId: "private-stop-attempt", expectedRunId: null });
    const attempts = f.state.workUnitAttemptsByWorkUnit[workUnitId];
    f.state.workUnits = f.state.workUnits.map(unit => ({ ...unit, activeAttemptId: "private-successor", attemptCount: 2 }));
    f.state.workUnitAttemptsByWorkUnit[workUnitId] = [
      { ...attempts[0], status: "lost" },
      { ...attempts[0], id: "private-successor", attemptNumber: 2, status: "started" },
    ];
    return route.fulfill({ status: 409, json: { error: "stale_cancellation", message: "The original execution has been replaced." } });
  });
  await f.composer.getByRole("button", { name: "Stop reply", exact: true }).click();
  await expect.poll(() => posts).toBe(1);
  await expect(f.composer.getByRole("button", { name: "Stopping", exact: true })).toHaveCount(0);
  await expect(f.composer.getByRole("button", { name: "Stop reply", exact: true })).toBeEnabled();
  await expect(page.getByText("Keep this private partial output.", { exact: true })).toBeVisible();
  expect(f.state.workUnits[0].status).toBe("running");
  expect(f.state.workUnits[0].activeAttemptId).toBe("private-successor");
  await mkdir(evidenceDir, { recursive: true });
  await page.screenshot({ path: `${evidenceDir}private-stale-stop-successor-running.png`, animations: "disabled" });
  expect(f.errors.filter(message => !/^Failed to load resource: the server responded with a status of 409\b/.test(message))).toEqual([]);
});

test("private stop denial remains actionable and retries only after another user click", async ({ page }) => {
  const f = await openPrivateReply(page);
  let denied = 0;
  let reject = true;
  await page.route(url => url.pathname === `/teammate-direct-replies/${workUnitId}/cancel`, route => {
    if (!reject) return route.fallback();
    denied++;
    return route.fulfill({ status: 403, json: { message: "Controlled stop permission denial" } });
  });
  await f.composer.getByRole("button", { name: "Stop reply", exact: true }).click();
  await expect(page.getByText("Controlled stop permission denial", { exact: true })).toBeVisible();
  await expect(f.composer.getByRole("button", { name: "Stop reply", exact: true })).toBeEnabled();
  await page.waitForTimeout(900);
  expect(denied).toBe(1);
  expect(f.counts().posts).toBe(0);
  reject = false;
  await f.composer.getByRole("button", { name: "Stop reply", exact: true }).click();
  await expect.poll(() => f.counts().posts).toBe(1);
  await expect(f.composer.getByRole("button", { name: "Stopping", exact: true })).toBeDisabled();
  f.state.workUnits = f.state.workUnits.map(unit => ({ ...unit, status: "cancelled" }));
  f.state.workUnitAttemptsByWorkUnit[workUnitId] = f.state.workUnitAttemptsByWorkUnit[workUnitId].map(attempt => ({ ...attempt, status: "cancelled" }));
  f.state.teammateDirectMessages = f.state.teammateDirectMessages.map(message => ({ ...message, status: "cancelled" }));
  await expect(f.composer.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  expect(f.errors).toEqual([]);
});

test("private stop keeps pending across a failed receipt read without repeating cancellation", async ({ page }) => {
  const f = await openPrivateReply(page);
  let failures = 0;
  await page.route(url => url.pathname === `/work-units/${workUnitId}`, route => {
    if (f.counts().posts > 0 && failures++ < 2) return route.fulfill({ status: 503, json: { message: "Controlled stop lookup unavailable" } });
    return route.fallback();
  });
  await f.composer.getByRole("button", { name: "Stop reply", exact: true }).click();
  await expect(page.getByText("Controlled stop lookup unavailable", { exact: true })).toBeVisible();
  await expect(f.composer.getByRole("button", { name: "Stopping", exact: true })).toBeDisabled();
  await expect.poll(() => failures).toBeGreaterThan(2);
  expect(f.counts().posts).toBe(1);
  f.state.workUnits = f.state.workUnits.map(unit => ({ ...unit, status: "cancelled" }));
  f.state.workUnitAttemptsByWorkUnit[workUnitId] = f.state.workUnitAttemptsByWorkUnit[workUnitId].map(attempt => ({ ...attempt, status: "cancelled" }));
  f.state.teammateDirectMessages = f.state.teammateDirectMessages.map(message => ({ ...message, status: "cancelled" }));
  await expect(f.composer.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  expect(f.counts().posts).toBe(1);
  expect(f.errors).toEqual([]);
});

test("private stop waits for the original Attempt and semaphore slot as well as the WorkUnit", async ({ page }) => {
  const f = await openPrivateReply(page);
  f.state.workUnitAttemptsByWorkUnit[workUnitId] = [{ id: "private-stop-attempt", workUnitId, attemptNumber: 1,
    runtimeInstanceId: "private-stop-runtime", runnerId: "runner_pi",
    status: "started", createdAt: now, startedAt: now }];
  await f.composer.getByRole("button", { name: "Stop reply", exact: true }).click();
  await expect.poll(() => f.counts().posts).toBe(1);
  f.state.workUnits = f.state.workUnits.map(unit => ({ ...unit, status: "cancelled" }));
  const reads = f.counts().reads;
  await expect.poll(() => f.counts().reads).toBeGreaterThan(reads);
  await expect(f.composer.getByRole("button", { name: "Stopping", exact: true })).toBeDisabled();
  f.state.workUnitAttemptsByWorkUnit[workUnitId] = f.state.workUnitAttemptsByWorkUnit[workUnitId].map(attempt => ({ ...attempt, status: "cancelled" }));
  f.state.runtimeSemaphoreSlots = [{ id: "private-stop-slot", workspaceId: "workspace_default", workUnitId,
    attemptId: "private-stop-attempt", ownerType: "work_unit_attempt", ownerId: "private-stop-attempt",
    resourceType: "runner", resourceKey: "runner_pi", status: "active", acquiredAt: now,
    lastRenewedAt: now, expiresAt: "2099-01-01T00:00:00.000Z" }];
  const attemptReads = f.counts().reads;
  await expect.poll(() => f.counts().reads).toBeGreaterThan(attemptReads);
  await expect(f.composer.getByRole("button", { name: "Stopping", exact: true })).toBeDisabled();
  f.state.runtimeSemaphoreSlots = [];
  f.state.teammateDirectMessages = f.state.teammateDirectMessages.map(message => ({ ...message, status: "cancelled" }));
  await expect(f.composer.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  expect(f.counts().posts).toBe(1);
  expect(f.errors).toEqual([]);
});

test("private stop with a missing original Attempt receipt stays uncertain until that receipt arrives", async ({ page }) => {
  const f = await openPrivateReply(page);
  f.state.workUnitAttemptsByWorkUnit[workUnitId] = [];
  await f.composer.getByRole("button", { name: "Stop reply", exact: true }).click();
  await expect.poll(() => f.counts().posts).toBe(1);
  f.state.workUnits = f.state.workUnits.map(unit => ({ ...unit, status: "cancelled" }));
  f.state.teammateDirectMessages = f.state.teammateDirectMessages.map(message => ({ ...message, status: "cancelled" }));
  const reads = f.counts().reads;
  await expect.poll(() => f.counts().reads).toBeGreaterThan(reads);
  await expect(f.composer.getByRole("button", { name: "Stopping", exact: true })).toBeDisabled();
  f.state.workUnitAttemptsByWorkUnit[workUnitId] = [{ id: "private-stop-attempt", workUnitId, attemptNumber: 1,
    runtimeInstanceId: "private-stop-runtime", runnerId: "runner_pi",
    status: "cancelled", createdAt: now, startedAt: now, endedAt: now }];
  await expect(f.composer.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  expect(f.counts().posts).toBe(1);
  expect(f.errors).toEqual([]);
});

test("a late private stop cannot overwrite another teammate's draft and recovers when returning", async ({ page }) => {
  const f = await openPrivateReply(page);
  let release: () => void = () => undefined;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  let dispatched = false;
  await page.route(url => url.pathname === `/teammate-direct-replies/${workUnitId}/cancel`, async route => {
    dispatched = true;
    await delayed;
    f.state.workUnits = f.state.workUnits.map(unit => ({ ...unit, status: "cancelled" }));
    f.state.workUnitAttemptsByWorkUnit[workUnitId] = f.state.workUnitAttemptsByWorkUnit[workUnitId].map(attempt => ({ ...attempt, status: "cancelled" }));
    f.state.teammateDirectMessages = f.state.teammateDirectMessages.map(message => ({ ...message, status: "cancelled" }));
    await route.fulfill({ json: { cwd, workUnit: f.state.workUnits[0], message: { ...f.state.teammateDirectMessages[0], body: "Never install this stale POST payload" } } });
  });
  await f.composer.getByRole("button", { name: "Stop reply", exact: true }).click();
  await expect.poll(() => dispatched).toBe(true);
  const sidebar = page.getByRole("complementary", { name: /Sidebar display/ });
  await sidebar.getByRole("button", { name: "Other Teammate", exact: true }).click();
  const draft = f.composer.getByRole("textbox");
  await draft.fill("Preserve the other private draft");
  const response = page.waitForResponse(item => item.url().includes(`/teammate-direct-replies/${workUnitId}/cancel`));
  release();
  await response;
  await expect(draft).toHaveAttribute("data-value", "Preserve the other private draft");
  await expect(page.getByText("Never install this stale POST payload", { exact: true })).toHaveCount(0);
  await expect(f.composer.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await mkdir(evidenceDir, { recursive: true });
  await page.screenshot({ path: `${evidenceDir}private-stop-preserves-other-teammate.png`, animations: "disabled" });
  await sidebar.getByRole("button", { name: "Stop Teammate", exact: true }).click();
  await expect(f.composer.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  await expect(page.getByText("Keep this private partial output.", { exact: true })).toBeVisible();
  expect(f.counts().posts).toBe(0);
  expect(f.errors).toEqual([]);
});

test("private stop response loss survives reload and only queries the original operation", async ({ page }) => {
  const f = await openPrivateReply(page, true);
  await f.composer.getByRole("button", { name: "Stop reply", exact: true }).click();
  await expect.poll(() => f.counts().posts).toBe(1);
  await expect(f.composer.getByRole("button", { name: "Stopping", exact: true })).toBeDisabled();
  f.state.workUnits = f.state.workUnits.map(unit => ({ ...unit, status: "cancelled" }));
  f.state.workUnitAttemptsByWorkUnit[workUnitId] = f.state.workUnitAttemptsByWorkUnit[workUnitId].map(attempt => ({ ...attempt, status: "cancelled" }));
  f.state.teammateDirectMessages = f.state.teammateDirectMessages.map(message => ({ ...message, status: "cancelled" }));
  f.state.resourceLeases = [{ id: "private-reload-lease", workspaceId: "workspace_default", resourceType: "workspace",
    resourceKey: cwd, ownerType: "work_unit_attempt", ownerId: "private-stop-attempt", workUnitId,
    status: "active", acquiredAt: now, expiresAt: "2099-01-01T00:00:00.000Z" }];
  await page.reload();
  await page.getByRole("complementary", { name: /Sidebar display/ }).getByRole("button", { name: "Stop Teammate", exact: true }).click();
  await expect(f.composer.getByRole("button", { name: "Stopping", exact: true })).toBeDisabled();
  await expect(page.getByText("Keep this private partial output.", { exact: true })).toBeVisible();
  expect(f.counts().posts).toBe(1);
  await mkdir(evidenceDir, { recursive: true });
  await page.screenshot({ path: `${evidenceDir}private-stop-reload-pending.png`, animations: "disabled" });
  f.state.resourceLeases = [];
  await expect(f.composer.getByRole("button", { name: "Stopping", exact: true })).toHaveCount(0);
  await expect(f.composer.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  expect(f.counts().posts).toBe(1);
  expect(f.errors).toEqual([]);
});

test("a private thread replacement fences an undispatched stop without blocking the new thread", async ({ page }) => {
  const f = await openPrivateReply(page);
  let release: () => void = () => undefined;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  let preflightStarted = false;
  await page.route(url => url.pathname === `/work-units/${workUnitId}`, async route => {
    preflightStarted = true;
    await delayed;
    await route.fallback();
  }, { times: 1 });
  await f.composer.getByRole("button", { name: "Stop reply", exact: true }).click();
  await expect.poll(() => preflightStarted).toBe(true);
  const nextThread = { id: "replacement-private-thread", workspaceId: "workspace_default", teammateId,
    title: "Replacement private thread", createdAt: now, updatedAt: now };
  f.state.teammateDirectThreads[teammateId] = nextThread;
  await page.route(url => url.pathname === `/teammates/${teammateId}/direct-runtime`, route => route.fulfill({
    json: { cwd, teammateId, thread: nextThread, interventions: [], approvals: [] },
  }));
  const refreshed = page.waitForResponse(response => response.url().includes(`/teammates/${teammateId}/direct-runtime`));
  await triggerFocusRevalidation(page);
  await refreshed;
  try {
    const draft = f.composer.getByRole("textbox");
    await draft.fill("Preserve the replacement thread draft");
    await expect(f.composer.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    const oldReceipt = page.waitForResponse(response => new URL(response.url()).pathname === `/work-units/${workUnitId}`);
    release();
    await oldReceipt;
    // Let the released preflight and the first reconciliation tick finish.
    await page.waitForTimeout(900);
    await expect(draft).toHaveAttribute("data-value", "Preserve the replacement thread draft");
    expect(f.counts().posts).toBe(0);
    await mkdir(evidenceDir, { recursive: true });
    await page.screenshot({ path: `${evidenceDir}private-stop-preserves-replacement-thread.png`, animations: "disabled" });
    expect(f.errors).toEqual([]);
  } finally {
    release();
  }
});
