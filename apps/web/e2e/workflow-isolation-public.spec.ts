import { expect } from "@playwright/test";
import {
  expandRow, integrationRoundRow, observeLiveDaemon, openLiveWorkflow, selectLiveConversation,
  test, workflowRow,
} from "./support/workflow-isolation-live";

test.use({ publicSelection: true, channel: "chrome", trace: "retain-on-failure", screenshot: "only-on-failure" });
test.describe.configure({ timeout: 180_000 });
test.skip(process.platform !== "darwin", "The public isolated profile requires the macOS Host sandbox.");

test("public isolated selection executes a dependency before parallel siblings and retains an unapplied candidate", async ({ page, live }, testInfo) => {
  const manifest = live.fixture.manifest;
  const observation = await observeLiveDaemon(page, live);
  const status = live.status;
  const approveWrites = async (count: number) => {
    await expect.poll(async () => (await status()).approvals.filter(item => item.actionType === "write").length).toBe(count);
    const approvals = (await status()).approvals.filter(item => item.actionType === "write");
    const remaining = new Set(approvals.map(item => item.id));
    for (let index = 0; index < count; index += 1) {
      const gate = page.locator('[data-runtime-approval-id][data-surface="channel"]');
      await expect(gate).toBeVisible();
      const id = await gate.getAttribute("data-runtime-approval-id");
      expect(remaining.has(id!)).toBe(true);
      await gate.getByRole("button", { name: "Allow once", exact: true }).click();
      await expect.poll(async () => (await status()).approvals.some(item => item.id === id)).toBe(false);
      remaining.delete(id!);
    }
    expect(remaining.size).toBe(0);
  };
  try {
    await openLiveWorkflow(page, live);
    await observation.ready();
    await live.check("ready");
    expect((await status()).selection).toBeUndefined();
    const row = workflowRow(page, manifest);
    await expandRow(row);
    await row.getByRole("button", { name: "Start isolated branches (candidate only)", exact: true }).click();
    await approveWrites(1);
    await expect.poll(async () => (await status()).executions.filter(item => item.reached).map(item => item.branch)).toEqual(["prepare"]);
    const preparing = await status();
    expect(preparing.runs).toHaveLength(1);
    expect(preparing.round.inputs.mode).toBe("candidate_only");
    expect(preparing.parent.state).toBe("held");
    expect(preparing.target).toEqual(preparing.initialTarget);
    await live.fixture.command({ op: "release", gate: "all", branch: "prepare" });

    await approveWrites(2);
    await expect.poll(async () => (await status()).executions.filter(item => item.reached && !item.returned)
      .map(item => item.branch).sort(), { timeout: 45_000 }).toEqual(["left", "right"]);
    const parallel = await status();
    expect(parallel.runs).toHaveLength(3);
    expect(new Set(parallel.runs.map(item => item.run.cwd)).size).toBe(3);
    expect(parallel.runs.filter(item => item.run.status === "running")).toHaveLength(2);
    expect(parallel.steps.find(item => item.id === manifest.stepIds.prepare)?.status).toBe("succeeded");
    expect(parallel.parent.state).toBe("held");
    expect(parallel.target).toEqual(parallel.initialTarget);
    expect(parallel.runs.find(item => item.run.id === preparing.runs[0]!.run.id)?.run.status).toBe("succeeded");
    const originalRuns = parallel.runs.map(item => item.run.id).sort();
    await live.fixture.command({ op: "release", gate: "provider" });
    await expect.poll(async () => (await status()).executions.every(item => item.sdkSettled)).toBe(true);
    await live.fixture.command({ op: "release", gate: "host" });
    await expect.poll(async () => {
      const state = await status();
      return { workflow: state.workflow.status, parent: state.parent.state, reports: state.reports.length };
    }, { timeout: 45_000 }).toEqual({ workflow: "succeeded", parent: "released", reports: 1 });
    const completed = await status();
    expect(completed.round).toMatchObject({ inputs: { mode: "candidate_only" }, phase: "awaiting_approval" });
    expect(completed.round.candidate?.commit).toBeTruthy();
    expect(completed.parent.state).toBe("released");
    expect(completed.sourceTurn).toMatchObject({ id: manifest.sourceTurnId, status: "succeeded" });
    expect(completed.runs.every(item => item.completion?.drainedAt && item.slots.length === 0)).toBe(true);
    expect(completed.approvals).toEqual([]);
    expect(completed.target).toEqual(completed.initialTarget);
    expect(completed.reports).toHaveLength(1);
    expect(completed.reports[0]!.resultItemId).toBeTruthy();
    expect(completed.errors).toEqual([]);
    const selectedManifest = completed.manifest;
    expect(selectedManifest.roundId).toBeTruthy();
    const round = integrationRoundRow(page, selectedManifest);
    await expandRow(round);
    await expect(round).toContainText("Candidate only; target unchanged");
    await expect(round.getByRole("button", { name: "Open approval", exact: true })).toHaveCount(0);
    await expect(row).toHaveAttribute("data-conversation-timeline-status", "succeeded");
    await page.screenshot({ path: testInfo.outputPath("public-isolated-candidate.png") });

    await live.fixture.command({ op: "restart" });
    await page.reload();
    await selectLiveConversation(page, manifest);
    await expect(workflowRow(page, manifest)).toHaveAttribute("data-conversation-timeline-status", "succeeded");
    await expect(integrationRoundRow(page, selectedManifest)).toContainText("Candidate only; target unchanged");
    const integration = page.locator(`[data-conversation-timeline-id="workflow-isolation:${manifest.workflowId}:observation"]`);
    await expect(integration).toHaveCount(0);
    const restarted = await status();
    expect(restarted.runs.map(item => item.run.id).sort()).toEqual(originalRuns);
    expect(restarted.target).toEqual(completed.initialTarget);
    expect(restarted.parent.state).toBe("released");
    await observation.assertHealthy();
    const orchestrations = observation.mutations.filter(item => item.path === `/workflows/${manifest.workflowId}/orchestrate`);
    expect(orchestrations.map(item => JSON.parse(item.body!))).toEqual([{ executionProfile: "pi_host_isolated_files_v1" }]);
    await page.setViewportSize({ width: 390, height: 844 });
    await expandRow(integrationRoundRow(page, selectedManifest));
    await expect(integrationRoundRow(page, selectedManifest)).toContainText("Candidate only; target unchanged");
    await expect(integration).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("public-isolated-candidate-mobile.png") });
  } finally {
    await testInfo.attach("public-isolated-browser-observation", { body: JSON.stringify(observation, null, 2), contentType: "application/json" });
  }
});
