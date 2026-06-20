import { expect, test } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";

test("profile avatar crop exports a transparent circular image", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Profile" }).click();
  await expect(page.getByRole("heading", { name: "Ling User", level: 1 })).toBeVisible();

  await page.locator('input[type="file"][accept="image/*"]').setInputFiles({
    name: "avatar.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="#d71920"/></svg>'),
  });

  await expect(page.getByRole("dialog", { name: "调整头像" })).toBeVisible();
  await page.getByRole("button", { name: "使用头像" }).click();

  const avatarImage = page.locator(".profile-avatar-button img");
  await expect(avatarImage).toBeVisible();
  const avatarDataUrl = await avatarImage.getAttribute("src");
  if (!avatarDataUrl) {
    throw new Error("profile avatar image did not render a data URL");
  }
  expect(avatarDataUrl).toMatch(/^data:image\/(?:webp|png);base64,/);

  const alpha = await page.evaluate(async (dataUrl) => {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("avatar image did not decode"));
      element.src = dataUrl;
    });
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("canvas context is unavailable");
    }
    context.drawImage(image, 0, 0);
    return {
      corner: context.getImageData(0, 0, 1, 1).data[3],
      center: context.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data[3],
    };
  }, avatarDataUrl);
  expect(alpha.corner).toBe(0);
  expect(alpha.center).toBeGreaterThan(240);

  await page.getByRole("button", { name: "保存资料" }).click();
  await expect.poll(() => state.userProfile.avatarDataUrl ?? "").toMatch(/^data:image\/(?:webp|png);base64,/);
});
