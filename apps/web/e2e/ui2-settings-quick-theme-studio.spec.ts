import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/features/quick-theme-first-run/",
  import.meta.url,
));

const validPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test("Quick Theme Studio generates and installs a token-only theme without generation requests", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state);
  await page.goto("/");
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: /Interface preferences/ }).click();
  await page.getByRole("button", { name: "Create theme" }).click();

  const studio = page.locator("[data-ui2-theme-studio]");
  await expect(studio).toBeVisible();
  const generationRequests: string[] = [];
  page.on("request", (request) => {
    if (/127\.0\.0\.1:17891\/(providers|media|runs)/u.test(request.url())) generationRequests.push(request.url());
  });
  const fileInput = studio.locator('input[type="file"]');
  await expect(fileInput).toBeEnabled();
  await fileInput.setInputFiles({
    name: "quiet-sky.png",
    mimeType: "image/png",
    buffer: validPng,
  });
  await expect(studio.getByRole("textbox", { name: "Theme name" })).toHaveValue("quiet-sky");
  await studio.getByRole("button", { name: "Generate preview" }).click();
  await expect(studio.locator("[data-theme-studio-preview-fixture]")).toBeVisible();
  await expect(studio.locator(".ling-ui-theme-studio-preview-artwork")).toHaveCount(0);
  expect(generationRequests).toEqual([]);
  await page.screenshot({ animations: "disabled", path: `${evidenceDirectory}1440x960-ling-light-quick-theme.png` });

  await studio.getByRole("button", { name: "Install and use" }).click();
  await expect(page.getByText("Theme installed and applied")).toBeVisible();
  const stored = await page.evaluate(async () => {
    return await new Promise<{ artwork: unknown; assetCount: number; generationMode: unknown; profileId: unknown }>((resolve, reject) => {
      const request = indexedDB.open("ling-stack-ui2");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction(["themes", "theme-assets"], "readonly");
        const manifestRequest = transaction.objectStore("themes").getAll();
        const assetRequest = transaction.objectStore("theme-assets").getAll();
        transaction.oncomplete = () => {
          const manifest = manifestRequest.result.find((item) => item.source === "local-generated");
          resolve({
            artwork: manifest?.artwork,
            assetCount: assetRequest.result.filter((item) => item.themeId === manifest?.id).length,
            generationMode: manifest?.generation?.mode,
            profileId: manifest?.presentation?.profileId,
          });
          database.close();
        };
        transaction.onerror = () => reject(transaction.error);
      };
    });
  });
  expect(stored).toEqual({ artwork: undefined, assetCount: 0, generationMode: "quick", profileId: "ling-standard" });

  await studio.getByRole("button", { name: "Back to themes" }).click();
  await expect(page.getByRole("button", { name: /quiet-sky/ })).toBeVisible();
  await page.reload();
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: /Interface preferences/ }).click();
  await page.getByRole("button", { name: "Create theme" }).click();
  await expect(page.getByRole("textbox", { name: "Theme name" })).toHaveValue("quiet-sky");
  await expect(page.getByText("quiet-sky.png")).toBeVisible();
});

test("Quick Theme Studio keeps the canvas readable at 1280x800 in dark mode", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  await page.setViewportSize({ width: 1280, height: 800 });
  const state = createBaseState({ approvalStatus: "expired" });
  state.workspaceSettings.theme = "dark";
  await mockDaemon(page, state);
  await page.goto("/");
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: /Interface preferences/ }).click();
  await page.getByRole("button", { name: "Create theme" }).click();
  const studio = page.locator("[data-ui2-theme-studio]");
  const fileInput = studio.locator('input[type="file"]');
  await expect(fileInput).toBeEnabled();
  await fileInput.setInputFiles({
    name: "night-sky.png",
    mimeType: "image/png",
    buffer: validPng,
  });
  await studio.getByRole("button", { name: "Generate preview" }).click();
  await expect(studio.locator("[data-theme-studio-preview-fixture]")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "ling-dark");
  await page.screenshot({ animations: "disabled", path: `${evidenceDirectory}1280x800-ling-dark-quick-theme.png` });
});
