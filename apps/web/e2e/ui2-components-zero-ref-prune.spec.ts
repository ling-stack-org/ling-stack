import { readFile, readdir } from "node:fs/promises";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const repositoryDirectory = fileURLToPath(new URL("../../../", import.meta.url));
const componentsCssPath = fileURLToPath(new URL("../src/styles/components.css", import.meta.url));
const proposedPlanCssPath = fileURLToPath(new URL("../src/styles/channel-proposed-plan.css", import.meta.url));
const webSourceDirectory = fileURLToPath(new URL("../src/", import.meta.url));
const packageSourceDirectory = fileURLToPath(new URL("../../../packages/", import.meta.url));

const prunedClassTokens = [
  "task-row-main",
  "run-detail-section",
  "tool-toggle",
  "channel-row",
  "task-row",
  "channel-options",
  "protocol-tab-panel",
  "thread-reply-meta",
  "activity-confirmation",
  "thread-list-section",
  "run-list-row",
  "work-history-turn-group",
  "work-history-attempt-list",
  "work-history-attempt-row",
  "thread-evidence-trail",
  "work-history-filter",
  "work-history-search-field",
  "thread-resume-panel",
  "channel-create-head",
  "channel-create-grid",
  "channel-options-grid",
  "run-list-main",
  "run-list-meta",
] as const;

const protectedClassTokens = [
  "channel-option-actions",
] as const;

const proposedPlanClassTokens = [
  "proposed-plan-block",
  "proposed-plan-head",
  "proposed-plan-icon",
  "proposed-plan-body",
  "proposed-plan-actions",
] as const;

const adjacentLiveSelectors = [
  "h1",
  ".runtime-kpi-grid strong",
  "p",
  ".first-run-flow",
  ".workbench-settings-panel",
  ".channel-protocol-tab-content",
  ".thread-reply-head",
  ".thread-reply-composer .composer-status-row",
  ".work-history-branch-row",
  ".protocol-row strong",
  ".channel-create-overlay",
  ".channel-create-teammates",
  ".task-workbench-header",
  ".task-workbench-window > .inline-error",
  ".tool-row span",
  ".muted",
  ".persistence-line",
  ".meta-row span",
  ".meta-row strong",
] as const;

const prunedRawInputSelectors = [
  "input:not([data-ling-control-native])",
  "textarea:not([data-ling-control-native])",
  "input:not([data-ling-control-native])::placeholder",
  "textarea:not([data-ling-control-native])::placeholder",
  "input:not([data-ling-control-native]):focus",
  "textarea:not([data-ling-control-native]):focus",
  "input:not([data-ling-control-native]):disabled",
  "textarea:not([data-ling-control-native]):disabled",
  ':root[data-theme="dark"] input:not([data-ling-control-native]):disabled',
  ':root[data-theme="dark"] textarea:not([data-ling-control-native]):disabled',
] as const;

test("T13-P.2-A removes only the frozen zero-reference component roots", async () => {
  expect(prunedClassTokens).toHaveLength(23);
  const cssFiles = [
    ...await listCssFiles(webSourceDirectory),
    ...await listCssFiles(packageSourceDirectory),
  ];

  for (const token of prunedClassTokens) {
    const owners: string[] = [];
    for (const file of cssFiles) {
      const css = await readFile(file, "utf8");
      if (cssDefinesClassSelector(css, token)) {
        owners.push(relative(repositoryDirectory, file));
      }
    }
    expect(owners, `.${token} must have no Web or package CSS writer`).toEqual([]);
  }
});

test("T13-P.2-A preserves adjacent live branches and T12.1d releases aggregate input owners", async () => {
  const componentsCss = await readFile(componentsCssPath, "utf8");

  for (const selector of adjacentLiveSelectors) {
    expect(
      cssDefinesExactSelectorBranch(componentsCss, selector),
      `${selector} must remain in components.css`,
    ).toBe(true);
  }

  for (const token of protectedClassTokens) {
    expect(
      cssDefinesClassSelector(componentsCss, token),
      `.${token} is protected by the T13-P.2-A contract`,
    ).toBe(true);
  }

  const proposedPlanCss = await readFile(proposedPlanCssPath, "utf8");
  const cssFiles = [
    ...await listCssFiles(webSourceDirectory),
    ...await listCssFiles(packageSourceDirectory),
  ];
  for (const token of proposedPlanClassTokens) {
    expect(
      cssDefinesClassSelector(componentsCss, token),
      `.${token} must leave components.css`,
    ).toBe(false);
    expect(
      cssDefinesClassSelector(proposedPlanCss, token),
      `.${token} must be owned by channel-proposed-plan.css`,
    ).toBe(true);
    const owners: string[] = [];
    for (const file of cssFiles) {
      const css = await readFile(file, "utf8");
      if (cssDefinesClassSelector(css, token)) {
        owners.push(relative(repositoryDirectory, file));
      }
    }
    expect(owners, `.${token} must have one focused CSS owner`).toEqual([
      "apps/web/src/styles/channel-proposed-plan.css",
    ]);
  }

  for (const selector of prunedRawInputSelectors) {
    const owners: string[] = [];
    for (const file of cssFiles) {
      const css = await readFile(file, "utf8");
      if (cssDefinesExactSelectorBranch(css, selector)) {
        owners.push(relative(repositoryDirectory, file));
      }
    }
    expect(owners, `${selector} must have no aggregate CSS writer`).toEqual([]);
  }
});

async function listCssFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const resolved = `${directory}${directory.endsWith("/") ? "" : "/"}${entry.name}`;
    if (entry.isDirectory()) return listCssFiles(resolved);
    return entry.name.endsWith(".css") ? [resolved] : [];
  }));
  return files.flat();
}

function cssDefinesClassSelector(css: string, token: string): boolean {
  const classToken = new RegExp(`(^|[^A-Za-z0-9_-])\\.${escapeRegex(token)}(?![A-Za-z0-9_-])`, "u");
  return extractSelectorBranches(css).some((selector) => classToken.test(selector));
}

function cssDefinesExactSelectorBranch(css: string, selector: string): boolean {
  return extractSelectorBranches(css).includes(selector);
}

function extractSelectorBranches(css: string): string[] {
  return [...css.replace(/\/\*[\s\S]*?\*\//gu, "").matchAll(/([^{}]+)\{/gu)]
    .map((match) => match[1]?.trim() ?? "")
    .filter((prelude) => prelude && !prelude.startsWith("@"))
    .flatMap((prelude) => prelude.split(",").map((branch) => branch.trim()))
    .filter(Boolean);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
