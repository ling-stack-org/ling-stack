import { expect, test, type Page } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createChatProvider } from "./support/mock-state";
import { installNormalConversationFixture } from "./support/normal-conversation-fixture";

const cursor = "[data-glow-cursor='farbound-journey']";
const artwork = "svg[data-scene='farbound-journey']";

test("ling-journey paints one glow cursor above the scrim and below app surfaces", async ({ page }) => {
  const errors = watchErrors(page);
  await prepare(page, "ling-journey");
  const layer = page.locator("[data-background-layer]");
  await expect(layer).toHaveCount(1);
  await expect(layer.locator(artwork)).toHaveCount(1);
  const glow = layer.locator(cursor);
  await expect(glow).toHaveCount(1);
  await expect(glow.locator("canvas")).toHaveCount(1);

  // The scene WebP decodes asynchronously; wait for it so the captured trail is
  // judged against the real ink-wash background instead of the empty layer.
  await page.evaluate(async () => {
    const image = document.querySelector("svg[data-scene] image");
    const href = image?.getAttribute("href");
    if (!href) return;
    const probe = new Image();
    probe.src = href;
    await probe.decode().catch(() => undefined);
  });
  await page.waitForTimeout(120);
  const beforeStroke = await layer.screenshot();
  await page.mouse.move(360, 220);
  await page.mouse.move(760, 300, { steps: 18 });
  await page.mouse.move(1280, 250, { steps: 22 });
  // Capture while the trail is still live so the evidence shows the light path,
  // not just the DOM contract. One frame at 60Hz is enough for the GPU pass.
  await page.waitForTimeout(120);
  // A DOM-only assertion would pass even if the GPU pass drew nothing, so the
  // layer pixels themselves must change after the stroke.
  const afterStroke = await layer.screenshot();
  expect(afterStroke.equals(beforeStroke)).toBe(false);
  await page.screenshot({ path: test.info().outputPath("journey-glow-cursor.png") });

  const evidence = await glow.evaluate(element => {
    const canvas = element.querySelector("canvas") as HTMLCanvasElement | null;
    const scrim = document.querySelector(".workspace-background-scrim");
    return {
      afterScrim: scrim ? Boolean(scrim.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) : null,
      pointerEvents: getComputedStyle(element).pointerEvents,
      canvasPointerEvents: canvas ? getComputedStyle(canvas).pointerEvents : "missing",
      blend: canvas ? getComputedStyle(canvas).mixBlendMode : "missing",
      width: canvas?.width ?? 0,
      height: canvas?.height ?? 0,
      ariaHidden: element.closest("[data-background-layer]")?.getAttribute("aria-hidden") ?? null,
    };
  });
  expect(evidence.afterScrim).toBe(true);
  expect(evidence.pointerEvents).toBe("none");
  expect(evidence.canvasPointerEvents).toBe("none");
  expect(evidence.blend).toBe("screen");
  expect(evidence.ariaHidden).toBe("true");
  expect(evidence.width).toBeGreaterThan(100);
  expect(evidence.height).toBeGreaterThan(100);

  expect(errors).toEqual([]);
});

test("the glow cursor is scoped to the journey theme and unmounts on switch", async ({ page }) => {
  const errors = watchErrors(page);
  await prepare(page, "ling-dark");
  await expect(page.locator(cursor)).toHaveCount(0);
  const panel = await preferences(page);
  await panel.locator("[data-theme-option-id='ling-journey']").click();
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "ling-journey");
  await expect(page.locator(cursor)).toHaveCount(1);
  await panel.locator("[data-theme-option-id='ling-dark']").click();
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "ling-dark");
  await expect(page.locator(cursor)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("reduced motion keeps the static scene without mounting the cursor", async ({ page }) => {
  const errors = watchErrors(page);
  await prepare(page, "ling-journey", { reducedMotion: "reduce" });
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "ling-journey");
  await expect(page.locator(artwork)).toHaveCount(1);
  await expect(page.locator(cursor)).toHaveCount(0);
  expect(errors).toEqual([]);
});

async function prepare(page: Page, themeId: "ling-journey" | "ling-dark", options: { reducedMotion?: "reduce" } = {}) {
  if (options.reducedMotion) await page.emulateMedia({ reducedMotion: options.reducedMotion });
  await page.addInitScript(id => {
    localStorage.setItem("ling-stack.locale", "en-US");
    const selection = { mode: "fixed", themeId: id };
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
  }, themeId);
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({ id: "glow-cursor-provider", lastCheck: {
    ok: true, code: "ready", message: "Glow cursor acceptance fixture", checkedAt: "2026-10-28T00:00:00.000Z",
  } })];
  state.workspaceSettings.defaultProviderPresetId = state.providers[0].id;
  state.approvals = [];
  installNormalConversationFixture(state);
  await mockDaemon(page, state);
  await page.route("**/runtime/conversation-execution**", route => route.fulfill({
    json: { cwd: "", status: "not_selected", defaultRunnerId: "pi" },
  }));
  await page.route("**/workspace/work-summary?**", route => route.fulfill({
    json: { cwd: "/tmp/ling-stack-workspace", sessions: [], workspaces: [], pullRequests: [], truncated: false, checkedAt: "2026-10-28T00:00:00Z" },
  }));
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", themeId);
  // Only a scene theme makes the shared background layer visible; token-only
  // themes keep it hidden, which is exactly why the cursor must not mount there.
  if (themeId === "ling-journey") await expect(page.locator("[data-background-layer]")).toBeVisible();
}

async function preferences(page: Page) {
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u })
    .getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections")
    .getByRole("button", { name: "Interface preferences", exact: true }).click();
  const panel = page.locator("[data-ui2-interface-preferences]");
  await expect(panel).toBeVisible();
  return panel;
}

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  return errors;
}

