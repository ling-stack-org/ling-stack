import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createExternalWorkStatus } from "./support/mock-state";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/settings/external-work/",
  import.meta.url,
));

test("External Work keeps no-channel and ready GitHub states quiet and truthful", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "light", "en-US", 1440, 960);
  const state = createBaseState({ approvalStatus: "pending" });
  await mockDaemon(page, state);
  await page.goto("/");

  await openExternalWork(page, false);
  const panel = page.locator("[data-ui2-external-work]");
  await expect(panel.getByText("Select a channel", { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Refresh external work status" })).toHaveCount(0);

  await page.getByRole("button", { name: "Back to app" }).click();
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();
  await openExternalWork(page, false);

  await expect(panel).toBeVisible();
  await expect(panel).not.toHaveClass(/\bexternal-work-settings-panel\b/);
  await expect(panel.getByRole("heading", { name: "External work" })).toHaveCount(0);
  await expect(panel.getByText("Connection status", { exact: true })).toBeVisible();
  await expect(panel.locator(".settings-external-work-overall-row").getByText("openclaw/openclaw", { exact: true })).toBeVisible();
  await expect(panel.locator(".ling-ui-status-indicator").getByText("Ready", { exact: true })).toHaveCount(3);
  await expect(panel.getByRole("button", { name: "Poll once" })).toBeEnabled();
  await expect(panel.getByRole("button", { name: "Reconcile" })).toBeEnabled();
  await expect(panel.getByRole("button", { name: "Start background" })).toBeEnabled();
  await expect(panel.getByText("env:GITHUB_TOKEN", { exact: true })).toBeHidden();
  await expect(panel.getByText(/View records|View CI triage/)).toHaveCount(0);
  await expect(panel.locator(".settings-external-work-summary-row")).toHaveCount(3);
  await expectNoHorizontalOverflow(panel);
  await expectNoPageOverflow(page);
  await captureEvidence(page, "1440x960-ling-light-ready-github.png");
  expect(runtimeErrors).toEqual([]);
});

test("status loading is local and refresh failure keeps the last loaded state", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "light", "en-US", 1280, 800);
  const state = createBaseState({ approvalStatus: "pending" });
  await mockDaemon(page, state);
  const gate = deferred();
  let statusMode: "hold" | "ok" | "fail" = "hold";
  await page.route("**/external-work/status?**", async (route) => {
    if (statusMode === "hold") {
      await gate.promise;
      await route.fallback();
      return;
    }
    if (statusMode === "fail") {
      await route.fulfill({ status: 503, json: { message: "Synthetic status failure" } });
      return;
    }
    await route.fallback();
  });
  await page.goto("/");
  const panel = await openExternalWork(page);

  await expect(panel.getByRole("status", { name: "Loading external work status" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Refresh external work status" })).toHaveAttribute("aria-busy", "true");
  statusMode = "ok";
  gate.resolve();
  await expect(panel.locator(".settings-external-work-overall-row").getByText("openclaw/openclaw", { exact: true })).toBeVisible();

  statusMode = "fail";
  await panel.getByRole("button", { name: "Refresh external work status" }).click();
  await expect(panel).toContainText("External work status could not be refreshed. The last loaded state is still shown.");
  await expect(panel.locator(".settings-external-work-overall-row").getByText("openclaw/openclaw", { exact: true })).toBeVisible();
  await panel.getByText("Status error details", { exact: true }).click();
  await expect(panel).toContainText("Synthetic status failure");
  await expectNoPageOverflow(page);
  await captureEvidence(page, "1280x800-ling-light-status-refresh-failure.png");
  expect(runtimeErrors).toEqual([]);
});

test("missing workflow validates the target and keeps parser detail collapsed", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "dark", "en-US", 1280, 800, "reduce");
  const state = createBaseState({ approvalStatus: "pending" });
  state.externalWorkStatus = createExternalWorkStatus({
    sourceKind: "unknown",
    workflowError: "WORKFLOW.md was not found at a deliberately long local path /tmp/example/workspace/WORKFLOW.md",
    workflowExists: false,
    workflowValid: false,
  });
  await mockDaemon(page, state);
  await page.goto("/");
  const panel = await openExternalWork(page);

  await expect(panel).toContainText("Create WORKFLOW.md before connecting an external source.");
  await expect(panel.getByText(/WORKFLOW\.md was not found at/)).toBeHidden();
  const repository = panel.getByLabel("Repository");
  await repository.fill("https://example.com/not-github");
  await expect(panel).toContainText("Enter owner/repository or a valid GitHub URL.");
  await expect(panel.getByRole("button", { name: "Create WORKFLOW.md" })).toBeDisabled();
  await expect(panel.getByRole("button", { name: "Save GitHub token" })).toHaveCount(0);
  await captureEvidence(page, "1280x800-ling-dark-workflow-missing.png");

  await repository.fill("https://github.com/owner/repository.git");
  await panel.getByRole("button", { name: "Create WORKFLOW.md" }).click();
  await expect.poll(() => state.externalWorkWorkflowConfigureCalls).toBe(1);
  await expect.poll(() => state.lastExternalWorkWorkflowConfigure?.repository).toBe("owner/repository");
  await expect(panel.locator(".settings-external-work-overall-row").getByText("owner/repository", { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: /Delete WORKFLOW/i })).toHaveCount(0);
  await expectNoHorizontalOverflow(panel);
  expect(runtimeErrors).toEqual([]);
});

test("Keychain token deletion requires confirmation and keeps a failed request in its Dialog", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "dark", "en-US", 1280, 800);
  const state = createBaseState({ approvalStatus: "pending" });
  state.externalWorkStatus = createExternalWorkStatus({ secretStatus: "missing" });
  await mockDaemon(page, state);
  let failDelete = false;
  await page.route("**/external-work/secrets/delete?**", async (route) => {
    if (failDelete) {
      await route.fulfill({ status: 503, json: { message: "Synthetic Keychain delete failure" } });
      return;
    }
    await route.fallback();
  });
  await page.goto("/");
  const panel = await openExternalWork(page);

  const token = panel.getByLabel("Token");
  await token.fill("temporary-token-value");
  await panel.getByRole("button", { name: "Save GitHub token" }).click();
  await expect.poll(() => state.externalWorkSecretConfigureCalls).toBe(1);
  await expect(token).toHaveCount(0);

  const removeTrigger = panel.getByRole("button", { name: "Remove token" });
  await removeTrigger.click();
  let dialog = page.getByRole("dialog", { name: "Remove external token?" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(removeTrigger).toBeFocused();
  expect(state.externalWorkSecretDeleteCalls).toBe(0);

  failDelete = true;
  await removeTrigger.click();
  dialog = page.getByRole("dialog", { name: "Remove external token?" });
  await dialog.getByRole("button", { name: "Remove token" }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("alert")).toContainText("The external token could not be removed");
  await dialog.getByText("Error details", { exact: true }).click();
  await expect(dialog).toContainText("Synthetic Keychain delete failure");
  expect(state.externalWorkSecretDeleteCalls).toBe(0);
  await captureEvidence(page, "1280x800-ling-dark-token-delete-failure.png");

  failDelete = false;
  await dialog.getByRole("button", { name: "Remove token" }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => state.externalWorkSecretDeleteCalls).toBe(1);
  await expect(panel).toContainText("Credential required");
  expect(runtimeErrors).toEqual([]);
});

test("operation busy state is scoped and Linear keeps unsupported background truthful", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "dark", "zh-CN", 1280, 800);
  const state = createBaseState({ approvalStatus: "pending" });
  await mockDaemon(page, state);
  const pollGate = deferred();
  let holdPoll = true;
  await page.route("**/external-work/github/poll?**", async (route) => {
    if (holdPoll) await pollGate.promise;
    await route.fallback();
  });
  await page.goto("/");
  const panel = await openExternalWork(page, true, /外部工作/);

  const poll = panel.getByRole("button", { name: "轮询一次" });
  const reconcile = panel.getByRole("button", { name: "对账" });
  await poll.click();
  await expect(poll).toHaveAttribute("aria-busy", "true");
  await expect(reconcile).toBeDisabled();
  await expect(reconcile).not.toHaveAttribute("aria-busy", "true");
  holdPoll = false;
  pollGate.resolve();
  await expect.poll(() => state.externalWorkPollCalls.github ?? 0).toBe(1);
  await expect(poll).not.toHaveAttribute("aria-busy", "true");

  await panel.getByRole("button", { name: "启动后台轮询" }).click();
  await expect.poll(() => state.externalWorkBackgroundStartCalls).toBe(1);
  await expect(panel.getByRole("button", { name: "停止后台轮询" })).toBeVisible();

  state.externalWorkStatus = createExternalWorkStatus({ sourceKind: "linear" });
  await panel.getByRole("button", { name: "刷新外部工作状态" }).click();
  await expect(panel).toContainText("不支持");
  await expect(panel.getByRole("button", { name: /启动后台轮询|停止后台轮询/ })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "轮询一次" })).toBeEnabled();
  await expectNoHorizontalOverflow(panel);
  await expectNoPageOverflow(page);
  await captureEvidence(page, "1280x800-ling-dark-linear-unsupported-zh-CN.png");
  expect(runtimeErrors).toEqual([]);
});

async function prepareSurface(
  page: Page,
  theme: "dark" | "light",
  locale: "en-US" | "zh-CN",
  width: number,
  height: number,
  reducedMotion: "no-preference" | "reduce" = "no-preference",
): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.emulateMedia({ colorScheme: theme, reducedMotion });
  await page.addInitScript(({ locale: initialLocale, theme: initialTheme }) => {
    const themeId = initialTheme === "dark" ? "ling-dark" : "ling-light";
    const selection = { mode: "fixed", themeId };
    localStorage.setItem("ling-stack.locale", initialLocale);
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapPreference", initialTheme);
  }, { locale, theme });
}

async function openExternalWork(
  page: Page,
  selectChannel = true,
  sectionName: RegExp = /External work/,
): Promise<Locator> {
  if (selectChannel) {
    await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();
  }
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: /Settings|设置/ }).click();
  await page.getByLabel(/Settings sections|设置分组/).getByRole("button", { name: sectionName }).click();
  const panel = page.locator("[data-ui2-external-work]");
  await expect(panel).toBeVisible();
  return panel;
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((next) => { resolve = next; });
  return { promise, resolve };
}

async function expectNoHorizontalOverflow(locator: Locator): Promise<void> {
  const metrics = await locator.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
}

async function captureEvidence(page: Page, filename: string): Promise<void> {
  if (process.env.LING_CAPTURE_UI2_EVIDENCE !== "1") return;
  await mkdir(evidenceDirectory, { recursive: true });
  await page.locator(".settings-layout").screenshot({
    animations: "disabled",
    path: `${evidenceDirectory}${filename}`,
  });
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
