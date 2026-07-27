import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const componentsCssPath = fileURLToPath(new URL("../src/styles/components.css", import.meta.url));
const layoutCssPath = fileURLToPath(new URL("../src/styles/layout.css", import.meta.url));
const sidebarLayoutCssPath = fileURLToPath(new URL("../src/styles/app/sidebar-layout.css", import.meta.url));
const overlaySizeCssPath = fileURLToPath(new URL("../src/styles/app/app-shell-overlay-size.css", import.meta.url));

test("AppShell column geometry has one 901px focused owner", async () => {
  const [componentsCss, sidebarLayoutCss] = await Promise.all([
    readFile(componentsCssPath, "utf8"),
    readFile(sidebarLayoutCssPath, "utf8"),
  ]);

  expect(componentsCss).not.toMatch(
    /\.app-shell\.channel-drawer-shell\.inspector-hidden\s*\{[^}]*grid-template-columns:/su,
  );
  expect(componentsCss).not.toMatch(
    /\.app-shell\.channel-drawer-shell\.channel-sidebar-collapsed\.inspector-hidden\s*\{[^}]*grid-template-columns:/su,
  );
  expect(sidebarLayoutCss).toMatch(
    /@media \(min-width: 901px\)[\s\S]*?\.app-shell\.channel-drawer-shell\.inspector-hidden\s*\{[^}]*grid-template-columns: var\(--sidebar-expanded-width\) minmax\(0, 1fr\);/u,
  );
  expect(sidebarLayoutCss).toMatch(
    /@media \(min-width: 901px\)[\s\S]*?\.app-shell\.channel-drawer-shell\.channel-sidebar-collapsed\.inspector-hidden\s*\{[^}]*grid-template-columns: var\(--sidebar-collapsed-width\) minmax\(0, 1fr\);/u,
  );
});

test("Workspace client overflow has one AppShell boundary owner", async () => {
  const [layoutCss, overlaySizeCss] = await Promise.all([
    readFile(layoutCssPath, "utf8"),
    readFile(overlaySizeCssPath, "utf8"),
  ]);

  expect(layoutCss).not.toMatch(/(?:^|\})\s*\.workspace-client-surface\s*\{[^}]*overflow:/su);
  expect(overlaySizeCss).toMatch(
    /\.app-shell\[data-ui2-shell-boundary="true"\] > \.workspace-client-surface\s*\{[^}]*display: grid;[^}]*min-height: 0;[^}]*overflow: hidden;/su,
  );
});

test("duplicate pruning preserves mixed AppShell, client window, and Inspector compatibility owners", async () => {
  const [layoutCss, overlaySizeCss] = await Promise.all([
    readFile(layoutCssPath, "utf8"),
    readFile(overlaySizeCssPath, "utf8"),
  ]);

  expect(layoutCss).toMatch(
    /\.app-shell\s*\{[^}]*grid-template-columns: 248px minmax\(0, 1fr\) 360px;[^}]*grid-template-rows: minmax\(0, 1fr\);[^}]*background: var\(--app-bg\);/su,
  );
  expect(layoutCss).toMatch(
    /\.client-window\s*\{[^}]*display: grid;[^}]*grid-template-rows: auto minmax\(0, 1fr\);[^}]*min-height: 100vh;/su,
  );
  expect(overlaySizeCss).toMatch(
    /@media \(min-width: 1121px\) and \(max-width: 1280px\)[\s\S]*?grid-template-columns: var\(--sidebar-expanded-width\) minmax\(0, 1fr\) 340px;/u,
  );
});
