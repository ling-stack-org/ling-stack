import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";
import {
  channelEventFilterToggle,
  channelEventFilters,
  openChannelChatTools,
  openEngineeringChannel,
} from "./support/test-helpers";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/conversations/channel-activity-work-thread/",
  import.meta.url,
));

test("Channel Activity keeps filters, search, drilldown, and triage contained", async ({ page }) => {
  await prepareSurface(page, "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state);

  await page.goto("/");
  await openChannelChatTools(page);

  const filters = channelEventFilters(page).first();
  const search = filters.getByPlaceholder("Search activity");
  const filterToggle = channelEventFilterToggle(filters);
  await expect(filters).toBeVisible();
  await expectNestedInputContained(search);

  await filterToggle.focus();
  await filterToggle.press("Enter");
  await expect(filterToggle).toHaveAttribute("aria-expanded", "true");
  const filterPanel = filters.locator(".activity-filter-panel");
  await expect(filterPanel).toBeVisible();
  await expect(filterPanel.getByLabel("Activity categories")).toBeVisible();
  await expect(filterPanel.getByLabel("Activity attention filters")).toBeVisible();
  await captureEvidence(page, "1440x960-ling-light-filters-open.png");

  const failedFilter = filterPanel
    .getByLabel("Activity attention filters")
    .locator(".activity-filter-chip")
    .filter({ hasText: "Failed" });
  await failedFilter.click();
  await expect(failedFilter).toHaveAttribute("aria-pressed", "true");
  await filters.getByRole("button", { name: "Clear" }).click();

  await search.fill("definitely-not-present");
  await expect(page.getByText("No activity matches these filters")).toBeVisible();
  await expect(page.getByLabel("Channel composer")).toBeVisible();
  await captureEvidence(page, "1440x960-ling-light-search-no-result.png");

  await search.fill("run_failed");
  const runEvent = page.locator(".message-bubble")
    .filter({ hasText: "Run event" })
    .filter({ hasText: "Inspect workspace" });
  await expect(runEvent).toBeVisible();
  await runEvent.getByRole("button", { name: "Details" }).click();

  const drilldown = page.getByLabel("Activity details");
  await expect(drilldown).toBeVisible();
  await expect(drilldown).toContainText("Run run_failed");
  const sourceDetails = drilldown.locator(".activity-drilldown-disclosure").filter({ hasText: "Source metadata" });
  const sourceSummary = sourceDetails.locator("summary");
  await sourceSummary.focus();
  await sourceSummary.press("Enter");
  await expect(sourceDetails).toHaveAttribute("open", "");
  await captureEvidence(page, "1440x960-ling-light-drilldown-open.png");

  const triage = drilldown.locator(".activity-triage-section");
  if ((await triage.getAttribute("open")) === null) {
    await triage.locator("summary").click();
  }
  await drilldown.getByRole("button", { name: "Create follow-up task" }).click();
  await drilldown.getByLabel("Triage title").fill("Investigate UI2 Activity failure");
  state.failNextTaskCreate = true;
  await drilldown.getByRole("button", { name: "Run triage action" }).click();
  await expect(drilldown.getByRole("alert")).toContainText("Triage action failed");
  await expect(drilldown.getByRole("button", { name: "Retry" })).toBeVisible();
  await captureEvidence(page, "1440x960-ling-light-triage-failed.png");

  await drilldown.getByRole("button", { name: "Retry" }).click();
  await expect(drilldown.getByRole("status")).toContainText("Triage action created");
  await expect.poll(() => state.tasks.some((task) => task.title === "Investigate UI2 Activity failure")).toBe(true);
  await captureEvidence(page, "1440x960-ling-light-triage-succeeded.png");

  await drilldown.getByLabel("Close details").click();
  await expect(drilldown).toHaveCount(0);
  await expect(search).toHaveValue("run_failed");
  await expectContained(filters);
  await expectDocumentContained(page);
  expect(runtimeErrors).toEqual([]);
});

test("Work Thread CSS specimen covers long, selected, error, empty, and archive states", async ({ page }) => {
  await prepareSurface(page, "dark", 1280, 800);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state);

  await page.goto("/");
  await openEngineeringChannel(page);
  await installWorkThreadSpecimen(page);

  const tree = page.locator("[data-ui2-work-thread-specimen]");
  await expect(tree).toBeVisible();
  await expect(tree).toContainText("Loading");
  await expect(tree.getByRole("alert")).toContainText("Branch refresh failed");
  await expect(tree).toContainText("No active branches match");

  const search = tree.getByRole("searchbox", { name: "Search branches" });
  await expectNestedInputContained(search);
  await search.fill("release");
  await expectNestedInputContained(search);

  const longBranch = tree.getByRole("button", { name: /Release readiness branch/ });
  await longBranch.focus();
  await longBranch.press("Enter");
  await expect(longBranch.locator("xpath=ancestor::*[contains(@class, 'channel-work-thread-row-shell')][1]"))
    .toHaveClass(/selected/u);

  await tree.getByRole("button", { name: "Archive release branch" }).click();
  const confirmation = tree.getByTestId("archive-confirmation");
  await expect(confirmation).toBeVisible();
  await expect(confirmation.getByRole("button", { name: "Confirm" })).toBeVisible();
  await confirmation.getByRole("button", { name: "Cancel" }).click();
  await expect(confirmation).toBeHidden();

  await expectContained(tree);
  await expectDocumentContained(page);
  await captureEvidence(page, "1280x800-ling-dark-work-thread-states.png");
  await captureElementEvidence(tree, "1280x800-ling-dark-work-thread-detail.png");
  expect(runtimeErrors).toEqual([]);
});

async function prepareSurface(
  page: Page,
  theme: "light" | "dark",
  width: number,
  height: number,
): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.addInitScript((resolvedTheme) => {
    const selection = { mode: "fixed", themeId: `ling-${resolvedTheme}` };
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themePreference", resolvedTheme);
    localStorage.setItem("ling-stack.themeBootstrapPreference", resolvedTheme);
  }, theme);
}

async function installWorkThreadSpecimen(page: Page): Promise<void> {
  await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>(".activity-chat-main");
    if (!host) throw new Error("Activity host is unavailable");
    const tree = document.createElement("div");
    tree.className = "channel-work-thread-tree";
    tree.dataset.ui2WorkThreadSpecimen = "true";
    tree.setAttribute("aria-label", "Channel branches CSS specimen");
    tree.innerHTML = `
      <div class="channel-work-thread-tree-head">
        <span>Conversation branches</span>
        <small>Loading</small>
      </div>
      <label class="activity-search-field channel-work-thread-search-field">
        <input type="search" aria-label="Search branches" placeholder="Search branches" />
      </label>
      <div class="inline-error compact" role="alert">Branch refresh failed</div>
      <div class="channel-work-thread-row-list">
        <div class="channel-work-thread-row-shell selected">
          <button class="channel-work-thread-row selected" type="button" aria-label="All branches">
            <span aria-hidden="true">#</span>
            <span class="channel-work-thread-row-main">
              <strong>All branches</strong>
              <small>4 branches</small>
            </span>
          </button>
        </div>
        <div class="channel-work-thread-row-shell" data-long-branch>
          <button class="channel-work-thread-row" type="button" aria-label="Release readiness branch with an intentionally long title for containment verification">
            <span class="status-dot running"></span>
            <span class="channel-work-thread-row-main">
              <strong>Release readiness branch with an intentionally long title for containment verification</strong>
              <small>Fork branch · pinned · thread_release_readiness_with_long_identifier</small>
            </span>
          </button>
          <button class="icon-button" type="button" aria-label="Archive release branch">A</button>
          <span data-testid="archive-confirmation" hidden>
            <button class="secondary-button compact-button danger" type="button">Confirm</button>
            <button class="secondary-button compact-button" type="button">Cancel</button>
          </span>
        </div>
        <div class="empty-state compact-empty">
          <span>No active branches match</span>
        </div>
      </div>
    `;
    const longShell = tree.querySelector<HTMLElement>("[data-long-branch]");
    const longButton = longShell?.querySelector<HTMLButtonElement>(".channel-work-thread-row");
    const archiveButton = longShell?.querySelector<HTMLButtonElement>("[aria-label='Archive release branch']");
    const confirmation = longShell?.querySelector<HTMLElement>("[data-testid='archive-confirmation']");
    longButton?.addEventListener("click", () => longShell?.classList.add("selected"));
    archiveButton?.addEventListener("click", () => {
      if (confirmation) confirmation.hidden = false;
    });
    confirmation?.querySelector<HTMLButtonElement>("button:last-child")?.addEventListener("click", () => {
      confirmation.hidden = true;
    });
    host.prepend(tree);
  });
}

async function expectNestedInputContained(input: Locator): Promise<void> {
  const shell = input.locator("xpath=ancestor::label[contains(@class, 'activity-search-field')][1]");
  const before = await readNestedInputGeometry(input, shell);
  await input.focus();
  const after = await readNestedInputGeometry(input, shell);
  expect(Math.round(before.shellHeight)).toBe(34);
  expect(after.inputHeight).toBe(before.inputHeight);
  expect(after.shellHeight).toBe(before.shellHeight);
  expect(after.inputTop).toBeGreaterThanOrEqual(after.shellTop);
  expect(after.inputBottom).toBeLessThanOrEqual(after.shellBottom);
  expect(after.borderTopWidth).toBe("0px");
  expect(after.boxShadow).toBe("none");
  expect(after.outlineStyle).toBe("none");
}

async function readNestedInputGeometry(input: Locator, shell: Locator): Promise<{
  readonly borderTopWidth: string;
  readonly boxShadow: string;
  readonly inputBottom: number;
  readonly inputHeight: number;
  readonly inputTop: number;
  readonly outlineStyle: string;
  readonly shellBottom: number;
  readonly shellHeight: number;
  readonly shellTop: number;
}> {
  const shellBox = await shell.boundingBox();
  const inputBox = await input.boundingBox();
  if (!shellBox || !inputBox) throw new Error("Nested input geometry is unavailable");
  const style = await input.evaluate((element) => {
    const computed = getComputedStyle(element);
    return {
      borderTopWidth: computed.borderTopWidth,
      boxShadow: computed.boxShadow,
      outlineStyle: computed.outlineStyle,
    };
  });
  return {
    ...style,
    inputBottom: inputBox.y + inputBox.height,
    inputHeight: inputBox.height,
    inputTop: inputBox.y,
    shellBottom: shellBox.y + shellBox.height,
    shellHeight: shellBox.height,
    shellTop: shellBox.y,
  };
}

async function expectContained(locator: Locator): Promise<void> {
  await expect.poll(() => locator.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }))).toMatchObject({
    clientWidth: expect.any(Number),
    scrollWidth: expect.any(Number),
  });
  expect(await locator.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
}

async function expectDocumentContained(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth
  )).toBeLessThanOrEqual(1);
}

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function captureEvidence(page: Page, filename: string): Promise<void> {
  if (process.env.LING_CAPTURE_UI2_EVIDENCE !== "1") return;
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: `${evidenceDirectory}${filename}`,
  });
}

async function captureElementEvidence(locator: Locator, filename: string): Promise<void> {
  if (process.env.LING_CAPTURE_UI2_EVIDENCE !== "1") return;
  await mkdir(evidenceDirectory, { recursive: true });
  await locator.screenshot({
    animations: "disabled",
    path: `${evidenceDirectory}${filename}`,
  });
}
