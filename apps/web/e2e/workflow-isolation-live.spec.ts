import { expect } from "@playwright/test";
import {
  expandRow, integrationRoundRow, observeLiveDaemon, openLiveWorkflow, selectLiveConversation,
  startAndApproveWrites, test, workflowRow,
} from "./support/workflow-isolation-live";

test.use({ channel: "chrome", trace: "retain-on-failure", screenshot: "only-on-failure" });
test.describe.configure({ timeout: 180_000 });
test.skip(process.platform === "linux" || process.platform === "win32", "Real isolated Host writes require the macOS sandbox in this fixture.");

test("live P3 UI cancel retains original Hosts until drain and survives same-scenario restart", async ({ page, context, live }, testInfo) => {
  const manifest = live.fixture.manifest;
  const observation = await observeLiveDaemon(page, live);
  try {
    await openLiveWorkflow(page, live);
    await observation.ready();
    await startAndApproveWrites(page, live);
    const parallel = await live.status();
    const originalRunIds = parallel.runs.map(item => item.run.id).sort();
    const replayCount = observation.events.filter(event => event.eventName === "control_plane_replay_ready").length;

    await context.setOffline(true);
    try { await page.waitForTimeout(1_000); }
    finally { await context.setOffline(false); }
    await page.reload();
    await selectLiveConversation(page, manifest);
    await expect.poll(() => observation.events.filter(event => event.eventName === "control_plane_replay_ready").length).toBeGreaterThan(replayCount);
    await live.check("parallel");
    expect((await live.status()).runs.map(item => item.run.id).sort()).toEqual(originalRunIds);

    const row = workflowRow(page, manifest);
    await expandRow(row);
    await row.getByRole("button", { name: "Cancel workflow", exact: true }).click();
    await live.check("retained");
    await expect(row).toHaveAttribute("data-conversation-timeline-status", "cancelled");
    await expect(live.fixture.command({ op: "restart" })).rejects.toThrow(/Release and drain original Hosts/);

    await live.fixture.command({ op: "release", gate: "provider" });
    await expect.poll(async () => (await live.status()).executions.every(item => item.sdkSettled)).toBe(true);
    await live.check("retained");
    await live.fixture.command({ op: "release", gate: "host" });
    await live.check("drained");
    await live.check("cancelled");
    const beforeRestart = await live.status();
    const restarted = await live.fixture.command({ op: "restart" });
    expect(restarted).toMatchObject({ ...manifest });
    await page.reload();
    await selectLiveConversation(page, manifest);
    await expect(workflowRow(page, manifest)).toHaveAttribute("data-conversation-timeline-status", "cancelled");
    await expect(workflowRow(page, manifest).getByRole("button", { name: "Advance workflow", exact: true })).toHaveCount(0);
    await live.check("drained");
    await live.check("cancelled");
    const afterRestart = await live.status();
    expect(afterRestart.runs.map(item => item.run.id).sort()).toEqual(originalRunIds);
    expect(afterRestart.executions.map(item => item.runId).sort()).toEqual(originalRunIds);
    expect(afterRestart.target).toEqual(parallel.initialTarget);
    expect(afterRestart.reports).toEqual(beforeRestart.reports);
    expect(observation.mutations.filter(item => item.path === `/workflows/${manifest.workflowId}/cancel`)).toHaveLength(1);
    await observation.assertHealthy();
    const screenshot = testInfo.outputPath("cancelled-workflow-after-restart.png");
    await page.screenshot({ path: screenshot });
    await testInfo.attach("cancelled-workflow-after-restart", { path: screenshot, contentType: "image/png" });
  } finally {
    await testInfo.attach("browser-sse-and-ui-mutations", { body: JSON.stringify(observation, null, 2), contentType: "application/json" });
  }
});

test("live P3 UI approves a verified merge candidate and observes target apply and terminal report", async ({ page, live }, testInfo) => {
  const manifest = live.fixture.manifest;
  const observation = await observeLiveDaemon(page, live);
  try {
    await openLiveWorkflow(page, live);
    await observation.ready();
    await startAndApproveWrites(page, live);
    await live.fixture.command({ op: "release", gate: "provider" });
    await expect.poll(async () => (await live.status()).executions.every(item => item.sdkSettled)).toBe(true);
    expect((await live.status()).executions.every(item => !item.returned)).toBe(true);
    await live.fixture.command({ op: "release", gate: "host" });
    await live.check("drained");
    await expect.poll(async () => (await live.status()).round.phase, { timeout: 45_000 }).toBe("awaiting_approval");
    // The round phase precedes the asynchronous Git inspection and approval transaction.
    await expect.poll(() => observation.events.filter(event => event.eventName === "control_plane_event")
      .map(event => JSON.parse(event.data)).filter(event => event.action === "channel_workflow.isolation_settled"
        && event.entityId === manifest.workflowId && event.data.operationKey === `merge-approval:${manifest.roundId}`).length)
      .toBeGreaterThan(0);
    const pending = await live.status();
    expect(pending.target).toEqual(pending.initialTarget);
    expect(pending.round.candidate?.commit).toBeTruthy();
    expect(pending.approvals.filter(item => item.risk === "high" || item.risk === "critical")).toHaveLength(1);

    const round = integrationRoundRow(page, manifest);
    await expandRow(round);
    const openApproval = round.getByRole("button", { name: "Open approval", exact: true });
    await expect(openApproval).toBeVisible({ timeout: 45_000 });
    await openApproval.click();
    const details = page.getByRole("region", { name: "Approval details", exact: true });
    await expect(details).toBeVisible();
    await details.getByRole("textbox", { name: "Decision reason" }).fill("Apply the verified candidate from both original isolated Pi Hosts.");
    await details.getByRole("button", { name: "Approve", exact: true }).click();
    await details.getByRole("button", { name: "Confirm approve", exact: true }).click();
    await live.check("succeeded");
    const succeeded = await live.status();
    expect(succeeded.target.head).toBe(succeeded.round.candidate?.commit);
    expect(succeeded.target.head).not.toBe(pending.initialTarget.head);
    expect(succeeded.sourceTurn.id).toBe(manifest.sourceTurnId);
    await page.keyboard.press("Escape");
    await page.reload();
    await selectLiveConversation(page, manifest);
    await expect(workflowRow(page, manifest)).toHaveAttribute("data-conversation-timeline-status", "succeeded");
    await expect(integrationRoundRow(page, manifest)).toContainText("Applied to target");
    await live.check("succeeded");
    await observation.assertHealthy();
    const screenshot = testInfo.outputPath("applied-workflow-after-reload.png");
    await page.screenshot({ path: screenshot });
    await testInfo.attach("applied-workflow-after-reload", { path: screenshot, contentType: "image/png" });
  } finally {
    await testInfo.attach("browser-sse-and-ui-mutations", { body: JSON.stringify(observation, null, 2), contentType: "application/json" });
  }
});
