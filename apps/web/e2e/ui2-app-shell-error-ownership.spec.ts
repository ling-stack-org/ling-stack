import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";

const appShellPath = fileURLToPath(new URL("../src/app/AppShell.tsx", import.meta.url));
const approvalsPagePath = fileURLToPath(new URL("../src/features/approvals/ApprovalsPage.tsx", import.meta.url));
const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/shell/app-shell-error-ownership/",
  import.meta.url,
));
const releasedDomainPaths = [
  "../src/domains/approvals/use-approvals-domain.ts",
  "../src/domains/mcp/use-mcp-domain.ts",
  "../src/domains/providers/use-providers-domain.ts",
  "../src/domains/runs/use-runs-domain.ts",
  "../src/domains/settings/use-settings-domain.ts",
].map((path) => fileURLToPath(new URL(path, import.meta.url)));

test("T13-P.9C released domains cannot restore the generic AppShell error writer", async () => {
  const [appShell, approvalsPage, ...domains] = await Promise.all([
    readFile(appShellPath, "utf8"),
    readFile(approvalsPagePath, "utf8"),
    ...releasedDomainPaths.map((path) => readFile(path, "utf8")),
  ]);

  for (const domain of domains) expect(domain).not.toContain("setErrorMessage");
  for (const hook of [
    "useApprovalsDomain",
    "useMcpDomain",
    "useProvidersDomain",
    "useRunsDomain",
    "useSettingsDomain",
  ]) {
    expect(readHookCall(appShell, hook)).not.toContain("setErrorMessage");
  }

  expect(appShell).toContain('errorMessage={providersDomain.error?.message ?? ""}');
  expect(appShell).toContain('errorMessage={runsDomain.error?.message ?? ""}');
  expect(appShell).not.toContain(
    'errorMessage={approvalErrors[selectedApprovalId] ?? approvalsDomain.error?.message ?? ""}',
  );
  expect(appShell).toContain('errorMessage={approvalsDomain.error?.message ?? ""}');
  expect(appShell).toContain("approvalErrors={approvalErrors}");
  expect(approvalsPage).toContain('errorMessage={controller.selectedRow ? approvalErrors[controller.selectedRow.id] ?? "" : ""}');
});

for (const fixture of [
  { height: 960, theme: "light" as const, width: 1440 },
  { height: 800, theme: "dark" as const, width: 1280 },
]) {
  test(`a Provider load failure stays in Model Workbench and never leaks into Channel at ${fixture.width} ${fixture.theme}`, async ({ page }) => {
    await page.setViewportSize({ width: fixture.width, height: fixture.height });
    await page.emulateMedia({ colorScheme: fixture.theme });
    await page.addInitScript((theme) => {
      const selection = { mode: "fixed", themeId: `ling-${theme}` };
      localStorage.setItem("ling-stack.locale", "en-US");
      localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
      localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    }, fixture.theme);
    const state = createBaseState({ approvalStatus: "expired" });
    await mockDaemon(page, state);
    await page.route(/\/providers(?:\?.*)?$/u, async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 503,
        json: { message: "Synthetic scoped Provider failure" },
      });
    });
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.goto("/");
    const navigation = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u });
    await navigation.getByRole("button", { name: "Engineering", exact: true }).click();
    await expect(page.getByLabel("Channel composer")).toBeVisible();
    await expect(page.getByText("Synthetic scoped Provider failure", { exact: true })).toHaveCount(0);

    await navigation.getByRole("button", { name: "Settings" }).click();
    await page.getByLabel("Settings sections").getByRole("button", { name: "Model Workbench" }).click();
    const workbench = page.locator(".provider-workbench");
    await expect(workbench.locator(".provider-page-error")).toContainText("Synthetic scoped Provider failure");
    await captureEvidence(page, `${fixture.width}x${fixture.height}-ling-${fixture.theme}-provider-failure.png`);

    await page.getByLabel("Settings sections").getByRole("button", { name: "Back to app" }).click();
    await expect(page.getByLabel("Channel composer")).toBeVisible();
    await expect(page.getByText("Synthetic scoped Provider failure", { exact: true })).toHaveCount(0);
    await captureEvidence(page, `${fixture.width}x${fixture.height}-ling-${fixture.theme}-channel-clean.png`);
    await expectNoDocumentOverflow(page);
    expect(pageErrors).toEqual([]);
  });
}

function readHookCall(source: string, hook: string): string {
  const start = source.indexOf(`${hook}({`);
  if (start < 0) throw new Error(`Missing ${hook} call`);
  const end = source.indexOf("\n  });", start);
  if (end < 0) throw new Error(`Missing ${hook} call boundary`);
  return source.slice(start, end);
}

async function expectNoDocumentOverflow(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth
  )).toBeLessThanOrEqual(1);
}

async function captureEvidence(page: Page, filename: string): Promise<void> {
  if (process.env.LING_CAPTURE_UI2_EVIDENCE !== "1") return;
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    caret: "hide",
    fullPage: false,
    path: `${evidenceDirectory}${filename}`,
  });
}
