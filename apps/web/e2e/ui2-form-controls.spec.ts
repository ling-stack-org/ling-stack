import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createExternalWorkStatus } from "./support/mock-state";
import { openChannelChatTools } from "./support/test-helpers";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/settings/ui-form-foundation/",
  import.meta.url,
));

test("UI 2.0 Field and Select connect labels, descriptions, and stable sizing", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSettings(page, "light", 1440, 960);
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state);
  await page.goto("/");
  await openSettingsSection(page, /Personalization/);

  const governance = page.locator(".settings-skill-governance");
  const field = governance.locator(".ling-ui-field").first();
  const select = field.getByRole("combobox");
  const controlId = await select.getAttribute("id");
  expect(controlId).toBeTruthy();
  await expect(field.locator(`label[for="${controlId}"]`)).toHaveText("Candidate generation");
  await expect(select).toHaveAttribute("aria-describedby", `${controlId}-description`);
  await expect(select).toHaveAttribute("data-ling-control-native", "true");
  await expect(field.locator("[id$='-description']")).toContainText("stable success");
  const selectShell = select.locator("xpath=ancestor::span[contains(@class, 'ling-ui-select')]");
  const heightBeforeFocus = await selectShell.evaluate((element) => element.getBoundingClientRect().height);
  await select.focus();
  const focusGeometry = await select.evaluate((element) => {
    const shell = element.closest(".ling-ui-select");
    if (!shell) throw new Error("Shared Select shell is missing");
    const nativeBox = element.getBoundingClientRect();
    const shellBox = shell.getBoundingClientRect();
    const styles = getComputedStyle(element);
    const shellStyles = getComputedStyle(shell);
    return {
      borderTopWidth: styles.borderTopWidth,
      boxShadow: styles.boxShadow,
      nativeBottom: nativeBox.bottom,
      nativeTop: nativeBox.top,
      shellBottom: shellBox.bottom,
      shellBoxShadow: shellStyles.boxShadow,
      shellTop: shellBox.top,
    };
  });
  expect(await selectShell.evaluate((element) => element.getBoundingClientRect().height)).toBe(heightBeforeFocus);
  expect(focusGeometry.borderTopWidth).toBe("0px");
  expect(focusGeometry.boxShadow).toBe("none");
  expect(focusGeometry.shellBoxShadow).toContain("inset");
  expect(focusGeometry.nativeTop).toBeGreaterThanOrEqual(focusGeometry.shellTop);
  expect(focusGeometry.nativeBottom).toBeLessThanOrEqual(focusGeometry.shellBottom);
  await expectNoHorizontalOverflow(governance);

  await captureEvidence(page, "1440x960-ling-light-personalization.png");
  expect(runtimeErrors).toEqual([]);
});

test("UI 2.0 Input and Field keep external-work forms readable in dark compact desktop", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSettings(page, "dark", 1280, 800);
  const state = createBaseState({ approvalStatus: "pending" });
  state.externalWorkStatus = createExternalWorkStatus({
    secretStatus: "missing",
    workflowError: "source.kind is required",
    workflowValid: false,
  });
  await mockDaemon(page, state);
  await page.goto("/");
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();
  await openSettingsSection(page, /External work/);

  const panel = page.locator("[data-ui2-external-work]");
  await expect(panel.locator(".ling-ui-field")).toHaveCount(2);
  await expect(panel.locator(".ling-ui-input")).toHaveCount(1);
  await expect(panel.locator(".ling-ui-select")).toHaveCount(1);
  await expect(panel.getByLabel("Repository")).toBeVisible();
  await expect(panel.getByLabel("Token")).toHaveCount(0);
  const input = panel.getByLabel("Repository");
  await expect(input).toHaveAttribute("data-ling-control-native", "true");
  const inputShell = input.locator("xpath=ancestor::span[contains(@class, 'ling-ui-input')]");
  const heightBeforeFocus = await inputShell.evaluate((element) => element.getBoundingClientRect().height);
  await input.focus();
  const focusGeometry = await input.evaluate((element) => {
    const shell = element.closest(".ling-ui-input");
    if (!shell) throw new Error("Shared Input shell is missing");
    const nativeBox = element.getBoundingClientRect();
    const shellBox = shell.getBoundingClientRect();
    const styles = getComputedStyle(element);
    const shellStyles = getComputedStyle(shell);
    return {
      borderTopWidth: styles.borderTopWidth,
      boxShadow: styles.boxShadow,
      nativeBottom: nativeBox.bottom,
      nativeTop: nativeBox.top,
      shellBottom: shellBox.bottom,
      shellBoxShadow: shellStyles.boxShadow,
      shellTop: shellBox.top,
    };
  });
  expect(await inputShell.evaluate((element) => element.getBoundingClientRect().height)).toBe(heightBeforeFocus);
  expect(focusGeometry.borderTopWidth).toBe("0px");
  expect(focusGeometry.boxShadow).toBe("none");
  expect(focusGeometry.shellBoxShadow).toContain("inset");
  expect(focusGeometry.nativeTop).toBeGreaterThanOrEqual(focusGeometry.shellTop);
  expect(focusGeometry.nativeBottom).toBeLessThanOrEqual(focusGeometry.shellBottom);
  await expectNoHorizontalOverflow(panel);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await captureEvidence(page, "1280x800-ling-dark-external-work.png");
  expect(runtimeErrors).toEqual([]);
});

test("mixed migration keeps the shared New Channel input contained during focus", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSettings(page, "light", 1280, 800);
  const state = createBaseState({ approvalStatus: "pending" });
  state.channels = [];
  state.channelBranches = [];
  state.tasks = [];
  state.runs = [];
  state.approvals = [];
  await mockDaemon(page, state);
  await page.goto("/");
  await page.addStyleTag({ content: "*, *::before, *::after { animation: none !important; transition: none !important; }" });

  const navigation = page.getByLabel("Ling Stack navigation");
  await navigation.getByRole("button", { name: "No channel yet" }).click();
  const dialog = page.getByRole("dialog", { name: "New channel" });
  const input = dialog.getByLabel("Name");
  await expect(input).toHaveAttribute("data-ling-control-native", "true");
  const inputShell = input.locator("xpath=ancestor::span[contains(concat(' ', normalize-space(@class), ' '), ' ling-ui-input ')][1]");
  await expect(inputShell).toHaveCount(1);
  await dialog.getByRole("button", { name: "Cancel" }).last().focus();
  await expect(input).not.toBeFocused();
  const beforeFocus = await readSharedInputGeometry(input);
  await input.focus();
  await expect(input).toBeFocused();
  const afterFocus = await readSharedInputGeometry(input);
  expect(Math.abs(afterFocus.nativeHeight - beforeFocus.nativeHeight)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(afterFocus.nativeWidth - beforeFocus.nativeWidth)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(afterFocus.shellHeight - beforeFocus.shellHeight)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(afterFocus.shellWidth - beforeFocus.shellWidth)).toBeLessThanOrEqual(0.5);
  expect(afterFocus.nativeBorderWidth).toBe("0px");
  expect(afterFocus.nativeBoxShadow).toBe("none");
  expect(afterFocus.nativeOutlineStyle).toBe("none");
  expect(afterFocus.nativeOutlineWidth).toBe("0px");
  expect(afterFocus.shellBoxShadow).toContain("inset");
  expect(afterFocus.nativeTop).toBeGreaterThanOrEqual(afterFocus.shellTop - 0.5);
  expect(afterFocus.nativeBottom).toBeLessThanOrEqual(afterFocus.shellBottom + 0.5);
  await expectNoHorizontalOverflow(inputShell);
  await expectNoHorizontalOverflow(dialog);
  expect(runtimeErrors).toEqual([]);
});

test("legacy nested channel searches keep focus inside their fixed-height shells", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSettings(page, "dark", 1280, 800);
  const state = createBaseState({ approvalStatus: "pending" });
  state.threads = [{
    id: "thread_channel_focus",
    workspaceId: "workspace_default",
    kind: "channel_discussion",
    channelId: "channel_engineering",
    title: "Channel focus branch",
    objective: "Verify nested channel search containment.",
    status: "succeeded",
    createdAt: "2026-07-23T00:00:00.000Z",
    updatedAt: "2026-07-23T00:00:00.000Z",
  }];
  await mockDaemon(page, state);
  await page.goto("/");
  await openChannelChatTools(page);
  await installDecisionGatedWorkThreadSearchSpecimen(page);

  const searches = page.locator(".channel-work-thread-search-field > input:visible");
  expect(await searches.count()).toBeGreaterThanOrEqual(1);
  for (let index = 0; index < await searches.count(); index += 1) {
    const input = searches.nth(index);
    const shell = input.locator("xpath=ancestor::label[contains(@class, 'activity-search-field')]");
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

  await expectNoHorizontalOverflow(page.getByLabel(/Activity filters|Channel event filters/));
  if (process.env.LING_CAPTURE_UI2_EVIDENCE === "1") {
    await page.screenshot({
      animations: "disabled",
      fullPage: true,
      path: `${evidenceDirectory}1280x800-ling-dark-channel-nested-search-focus.png`,
    });
  }
  expect(runtimeErrors).toEqual([]);
});

async function prepareSettings(
  page: Page,
  theme: "dark" | "light",
  width: number,
  height: number,
): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.addInitScript((resolvedTheme) => {
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themePreference", resolvedTheme);
    localStorage.setItem("ling-stack.themeBootstrapPreference", resolvedTheme);
  }, theme);
}

async function openSettingsSection(page: Page, name: RegExp): Promise<void> {
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name }).click();
}

async function expectNoHorizontalOverflow(locator: Locator): Promise<void> {
  const metrics = await locator.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
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
  const [inputBox, shellBox, styles] = await Promise.all([
    input.boundingBox(),
    shell.boundingBox(),
    input.evaluate((element) => {
      const computed = getComputedStyle(element);
      return {
        borderTopWidth: computed.borderTopWidth,
        boxShadow: computed.boxShadow,
        outlineStyle: computed.outlineStyle,
      };
    }),
  ]);
  if (!inputBox || !shellBox) throw new Error("Nested input geometry is unavailable");
  return {
    ...styles,
    inputBottom: inputBox.y + inputBox.height,
    inputHeight: inputBox.height,
    inputTop: inputBox.y,
    shellBottom: shellBox.y + shellBox.height,
    shellHeight: shellBox.height,
    shellTop: shellBox.y,
  };
}

async function installDecisionGatedWorkThreadSearchSpecimen(page: Page): Promise<void> {
  await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>(".activity-chat-main");
    if (!host) throw new Error("Activity host is unavailable");
    const tree = document.createElement("div");
    tree.className = "channel-work-thread-tree";
    tree.dataset.ui2WorkThreadSearchSpecimen = "true";
    tree.setAttribute("aria-label", "Decision-gated Channel branches CSS specimen");
    tree.innerHTML = `
      <label class="activity-search-field channel-work-thread-search-field">
        <input type="search" aria-label="Search branches" placeholder="Search branches" />
      </label>
    `;
    host.prepend(tree);
  });
}

async function readSharedInputGeometry(input: Locator): Promise<{
  readonly nativeBorderWidth: string;
  readonly nativeBottom: number;
  readonly nativeBoxShadow: string;
  readonly nativeHeight: number;
  readonly nativeOutlineStyle: string;
  readonly nativeOutlineWidth: string;
  readonly nativeTop: number;
  readonly nativeWidth: number;
  readonly shellBottom: number;
  readonly shellBoxShadow: string;
  readonly shellHeight: number;
  readonly shellTop: number;
  readonly shellWidth: number;
}> {
  return input.evaluate((element) => {
    const shell = element.closest<HTMLElement>(".ling-ui-input");
    if (!shell) throw new Error("Shared Input shell is missing");
    const nativeBox = element.getBoundingClientRect();
    const shellBox = shell.getBoundingClientRect();
    const nativeStyles = getComputedStyle(element);
    const shellStyles = getComputedStyle(shell);
    return {
      nativeBorderWidth: nativeStyles.borderWidth,
      nativeBottom: nativeBox.bottom,
      nativeBoxShadow: nativeStyles.boxShadow,
      nativeHeight: nativeBox.height,
      nativeOutlineStyle: nativeStyles.outlineStyle,
      nativeOutlineWidth: nativeStyles.outlineWidth,
      nativeTop: nativeBox.top,
      nativeWidth: nativeBox.width,
      shellBottom: shellBox.bottom,
      shellBoxShadow: shellStyles.boxShadow,
      shellHeight: shellBox.height,
      shellTop: shellBox.top,
      shellWidth: shellBox.width,
    };
  });
}

async function captureEvidence(page: Page, filename: string): Promise<void> {
  if (process.env.LING_CAPTURE_UI2_EVIDENCE !== "1") {
    return;
  }
  await mkdir(evidenceDirectory, { recursive: true });
  await page.locator(".settings-layout").screenshot({
    animations: "disabled",
    path: `${evidenceDirectory}${filename}`,
  });
}

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}
