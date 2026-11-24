import { expect, test } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createChatProvider, createMockTeammate } from "./support/mock-state";

for (const surface of ["normal", "private", "channel"] as const) {
  test(`${surface} drawing becomes a pending image attachment`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
    const state = createBaseState({ approvalStatus: "expired" });
    state.providers = [createChatProvider({ id: "drawing_provider", model: "gpt-5.5", lastCheck: { ok: true, code: "ready", message: "fixture", checkedAt: "2026-10-14T00:00:00.000Z" } })];
    state.aiTeammates = [createMockTeammate({ id: "drawing_teammate", displayName: "Drawing teammate", providerPresetId: "drawing_provider" })];
    state.runs = []; state.tasks = []; state.approvals = []; state.teammateDirectMessages = [];
    state.threads = []; state.turns = []; state.channelMessages = [];
    state.workspaceSettings.defaultProviderPresetId = "drawing_provider";
    state.channels = state.channels.map(channel => ({ ...channel, defaultProviderPresetId: "drawing_provider" }));
    await mockDaemon(page, state);
    await page.goto("/");
    if (surface !== "normal") await page.getByRole("complementary", { name: /Sidebar display/ }).getByRole("button", { name: surface === "private" ? "Drawing teammate" : "Engineering", exact: true }).click();
    const composer = page.getByLabel(surface === "private" ? "Private chat composer" : surface === "channel" ? "Channel composer" : "New conversation composer", { exact: true });
    await composer.getByRole("button", { name: "Drawing board" }).click();
    const dialog = page.getByRole("dialog", { name: "Drawing board" });
    const canvas = dialog.locator("canvas");
    await expect(dialog.getByRole("button", { name: "Add image to message" })).toBeDisabled();
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + box.width * .3, box.y + box.height * .4); await page.mouse.down();
    await page.mouse.move(box.x + box.width * .7, box.y + box.height * .6, { steps: 8 }); await page.mouse.up();
    await expect(dialog.getByRole("button", { name: "Undo" })).toBeEnabled();
    await dialog.getByRole("button", { name: "Undo" }).click();
    await expect(dialog.getByRole("button", { name: "Add image to message" })).toBeDisabled();
    await dialog.getByRole("button", { name: "Redo" }).click();
    await expect(dialog.getByRole("button", { name: "Add image to message" })).toBeEnabled();
    await page.screenshot({ path: info.outputPath(`${surface}-drawing-board.png`) });
    await dialog.getByRole("button", { name: "Add image to message" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(composer.locator(".composer-preview-card")).toHaveClass(/ready/);
    await composer.locator('input[type="file"]').setInputFiles(Array.from({ length: 9 }, (_, index) => ({
      name: `extra-${index}.txt`, mimeType: "text/plain", buffer: Buffer.from("test"),
    })));
    await expect(composer.locator(".composer-preview-card")).toHaveCount(10);
    await expect(composer.getByRole("button", { name: "Drawing board" })).toBeDisabled();
    expect(errors).toEqual([]);
  });
}

test("drawing tools, cancel and conversation change preserve attachment boundaries", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [createMockTeammate({ id: "drawing_one", displayName: "Drawing One" }), createMockTeammate({ id: "drawing_two", displayName: "Drawing Two" })];
  await mockDaemon(page, state); await page.goto("/");
  const sidebar = page.getByRole("complementary", { name: /Sidebar display/ });
  await sidebar.getByRole("button", { name: "Drawing One", exact: true }).click();
  const composer = page.getByLabel("Private chat composer", { exact: true });
  await composer.getByRole("button", { name: "Drawing board" }).click();
  const dialog = page.getByRole("dialog", { name: "Drawing board" });
  const canvas = dialog.locator("canvas");
  const pixels = () => canvas.evaluate((node: HTMLCanvasElement) => node.toDataURL());
  const blank = await pixels(); const box = (await canvas.boundingBox())!;
  const drag = async (x1: number, y1: number, x2: number, y2: number) => { await page.mouse.move(box.x + box.width*x1, box.y + box.height*y1); await page.mouse.down(); await page.mouse.move(box.x + box.width*x2, box.y + box.height*y2, { steps: 5 }); await page.mouse.up(); };
  await dialog.getByRole("button", { name: "Rectangle", exact: true }).click(); await drag(.25,.25,.6,.55);
  await expect.poll(pixels).not.toBe(blank); const rectangle = await pixels();
  await dialog.getByRole("button", { name: "Select", exact: true }).click(); await drag(.25,.25,.35,.35);
  await expect.poll(pixels).not.toBe(rectangle);
  await dialog.getByRole("button", { name: "Erase drawing" }).click();
  await canvas.click({ position: { x: box.width*.35, y: box.height*.35 } });
  await expect.poll(pixels).toBe(blank);
  await dialog.getByRole("button", { name: "Text", exact: true }).click();
  await dialog.getByRole("textbox", { name: "Annotation text" }).fill("Ling");
  await canvas.click({ position: { x: box.width*.4, y: box.height*.5 } });
  await expect.poll(pixels).not.toBe(blank);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(composer.locator(".composer-preview-card")).toHaveCount(0);
  await composer.getByRole("button", { name: "Drawing board" }).click();
  await expect(page.getByRole("dialog", { name: "Drawing board" }).getByRole("button", { name: "Add image to message" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await sidebar.getByRole("button", { name: "Drawing Two", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Drawing board" })).toHaveCount(0);
});

test("long brush strokes retain their beginning", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.goto("/");
  await page.getByRole("button", { name: "Drawing board" }).click();
  const canvas = page.getByRole("dialog", { name: "Drawing board" }).locator("canvas");
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width * .2, box.y + box.height * .2);
  await page.mouse.down();
  await canvas.evaluate((node: HTMLCanvasElement) => {
    const rect = node.getBoundingClientRect();
    for (let i = 0; i < 5005; i++) {
      const fraction = .2 + .6 * i / 5004;
      node.dispatchEvent(new PointerEvent("pointermove", {
        bubbles: true, pointerId: 1, clientX: rect.left + rect.width * fraction,
        clientY: rect.top + rect.height * fraction,
      }));
    }
  });
  await page.mouse.up();
  await expect.poll(() => canvas.evaluate((node: HTMLCanvasElement) => {
    const pixel = node.getContext("2d")!.getImageData(192, 192, 1, 1).data;
    return pixel[0];
  })).toBeGreaterThan(100);
});

test("selection and eraser only hit near visible brush strokes", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.goto("/");
  await page.getByRole("button", { name: "Drawing board" }).click();
  const dialog = page.getByRole("dialog", { name: "Drawing board" });
  const canvas = dialog.locator("canvas");
  const pixels = () => canvas.evaluate((node: HTMLCanvasElement) => node.toDataURL());
  const blank = await pixels(); const box = (await canvas.boundingBox())!;
  const point = (x: number, y: number) => ({ x: box.x + box.width * x, y: box.y + box.height * y });
  await page.mouse.move(point(.2, .2).x, point(.2, .2).y); await page.mouse.down();
  await page.mouse.move(point(.8, .8).x, point(.8, .8).y, { steps: 8 }); await page.mouse.up();
  await expect.poll(pixels).not.toBe(blank); const stroke = await pixels();
  await dialog.getByRole("button", { name: "Erase drawing" }).click();
  await canvas.click({ position: { x: box.width * .25, y: box.height * .75 } });
  await expect.poll(pixels).toBe(stroke);
  await dialog.getByRole("button", { name: "Select", exact: true }).click();
  await page.mouse.move(point(.25, .75).x, point(.25, .75).y); await page.mouse.down();
  await page.mouse.move(point(.35, .75).x, point(.35, .75).y); await page.mouse.up();
  await expect.poll(pixels).toBe(stroke);
  await dialog.getByRole("button", { name: "Erase drawing" }).click();
  await canvas.click({ position: { x: box.width * .5, y: box.height * .5 } });
  await expect.poll(pixels).toBe(blank);
});
