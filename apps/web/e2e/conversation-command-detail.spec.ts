import { expect, test, type Page } from "@playwright/test";
import type { ConversationTimelineCommandExecutionItem } from "@ling-stack/conversation-ui-core";

async function mount(page: Page, item: Partial<ConversationTimelineCommandExecutionItem>) {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => {
      (window as Window & { commandCopied?: string }).commandCopied = value;
    } } });
  });
  await page.goto("/e2e/support/p2-reading.html?manual");
  await page.evaluate(async input => {
    const path = "/e2e/support/command-detail-harness.tsx";
    window.commandDetailHarness = (await import(/* @vite-ignore */ path)).mountCommandDetailFixture(input);
  }, item);
  return page.locator('[data-conversation-timeline-kind="commandExecution"]');
}

test("command-only history exposes and copies the complete multiline command", async ({ page }, info) => {
  const command = `python3 - <<'PY'\nprint('quoted \\"text\\" and $HOME stay literal')\n${"# long command ".repeat(35)}\nPY`;
  const row = await mount(page, { command });
  const disclosure = row.locator(".conversation-timeline-activity-main");
  await expect(disclosure).toHaveAttribute("aria-expanded", "false");
  await disclosure.click();
  await expect(row.getByLabel("Command", { exact: true })).toHaveText(command);
  await row.getByRole("button", { name: "Copy: Command", exact: true }).click();
  expect(await page.evaluate(() => (window as Window & { commandCopied?: string }).commandCopied)).toBe(command);
  await expect(row.getByRole("button", { name: "Command copied" })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: info.outputPath("command-multiline-mobile.png") });
});

test("only owned log evidence becomes an action and keeps exact operation lineage", async ({ page }) => {
  const log = { kind: "artifact" as const, id: "stdout-log" };
  const row = await mount(page, { outputTruncated: true, stdoutArtifactId: log.id,
    stderrArtifactId: "missing-stderr", sourceRefs: [log, { kind: "artifact", id: "unrelated-log" }], exitCode: 0,
    outputTail: [{ eventSeq: 1, stream: "stderr", text: "A warning, not failure", redacted: false }] });
  await row.locator(".conversation-timeline-activity-main").click();
  await expect(row).toHaveAttribute("data-conversation-timeline-status", "succeeded");
  await expect(row).toContainText("exit 0");
  await expect(row.getByRole("button", { name: /Open full log/u })).toHaveCount(1);
  await row.getByRole("button", { name: /Open full log/u }).click();
  expect(await page.evaluate(() => window.commandDetailHarness.opened().map(value => JSON.parse(value)))).toEqual([
    { ref: log, actionId: "action-detail", runId: "run-detail" },
  ]);
});

const failureCases: readonly Partial<ConversationTimelineCommandExecutionItem>[] = [
  { status: "failed", exitCode: 7 },
  { status: "failed", timedOut: true, signal: "SIGTERM" },
  { status: "cancelled", signal: "SIGINT" },
];
for (const input of failureCases) {
  test(`command ${input.timedOut ? "timeout" : input.signal ?? "nonzero exit"} remains visible with unavailable log feedback`, async ({ page }) => {
    const row = await mount(page, { ...input, outputTruncated: true, stdoutArtifactId: "orphan-log" });
    await expect(row.locator(".conversation-timeline-activity-main")).toHaveAttribute("aria-expanded", "true");
    await expect(row).toHaveAttribute("data-conversation-timeline-status", input.status);
    await expect(row).toContainText("Full output is unavailable for this command.");
    await expect(row.getByRole("button", { name: /Open full log/u })).toHaveCount(0);
    if ("exitCode" in input) await expect(row).toContainText("exit 7");
    if (input.timedOut) await expect(row).toContainText("Timed out");
    if (input.signal) await expect(row).toContainText(input.signal);
  });
}

test("saved disclosure returns after remount but cannot conceal a new failure", async ({ page }) => {
  let row = await mount(page, { command: "node --test" });
  await row.locator(".conversation-timeline-activity-main").click();
  row = await mount(page, { command: "node --test" });
  await expect(row.locator(".conversation-timeline-activity-main")).toHaveAttribute("aria-expanded", "true");
  await row.locator(".conversation-timeline-activity-main").click();
  row = await mount(page, { command: "node --test", status: "failed", exitCode: 2 });
  await expect(row.locator(".conversation-timeline-activity-main")).toHaveAttribute("aria-expanded", "true");
  await expect(row).toContainText("exit 2");
});

for (const outcome of ["succeeded", "failed"] as const) {
  test(`restored pending collapse reveals running and ${outcome} updates`, async ({ page }) => {
    let row = await mount(page, { command: "node --test" });
    await row.locator(".conversation-timeline-activity-main").click();
    await row.locator(".conversation-timeline-activity-main").click();
    row = await mount(page, { command: "node --test", status: "pending" });
    const disclosure = row.locator(".conversation-timeline-activity-main");
    await expect(disclosure).toHaveAttribute("aria-expanded", "false");
    await page.evaluate(() => window.commandDetailHarness.update({ status: "running", revision: 2 }));
    await expect(disclosure).toHaveAttribute("aria-expanded", "true");
    await expect(row.getByLabel("Command", { exact: true })).toHaveText("node --test");
    await page.evaluate(status => window.commandDetailHarness.update({ status, revision: 3,
      exitCode: status === "succeeded" ? 0 : 2 }), outcome);
    await expect(disclosure).toHaveAttribute("aria-expanded", outcome === "succeeded" ? "false" : "true");
    if (outcome === "failed") await expect(row).toContainText("exit 2");
  });
}

test("more files survives virtual remount and a page reload", async ({ page }) => {
  await page.goto("/e2e/support/p2-reading.html?manual");
  const mountFiles = () => page.evaluate(async () => {
    const path = "/e2e/support/command-detail-harness.tsx";
    window.responseFilesHarness = (await import(/* @vite-ignore */ path)).mountResponseFilesFixture();
  });
  await mountFiles();
  const files = page.locator("[data-conversation-response-files]");
  await expect(files.locator(".conversation-response-file")).toHaveCount(3);
  await files.locator(".conversation-response-files-more").click();
  await expect(files.locator(".conversation-response-file")).toHaveCount(5);
  await page.evaluate(() => window.responseFilesHarness.show(false));
  await expect(files).toHaveCount(0);
  await page.evaluate(() => window.responseFilesHarness.show(true));
  await expect(files.locator(".conversation-response-file")).toHaveCount(5);
  await page.reload();
  await mountFiles();
  await expect(files.locator(".conversation-response-file")).toHaveCount(5);
});
