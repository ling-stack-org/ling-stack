import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const sidebarCssPath = fileURLToPath(new URL("../src/styles/sidebar.css", import.meta.url));
const sidebarRailCssPath = fileURLToPath(new URL(
  "../src/styles/app/sidebar-rail-sections.css",
  import.meta.url,
));
const sidebarUi2CssPath = fileURLToPath(new URL("../src/styles/app/sidebar-ui2.css", import.meta.url));

test("Sidebar motion shell removes dead compatibility writers and preserves live geometry contracts", async () => {
  const css = await readFile(sidebarCssPath, "utf8");

  expect(css).not.toContain("sidebar-drawer-labels-in");
  expect(css).not.toContain("sidebar-list-reveal-down");
  expect(css).not.toContain("sidebar-drawer-expand");
  expect(css).not.toContain("sidebar-drawer-collapse");
  expect(css).not.toContain("520ms");
  expect(css).not.toMatch(/\.channel-left-drawer\s*\{\s*transition:/u);
  expect(css).not.toContain(".sidebar-section-list:not([data-ling-collapsible-content])");
  expect(css).not.toContain(".sidebar-section:first-of-type");
  expect(css).not.toContain(".sidebar-section:last-of-type");
  expect(css).not.toContain(".sidebar-section-list > *");
  expect(css).not.toContain(".app-shell.channel-drawer-shell.inspector-hidden,");
  expect(css).not.toContain(".app-shell.channel-sidebar-collapsed.inspector-collapsed");
  expect(css).not.toContain(
    ".app-shell.channel-drawer-shell.inspector-hidden:not(.channel-sidebar-collapsed)",
  );
  expect(css).not.toContain(
    ".app-shell.channel-drawer-shell:not(.channel-sidebar-collapsed) .channel-left-drawer .sidebar-recent-copy",
  );

  expect(css).toContain("--sidebar-expanded-width: 240px;");
  expect(css).toContain("--sidebar-collapsed-width: 48px;");
  expect(css).toContain("--sidebar-rail-motion-duration: var(--ling-motion-slow);");
  expect(css).toContain("--sidebar-rail-motion-ease: var(--ling-ease-standard);");
  expect(css).toMatch(
    /\.app-shell\.channel-drawer-shell\s*\{\s*transition: grid-template-columns var\(--sidebar-rail-motion-duration\) var\(--sidebar-rail-motion-ease\);\s*\}/u,
  );
  expect(css).toMatch(
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?--sidebar-rail-motion-duration: var\(--ling-motion-instant\);[\s\S]*?\.app-shell\.channel-drawer-shell \.channel-left-drawer\s*\{\s*transition-duration: var\(--ling-motion-instant\);/u,
  );
  expect(css).toMatch(
    /@media \(max-width: 900px\)\s*\{\s*\.app-shell,\s*\.app-shell\.inspector-collapsed,\s*\.app-shell\.inspector-hidden,\s*\.app-shell\.channel-drawer-shell\s*\{/u,
  );
  expect(css).toMatch(
    /\.app-shell\.channel-drawer-shell:not\(\.channel-sidebar-collapsed\) \.sidebar-scroll-region\s*\{[^}]*display: flex;[^}]*grid-row: 2;[^}]*min-height: 0;[^}]*overflow-y: auto;/su,
  );
});

test("Compact Sidebar rail removes dead hover and stack variables while preserving rail geometry", async () => {
  const css = await readFile(sidebarRailCssPath, "utf8");

  expect(css).not.toContain(
    ".app-shell.channel-sidebar-collapsed .channel-left-drawer:hover",
  );
  expect(css).not.toContain(
    ".app-shell.channel-sidebar-collapsed .channel-left-drawer:focus-within",
  );
  expect(css).not.toContain("--sidebar-rail-stack-offset");
  expect(css).not.toContain("--sidebar-rail-order");

  expect(css).toMatch(
    /\.app-shell\.channel-sidebar-collapsed \.channel-left-drawer\s*\{[^}]*width: var\(--sidebar-collapsed-width\);[^}]*padding: 10px 8px;[^}]*overflow: hidden;/su,
  );
  expect(css).toMatch(
    /\.app-shell\.channel-sidebar-collapsed \.sidebar-scroll-region\s*\{[^}]*height: 100%;[^}]*min-height: 0;[^}]*overflow-y: auto;[^}]*overflow-x: hidden;/su,
  );
  expect(css).toContain("max-height: var(--sidebar-rail-section-open-height, 960px);");
  expect(css).toContain("max-height: var(--sidebar-rail-section-preview-height, 136px);");
});

test("Sidebar UI2 layer removes ownerless child resets and the duplicate compact row override", async () => {
  const css = await readFile(sidebarUi2CssPath, "utf8");

  expect(css).not.toMatch(
    /\.sidebar-rail-section-body > \.sidebar-section-list > \*\s*\{\s*animation: none;/u,
  );
  expect(css).not.toContain("@media (max-width: 900px)");

  expect(css).toContain(".channel-left-drawer .sidebar-section-action.ling-ui-button");
  expect(css).toContain(".channel-left-drawer .sidebar-row-main.ling-ui-button");
  expect(css).toMatch(
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.sidebar-section-list\[data-ling-collapsible-content\]\[data-state\][\s\S]*?transition-duration: var\(--ling-motion-instant\);/u,
  );
});
