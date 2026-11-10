import assert from "node:assert/strict";
import test from "node:test";
import { deriveSilentChannelReplyRunIds } from "../src/lib/conversation-runtime-visibility.ts";

// Regression: C03-VISIBILITY-LOADING — incomplete WorkUnit hydration must not hide known work.
// Found by /qa independent review on 2026-10-25.
// Report: output/e6-20260928/p3-bash-cwd-contract-live-20261025/c03-scope-findings.md
// Pure projection with synthetic Host records, not packaged or pagination acceptance.
const run = { id: "run", status: "succeeded", workUnitId: "wu-outside-page" };
const base = { runs: [run], workUnits: [], approvals: [], executionActions: [], terminalReports: [] };
for (const [name, overrides] of [
  ["tool evidence", { executionActions: [{ id: "read", runId: run.id }] }],
  ["pending approval", { approvals: [{ id: "approval", runId: run.id, status: "pending" }] }],
  ["waiting state", { runs: [{ ...run, status: "waiting_for_approval" }] }],
  ["failure", { runs: [{ ...run, status: "failed" }] }],
  ["durable change report", { terminalReports: [{ source: { kind: "run", id: run.id },
    outcome: { corrections: [], sourceRefs: [] }, changes: [{ id: "change" }], artifacts: [], risks: [], references: [], verification: [] }] }],
]) {
  test(`missing WorkUnit cannot silence ${name}`, () => {
    assert.deepEqual([...deriveSilentChannelReplyRunIds({ ...base, ...overrides })], []);
  });
}
test("missing WorkUnit without any known execution evidence retains its loading policy", () => {
  assert.deepEqual([...deriveSilentChannelReplyRunIds(base)], [run.id]);
});
