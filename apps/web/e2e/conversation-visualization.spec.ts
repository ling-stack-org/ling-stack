import { expect, test } from "@playwright/test";
import { installNormalWorkCellFixture } from "./support/conversation-work-cell-fixture";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";

const artifactId = "viz_0123456789abcdef0123456789abcdef";
const html = `
  <style>
    :root { color-scheme: light dark; font: 14px system-ui, sans-serif; }
    body { margin: 0; padding: 12px; }
    main { padding: 16px; border-radius: 10px; background: light-dark(#f2f6f4, #202a26); }
    fieldset { display: flex; flex-wrap: wrap; gap: 8px; margin: 0; padding: 0; border: 0; }
    legend { padding: 0; margin-bottom: 8px; font-weight: 600; }
    label { display: inline-flex; align-items: center; gap: 5px; padding: 5px 10px; border-radius: 7px; }
    label:has(:checked) { background: light-dark(#d5ebe0, #305442); }
    input { accent-color: #358263; }
    h2 { font-size: 16px; margin: 12px 0 6px; }
    .project, main:has(#project:checked) .session { display: none; }
    main:has(#project:checked) .project { display: block; }
    summary { cursor: pointer; }
    button { margin-top: 8px; font: inherit; }
  </style>
  <main>
    <fieldset>
      <legend>Workspace view</legend>
      <label><input type="radio" name="view" checked>Current session</label>
      <label><input type="radio" name="view" id="project">Project overview</label>
    </fieldset>
    <h2 class="session">Current session · UI review</h2>
    <h2 class="project">Project overview · Example workspace</h2>
    <details><summary>View changes</summary><p>Example branch</p></details>
    <button id="counter" type="button">Count 0</button>
  </main>
  <script>const counter = document.getElementById('counter'); counter.onclick = () => { counter.textContent = 'Count 1'; };</script>
`;

test("committed assistant visualization can start and stop scripts inline with independent expanded consent", async ({ page }, info) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  const state = createBaseState({ approvalStatus: "expired" });
  const title = installNormalWorkCellFixture(state);
  const body = "This paragraph is before the prototype.\n\n[Workspace mockup](#ling-visualization-v1-" + artifactId +
    ")\n\nThis paragraph is after the prototype.";
  const runId = "run_ui2_normal_work_cell";
  state.eventsByRun[runId] = state.eventsByRun[runId]!.map(event => ({
    ...event, data: { ...event.data, text: body },
  }));
  state.terminalReports = [];
  await mockDaemon(page, state);
  let reads = 0;
  await page.route("**/conversation-visualizations/" + artifactId + "?*", async route => {
    const query = new URL(route.request().url()).searchParams;
    expect(query.get("threadId")).toBe("thread_ui2_normal_work_cell");
    expect(query.get("messageId")).toBeTruthy();
    reads += 1;
    await route.fulfill({ json: {
      artifactId, title: "Workspace mockup", summary: "Example data", html, interaction: "script", layout: "wide",
      sizeBytes: Buffer.byteLength(html), sha256: "0".repeat(64), preferredHeight: 252,
    } });
  });
  const open = async () => {
    await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).locator(".sidebar-recent-row").filter({ hasText: title }).click();
    await expect(page.getByLabel("Conversation page")).toBeVisible();
  };
  await page.goto("/");
  await open();
  const figure = page.locator(".conversation-visualization");
  await expect(figure.getByText("Example data")).toBeVisible();
  const inline = page.locator("iframe[data-conversation-visualization-frame='inline']");
  await expect(inline).toHaveAttribute("sandbox", "");
  const bounds = await figure.boundingBox();
  expect(bounds).not.toBeNull();
  const before = await page.getByText("This paragraph is before the prototype.").boundingBox();
  const after = await page.getByText("This paragraph is after the prototype.").boundingBox();
  expect(before!.y).toBeLessThan(bounds!.y);
  expect(after!.y).toBeGreaterThan(bounds!.y + bounds!.height);
  const innerInline = page.frameLocator("iframe[data-conversation-visualization-frame='inline']").frameLocator("iframe").frameLocator("iframe");
  await innerInline.getByRole("radio", { name: "Project overview" }).check();
  await expect(innerInline.getByRole("heading", { name: "Project overview · Example workspace" })).toBeVisible();
  await innerInline.getByText("View changes").click();
  await expect(innerInline.getByText("Example branch")).toBeVisible();
  await innerInline.getByRole("button", { name: "Count 0" }).click();
  await expect(innerInline.getByRole("button", { name: "Count 0" })).toBeVisible();
  const runInline = figure.getByRole("button", { name: "Run interactive preview", exact: true });
  const stopInline = figure.getByRole("button", { name: "Stop interactive preview", exact: true });
  await runInline.click();
  await expect(inline).toHaveAttribute("sandbox", "allow-scripts");
  await innerInline.getByRole("button", { name: "Count 0" }).click();
  await expect(innerInline.getByRole("button", { name: "Count 1" })).toBeVisible();
  if (process.env.LING_CAPTURE_UI2_EVIDENCE === "1") {
    await figure.screenshot({ path: info.outputPath("visualization-inline.png") });
  }

  await stopInline.click();
  await expect(runInline).toBeFocused();
  await expect(inline).toHaveAttribute("sandbox", "");
  await expect(innerInline.getByRole("button", { name: "Count 0" })).toBeVisible();
  await runInline.click();
  const expand = figure.getByRole("button", { name: "Expand", exact: true });
  await expand.click();
  const dialog = page.getByRole("dialog", { name: "Workspace mockup" });
  await expect(inline).toHaveCount(0);
  const expanded = dialog.frameLocator("iframe[data-conversation-visualization-frame='expanded']").frameLocator("iframe").frameLocator("iframe");
  await dialog.getByRole("button", { name: "Run interactive preview", exact: true }).click();
  await expanded.getByRole("button", { name: "Count 0" }).click();
  await expect(expanded.getByRole("button", { name: "Count 1" })).toBeVisible();
  await dialog.getByRole("button", { name: "Close preview" }).click();
  await expect(expand).toBeFocused();
  await expect(inline).toHaveAttribute("sandbox", "");
  await expand.click();
  await expect(dialog.getByRole("button", { name: "Run interactive preview", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Close preview" }).click();
  expect(reads).toBe(1);

  await page.reload();
  await open();
  await expect(figure.getByText("Example data")).toBeVisible();
  await expect(runInline).toBeVisible();
  await expect(inline).toHaveAttribute("sandbox", "");
  expect(reads).toBe(2);
});
