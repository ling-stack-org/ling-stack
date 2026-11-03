import { expect, test, type Page } from "@playwright/test";
import { expandRow } from "./support/workflow-isolation-live";

const fixtureUrl = new URL("../../../packages/daemon/test/support/workflow-isolation-live-fixture.mjs", import.meta.url).href;
interface Manifest { daemonUrl: string; workspaceCwd: string; channelId: string; threadId: string; participantId: string }
interface Status {
  workflows: { id: string; status: string; metadata: { templateCompilation: { templatePin: { id: string; version: string; digest: string } } } }[];
  steps: { id: string; status: string; metadata: { templateCompilationPin: { digest: string } } }[];
  runs: { id: string; status: string }[];
  templates: { revision: number; reviewStatus: string; publishedVersion?: { id: string; version: string; digest: string } }[];
  executions: { runId: string; sdkSettled: boolean; returned: boolean; requests: number }[];
  reports: { resultItemId?: string }[];
  target: unknown; initialTarget: unknown; errors: string[];
}

test.use({ channel: "chrome", trace: "retain-on-failure", screenshot: "only-on-failure" });

test("P4 authoring saves and pins a template before an explicit UI start reaches the original Pi Run", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  const { startWorkflowIsolationLiveFixture } = await import(fixtureUrl);
  const fixture = await startWorkflowIsolationLiveFixture({ authoring: true });
  const manifest: Manifest = fixture.manifest;
  const status = async () => await fixture.command({ op: "status" }) as Status;
  const mutations: { method: string; path: string; body: unknown }[] = [];
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.origin === manifest.daemonUrl && !["GET", "OPTIONS", "HEAD"].includes(request.method())) {
      mutations.push({ method: request.method(), path: url.pathname, body: request.postDataJSON() });
    }
  });
  try {
    await configureWorkspace(page, manifest);
    await page.goto("/");
    await page.getByRole("complementary", { name: "Sidebar display" }).getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByLabel("Settings sections").getByRole("button", { name: "Skill library", exact: true }).click();
    const panel = page.locator("[data-ui2-skill-library]");
    await panel.getByRole("tab", { name: "Workflow templates", exact: true }).click();
    const templates = panel.getByRole("region", { name: "Workflow templates", exact: true });
    await templates.getByRole("button", { name: "New template", exact: true }).click();
    const editor = templates.locator("[data-ui2-workflow-template-editor]");
    await expect(editor.getByRole("checkbox", { name: "Auto-start by default", exact: true })).not.toBeChecked();
    await expect(editor.getByRole("checkbox", { name: "Auto-start step", exact: true })).not.toBeChecked();
    await editor.getByRole("textbox", { name: "Template ID", exact: true }).fill("live-authored-analysis");
    await editor.getByRole("textbox", { name: "Template name", exact: true }).fill("Live authored analysis");
    const step = editor.getByRole("article", { name: "Step 1", exact: true });
    await step.getByRole("textbox", { name: "Step name", exact: true }).fill("Inspect authored objective");
    await step.getByRole("combobox", { name: "Member", exact: true }).selectOption(`teammate:${manifest.participantId}`);
    await step.getByRole("textbox", { name: "Prompt", exact: true }).fill("Analyze the objective without tools or side effects, and return a concise result.");
    // Opt this step into explicit workflow advancement, never into execution on save/create.
    await step.getByText("Auto-start step", { exact: true }).click();
    await expect(step.getByRole("checkbox", { name: "Auto-start step", exact: true })).toBeChecked();
    await editor.getByRole("button", { name: "Save draft", exact: true }).click();
    await expect.poll(async () => (await status()).templates[0]?.reviewStatus).toBe("draft");
    expect((await status()).runs).toEqual([]);
    await editor.getByRole("combobox", { name: "Review status", exact: true }).selectOption("published");
    await expect.poll(async () => (await status()).templates[0]?.reviewStatus).toBe("published");
    const pin = (await status()).templates[0]!.publishedVersion!;
    const preview = editor.getByRole("region", { name: "Compile preview", exact: true });
    await preview.getByRole("combobox", { name: "Channel", exact: true }).selectOption(manifest.channelId);
    await preview.getByRole("textbox", { name: "Objective", exact: true }).fill("Verify the saved exact template through an explicit start.");
    await preview.getByRole("button", { name: "Compile preview", exact: true }).click();
    await expect(preview.getByLabel("Compiled steps")).toContainText(pin.digest);
    expect((await status()).workflows).toEqual([]);
    expect((await status()).runs).toEqual([]);
    await preview.getByRole("button", { name: "Create workflow", exact: true }).click();
    await expect.poll(async () => (await status()).workflows.length).toBe(1);
    const created = await status();
    expect(created.workflows[0]!.metadata.templateCompilation.templatePin).toEqual(pin);
    expect(created.steps[0]!.metadata.templateCompilationPin.digest).toBe(pin.digest);
    expect(created.runs).toEqual([]);
    expect(created.executions).toEqual([]);
    await page.getByRole("button", { name: "Back to app", exact: true }).click();
    await page.locator('[aria-label="P4 live authored workflow"]').click();
    const session = page.locator(".sidebar-channel-group").filter({
      has: page.getByRole("button", { name: "P4 live authored workflow", exact: true }),
    }).getByTitle("Default conversation", { exact: true });
    await session.click();
    const workflowId = created.workflows[0]!.id;
    const row = page.locator(`[data-conversation-timeline-item="protocolEvent"][data-conversation-source-refs*="channel_workflow:${workflowId}"]`);
    await expandRow(row);
    await row.getByRole("button", { name: "Advance workflow", exact: true }).click();
    await expect.poll(async () => (await status()).workflows[0]?.status, { timeout: 45_000 }).toBe("succeeded");
    const completed = await status();
    expect(completed.runs).toHaveLength(1);
    expect(completed.runs[0]!.status).toBe("succeeded");
    expect(completed.executions).toEqual([{ runId: completed.runs[0]!.id, requests: 1, sdkSettled: true, returned: true }]);
    expect(completed.steps[0]!.status).toBe("succeeded");
    expect(completed.target).toEqual(completed.initialTarget);
    expect(completed.errors).toEqual([]);
    await expect(row).toHaveAttribute("data-conversation-timeline-status", "succeeded");
    await page.reload();
    await page.locator('[aria-label="P4 live authored workflow"]').click();
    await session.click();
    await expect(page.locator(`[data-session-id="${manifest.threadId}"] button[title="Default conversation"]`))
      .toHaveAttribute("aria-current", "page");
    await expect(page.locator(`[data-conversation-timeline-item="protocolEvent"][data-conversation-source-refs*="channel_workflow:${workflowId}"]`))
      .toHaveAttribute("data-conversation-timeline-status", "succeeded");
    expect((await status()).runs.map(run => run.id)).toEqual(completed.runs.map(run => run.id));
    expect(mutations.filter(item => item.path === `/channels/${manifest.channelId}/workflows`)).toHaveLength(1);
    expect(mutations.filter(item => item.path === `/workflows/${workflowId}/orchestrate`)).toHaveLength(1);
    expect(errors).toEqual([]);
    const screenshot = testInfo.outputPath("authored-workflow-completed.png");
    await page.screenshot({ path: screenshot });
    await testInfo.attach("authored-workflow-completed", { path: screenshot, contentType: "image/png" });
  } finally {
    try {
      await testInfo.attach("authoring-daemon-state", { body: JSON.stringify(await status(), null, 2), contentType: "application/json" });
      await testInfo.attach("authoring-ui-mutations", { body: JSON.stringify(mutations, null, 2), contentType: "application/json" });
    } finally { await fixture.close(); }
  }
});

async function configureWorkspace(page: Page, manifest: Manifest): Promise<void> {
  await page.addInitScript(value => {
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.workspaceCwd", value.workspaceCwd);
    Object.defineProperty(window, "lingDesktop", { configurable: true, value: {
      platform: "macos", daemonBaseUrl: value.daemonUrl,
      daemon: { onStatusChanged(listener: (value: unknown) => void) {
        listener({ state: "connected", baseUrl: value.daemonUrl, ownedByDesktop: true });
        return () => {};
      } },
    } });
  }, manifest);
}
