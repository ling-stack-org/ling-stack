import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { cwd } from "./support/mock-daemon";
import { createRunsThreadsFixture, installRunsThreadsFixture, openMainRunHistory } from "./support/runs-threads-fixture";

const evidenceDir = process.env.LING_P2_EVIDENCE_DIR ?? fileURLToPath(new URL("../../../.ling-stack/acceptance/p2-ux2-stop-20261015/", import.meta.url));

test("a terminal Run without its original execution owner remains unconfirmed instead of assuming no resources", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  const state = createRunsThreadsFixture();
  state.approvals = [];
  state.runs = state.runs.map(run => run.id === "run_ui2_running" ? { ...run, workUnitId: undefined } : run);
  await installRunsThreadsFixture(page, state);
  let posts = 0, reads = 0;
  await page.route(url => url.pathname === "/runs/run_ui2_running", async route => { reads++; await route.fallback(); });
  await page.route(url => url.pathname === "/runs/run_ui2_running/cancel", route => {
    posts++;
    state.runs = state.runs.map(run => run.id === "run_ui2_running" ? { ...run, status: "cancelled" } : run);
    return route.fulfill({ json: { cancelled: true, active: false, run: state.runs.find(run => run.id === "run_ui2_running") } });
  });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto("/");
  await openMainRunHistory(page, "Running approval audit");
  const detail = page.getByLabel("Run detail", { exact: true });
  await detail.getByRole("button", { name: "Stop", exact: true }).click();
  await expect.poll(() => posts).toBe(1);
  const previous = reads;
  await expect.poll(() => reads).toBeGreaterThan(previous);
  await expect(detail.getByRole("button", { name: "Stopping", exact: true })).toBeDisabled();
  expect(posts).toBe(1);
  await mkdir(evidenceDir, { recursive: true });
  await page.screenshot({ path: `${evidenceDir}run-stop-owner-unavailable.png`, animations: "disabled" });
  expect(errors).toEqual([]);
});

test("logical Run cancellation keeps the stop pending until original Host effects settle", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  const state = createRunsThreadsFixture();
  state.approvals = [];
  await installRunsThreadsFixture(page, state);
  const unit = state.workUnits.find(unit => unit.id === "wu_ui2_running")!;
  const attempt = state.workUnitAttemptsByWorkUnit[unit.id][0];
  attempt.fencingToken = "7";
  const proof = { attemptId: attempt.id, runtimeInstanceId: attempt.runtimeInstanceId, fencingToken: "7",
    localExecution: "draining" as const, effects: "settled" as "settled" | "unknown" };
  state.workUnitStopEvidenceByWorkUnit = { [unit.id]: { schemaVersion: 1, workUnitId: unit.id, attempts: [proof] } };
  let posts = 0, reads = 0;
  await page.route(url => url.pathname === `/work-units/${unit.id}`, async route => { reads++; await route.fallback(); });
  await page.route(url => url.pathname === `/work-units/${unit.id}/cancel`, route => {
    posts++;
    state.workUnits = state.workUnits.map(item => item.id === unit.id ? { ...item, status: "cancelled" } : item);
    state.workUnitAttemptsByWorkUnit[unit.id] = [{ ...attempt, status: "cancelled" }];
    state.runs = state.runs.map(run => run.id === unit.linkedRunId ? { ...run, status: "cancelled" } : run);
    return route.fulfill({ json: { cwd, workUnit: state.workUnits.find(item => item.id === unit.id) } });
  });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto("/");
  await openMainRunHistory(page, "Running approval audit");
  const detail = page.getByLabel("Run detail", { exact: true });
  await detail.getByRole("button", { name: "Stop", exact: true }).click();
  await expect.poll(() => posts).toBe(1);
  let previous = reads;
  await expect.poll(() => reads).toBeGreaterThan(previous);
  await expect(detail.getByRole("button", { name: "Stopping", exact: true })).toBeDisabled();
  state.workUnitStopEvidenceByWorkUnit[unit.id] = { schemaVersion: 1, workUnitId: unit.id,
    attempts: [{ ...proof, localExecution: "drained", effects: "unknown" }] };
  previous = reads;
  await expect.poll(() => reads).toBeGreaterThan(previous);
  await expect(detail.getByRole("button", { name: "Stopping", exact: true })).toBeDisabled();
  await mkdir(evidenceDir, { recursive: true });
  await page.screenshot({ path: `${evidenceDir}run-logical-cancel-host-unknown.png`, animations: "disabled" });
  state.workUnitStopEvidenceByWorkUnit[unit.id] = { schemaVersion: 1, workUnitId: unit.id,
    attempts: [{ ...proof, localExecution: "drained", effects: "settled" }] };
  await expect(detail.getByRole("button", { name: "Stopping", exact: true })).toHaveCount(0);
  expect(posts).toBe(1);
  expect(errors).toEqual([]);
});

for (const loseResponse of [false, true]) test(`Run stop ${loseResponse ? "lost receipt" : "accepted request"} waits for authoritative termination and resource release`, async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  if (loseResponse) await page.addInitScript(() => {
    const originalFetch = window.fetch;
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      if (response.ok && args[1]?.method === "POST" && /\/work-units\/[^/]+\/cancel$/.test(new URL(String(args[0]), location.href).pathname)) {
        await response.text();
        throw new TypeError("Controlled cancellation response loss");
      }
      return response;
    };
  });
  const state = createRunsThreadsFixture();
  state.approvals = [];
  const run = state.runs.find(item => item.id === "run_ui2_running")!;
  state.eventsByRun[run.id] = [{ id: "partial-output", runId: run.id, seq: 1, ts: run.updatedAt,
    type: "assistant_text_delta", data: { text: "Keep this partial reply after stopping." } }];
  await installRunsThreadsFixture(page, state);
  let requests = 0;
  let reads = 0;
  await page.route(url => url.pathname === "/work-units/wu_ui2_running", async route => {
    reads++;
    await route.fallback();
  });
  await page.route(url => url.pathname === "/work-units/wu_ui2_running/cancel", route => {
    expect(route.request().postDataJSON()).toEqual({
      expectedAttemptId: state.workUnits[0].activeAttemptId ?? null, expectedRunId: run.id,
    });
    requests++;
    state.workUnits = state.workUnits.map(unit => ({ ...unit, status: "cancelling" }));
    return route.fulfill({ json: { cwd, workUnit: state.workUnits[0] } });
  });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto("/");
  await openMainRunHistory(page, "Running approval audit");
  const detail = page.getByLabel("Run detail", { exact: true });
  await detail.getByRole("button", { name: "Run summary preview", exact: true }).click();
  const partialReply = detail.locator("p.runs-readable-copy").filter({ hasText: "Keep this partial reply after stopping." });
  await expect(partialReply).toBeVisible();
  await detail.getByRole("button", { name: "Stop", exact: true }).click();
  await expect.poll(() => requests).toBe(1);
  await expect.poll(() => state.workUnits[0].status).toBe("cancelling");
  // The command is accepted, but the host has not confirmed termination yet.
  await page.waitForTimeout(650);
  await expect(detail.getByRole("button", { name: "Stopping", exact: true })).toBeDisabled();
  await expect(partialReply).toBeVisible();
  await mkdir(evidenceDir, { recursive: true });
  await page.screenshot({ path: `${evidenceDir}run-stop-${loseResponse ? "lost-response" : "pending"}.png`, animations: "disabled" });
  state.workUnits = state.workUnits.map(unit => ({ ...unit, status: "cancelled" }));
  state.workUnitAttemptsByWorkUnit.wu_ui2_running = state.workUnitAttemptsByWorkUnit.wu_ui2_running.map(attempt => ({ ...attempt, status: "cancelled" }));
  state.runs = state.runs.map(item => item.id === run.id ? { ...item, status: "cancelled" } : item);
  state.resourceLeases = [{ id: "owned-stop-lease", workspaceId: "workspace_default", resourceType: "workspace",
    resourceKey: cwd, ownerType: "work_unit_attempt", ownerId: "guidance-attempt", workUnitId: "wu_ui2_running",
    status: "active", acquiredAt: run.createdAt, expiresAt: "2099-01-01T00:00:00.000Z" }];
  const previousReads = reads;
  await expect.poll(() => reads).toBeGreaterThan(previousReads);
  await expect(detail.getByRole("button", { name: "Stopping", exact: true })).toBeDisabled();
  state.resourceLeases = [];
  state.eventsByRun[run.id].push({ id: "stop-confirmed", runId: run.id, seq: 2, ts: run.updatedAt,
    type: "run_cancelled", data: { reason: "user_requested" } });
  await expect(detail.getByRole("button", { name: "Stopping", exact: true })).toHaveCount(0);
  await expect(detail.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  await expect(partialReply).toBeVisible();
  expect(requests).toBe(1);
  await page.screenshot({ path: `${evidenceDir}run-stop-confirmed-${loseResponse ? "lost-response" : "acknowledged"}.png`, animations: "disabled" });
  expect(errors).toEqual([]);
});

test("a previous Run's stop receipt cannot replace the newly selected Run or guidance draft", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  const state = createRunsThreadsFixture();
  state.approvals = [];
  await installRunsThreadsFixture(page, state);
  let cancelRequests = 0;
  let receiptHeld = false;
  let releaseReceipt: (() => void) | undefined;
  const oldReceipt = new Promise<void>(resolve => { releaseReceipt = resolve; });
  await page.route(url => url.pathname === "/work-units/wu_ui2_running", async route => {
    if (cancelRequests) {
      receiptHeld = true;
      await oldReceipt;
    }
    await route.fallback();
  });
  await page.route(url => url.pathname === "/work-units/wu_ui2_running/cancel", route => {
    cancelRequests++;
    state.workUnits = state.workUnits.map(unit => ({ ...unit, status: "cancelling" }));
    return route.fulfill({ json: { cwd, workUnit: state.workUnits[0] } });
  });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await openMainRunHistory(page, "Running approval audit");
  const detail = page.getByLabel("Run detail", { exact: true });
  await detail.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(detail.getByRole("button", { name: "Stopping", exact: true })).toBeDisabled();
  await expect.poll(() => receiptHeld).toBe(true);
  await page.getByRole("listbox", { name: "Work history" }).getByRole("button", { name: /^Attempt 2 Retry completed/ }).click();
  await expect(detail.locator(".runs-detail-heading")).toContainText("Retry completed with evidence");
  const draft = detail.getByRole("textbox", { name: "Run guidance", exact: true });
  await draft.fill("Keep this newly selected Run's draft");
  state.workUnits = state.workUnits.map(unit => ({ ...unit, status: "cancelled" }));
  state.workUnitAttemptsByWorkUnit.wu_ui2_running = state.workUnitAttemptsByWorkUnit.wu_ui2_running.map(attempt => ({ ...attempt, status: "cancelled" }));
  state.runs = state.runs.map(run => run.id === "run_ui2_running" ? { ...run, status: "cancelled" } : run);
  releaseReceipt?.();
  await expect.poll(() => page.evaluate(workspaceCwd => localStorage.getItem(
    `ling-stack.run-stop-lookup.v1:${JSON.stringify(workspaceCwd)}`,
  ), cwd)).toBe(null);
  await expect(detail.locator(".runs-detail-heading")).toContainText("Retry completed with evidence");
  await expect(draft).toHaveValue("Keep this newly selected Run's draft");
  await expect(detail.getByRole("button", { name: "Stopping", exact: true })).toHaveCount(0);
  await mkdir(evidenceDir, { recursive: true });
  await page.screenshot({ path: `${evidenceDir}previous-stop-preserves-selected-run.png`, animations: "disabled" });
  expect(cancelRequests).toBe(1);
  expect(errors).toEqual([]);
});

test("stopping across a safe yield settles the logical WorkUnit without rewriting the yielded Run", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  const state = createRunsThreadsFixture();
  state.approvals = [];
  await installRunsThreadsFixture(page, state);
  let posts = 0;
  await page.route(url => url.pathname === "/work-units/wu_ui2_running/cancel", route => {
    posts++;
    state.workUnits = state.workUnits.map(unit => ({ ...unit, status: "cancelled", activeAttemptId: undefined }));
    state.runs = state.runs.map(run => run.id === "run_ui2_running" ? { ...run, status: "yielded" } : run);
    state.workUnitAttemptsByWorkUnit.wu_ui2_running = [{ id: "attempt_ui2_running", workUnitId: "wu_ui2_running",
      attemptNumber: 1, runtimeInstanceId: "yielded-runtime", runnerId: "runner_pi",
      status: "yielded", createdAt: state.runs[0].createdAt, endedAt: state.runs[0].updatedAt }];
    return route.fulfill({ json: { cwd, workUnit: state.workUnits[0] } });
  });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await openMainRunHistory(page, "Running approval audit");
  const detail = page.getByLabel("Run detail", { exact: true });
  await detail.getByRole("button", { name: "Stop", exact: true }).click();
  await expect.poll(() => posts).toBe(1);
  await expect(detail.getByRole("button", { name: "Stopping", exact: true })).toHaveCount(0);
  await expect(detail.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  expect(state.runs.find(run => run.id === "run_ui2_running")?.status).toBe("yielded");
  expect(state.workUnits[0].status).toBe("cancelled");
  expect(errors).toEqual([]);
});

test("Run stop discovers an initially missing WorkUnit before confirming resource release", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  const state = createRunsThreadsFixture();
  state.approvals = [];
  state.runs = state.runs.map(run => run.id === "run_ui2_running" ? { ...run, workUnitId: undefined } : run);
  await installRunsThreadsFixture(page, state);
  let posts = 0, reads = 0;
  await page.route(url => url.pathname === "/work-units/wu_ui2_running", async route => {
    reads++;
    await route.fallback();
  });
  await page.route(url => url.pathname === "/runs/run_ui2_running/cancel", route => {
    posts++;
    state.runs = state.runs.map(run => run.id === "run_ui2_running"
      ? { ...run, status: "cancelled", workUnitId: "wu_ui2_running" } : run);
    state.workUnits = state.workUnits.map(unit => ({ ...unit, status: "cancelling" }));
    return route.fulfill({ json: { cancelled: true, active: false, run: state.runs.find(run => run.id === "run_ui2_running") } });
  });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await openMainRunHistory(page, "Running approval audit");
  const detail = page.getByLabel("Run detail", { exact: true });
  await detail.getByRole("button", { name: "Stop", exact: true }).click();
  await expect.poll(() => posts).toBe(1);
  await expect(detail.getByRole("button", { name: "Stopping", exact: true })).toBeDisabled();
  await expect.poll(() => reads).toBeGreaterThan(0);
  state.workUnits = state.workUnits.map(unit => ({ ...unit, status: "cancelled" }));
  state.workUnitAttemptsByWorkUnit.wu_ui2_running = state.workUnitAttemptsByWorkUnit.wu_ui2_running.map(attempt => ({ ...attempt, status: "cancelled" }));
  state.resourceLeases = [{ id: "discovered-stop-lease", workspaceId: "workspace_default", resourceType: "workspace",
    resourceKey: cwd, ownerType: "work_unit_attempt", ownerId: "attempt_ui2_running", workUnitId: "wu_ui2_running",
    status: "active", acquiredAt: state.runs[0].createdAt, expiresAt: "2099-01-01T00:00:00.000Z" }];
  const previousReads = reads;
  await expect.poll(() => reads).toBeGreaterThan(previousReads);
  await expect(detail.getByRole("button", { name: "Stopping", exact: true })).toBeDisabled();
  await mkdir(evidenceDir, { recursive: true });
  await page.screenshot({ path: `${evidenceDir}run-stop-discovered-work-unit-pending.png`, animations: "disabled" });
  state.resourceLeases = [];
  await expect(detail.getByRole("button", { name: "Stopping", exact: true })).toHaveCount(0);
  await expect(detail.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  expect(posts).toBe(1);
  expect(errors).toEqual([]);
});

test("a lost Run stop response survives reload and reconciles without another cancellation", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
    const fetch = window.fetch;
    window.fetch = async (...args) => {
      const response = await fetch(...args);
      if (response.ok && args[1]?.method === "POST" && /\/work-units\/[^/]+\/cancel$/.test(new URL(String(args[0]), location.href).pathname)) {
        await response.text();
        throw new TypeError("Controlled stop reload response loss");
      }
      return response;
    };
  });
  const state = createRunsThreadsFixture();
  state.approvals = [];
  await installRunsThreadsFixture(page, state);
  let posts = 0, reads = 0;
  await page.route(url => url.pathname === "/work-units/wu_ui2_running", async route => { reads++; await route.fallback(); });
  await page.route(url => url.pathname === "/work-units/wu_ui2_running/cancel", route => {
    posts++;
    state.workUnits = state.workUnits.map(unit => ({ ...unit, status: "cancelling" }));
    return route.fulfill({ json: { cwd, workUnit: state.workUnits[0] } });
  });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await openMainRunHistory(page, "Running approval audit");
  const detail = page.getByLabel("Run detail", { exact: true });
  await detail.getByRole("button", { name: "Stop", exact: true }).click();
  await expect.poll(() => posts).toBe(1);
  await expect(detail.getByRole("button", { name: "Stopping", exact: true })).toBeDisabled();
  state.runs = state.runs.map(run => run.id === "run_ui2_running" ? { ...run, status: "cancelled" } : run);
  state.workUnits = state.workUnits.map(unit => ({ ...unit, status: "cancelled" }));
  state.workUnitAttemptsByWorkUnit.wu_ui2_running = state.workUnitAttemptsByWorkUnit.wu_ui2_running.map(attempt => ({ ...attempt, status: "cancelled" }));
  state.resourceLeases = [{ id: "stop-reload-lease", workspaceId: "workspace_default", resourceType: "workspace",
    resourceKey: cwd, ownerType: "work_unit_attempt", ownerId: "attempt_ui2_running", workUnitId: "wu_ui2_running",
    status: "active", acquiredAt: state.runs[0].createdAt, expiresAt: "2099-01-01T00:00:00.000Z" }];
  await page.reload();
  await openMainRunHistory(page, "Running approval audit");
  await expect(detail.getByRole("button", { name: "Stopping", exact: true })).toBeDisabled();
  const previousReads = reads;
  await expect.poll(() => reads).toBeGreaterThan(previousReads);
  expect(posts).toBe(1);
  await mkdir(evidenceDir, { recursive: true });
  await page.screenshot({ path: `${evidenceDir}run-stop-reload-pending.png`, animations: "disabled" });
  state.resourceLeases = [];
  await expect(detail.getByRole("button", { name: "Stopping", exact: true })).toHaveCount(0);
  await expect(detail.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  expect(posts).toBe(1);
  expect(errors).toEqual([]);
});

test("a failed stop preflight allows an explicit retry without pretending cancellation was sent", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  const state = createRunsThreadsFixture();
  state.approvals = [];
  await installRunsThreadsFixture(page, state);
  let posts = 0;
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/work-units/wu_ui2_running/cancel") posts++;
  });
  await page.goto("/");
  await openMainRunHistory(page, "Running approval audit");
  const detail = page.getByLabel("Run detail", { exact: true });
  let rejectPreflight = true;
  await page.route(url => url.pathname === "/work-units/wu_ui2_running", route => rejectPreflight ? route.fulfill({
    status: 503, json: { message: "Controlled cancellation preflight unavailable" },
  }) : route.fallback());
  await detail.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByText("Controlled cancellation preflight unavailable", { exact: true })).toBeVisible();
  await expect(detail.getByRole("button", { name: "Stop", exact: true })).toBeEnabled();
  expect(posts).toBe(0);
  rejectPreflight = false;
  await detail.getByRole("button", { name: "Stop", exact: true }).click();
  await expect.poll(() => posts).toBe(1);
  await expect(detail.getByRole("button", { name: "Stopping", exact: true })).toHaveCount(0);
  await expect(detail.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});
