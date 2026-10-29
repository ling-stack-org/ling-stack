import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { startExecutionEngineFixture } from "./support/execution-engine-fixture.mjs";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/settings/execution-engines/",
  import.meta.url,
));

async function captureEvidence(page: Page, name: string): Promise<void> {
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({ path: `${evidenceDirectory}${name}` });
}

async function clickSettingsEntry(page: Page): Promise<void> {
  const settingsEntry = page.locator('button[aria-label="Settings"], button[aria-label="设置"]');
  await settingsEntry.waitFor({ state: "attached" });
  // A fresh fixture home shows the first-run dialog; dismiss it before real clicks work.
  const skipFirstRun = page.getByRole("button", { name: /Skip for now|稍后再说/ }).first();
  if (await skipFirstRun.isVisible().catch(() => false)) await skipFirstRun.click();
  await settingsEntry.click();
}

test("engine settings discovers installed engines and offers managed install", async ({ page }) => {
  test.setTimeout(90_000);
  const fixture = await startExecutionEngineFixture({ port: 17891, origin: "http://127.0.0.1:4174" });
  try {
    const enrollment = await fixture.enroll();
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await clickSettingsEntry(page);
    const laterButton = page.getByRole("button", { name: /稍后再说|Later|Maybe later/ }).first();
    if (await laterButton.isVisible().catch(() => false)) await laterButton.click();
    await page.getByLabel(/Settings sections|设置分组/).getByRole("button", { name: /Execution engines|执行引擎/ }).click();

    const codeInput = page.getByLabel(/Authorization code|授权码/);
    await expect(codeInput).toBeVisible();
    await codeInput.fill(enrollment.code);
    await page.getByRole("button", { name: /Confirm|确认/ }).click();

    const codexRow = page.locator('[data-engine-id="codex-app-server"]');
    await expect(codexRow).toBeVisible();
    await expect(codexRow).toContainText(/使用检测到的|Use detected/, { timeout: 30_000 });
    await captureEvidence(page, "1440x960-engine-discovery-en-US.png");
  } finally {
    await fixture.close();
  }
});
