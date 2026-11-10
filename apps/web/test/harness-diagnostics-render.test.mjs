import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Compile the actual TSX and its local dependencies, using the workspace's existing Desktop bundler.
// Temporary output lives beneath Web so external React resolves to the same installed instance as this renderer.
const desktopRequire = createRequire(new URL("../../desktop/package.json", import.meta.url));
const { build } = desktopRequire("esbuild");
const temporary = await mkdtemp(fileURLToPath(new URL("../.harness-diagnostics-render-", import.meta.url)));
after(() => rm(temporary, { recursive: true, force: true }));
const output = `${temporary}/component.mjs`;
await build({ entryPoints: [fileURLToPath(new URL("../src/features/runs/RunHarnessDiagnostics.tsx", import.meta.url))], outfile: output,
  bundle: true, platform: "node", format: "esm", packages: "external", jsx: "automatic", define: { "import.meta.env": "{}" }, logLevel: "silent" });
const oldWindow = globalThis.window;
globalThis.window = {};
const { RunHarnessDiagnostics, RunHarnessDiagnosticsView } = await import(pathToFileURL(output).href);
if (oldWindow === undefined) delete globalThis.window;
else globalThis.window = oldWindow;

const time = "2026-10-09T00:00:00.000Z";
const row = {
  record: { id: "continuation-" + "long-id-".repeat(80), runId: "run", workUnitId: "unit", kind: "continuation", state: "recovery_pending",
    revision: 3, createdAt: time, updatedAt: time, claimOwner: "worker", claimExpiresAt: time, nextAttemptAt: time,
    sourceAttemptId: "source", targetAttemptId: "target", origin: "approval_resume", strategy: "native_resume", runnerId: "pi", generation: 2,
    failureCode: "continuation.target_attempt_lost", failureDetailArtifactId: "failure-artifact",
    claimToken: "PRIVATE_SENTINEL", runnerHandleRef: "PRIVATE_SENTINEL", request: "PRIVATE_SENTINEL", resultSummary: "PRIVATE_SENTINEL" },
  leaseStatus: "expired",
  attempts: [
    { id: "source", status: "observed", workUnitId: "unit", runtimeInstanceId: "runtime-owner", fencingToken: "opaque-fence:0002", attemptStatus: "failed" },
    { id: "target", status: "ownership_mismatch", workUnitId: "PRIVATE_SENTINEL", runtimeInstanceId: "PRIVATE_SENTINEL", fencingToken: "PRIVATE_SENTINEL" },
  ],
};
const cursor = { runId: "run", workUnitId: "unit", id: row.record.id, kind: row.record.kind, createdAt: time };
function render(state) {
  return renderToStaticMarkup(React.createElement(RunHarnessDiagnosticsView, { state, onRefresh() {}, onLoadMore() {} }));
}

test("actual React diagnostics render explicit safe metadata, historical lease context and opaque fences", () => {
  const markup = render({ phase: "ready", items: [row], observedAt: time });
  for (const value of ["Recovery diagnostics", "Stored recovery metadata only", "Lease observations never authorize execution", row.record.id,
    "worker", "Stored lease expired at observation", "source", "target", "runtime-owner", "opaque-fence:0002", "Attempt ownership mismatch", "continuation.target_attempt_lost", "failure-artifact"]) {
    assert.ok(markup.includes(value), `rendered ${value}`);
  }
  assert.ok(!markup.includes("PRIVATE_SENTINEL"));
  assert.ok(markup.includes("<details"));
  assert.ok(markup.includes("<summary"));
  assert.ok(!markup.includes("<pre"), "does not dump raw JSON or artifact bodies");
  assert.ok(!markup.includes("Copy"), "does not add another conversation copy footer");
});

test("actual tool metadata renders command identity but never command inputs, bodies or result summaries", () => {
  const tool = { record: { ...row.record, id: "tool-record", kind: "tool_execution", state: "unknown_outcome", attemptId: "source", toolCallId: "call",
    toolName: "bash", executorKind: "bash", continuationId: "continuation", delegationStepId: "step", supersedesExecutionId: "prior",
    policySnapshotArtifactId: "policy", approvalId: "approval", sandboxProfileId: "sandbox", executionStartedAt: time, executionFinishedAt: time,
    command: "PRIVATE_SENTINEL", artifactBody: "PRIVATE_SENTINEL" }, leaseStatus: "terminal_retained", attempts: row.attempts.slice(0, 1) };
  const markup = render({ phase: "ready", items: [tool] });
  for (const value of ["Controlled tool execution", "call", "bash", "step", "prior", "policy", "approval", "sandbox", "unknown_outcome", "Terminal record retains historical lease"]) {
    assert.ok(markup.includes(value));
  }
  assert.ok(!markup.includes("PRIVATE_SENTINEL"));
});

test("evaluation and delegation render as distinct authority records without private inputs", () => {
  const evaluation = { record: { id: "evaluation-record", runId: "run", workUnitId: "unit", kind: "evaluation", rootRunId: "root",
    state: "grading", revision: 1, createdAt: time, updatedAt: time, suiteArtifactId: "PRIVATE_SENTINEL", candidateArtifactId: "PRIVATE_SENTINEL" },
    leaseStatus: "held", attempts: [] };
  const delegation = { record: { id: "delegation-record", runId: "run", workUnitId: "unit", kind: "delegation", rootRunId: "root",
    state: "running", revision: 2, createdAt: time, updatedAt: time, parentAttemptId: "parent", workflowId: "workflow",
    workflowStepId: "workflow-step", parentDelegationStepId: "parent-step", childRunId: "child", required: true, depth: 2,
    objectiveArtifactId: "PRIVATE_SENTINEL", permissionSnapshotArtifactId: "PRIVATE_SENTINEL" }, leaseStatus: "unclaimed",
    attempts: [{ id: "parent", status: "missing" }] };
  const markup = render({ phase: "ready", items: [evaluation, delegation] });
  for (const value of ["Run evaluation", "Delegation", "root", "grading", "parent", "workflow-step", "parent-step", "child", "running"]) {
    assert.ok(markup.includes(value), `rendered ${value}`);
  }
  assert.ok(!markup.includes("Controlled tool execution · undefined"));
  assert.ok(!markup.includes("PRIVATE_SENTINEL"));
});

test("collapsed records expose distinct identities and visible state without expanding private details", () => {
  const tools = ["browser-tool-100", "browser-tool-099"].map(id => ({
    record: { ...row.record, id, kind: "tool_execution", state: "approved", attemptId: "source", toolCallId: id + "-call", toolName: "bash", executorKind: "bash" },
    leaseStatus: "unclaimed", attempts: row.attempts.slice(0, 1),
  }));
  const markup = render({ phase: "ready", items: [...tools, row] });
  const summaries = [...markup.matchAll(/<summary\b[^>]*>([\s\S]*?)<\/summary>/g)].map(match => match[1]);
  assert.equal(summaries.length, 3);
  assert.ok(summaries[0].includes("browser-tool-100"));
  assert.ok(summaries[1].includes("browser-tool-099"));
  assert.ok(summaries[0].includes("bash"));
  assert.ok(summaries[0].includes("approved"));
  assert.ok(!summaries[0].includes('data-compact="true"'), "state label remains visible rather than a dot-only indicator");
  assert.ok(summaries[2].includes('title="' + row.record.id + '"'), "long identity remains available in the summary tooltip");
  assert.ok(markup.includes(row.record.id), "full identity remains in expanded metadata");
  assert.ok(!markup.includes("PRIVATE_SENTINEL"));
});

test("diagnostic rows have a scope-specific bounded scroll area without constraining other debug lists", async () => {
  const markup = render({ phase: "ready", items: [row] });
  assert.ok(markup.includes("runs-harness-record-list"));
  const css = await readFile(new URL("../src/styles/runs/run-detail.css", import.meta.url), "utf8");
  assert.match(css, /\.runs-harness-record-list\s*\{[^}]*max-height:\s*min\(28rem,\s*55vh\)[^}]*overflow-y:\s*auto/s);
});

test("loading is announced accessibly and never claims completion", () => {
  const markup = render({ phase: "loading", items: [] });
  assert.ok(markup.includes('aria-busy="true"'));
  assert.ok(markup.includes('role="status"'));
  assert.ok(markup.includes("Loading recovery diagnostics..."));
  assert.ok(markup.includes("disabled="));
  assert.ok(!markup.includes("All pages loaded"));
  assert.ok(!markup.includes("No stored recovery records"));
});

test("empty success is distinct from unavailable data and ends pagination explicitly", () => {
  const markup = render({ phase: "ready", items: [] });
  assert.ok(markup.includes("No stored recovery records for this run"));
  assert.ok(markup.includes("All pages loaded. Refresh for newer recovery records."));
  assert.ok(!markup.includes("Load more"));
  for (const availability of ["run_unlinked", "run_missing", "lineage_mismatch", "linkage_unloaded"]) {
    const unavailable = render({ phase: "unavailable", availability, items: [] });
    assert.ok(!unavailable.includes("No stored recovery records"));
    assert.ok(!unavailable.includes("All pages loaded"));
    assert.ok(unavailable.includes('data-tone="warning"'));
  }
});

test("cold workspace and malformed responses explain retry without leaking raw errors or implying success", () => {
  for (const issue of ["workspace_uninitialized", "not_found", "invalid_query", "invalid_response", "unavailable"]) {
    const markup = render({ phase: "error", issue, items: [], message: "PRIVATE_SENTINEL", stack: "PRIVATE_SENTINEL", code: "PRIVATE_SENTINEL" });
    assert.ok(markup.includes("Recovery diagnostics unavailable"));
    assert.ok(markup.includes("Retry"));
    assert.ok(!markup.includes("PRIVATE_SENTINEL"));
    assert.ok(!markup.includes("All pages loaded"));
  }
});

test("more pages are user-controlled and pagination failure cannot masquerade as the end", () => {
  const more = render({ phase: "ready", items: [row], nextCursor: cursor });
  assert.ok(more.includes("Load more"));
  assert.ok(!more.includes("All pages loaded"));
  const failed = render({ phase: "error", issue: "unavailable", items: [row], nextCursor: cursor });
  assert.ok(failed.includes(row.record.id));
  assert.ok(failed.includes("Retry"));
  assert.ok(!failed.includes("All pages loaded"));
});

test("actual component starts idle beneath a collapsed disclosure and wrong work-unit/run linkage is not rendered as data", () => {
  const idle = renderToStaticMarkup(React.createElement(RunHarnessDiagnostics, { cwd: "/repo", runId: "run", workUnitId: "unit",
    workUnitDetail: { workUnit: { id: "unit", linkedRunId: "run" } }, enabled: false }));
  assert.ok(!idle.includes("No stored recovery records"));
  assert.ok(!idle.includes("All pages loaded"));
  const mismatch = renderToStaticMarkup(React.createElement(RunHarnessDiagnostics, { cwd: "/repo", runId: "run", workUnitId: "unit",
    workUnitDetail: { workUnit: { id: "foreign", linkedRunId: "run" } }, enabled: false }));
  assert.ok(mismatch.includes("Work unit and run ownership do not match"));
  assert.ok(!mismatch.includes("No stored recovery records"));
});
