import type {} from "./review-harness";
import { expect, type Locator, type Page } from "@playwright/test";

export async function mountReviewPage(page: Page, providers: readonly unknown[] = []): Promise<void> {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  await page.route(/\/providers(?:\?.*)?$/u, route => route.fulfill({ json: { providers } }));
  await page.goto("/e2e/support/p2-reading.html?manual");
  await remountReviewPage(page);
}

export async function remountReviewPage(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const path = "/e2e/support/review-harness.tsx";
    window.reviewHarness = (await import(/* @vite-ignore */ path)).mountReviewFixture();
  });
  await expect(page.getByRole("heading", { name: "Review workspace" })).toBeVisible();
}

export async function drawReviewStroke(page: Page, canvas: Locator): Promise<void> {
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width * .25, box.y + box.height * .3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * .6, box.y + box.height * .6, { steps: 8 });
  await page.mouse.up();
}

export function canvasPixels(canvas: Locator): Promise<string> {
  return canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
}
