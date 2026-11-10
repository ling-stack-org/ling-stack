import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { qaCwd, qaRow, qaSnapshot, qaEvent, qaReport } from "./human-qa-fixtures.mjs";

const requireDesktop = createRequire(new URL("../../desktop/package.json", import.meta.url));
const { build } = requireDesktop("esbuild");
const temporary = await mkdtemp(fileURLToPath(new URL("../.human-qa-render-", import.meta.url)));
after(() => rm(temporary, { recursive: true, force: true }));
const output = `${temporary}/component.mjs`;
await build({ entryPoints: [fileURLToPath(new URL("../src/features/settings/human-qa/HumanQaSettingsPanel.tsx", import.meta.url))],
  outfile: output, bundle: true, platform: "node", format: "esm", packages: "external", jsx: "automatic",
  define: { "import.meta.env": "{}" }, logLevel: "silent" });
const { HumanQaSettingsPanel, HumanQaSettingsView } = await import(pathToFileURL(output).href);
const controller = Object.fromEntries(["refresh", "loadMore", "select", "inspect", "submit", "cancel", "generateReport", "loadMoreHistory"].map(key => [key, () => {}]));
function render(overrides = {}) {
  return renderToStaticMarkup(React.createElement(HumanQaSettingsView, { controller,
    state: { phase: "ready", items: [qaRow()], selectedTaskId: "task", snapshot: qaSnapshot(), ...overrides } }));
}

test("actual QA panel starts collapsed, with no hidden form/model trigger or ordinary run list", () => {
  const markup = renderToStaticMarkup(React.createElement(HumanQaSettingsPanel, { cwd: qaCwd }));
  assert.ok(markup.includes("Dedicated QA evaluation"));
  assert.ok(!markup.includes("<form")); assert.ok(!markup.includes("Run model"));
  assert.ok(!markup.includes("No enrolled QA cases"), "collapsed is not an empty success");
});

test("actual QA form exposes explicit feedback and rationale, not authority flags or paths", () => {
  const markup = render();
  for (const text of ["Only enrolled QA", "review-suite / redacted-case", "Rationale", "Verdict", "Submit for system confirmation", "Inspect submission and history"]) assert.ok(markup.includes(text));
  for (const text of ["authenticated", "adjudicator", "confirmationKey", "OPENAI_API_KEY", "Copy", "Run model"]) assert.ok(!markup.includes(text));
  assert.ok(markup.includes('maxLength="2000"') || markup.includes('maxLength="2000"'.toLowerCase()));
});

test("unknown/busy states disable submit and distinguish cancellation from rollback", () => {
  for (const lastSubmission of ["pending", "unknown"]) {
    const markup = render({ snapshot: qaSnapshot([], { lastSubmission }) });
    assert.ok(markup.includes("do not submit again")); assert.ok(markup.includes("Cancellation does not prove"));
    assert.match(markup, /<textarea[^>]*disabled/);
  }
  const busy = render({ busy: "submit" });
  assert.ok(busy.includes('aria-busy="true"')); assert.ok(busy.includes('role="status"'));
  assert.ok(busy.includes("Cancel confirmation"));
  assert.ok(busy.includes("Waiting for system confirmation"));
});

test("correction/revoke uses current event; withdrawn feedback is not a silent new adjudication", () => {
  const active = render({ snapshot: qaSnapshot([qaEvent()]) });
  assert.ok(active.includes("Correct current decision")); assert.ok(active.includes("Revoke current decision"));
  assert.ok(active.includes("event:task:1"));
  const withdrawn = render({ snapshot: qaSnapshot([qaEvent(), qaEvent(2, "revoke")]) });
  assert.ok(withdrawn.includes("This human decision was revoked")); assert.match(withdrawn, /<textarea[^>]*disabled/);
  assert.ok(!withdrawn.includes("Correct current decision"));
});

test("stale report displays frozen decision, audit and digests without raw payload dump", () => {
  const markup = render({ snapshot: qaSnapshot([qaEvent(), qaEvent(2, "correct")]), report: { ...qaReport(), currentness: "stale" } });
  for (const text of ["Fixed human QA report", "Historical report", "contents have not been changed", "reviewed:1", "Audit", "human_evaluation.adjudicate", "Payload digest", "Report digest", "rubric"]) assert.ok(markup.includes(text));
  assert.ok(!markup.includes("<pre")); assert.ok(!markup.includes("osSessionId"));
  const unavailable = render({ report: { ...qaReport(), currentness: "unavailable" } });
  assert.ok(unavailable.includes("Report currentness unavailable"));
});

test("safe error rendering never displays raw transport errors and empty/unavailable are distinct", () => {
  const failed = render({ phase: "error", issue: "host_rejected", rawError: "PRIVATE_SECRET" });
  assert.ok(failed.includes("No success or current report is inferred")); assert.ok(!failed.includes("PRIVATE_SECRET"));
  const unavailable = render({ phase: "unavailable", items: [], selectedTaskId: undefined, snapshot: undefined });
  assert.ok(unavailable.includes("packaged macOS Desktop")); assert.ok(!unavailable.includes("No enrolled QA cases"));
  const empty = render({ items: [], selectedTaskId: undefined, snapshot: undefined });
  assert.ok(empty.includes("No enrolled QA cases")); assert.ok(empty.includes("Ordinary runs are not included"));
});

test("QA list/history use scoped height limits and settings integration remains independent", async () => {
  const css = await readFile(new URL("../src/styles/settings-human-qa.css", import.meta.url), "utf8");
  assert.match(css, /\.settings-human-qa-list\s*\{[^}]*max-height:[^}]*overflow-y:\s*auto/s);
  assert.match(css, /\.settings-human-qa-history ol\s*\{[^}]*max-height:[^}]*overflow-y:\s*auto/s);
  const settings = await readFile(new URL("../src/features/settings/SettingsPage.tsx", import.meta.url), "utf8");
  assert.match(settings, /<HumanQaSettingsPanel key=\{cwd\} cwd=\{cwd\}/);
});
