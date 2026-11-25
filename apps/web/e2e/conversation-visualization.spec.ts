import { expect, test } from "@playwright/test";
import { installNormalWorkCellFixture } from "./support/conversation-work-cell-fixture";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";

const artifactId = "viz_0123456789abcdef0123456789abcdef";
const html = [
  "<fieldset><legend>Workspace view</legend><label><input type='radio' name='view' checked>Current session</label>",
  "<label><input type='radio' name='view'>Project overview</label></fieldset>",
  "<details><summary>View changes</summary><p>Example branch</p></details>",
  "<button id='counter' type='button'>Count 0</button>",
  "<script>const counter = document.getElementById('counter'); counter.onclick = () => { counter.textContent = 'Count 1'; };</script>",
].join("");

test("committed assistant visualization is inline, expandable and separate from script consent", async ({ page }, info) => {
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
      sizeBytes: Buffer.byteLength(html), sha256: "0".repeat(64), preferredHeight: 240,
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
  await innerInline.getByText("View changes").click();
  await expect(innerInline.getByText("Example branch")).toBeVisible();
  await innerInline.getByRole("button", { name: "Count 0" }).click();
  await expect(innerInline.getByRole("button", { name: "Count 0" })).toBeVisible();
  if (process.env.LING_CAPTURE_UI2_EVIDENCE === "1") {
    await page.screenshot({ path: info.outputPath("visualization-inline.png") });
  }

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
  await expand.click();
  await expect(dialog.getByRole("button", { name: "Run interactive preview", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Close preview" }).click();
  expect(reads).toBe(1);

  await page.reload();
  await open();
  await expect(figure.getByText("Example data")).toBeVisible();
  expect(reads).toBe(2);
});
