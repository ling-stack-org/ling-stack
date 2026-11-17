import { expect, test } from "@playwright/test";
import { createMediaProvider } from "./support/mock-state";
import { canvasPixels, drawReviewStroke, mountReviewPage, remountReviewPage } from "./support/review-test-helpers";

test("large original images remain viewable and use a bounded editing canvas", async ({ page }) => {
  await page.route("**/themes/ling-ocean/salt-coast-v1-thumb.webp", route => route.fulfill({ contentType: "image/svg+xml", body:
    '<svg xmlns="http://www.w3.org/2000/svg" width="9000" height="10"><rect width="9000" height="10" fill="red"/></svg>' }));
  await mountReviewPage(page);
  const editor = page.locator(".image-review-editor");
  await expect(editor.getByRole("button", { name: "Download edited image" })).toBeEnabled();
  const original = editor.locator(".image-compare-frame img");
  await expect(original).toBeVisible();
  expect(await original.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(9000);
  await expect(editor).toContainText("The image is scaled to fit the editing canvas.");
  await editor.getByRole("button", { name: "Brush", exact: true }).click();
  await expect(editor.locator("canvas")).toHaveAttribute("width", "8192");
  await editor.getByRole("button", { name: "Restore original" }).click();
  await expect(editor.locator("canvas")).toHaveAttribute("width", "8192");
});

test("all drawing tools change exported pixels, undo precisely, and recover with pending image comments", async ({ page }) => {
  await mountReviewPage(page);
  const editor = page.locator(".image-review-editor"); const canvas = editor.locator("canvas");
  await expect(editor.getByRole("button", { name: "Download edited image" })).toBeEnabled();
  for (const tool of ["Line", "Arrow", "Rectangle", "Ellipse", "Text"]) {
    await editor.getByRole("button", { name: tool, exact: true }).click();
    await editor.getByRole("spinbutton", { name: "Stroke width" }).fill("30");
    if (tool === "Text") await editor.getByRole("textbox", { name: "Annotation text" }).fill("Review here");
    const before = await canvasPixels(canvas);
    await drawReviewStroke(page, canvas);
    await expect.poll(() => canvasPixels(canvas)).not.toBe(before);
    const after = await canvasPixels(canvas);
    await editor.getByRole("button", { name: "Undo", exact: true }).click();
    await expect.poll(() => canvasPixels(canvas)).toBe(before);
    await editor.getByRole("button", { name: "Redo", exact: true }).click();
    await expect.poll(() => canvasPixels(canvas)).toBe(after);
  }
  await editor.getByRole("spinbutton", { name: "Image width" }).fill("320");
  await editor.getByRole("button", { name: "Resize", exact: true }).click();
  await expect(canvas).toHaveAttribute("width", "320");
  await editor.getByRole("button", { name: "Comment", exact: true }).click();
  await canvas.click({ position: { x: 60, y: 60 } });
  await editor.getByRole("textbox", { name: "Image comment" }).fill("Unfinished image feedback");
  const edited = await canvasPixels(canvas);
  await page.reload(); await remountReviewPage(page);
  await expect(editor.getByRole("textbox", { name: "Image comment" })).toHaveValue("Unfinished image feedback");
  await expect(canvas).toHaveAttribute("width", "320");
  await expect(editor.locator(".image-review-pin.selected")).toHaveCount(1);
  await expect.poll(() => canvasPixels(canvas)).toBe(edited);
  await page.getByRole("button", { name: "Switch conversation" }).click();
  await editor.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(editor.getByRole("textbox", { name: "Image comment" })).toHaveValue("");
  await expect(editor.locator(".image-review-pin.selected")).toHaveCount(0);
  await page.getByRole("button", { name: "Switch conversation" }).click();
  await expect(editor.getByRole("textbox", { name: "Image comment" })).toHaveValue("Unfinished image feedback");
  await editor.getByRole("button", { name: "Add comment", exact: true }).click();
  const shelf = page.getByRole("region", { name: "Review feedback" });
  await expect(shelf.getByRole("textbox")).toHaveValue("Unfinished image feedback");
  expect(await page.evaluate(() => window.reviewHarness.files())).toHaveLength(1);
  await shelf.getByRole("button", { name: "Send feedback" }).click();
  await canvas.click({ position: { x: 80, y: 80 } });
  await editor.getByRole("textbox", { name: "Image comment" }).fill("Next message feedback");
  await editor.getByRole("button", { name: "Add comment", exact: true }).click();
  await expect.poll(async () => (await page.evaluate(() => window.reviewHarness.files())).length).toBe(2);
});

test("model background removal and mask repair retain drafts on failure and load results before replacing", async ({ page }, info) => {
  const provider = createMediaProvider({ capabilities: ["image_edit"], compat: { mediaVendorTransport: { mode: "live" } } });
  const requests: Array<Record<string, unknown>> = [];
  let outcome: "failed" | "unreadable" | "success" = "failed";
  let resultPng = Buffer.alloc(0);
  await page.route(/\/media-jobs(?:\?.*)?$/u, async route => {
    requests.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({ json: { mediaJob: { id: "edit_job", status: "queued" } } });
  });
  await page.route(/\/media-jobs\/edit_job\/run(?:\?.*)?$/u, route => route.fulfill({ json: { mediaJob: {
    id: "edit_job", status: outcome === "failed" ? "failed" : "succeeded", ...(outcome === "failed" ? { errorMessage: "Provider could not edit this image" } : {}),
  }, artifacts: [{ id: "artifact_edited", contentType: "image/png" }] } }));
  await page.route(/\/artifacts\/artifact_edited\/content(?:\?.*)?$/u, route => outcome === "unreadable"
    ? route.fulfill({ status: 503, body: "Image unavailable" }) : route.fulfill({ contentType: "image/png", body: resultPng }));
  await mountReviewPage(page, [provider]);
  resultPng = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 128; canvas.height = 96;
    const context = canvas.getContext("2d")!; context.fillStyle = "red"; context.fillRect(20, 20, 30, 30);
    return canvas.toDataURL("image/png").split(",")[1]!;
  }), "base64");
  const editor = page.locator(".image-review-editor"); const canvas = editor.locator("canvas");
  await expect(editor.getByRole("button", { name: "Remove background" })).toBeEnabled();
  await editor.getByRole("button", { name: "Brush", exact: true }).click(); await drawReviewStroke(page, canvas);
  const edited = await canvasPixels(canvas);
  await editor.getByRole("button", { name: "Remove background" }).click();
  await expect(editor).toContainText("Provider could not edit this image");
  expect(requests[0]).toMatchObject({ operation: "image_edit", providerPresetId: "provider_seedream", input: { imageUrl: expect.stringMatching(/^data:image\/png;base64,/u) } });
  expect((requests[0]!.input as Record<string, unknown>).maskUrl).toBeUndefined();
  expect(requests[0]!.prompt).toContain("transparent background");
  expect(await canvasPixels(canvas)).toBe(edited);
  outcome = "unreadable";
  await editor.getByRole("button", { name: "Remove background" }).click();
  await expect(editor).toContainText("Image load failed (503)");
  expect(await canvasPixels(canvas)).toBe(edited);
  await expect(editor.getByRole("button", { name: "Undo", exact: true })).toBeEnabled();
  await editor.getByRole("button", { name: "Erase pixels" }).click();
  await editor.getByRole("spinbutton", { name: "Stroke width" }).fill("100");
  await drawReviewStroke(page, canvas);
  outcome = "success";
  await editor.getByRole("button", { name: "Repair erased area" }).click();
  await expect(editor).toContainText("Image edit completed.");
  const mask = (requests.at(-1)!.input as Record<string, string>).maskUrl!;
  const pixels = await page.evaluate(async mask => {
    const image = new Image(); image.src = mask; await image.decode();
    const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext("2d")!; context.drawImage(image, 0, 0);
    return { corner: [...context.getImageData(0, 0, 1, 1).data], erased: [...context.getImageData(Math.round(canvas.width * .4), Math.round(canvas.height * .43), 1, 1).data] };
  }, mask);
  expect(pixels.corner).toEqual([0, 0, 0, 255]); expect(pixels.erased).toEqual([255, 255, 255, 255]);
  await expect(canvas).toHaveAttribute("width", "128");
  await expect(editor.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
  await page.reload(); await remountReviewPage(page);
  await expect(editor.getByRole("spinbutton", { name: "Image width" })).toHaveValue("128");
  await expect(canvas).toHaveAttribute("height", "96");
  expect(await canvas.evaluate((element: HTMLCanvasElement) => element.getContext("2d")!.getImageData(0, 0, 1, 1).data[3])).toBe(0);
  await page.screenshot({ path: info.outputPath("model-image-result.png") });
  await editor.getByRole("button", { name: "Restore original" }).click();
  await expect(canvas).not.toHaveAttribute("width", "128");
});

test("review controls preserve drafts and fit all built-in themes and narrow windows", async ({ page }, info) => {
  await mountReviewPage(page);
  const editor = page.locator(".image-review-editor");
  await editor.getByRole("button", { name: "Comment", exact: true }).click();
  await editor.getByRole("textbox", { name: "Image comment" }).fill("Theme switching keeps this draft");
  for (const theme of ["ling-light", "ling-dark", "ling-breeze", "ling-night", "ling-ocean", "ling-journey"]) {
    await page.getByRole("combobox", { name: "Fixture theme" }).selectOption(theme);
    await expect(page.locator("html")).toHaveAttribute("data-ui-theme", theme);
    await expect.poll(() => editor.getByRole("button", { name: "Brush", exact: true }).evaluate(element =>
      getComputedStyle(element).color === getComputedStyle(element.closest(".image-review-editor")!).color)).toBe(true);
    await expect(editor.getByRole("textbox", { name: "Image comment" })).toHaveValue("Theme switching keeps this draft");
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 960 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.screenshot({ path: info.outputPath(`${theme}-${width}-review.png`), animations: "disabled" });
    }
  }
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await editor.getByRole("button", { name: "Brush", exact: true }).focus();
  await expect(editor.getByRole("button", { name: "Brush", exact: true })).toBeFocused();
});
