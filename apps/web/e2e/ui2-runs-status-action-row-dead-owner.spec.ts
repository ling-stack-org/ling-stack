import { access, readFile, readdir } from "node:fs/promises";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import {
  createRunsThreadsFixture,
  installRunsThreadsFixture,
  openMainRunHistory,
} from "./support/runs-threads-fixture";

const webSourceDirectory = fileURLToPath(new URL("../src/", import.meta.url));
const stylesDirectory = fileURLToPath(new URL("../src/styles/", import.meta.url));
const statusActionRowUrl = new URL("../src/shared/components/StatusActionRow.tsx", import.meta.url);
const componentBarrelUrl = new URL("../src/shared/components/index.ts", import.meta.url);

test("StatusActionRow production owner and selector family stay deleted", async () => {
  await expect(access(statusActionRowUrl)).rejects.toMatchObject({ code: "ENOENT" });

  const [componentBarrel, styles, productionFiles, styleFiles] = await Promise.all([
    readFile(componentBarrelUrl, "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
    collectFiles(webSourceDirectory, /\.(?:ts|tsx)$/u),
    collectFiles(stylesDirectory, /\.css$/u),
  ]);

  expect(componentBarrel).not.toContain("StatusActionRow");
  expect(styles).not.toContain("operation-states.css");
  expect(productionFiles.filter(({ content }) => content.includes("StatusActionRow"))).toEqual([]);

  const repairOwners = styleFiles
    .filter(({ content }) => /\.run-repair-(?:hint|body|copy)\b/u.test(content))
    .map(({ path }) => relative(stylesDirectory, path));
  expect(repairOwners).toEqual(["runs/guidance.css"]);
});

test("live provider repair hint keeps its focused Runs layout and action", async ({ page }) => {
  await prepareSurface(page);
  const state = createRunsThreadsFixture();
  await installRunsThreadsFixture(page, state);
  await page.goto("/");
  await openMainRunHistory(page, "Failed provider repair run");

  const hint = page.locator(".run-repair-hint.providers");
  await expect(hint).toBeVisible();
  await expect(hint).toContainText("Provider repair needed");

  const geometry = await hint.evaluate((element) => {
    const body = element.querySelector<HTMLElement>(".run-repair-body");
    const action = element.querySelector<HTMLElement>("button");
    if (!body || !action) throw new Error("Run repair hint contract is incomplete");
    const bodyStyle = getComputedStyle(body);
    const actionRect = action.getBoundingClientRect();
    return {
      actionHeight: actionRect.height,
      actionWidth: actionRect.width,
      bodyDisplay: bodyStyle.display,
      bodyOverflow: body.scrollWidth - body.clientWidth,
      hintOverflow: element.scrollWidth - element.clientWidth,
    };
  });
  expect(geometry.bodyDisplay).toBe("grid");
  expect(geometry.bodyOverflow).toBeLessThanOrEqual(1);
  expect(geometry.hintOverflow).toBeLessThanOrEqual(1);
  expect(geometry.actionHeight).toBeGreaterThanOrEqual(32);
  expect(geometry.actionWidth).toBeGreaterThanOrEqual(32);

  await hint.getByRole("button", { name: "Model Workbench" }).click();
  await expect(page.getByRole("heading", { name: "Model Workbench", level: 1 })).toBeVisible();
});

async function collectFiles(directory: string, pattern: RegExp): Promise<readonly {
  readonly content: string;
  readonly path: string;
}[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = `${directory}${entry.name}${entry.isDirectory() ? "/" : ""}`;
    if (entry.isDirectory()) return collectFiles(path, pattern);
    if (!entry.isFile() || !pattern.test(entry.name)) return [];
    return [{ content: await readFile(path, "utf8"), path }];
  }));
  return files.flat();
}

async function prepareSurface(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => {
    const selection = { mode: "fixed", themeId: "ling-light" };
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
  });
}
