import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { cwd } from "./support/mock-daemon";
import { createRunsThreadsFixture, installRunsThreadsFixture, openMainRunHistory } from "./support/runs-threads-fixture";

const evidenceDir = process.env.LING_P2_EVIDENCE_DIR ?? fileURLToPath(new URL("../../../.ling-stack/acceptance/p2-ux2-run-guidance-20261015/", import.meta.url));

async function openGuidance(page: Page, theme: "light" | "dark" = "light") {
  await page.addInitScript(theme => {
    localStorage.setItem("ling-stack.locale", "en-US");
    const selection = JSON.stringify({ mode: "fixed", themeId: `ling-${theme}` });
    localStorage.setItem("ling-stack.themeSelection", selection);
    localStorage.setItem("ling-stack.themeBootstrapSelection", selection);
    const originalFetch = window.fetch;
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      if (response.ok && args[1]?.method === "POST" && /\/runs\/[^/]+\/interventions$/.test(new URL(String(args[0]), location.href).pathname)) {
        await response.text();
        throw new TypeError("Controlled Run guidance receipt loss");
      }
      return response;
    };
  }, theme);
  const state = createRunsThreadsFixture();
  state.approvals = [];
  await installRunsThreadsFixture(page, state);
  let available = false, posts = 0, queries = 0;
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  page.on("request", request => {
    if (request.method() === "POST" && /\/runs\/[^/]+\/interventions$/.test(new URL(request.url()).pathname)) posts++;
  });
  await page.route(url => /\/runs\/[^/]+\/interventions$/.test(url.pathname) && url.searchParams.has("idempotencyKey"), route => {
    queries++;
    const url = new URL(route.request().url());
    const key = url.searchParams.get("idempotencyKey");
    const sourceRunId = url.pathname.split("/").at(-2);
    const interventions = state.runInterventions.filter(item => item.sourceRunId === sourceRunId && item.idempotencyKey === key);
    return route.fulfill({ json: { cwd, idempotencyKey: key, interventions: available ? interventions : [] } });
  });
  await page.goto("/");
  await openMainRunHistory(page, "Failed provider repair run");
  const panel = page.locator(".run-guidance-panel");
  await expect(panel).toBeVisible();
  return { state, panel, errors, reveal: () => { available = true; }, counts: () => ({ posts, queries }) };
}

for (const theme of ["light", "dark"] as const) {
  test(`Run details ${theme} guidance retries query the original receipt and preserve newer input`, async ({ page }) => {
    await page.setViewportSize(theme === "light" ? { width: 1280, height: 800 } : { width: 1440, height: 960 });
    const f = await openGuidance(page, theme);
    const input = f.panel.getByRole("textbox", { name: "Run guidance" });
    await input.fill("Original queued guidance");
    await f.panel.getByRole("button", { name: "Queue guidance", exact: true }).click();
    await expect(f.panel.getByText("Pending confirmation", { exact: true })).toBeVisible();
    expect(f.counts().posts).toBe(1);
    await input.fill("New independent instruction");
    await f.panel.getByRole("button", { name: "Retry", exact: true }).click();
    await expect.poll(() => f.counts().queries).toBeGreaterThan(3);
    await expect(f.panel.getByRole("button", { name: "Retry", exact: true })).toBeEnabled();
    expect(f.counts().posts).toBe(1);
    await mkdir(evidenceDir, { recursive: true });
    await f.panel.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${evidenceDir}${theme}-query-only.png`, animations: "disabled" });
    f.reveal();
    await f.panel.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(f.panel.getByText("Pending confirmation", { exact: true })).toHaveCount(0);
    await expect(f.panel.locator(".runs-intervention-row")).toContainText("Original queued guidance");
    await expect(input).toHaveValue("New independent instruction");
    expect(f.counts().posts).toBe(1);
    expect(f.state.runInterventions).toHaveLength(1);
    await page.screenshot({ path: `${evidenceDir}${theme}-recovered-new-draft.png`, animations: "disabled" });
    expect(f.errors).toEqual([]);
  });
}

test("Run details pending guidance survives reload with an empty editor and queries without a new POST", async ({ page }) => {
  const f = await openGuidance(page);
  await f.panel.getByRole("textbox", { name: "Run guidance" }).fill("Guidance before reload");
  await f.panel.getByRole("button", { name: "Queue guidance", exact: true }).click();
  await expect(f.panel.getByText("Pending confirmation", { exact: true })).toBeVisible();
  await page.reload();
  await openMainRunHistory(page, "Failed provider repair run");
  const panel = page.locator(".run-guidance-panel");
  await expect(panel.getByRole("textbox", { name: "Run guidance" })).toHaveValue("");
  await expect(panel.getByRole("button", { name: "Retry", exact: true })).toBeEnabled();
  f.reveal();
  await panel.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(panel.locator(".runs-intervention-row")).toContainText("Guidance before reload");
  expect(f.counts().posts).toBe(1);
  expect(f.errors).toEqual([]);
});
